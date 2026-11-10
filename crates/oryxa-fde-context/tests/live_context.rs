//! Ingestion and search against a real Postgres with pgvector (see `oryxa_fde_store::testing`):
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde cargo test -p oryxa-fde-context -- --ignored
//! Files live in memory and embeddings come from the deterministic fake.

use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
use oryxa_core::{TenantId, UserId};
use oryxa_events::{Encoded, Signer, Verifier};
use oryxa_fde_context::ingest::{Ingested, handle, ingest};
use oryxa_fde_context::search::{search_company, search_project};
use oryxa_fde_context::{Context, FakeCompanyKeys, MemoryBlobs, SearchQuery, document_key};
use oryxa_fde_core::{CompanyId, CompanyScope, DocumentId, ProjectId};
use oryxa_fde_events::inbox::{Message, Outcome};
use oryxa_fde_store::{
    Actor, CompanyIn, ContentType, DocumentIn, DocumentStatus, Name, ProjectIn, Store, new_id, testing,
};
use sha2::{Digest, Sha256};

fn actor() -> Actor {
    Actor {
        user: UserId::new("alice").unwrap(),
        request_id: new_id("req"),
    }
}

async fn company(store: &Store, t: &TenantId) -> CompanyScope {
    let s = CompanyScope::new(t.clone(), CompanyId::new(new_id("cmp")).unwrap());
    let mut tx = store.company(&s).await.unwrap();
    let v = CompanyIn {
        name: Name::new("Acme").unwrap(),
        industry: None,
        region: None,
        summary: None,
    };
    tx.create(&v, &actor()).await.unwrap();
    tx.commit().await.unwrap();
    s
}

/// Uploads `bytes` the way the API does: the file to the blob store, then the row and its event.
async fn upload(
    ctx: &Context,
    store: &Store,
    s: &CompanyScope,
    name: &str,
    ct: ContentType,
    bytes: &[u8],
) -> DocumentId {
    let id = DocumentId::new(new_id("doc")).unwrap();
    let key = document_key(s, &id);
    ctx.blobs.put(&key, bytes.to_vec(), ct.as_str()).await.unwrap();
    let v = DocumentIn {
        name: Name::new(name).unwrap(),
        content_type: ct,
        size_bytes: bytes.len() as i64,
        sha256: Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect(),
        blob_key: key.key().to_owned(),
    };
    let mut tx = store.company(s).await.unwrap();
    tx.add_document(&id, &v, &actor()).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    id
}

fn keys() -> (Signer, Verifier) {
    let k = SigningKey::generate(&mut rand::rngs::OsRng);
    let signer = Signer::from_pkcs8_pem("fde-1", &k.to_pkcs8_pem(LineEnding::LF).unwrap()).unwrap();
    let public = k.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
    let verifier = Verifier::default()
        .trust("fde-1", oryxa_fde_events::SOURCE, &public)
        .unwrap();
    (signer, verifier)
}

/// The `document.uploaded` the upload queued, signed as the relay signs it, as SQS delivers it.
async fn uploaded_event(t: &TenantId, document: &DocumentId, signer: &Signer) -> Message {
    let owner = testing::admin().await;
    let (id, source, detail_type, group, detail): (String, String, String, String, String) = sqlx::query_as(
        "select id, source, detail_type, group_key, detail from outbox
         where tenant_id = $1 and detail_type = 'fde.document.uploaded.v1' and detail like '%' || $2 || '%'",
    )
    .bind(t.as_str())
    .bind(document.as_str())
    .fetch_one(&owner)
    .await
    .unwrap();
    let mut e = Encoded {
        event_id: id,
        source,
        detail_type,
        group,
        detail,
    };
    signer.sign(&mut e).unwrap();
    Message {
        source: e.source,
        detail_type: e.detail_type,
        detail: e.detail,
    }
}

const RUNBOOK: &str = "# Support runbook\n\nRefunds over 500 pounds need approval from the support lead.\n\n\
    Tier-1 tickets about passwords are answered by the bot within two minutes.";
const ONCALL: &str =
    "Kubernetes on-call: restart the ingestion pods when the queue backs up, then page the platform team.";

#[tokio::test]
#[ignore = "needs Postgres with pgvector (DATABASE_URL)"]
async fn a_redelivered_upload_adds_nothing() {
    let store = testing::store().await;
    let ctx = Context::fake();
    let (signer, verifier) = keys();
    let t = TenantId::new(new_id("org")).unwrap();
    let s = company(&store, &t).await;
    let doc = upload(
        &ctx,
        &store,
        &s,
        "runbook.md",
        ContentType::Markdown,
        RUNBOOK.as_bytes(),
    )
    .await;
    let msg = uploaded_event(&t, &doc, &signer).await;

    // The event holds ids only.
    let detail: serde_json::Value = serde_json::from_str(&msg.detail).unwrap();
    assert_eq!(
        detail["data"],
        serde_json::json!({"company": s.company.as_str(), "document": doc.as_str()})
    );

    assert_eq!(handle(&ctx, &store, &verifier, &msg).await, Outcome::Done);
    let mut tx = store.company(&s).await.unwrap();
    let ingested = tx.document(&doc).await.unwrap().unwrap();
    drop(tx);
    assert_eq!((ingested.status, ingested.chunks), (DocumentStatus::Ingested, 1));

    // Delivered again, and once more straight to ingest: nothing changes.
    assert_eq!(handle(&ctx, &store, &verifier, &msg).await, Outcome::Done);
    assert_eq!(ingest(&ctx, &store, &s, &doc).await.unwrap(), Ingested::Settled);
    let owner = testing::admin().await;
    let chunks: i64 = sqlx::query_scalar("select count(*) from document_chunks where document_id = $1")
        .bind(doc.as_str())
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(chunks, 1);

    // A message signed by another key, or tampered with, is never acted on.
    let (other, _) = keys();
    let doc2 = upload(&ctx, &store, &s, "oncall.txt", ContentType::Text, ONCALL.as_bytes()).await;
    let forged = uploaded_event(&t, &doc2, &other).await;
    assert_eq!(handle(&ctx, &store, &verifier, &forged).await, Outcome::Quarantine);
    let mut tampered = uploaded_event(&t, &doc2, &signer).await;
    tampered.detail = tampered.detail.replace(doc2.as_str(), doc.as_str());
    assert_eq!(handle(&ctx, &store, &verifier, &tampered).await, Outcome::Quarantine);
    let mut tx = store.company(&s).await.unwrap();
    assert_eq!(
        tx.document(&doc2).await.unwrap().unwrap().status,
        DocumentStatus::Pending
    );
}

#[tokio::test]
#[ignore = "needs Postgres with pgvector (DATABASE_URL)"]
async fn a_file_whose_company_key_is_refused_fails_for_good_and_is_not_retried() {
    let store = testing::store().await;
    let company_keys = std::sync::Arc::new(FakeCompanyKeys::default());
    let ctx = Context {
        blobs: std::sync::Arc::new(MemoryBlobs::requiring_company_keys(company_keys.clone())),
        keys: company_keys.clone(),
        ..Context::fake()
    };
    let (signer, verifier) = keys();
    let t = TenantId::new(new_id("org")).unwrap();
    let s = company(&store, &t).await;
    company_keys.give(&s);
    let doc = upload(
        &ctx,
        &store,
        &s,
        "runbook.md",
        ContentType::Markdown,
        RUNBOOK.as_bytes(),
    )
    .await;
    let msg = uploaded_event(&t, &doc, &signer).await;

    // Offboarded (or the worker not yet in the key's policy) before the event is handled: the
    // read is refused. The event is settled, not left for redelivery, and the document says why.
    company_keys.take(&s);
    assert_eq!(handle(&ctx, &store, &verifier, &msg).await, Outcome::Done);
    let mut tx = store.company(&s).await.unwrap();
    let d = tx.document(&doc).await.unwrap().unwrap();
    drop(tx);
    assert_eq!(
        (d.status, d.failure.as_deref(), d.chunks),
        (DocumentStatus::Failed, Some("key_unavailable"), 0)
    );
    // Delivered again: nothing to do, still no retry.
    assert_eq!(handle(&ctx, &store, &verifier, &msg).await, Outcome::Done);
    assert_eq!(ingest(&ctx, &store, &s, &doc).await.unwrap(), Ingested::Settled);
}

#[tokio::test]
#[ignore = "needs Postgres with pgvector (DATABASE_URL)"]
async fn files_that_cannot_be_used_fail_with_a_code() {
    let store = testing::store().await;
    let ctx = Context::fake();
    let t = TenantId::new(new_id("org")).unwrap();
    let s = company(&store, &t).await;

    let broken = upload(
        &ctx,
        &store,
        &s,
        "broken.pdf",
        ContentType::Pdf,
        b"%PDF-1.4 nothing here",
    )
    .await;
    assert_eq!(
        ingest(&ctx, &store, &s, &broken).await.unwrap(),
        Ingested::Failed("unreadable")
    );
    assert_eq!(ingest(&ctx, &store, &s, &broken).await.unwrap(), Ingested::Settled);

    // The file changed in S3 after upload.
    let swapped = upload(&ctx, &store, &s, "notes.txt", ContentType::Text, b"original notes").await;
    ctx.blobs
        .put(&document_key(&s, &swapped), b"something else".to_vec(), "text/plain")
        .await
        .unwrap();
    assert_eq!(
        ingest(&ctx, &store, &s, &swapped).await.unwrap(),
        Ingested::Failed("checksum")
    );
    let mut tx = store.company(&s).await.unwrap();
    let d = tx.document(&swapped).await.unwrap().unwrap();
    assert_eq!(
        (d.status, d.failure.as_deref()),
        (DocumentStatus::Failed, Some("checksum"))
    );
    // Another company's document id is not this company's.
    drop(tx);
    let other = company(&store, &t).await;
    assert_eq!(ingest(&ctx, &store, &other, &swapped).await.unwrap(), Ingested::Gone);
}

#[tokio::test]
#[ignore = "needs Postgres with pgvector (DATABASE_URL)"]
async fn search_finds_the_right_passage_in_its_own_company_only() {
    let store = testing::store().await;
    let ctx = Context::fake();
    let t = TenantId::new(new_id("org")).unwrap();
    let (a, b) = (company(&store, &t).await, company(&store, &t).await);
    let elsewhere = company(&store, &TenantId::new(new_id("org")).unwrap()).await;
    let runbook = upload(
        &ctx,
        &store,
        &a,
        "runbook.md",
        ContentType::Markdown,
        RUNBOOK.as_bytes(),
    )
    .await;
    let oncall = upload(&ctx, &store, &a, "oncall.txt", ContentType::Text, ONCALL.as_bytes()).await;
    // B and another tenant hold a passage that matches the query even better.
    let refunds = "Refunds approval: refunds over 500 pounds need approval. Refunds refunds approval.";
    for s in [&b, &elsewhere] {
        let d = upload(&ctx, &store, s, "policy.txt", ContentType::Text, refunds.as_bytes()).await;
        ingest(&ctx, &store, s, &d).await.unwrap();
    }
    for d in [&runbook, &oncall] {
        assert!(matches!(
            ingest(&ctx, &store, &a, d).await.unwrap(),
            Ingested::Chunks(_)
        ));
    }

    let q = SearchQuery::new("who approves refunds over 500?").unwrap();
    let hits = search_company(&ctx, &store, &a, &q, 5).await.unwrap();
    assert_eq!(hits[0].document, runbook, "{hits:?}");
    assert!(
        hits[0]
            .content
            .as_str()
            .contains("Refunds over 500 pounds need approval")
    );
    assert!(
        hits.iter().all(|h| h.document == runbook || h.document == oncall),
        "only A's documents"
    );
    let hits = search_company(&ctx, &store, &a, &SearchQuery::new("restart the pods").unwrap(), 5)
        .await
        .unwrap();
    assert_eq!(hits[0].document, oncall);

    // Through a project of A, the same documents; through a project that is not A's, nothing.
    let p = a.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&p).await.unwrap();
    let v = ProjectIn {
        name: Name::new("RAG").unwrap(),
        summary: None,
    };
    tx.create(&v, &actor()).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    let hits = search_project(&ctx, &store, &p, &q, 5).await.unwrap().unwrap();
    assert_eq!(hits[0].document, runbook);
    let not_in_b = b.project(p.project.clone());
    assert_eq!(search_project(&ctx, &store, &not_in_b, &q, 5).await.unwrap(), None);

    // Row-level security: in A's transaction an unfiltered query sees A's chunks only.
    let owner = testing::admin().await;
    let total: i64 = sqlx::query_scalar("select count(*) from document_chunks where company_id = any($1)")
        .bind(vec![a.company.as_str(), b.company.as_str(), elsewhere.company.as_str()])
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(total, 4);
    let mut tx = store.company(&a).await.unwrap();
    let visible = tx.search_text("refunds", 50).await.unwrap();
    assert!(visible.iter().all(|h| h.document == runbook));
}

/// The fake embedder under a chosen model name, counting what it embeds; with `fail_after`, it
/// fails a call that would take it past that many texts, as Bedrock does mid-document.
struct Scripted {
    model: &'static str,
    embedded: std::sync::atomic::AtomicUsize,
    fail_after: Option<usize>,
}

impl Scripted {
    fn new(model: &'static str, fail_after: Option<usize>) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            model,
            embedded: Default::default(),
            fail_after,
        })
    }

    fn embedded(&self) -> usize {
        self.embedded.load(std::sync::atomic::Ordering::SeqCst)
    }
}

type EmbedFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<Vec<f32>>, oryxa_fde_context::ContextError>> + Send + 'a>,
>;

impl oryxa_fde_context::Embedder for Scripted {
    fn model(&self) -> &str {
        self.model
    }

    fn embed<'a>(&'a self, texts: &'a [oryxa_fde_store::Text]) -> EmbedFuture<'a> {
        Box::pin(async move {
            let before = self.embedded.load(std::sync::atomic::Ordering::SeqCst);
            if self.fail_after.is_some_and(|n| before + texts.len() > n) {
                return Err(oryxa_fde_context::ContextError::Embed("throttled".into()));
            }
            self.embedded
                .fetch_add(texts.len(), std::sync::atomic::Ordering::SeqCst);
            Ok(texts
                .iter()
                .map(|t| oryxa_fde_context::FakeEmbedder::vector(t.as_str()))
                .collect())
        })
    }
}

/// `ctx`'s files with `embedder`, re-embedding documents on the models in `replaces`.
fn with(ctx: &Context, embedder: &std::sync::Arc<Scripted>, replaces: &[&str]) -> Context {
    Context {
        blobs: ctx.blobs.clone(),
        keys: ctx.keys.clone(),
        embedder: embedder.clone(),
        replaces: replaces.iter().map(|m| m.to_string()).collect(),
        extractor: ctx.extractor.clone(),
    }
}

/// Chunks stored for `document` under each model, read as the owner.
async fn sets(document: &DocumentId) -> Vec<(String, i64)> {
    sqlx::query_as(
        "select embedding_model, count(*) from document_chunks where document_id = $1
         group by embedding_model order by embedding_model",
    )
    .bind(document.as_str())
    .fetch_all(&testing::admin().await)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "needs Postgres with pgvector (DATABASE_URL)"]
async fn ingestion_resumes_where_it_stopped_and_re_embeds_for_a_new_model() {
    use oryxa_fde_context::ingest::BATCH;
    let store = testing::store().await;
    let base = Context::fake();
    let t = TenantId::new(new_id("org")).unwrap();
    let s = company(&store, &t).await;
    // Long enough for three batches: 200-word windows every 160 words.
    let mut long = String::from("Refunds over 500 pounds need approval from the support lead. ");
    for i in 0..11_000 {
        long.push_str(&format!("w{i} "));
    }
    let doc = upload(&base, &store, &s, "handbook.md", ContentType::Markdown, long.as_bytes()).await;
    let q = SearchQuery::new("who approves refunds over 500?").unwrap();

    // Bedrock fails after the first batch: that batch is kept, and nothing is searchable yet.
    let throttled = Scripted::new("fake-v1", Some(BATCH));
    let ctx = with(&base, &throttled, &[]);
    assert!(ingest(&ctx, &store, &s, &doc).await.is_err());
    assert_eq!(sets(&doc).await, [("fake-v1".to_owned(), BATCH as i64)]);
    let mut tx = store.company(&s).await.unwrap();
    assert_eq!(
        tx.document(&doc).await.unwrap().unwrap().status,
        DocumentStatus::Pending
    );
    drop(tx);
    let probe = with(&base, &Scripted::new("fake-v1", None), &[]);
    assert!(search_company(&probe, &store, &s, &q, 5).await.unwrap().is_empty());

    // The redelivery embeds only what is missing.
    let v1 = Scripted::new("fake-v1", None);
    let ctx = with(&base, &v1, &[]);
    let Ingested::Chunks(n) = ingest(&ctx, &store, &s, &doc).await.unwrap() else {
        panic!("not ingested");
    };
    assert!(n > 2 * BATCH, "{n} chunks");
    assert_eq!(v1.embedded(), n - BATCH);
    let mut tx = store.company(&s).await.unwrap();
    let d = tx.document(&doc).await.unwrap().unwrap();
    drop(tx);
    assert_eq!(
        (d.status, d.chunks as usize, d.embedding_model.as_deref()),
        (DocumentStatus::Ingested, n, Some("fake-v1"))
    );
    assert_eq!(
        search_company(&probe, &store, &s, &q, 5).await.unwrap()[0].document,
        doc
    );
    assert_eq!(ingest(&ctx, &store, &s, &doc).await.unwrap(), Ingested::Settled);
    assert_eq!(v1.embedded(), n - BATCH, "a redelivery embeds nothing");

    // A new model that does not name v1 as replaced leaves the document as it is (a rolling deploy
    // in its first phase), and the document is still found, by full text.
    let v2 = Scripted::new("fake-v2", None);
    let first_phase = with(&base, &v2, &[]);
    assert_eq!(ingest(&first_phase, &store, &s, &doc).await.unwrap(), Ingested::Settled);
    assert_eq!(v2.embedded(), 0);
    let probe_v2 = with(&base, &Scripted::new("fake-v2", None), &[]);
    assert_eq!(
        search_company(&probe_v2, &store, &s, &q, 5).await.unwrap()[0].document,
        doc
    );
    // Replacing v1, it re-embeds it in full; the old set is gone once the new one is complete.
    let ctx = with(&base, &v2, &["fake-v1"]);
    assert_eq!(ingest(&ctx, &store, &s, &doc).await.unwrap(), Ingested::Chunks(n));
    assert_eq!(v2.embedded(), n);
    assert_eq!(sets(&doc).await, [("fake-v2".to_owned(), n as i64)]);
    assert_eq!(search_company(&ctx, &store, &s, &q, 5).await.unwrap()[0].document, doc);
    assert_eq!(ingest(&ctx, &store, &s, &doc).await.unwrap(), Ingested::Settled);
    // A task still on v1 never swaps it back.
    assert_eq!(
        ingest(&with(&base, &v1, &[]), &store, &s, &doc).await.unwrap(),
        Ingested::Settled
    );
    assert_eq!(sets(&doc).await, [("fake-v2".to_owned(), n as i64)]);

    // Stored chunks that are not this text (extraction changed between runs) are not resumed.
    let other = upload(&base, &store, &s, "notes.md", ContentType::Markdown, RUNBOOK.as_bytes()).await;
    let mut tx = store.company(&s).await.unwrap();
    let stale = oryxa_fde_store::ChunkIn {
        index: 0,
        content: oryxa_fde_store::Text::new("an older extraction").unwrap(),
        embedding: vec![0.5; 1024],
    };
    assert!(tx.add_chunks(&other, "fake-v2", &[], &[stale]).await.unwrap());
    tx.commit().await.unwrap();
    assert!(matches!(
        ingest(&ctx, &store, &s, &other).await.unwrap(),
        Ingested::Chunks(1)
    ));
    let stored: Vec<String> = sqlx::query_scalar("select content from document_chunks where document_id = $1")
        .bind(other.as_str())
        .fetch_all(&testing::admin().await)
        .await
        .unwrap();
    assert!(
        stored.len() == 1 && stored[0].contains("Refunds over 500"),
        "{stored:?}"
    );
}

/// A one-page PDF saying `text`, whose font's ToUnicode map is 4 MiB of spaces under
/// `/ASCIIHexDecode` (it decodes to nothing), under `names` font names.
fn pdf_with_empty_map(text: &str, names: usize) -> Vec<u8> {
    use lopdf::{Document, Object, Stream, dictionary};
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let map = Stream::new(dictionary! { "Filter" => "ASCIIHexDecode" }, vec![b' '; 4 << 20]);
    let map_id = doc.add_object(map);
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "ToUnicode" => map_id,
    });
    let mut fonts = lopdf::Dictionary::new();
    for n in 1..=names {
        fonts.set(format!("F{n}"), font_id);
    }
    let content = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
        "Resources" => dictionary! { "Font" => fonts },
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Count" => 1, "Kids" => vec![page_id.into()],
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

/// Files in memory and the fake embedder, with extraction in a child: `program` and its leading
/// arguments, under `limits`.
fn in_child(program: &str, args: &[&str], limits: oryxa_fde_context::child::ChildLimits) -> Context {
    let child = oryxa_fde_context::child::ChildExtractor::new(program, args.iter().map(Into::into).collect(), limits);
    Context {
        extractor: oryxa_fde_context::Extractor::Child(child),
        ..Context::fake()
    }
}

#[tokio::test]
#[ignore = "needs Postgres with pgvector (DATABASE_URL)"]
async fn extraction_runs_in_a_child_and_a_document_past_its_limits_fails_for_good() {
    use oryxa_fde_context::child::ChildLimits;
    let store = testing::store().await;
    let (signer, verifier) = keys();
    let t = TenantId::new(new_id("org")).unwrap();
    let s = company(&store, &t).await;
    let status = async |doc: &DocumentId| {
        let mut tx = store.company(&s).await.unwrap();
        let d = tx.document(doc).await.unwrap().unwrap();
        (d.status, d.failure)
    };

    // The ingest binary itself, as the worker runs it: a readable PDF is ingested.
    let ctx = in_child(env!("CARGO_BIN_EXE_oryxa-fde-ingest"), &[], ChildLimits::default());
    let good = pdf_with_empty_map("Refunds over 500 need approval", 1);
    let doc = upload(&ctx, &store, &s, "policy.pdf", ContentType::Pdf, &good).await;
    let msg = uploaded_event(&t, &doc, &signer).await;
    assert_eq!(handle(&ctx, &store, &verifier, &msg).await, Outcome::Done);
    assert_eq!(status(&doc).await, (DocumentStatus::Ingested, None));
    let q = SearchQuery::new("refunds approval").unwrap();
    assert_eq!(search_company(&ctx, &store, &s, &q, 5).await.unwrap()[0].document, doc);

    // The reviewer's file: 100 names for a map that decodes to nothing. The child refuses it, the
    // document fails, and the message is done with, never redelivered.
    let bomb = pdf_with_empty_map("Refunds", 100);
    let doc = upload(&ctx, &store, &s, "bomb.pdf", ContentType::Pdf, &bomb).await;
    let msg = uploaded_event(&t, &doc, &signer).await;
    let started = std::time::Instant::now();
    assert_eq!(handle(&ctx, &store, &verifier, &msg).await, Outcome::Done);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(status(&doc).await, (DocumentStatus::Failed, Some("too_large".into())));

    // A child that never finishes is killed at its wall clock; the document fails as too slow,
    // and its redelivery changes nothing.
    let limits = ChildLimits {
        wall: std::time::Duration::from_secs(1),
        ..ChildLimits::default()
    };
    let stuck = in_child("/bin/sh", &["-c", "cat >/dev/null; sleep 30", "sh"], limits);
    let doc = upload(&stuck, &store, &s, "stuck.pdf", ContentType::Pdf, &good).await;
    let msg = uploaded_event(&t, &doc, &signer).await;
    let started = std::time::Instant::now();
    assert_eq!(handle(&stuck, &store, &verifier, &msg).await, Outcome::Done);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(status(&doc).await, (DocumentStatus::Failed, Some("too_slow".into())));
    assert_eq!(handle(&stuck, &store, &verifier, &msg).await, Outcome::Done);
    assert_eq!(ingest(&stuck, &store, &s, &doc).await.unwrap(), Ingested::Settled);
}

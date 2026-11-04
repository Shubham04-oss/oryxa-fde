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
use oryxa_fde_context::{Context, SearchQuery, document_key};
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
        blob_key: key,
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
        embedder: embedder.clone(),
        replaces: replaces.iter().map(|m| m.to_string()).collect(),
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
    let mut tx = store.company(&s).await.unwrap();
    let stored = tx.stored_chunks(&other, "fake-v2").await.unwrap();
    assert!(stored[0].1.as_str().contains("Refunds over 500"), "{stored:?}");
}

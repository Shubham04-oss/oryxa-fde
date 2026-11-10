//! The ingestion consumer: on `document.uploaded`, read the file from S3, extract its text, chunk
//! and embed it, and store the chunks. Chunks are embedded and stored [`BATCH`] at a time, so a
//! run that stops (a Bedrock error, a restart, a visibility timeout) is resumed by the redelivery
//! after the last batch stored. The document becomes `ingested`, and searchable, only once every
//! chunk is stored. A document ingested with a model this one replaces is re-embedded the same way, keeping
//! its old chunks searchable until the new set is complete. A file that cannot be read marks the
//! document `failed` with a short code; so does one whose company key S3 or KMS refuses
//! (`key_unavailable`), which no redelivery would change.

use std::collections::HashSet;

use oryxa_events::{Verifier, decode};
use oryxa_fde_core::{CompanyScope, DocumentId};
use oryxa_fde_events::DocumentUploaded;
use oryxa_fde_events::inbox::{Message, Outcome, refusal};
use oryxa_fde_store::{ChunkIn, DocumentStatus, Store, Text};
use sha2::{Digest, Sha256};

use crate::blob::company_prefix;
use crate::chunk::chunk;
use crate::{Context, ContextError};

/// Chunks embedded and stored per transaction: what a redelivery need not embed again.
pub const BATCH: usize = 32;
/// The longest one document's text may take to extract; past it the document fails as `too_slow`.
const MAX_EXTRACTION: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ingested {
    /// The document now has this many chunks under the current model.
    Chunks(usize),
    /// Already ingested under the current model, or failed: a redelivery.
    Settled,
    /// No such document in this company.
    Gone,
    /// The file could not be used. A pending document is marked failed with this code; one being
    /// re-embedded keeps the chunks it has.
    Failed(&'static str),
}

/// Ingests one document of one company under the context's embedding model.
pub async fn ingest(
    ctx: &Context,
    store: &Store,
    scope: &CompanyScope,
    id: &DocumentId,
) -> Result<Ingested, ContextError> {
    let (model, replaces) = (ctx.embedder.model(), ctx.replaces.as_slice());
    let mut tx = store.company(scope).await?;
    let Some((doc, key)) = tx.lock_document(id).await? else {
        return Ok(Ingested::Gone);
    };
    tx.commit().await?;
    if !doc.needs(model, replaces) {
        return Ok(Ingested::Settled);
    }
    // The key was made from this scope at upload; refuse anything outside the company's prefix.
    if !key.starts_with(&company_prefix(scope)) {
        return fail(store, scope, id, (model, replaces), "blob_key").await;
    }
    let bytes = match ctx.blobs.get(&key).await {
        Ok(b) => b,
        // The key is missing, disabled or going, or this worker may not use it: the event is
        // settled, never retried.
        Err(ContextError::KeyUnavailable) => return fail(store, scope, id, (model, replaces), "key_unavailable").await,
        Err(e) => return Err(e),
    };
    let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if bytes.len() as i64 != doc.size_bytes || digest != doc.sha256 {
        return fail(store, scope, id, (model, replaces), "checksum").await;
    }
    // The handler may be dropped at the message's ceiling; the extraction stops on its own too
    // (its deadline in process, its limits in a child).
    let deadline = std::time::Instant::now() + MAX_EXTRACTION;
    let text = ctx.extractor.extract(doc.content_type, bytes, deadline).await?;
    let text = match text {
        Ok(t) => t,
        Err(e) => return fail(store, scope, id, (model, replaces), e.code()).await,
    };
    let chunks = chunk(&text);
    if chunks.is_empty() {
        return fail(store, scope, id, (model, replaces), "empty").await;
    }

    // Resume from what an interrupted run stored, if it is this text; otherwise start again.
    let mut tx = store.company(scope).await?;
    let stored = tx.stored_chunks(id, model).await?;
    let same = stored.iter().all(|(i, c)| chunks.get(*i as usize) == Some(c));
    // Under the document's lock: a set another worker has just completed is not dropped.
    if !same && !tx.drop_chunks(id, model, replaces).await? {
        return Ok(Ingested::Settled);
    }
    tx.commit().await?;
    let done: HashSet<u32> = if same {
        stored.into_iter().map(|(i, _)| i).collect()
    } else {
        HashSet::new()
    };
    let todo: Vec<(u32, &Text)> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| (i as u32, c))
        .filter(|(i, _)| !done.contains(i))
        .collect();
    for batch in todo.chunks(BATCH) {
        let texts: Vec<Text> = batch.iter().map(|(_, c)| (*c).clone()).collect();
        let embeddings = ctx.embedder.embed(&texts).await?;
        if embeddings.len() != texts.len() {
            return Err(ContextError::Embed("one vector per chunk expected".into()));
        }
        let rows: Vec<ChunkIn> = batch
            .iter()
            .zip(embeddings)
            .map(|((i, content), embedding)| ChunkIn {
                index: *i,
                content: (*content).clone(),
                embedding,
            })
            .collect();
        let mut tx = store.company(scope).await?;
        if !tx.add_chunks(id, model, replaces, &rows).await? {
            return Ok(Ingested::Settled);
        }
        tx.commit().await?;
    }

    let mut tx = store.company(scope).await?;
    if !tx.finish_chunks(id, model, replaces, chunks.len()).await? {
        return Ok(Ingested::Settled);
    }
    tx.commit().await?;
    Ok(Ingested::Chunks(chunks.len()))
}

async fn fail(
    store: &Store,
    scope: &CompanyScope,
    id: &DocumentId,
    (model, replaces): (&str, &[String]),
    why: &'static str,
) -> Result<Ingested, ContextError> {
    let mut tx = store.company(scope).await?;
    match tx.lock_document(id).await? {
        Some((doc, _)) if doc.status == DocumentStatus::Pending => {}
        // Being re-embedded: it stays searchable with the chunks it has.
        Some((doc, _)) if doc.needs(model, replaces) => return Ok(Ingested::Failed(why)),
        Some(_) => return Ok(Ingested::Settled),
        None => return Ok(Ingested::Gone),
    }
    tx.record_failure(id, why).await?;
    tx.commit().await?;
    Ok(Ingested::Failed(why))
}

/// Handles one message from the ingestion queue: only a verified `document.uploaded` is acted
/// on, under the scope its signed envelope and payload name.
pub async fn handle(ctx: &Context, store: &Store, verifier: &Verifier, msg: &Message) -> Outcome {
    if msg.detail_type != <DocumentUploaded as oryxa_events::Event>::DETAIL_TYPE {
        // The queue's rule should only send uploads; anything else is not ours to act on.
        return Outcome::Done;
    }
    let event = match decode::<DocumentUploaded>(verifier, &msg.source, &msg.detail_type, &msg.detail) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!(reason = refusal(&e), "document.uploaded refused");
            return Outcome::Quarantine;
        }
    };
    let scope = event.data.scope(&event.tenant);
    match ingest(ctx, store, &scope, &event.data.document).await {
        Ok(result) => {
            tracing::info!(event_id = %event.envelope.event_id, document = %event.data.document, ?result, "ingested");
            Outcome::Done
        }
        Err(e) => {
            tracing::warn!(event_id = %event.envelope.event_id, error = %e, "ingestion failed; will retry");
            Outcome::Retry
        }
    }
}

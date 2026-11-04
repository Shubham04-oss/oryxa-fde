//! The ingestion consumer: on `document.uploaded`, read the file from S3, extract its text, chunk
//! and embed it, and store the chunks. Idempotent: the chunks and the document's move to
//! `ingested` commit together, with the document locked, so a redelivered event finds it settled
//! and adds nothing. A file that cannot be read marks the document `failed` with a short code.

use oryxa_events::{Verifier, decode};
use oryxa_fde_core::{CompanyScope, DocumentId};
use oryxa_fde_events::DocumentUploaded;
use oryxa_fde_events::inbox::{Message, Outcome, refusal};
use oryxa_fde_store::{ChunkIn, DocumentStatus, Store};
use sha2::{Digest, Sha256};

use crate::blob::company_prefix;
use crate::chunk::chunk;
use crate::extract::extract_guarded;
use crate::{Context, ContextError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ingested {
    /// Stored this many chunks.
    Chunks(usize),
    /// Already ingested or failed: a redelivery.
    Settled,
    /// No such document in this company.
    Gone,
    /// The file could not be used; the document is marked failed with this code.
    Failed(&'static str),
}

/// Ingests one document of one company.
pub async fn ingest(
    ctx: &Context,
    store: &Store,
    scope: &CompanyScope,
    id: &DocumentId,
) -> Result<Ingested, ContextError> {
    let mut tx = store.company(scope).await?;
    let Some((doc, key)) = tx.lock_document(id).await? else {
        return Ok(Ingested::Gone);
    };
    tx.commit().await?;
    if doc.status != DocumentStatus::Pending {
        return Ok(Ingested::Settled);
    }
    // The key was made from this scope at upload; refuse anything outside the company's prefix.
    if !key.starts_with(&company_prefix(scope)) {
        return fail(store, scope, id, "blob_key").await;
    }
    let bytes = ctx.blobs.get(&key).await?;
    let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if bytes.len() as i64 != doc.size_bytes || digest != doc.sha256 {
        return fail(store, scope, id, "checksum").await;
    }
    let content_type = doc.content_type;
    let text = tokio::task::spawn_blocking(move || extract_guarded(content_type, &bytes))
        .await
        .map_err(|e| ContextError::Blob(e.to_string()))?;
    let text = match text {
        Ok(t) => t,
        Err(e) => return fail(store, scope, id, e.code()).await,
    };
    let chunks = chunk(&text);
    if chunks.is_empty() {
        return fail(store, scope, id, "empty").await;
    }
    let embeddings = ctx.embedder.embed(&chunks).await?;
    if embeddings.len() != chunks.len() {
        return Err(ContextError::Embed("one vector per chunk expected".into()));
    }
    let rows: Vec<ChunkIn> = chunks
        .into_iter()
        .zip(embeddings)
        .enumerate()
        .map(|(i, (content, embedding))| ChunkIn {
            index: i as u32,
            content,
            embedding,
        })
        .collect();

    let mut tx = store.company(scope).await?;
    match tx.lock_document(id).await? {
        Some((doc, _)) if doc.status == DocumentStatus::Pending => {}
        Some(_) => return Ok(Ingested::Settled),
        None => return Ok(Ingested::Gone),
    }
    tx.record_chunks(id, ctx.embedder.model(), &rows).await?;
    tx.commit().await?;
    Ok(Ingested::Chunks(rows.len()))
}

async fn fail(
    store: &Store,
    scope: &CompanyScope,
    id: &DocumentId,
    why: &'static str,
) -> Result<Ingested, ContextError> {
    let mut tx = store.company(scope).await?;
    match tx.lock_document(id).await? {
        Some((doc, _)) if doc.status == DocumentStatus::Pending => {}
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

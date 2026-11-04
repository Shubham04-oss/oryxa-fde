//! The context layer: a company's documents and what the workspace knows from them. Uploads go to
//! S3 under the company's prefix ([`blob`]); the ingestion consumer ([`ingest`]) turns each into
//! text ([`extract`]), chunks ([`chunk`]) and embeddings ([`embed`]) stored in Postgres with
//! row-level security; [`search`] merges full-text and vector results by reciprocal rank fusion.
//! Everything is scoped: a call takes the `CompanyScope` or `ProjectScope` it runs under.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use oryxa_fde_store::StoreError;

pub mod blob;
pub mod chunk;
pub mod embed;
pub mod extract;
pub mod ingest;
pub mod search;

pub use blob::{BlobStore, MemoryBlobs, S3Blobs, document_key};
pub use embed::{Embedder, FakeEmbedder};
pub use search::{Hit, SearchQuery};

/// Largest document accepted for upload.
pub const MAX_DOCUMENT_BYTES: usize = 20 * 1024 * 1024;

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, thiserror::Error)]
pub enum ContextError {
    #[error("store: {0}")]
    Store(#[from] StoreError),
    #[error("blob store: {0}")]
    Blob(String),
    #[error("embeddings: {0}")]
    Embed(String),
    #[error("configuration: {0}")]
    Config(String),
}

/// What the context layer runs on: where files live and how text is embedded.
#[derive(Clone)]
pub struct Context {
    pub blobs: Arc<dyn BlobStore>,
    pub embedder: Arc<dyn Embedder>,
    /// Older models whose documents ingestion re-embeds with the embedder's model; a document on
    /// any other model is left as it is.
    pub replaces: Vec<String>,
}

impl Context {
    /// In memory, with the deterministic fake embedder: for tests and local runs.
    pub fn fake() -> Self {
        Self {
            blobs: Arc::new(MemoryBlobs::default()),
            embedder: Arc::new(FakeEmbedder),
            replaces: Vec::new(),
        }
    }

    /// From the environment: `DOCUMENTS_BUCKET`, `EMBEDDING_PROVIDER` (`bedrock`, the default, or
    /// `fake`) with `EMBEDDING_MODEL`, and `EMBEDDING_REPLACES`, the comma-separated models whose
    /// documents are re-embedded. Name the old model there only once every task runs the new one,
    /// so a rolling deploy never re-embeds back and forth.
    // ponytail: one embedding model per deployment from the environment; the layered org, company
    // and project config does not exist yet. A document on a replaced model is re-embedded when its
    // `document.uploaded` is delivered again, but nothing replays those after a change yet; until
    // then it is found by full text.
    pub async fn from_env() -> Result<Self, ContextError> {
        let aws = aws_config::load_from_env().await;
        let bucket = std::env::var("DOCUMENTS_BUCKET").map_err(|_| ContextError::Config("DOCUMENTS_BUCKET".into()))?;
        let embedder: Arc<dyn Embedder> = match std::env::var("EMBEDDING_PROVIDER").as_deref() {
            Ok("fake") => Arc::new(FakeEmbedder),
            Ok("bedrock") | Err(_) => Arc::new(embed::BedrockEmbedder::new(
                aws_sdk_bedrockruntime::Client::new(&aws),
                std::env::var("EMBEDDING_MODEL").unwrap_or_else(|_| embed::TITAN_V2.into()),
            )),
            Ok(other) => return Err(ContextError::Config(format!("unknown EMBEDDING_PROVIDER {other}"))),
        };
        let model = embedder.model().to_owned();
        let replaces = std::env::var("EMBEDDING_REPLACES")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|m| !m.is_empty() && *m != model)
            .map(str::to_owned)
            .collect();
        Ok(Self {
            blobs: Arc::new(S3Blobs::new(aws_sdk_s3::Client::new(&aws), bucket)),
            embedder,
            replaces,
        })
    }
}

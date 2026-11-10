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
pub mod child;
pub mod chunk;
pub mod embed;
pub mod extract;
pub mod ingest;
pub mod keys;
pub mod search;

pub use blob::{BlobStore, CompanyObject, MemoryBlobs, S3Blobs, canvas_key, document_key};
pub use embed::{Embedder, FakeEmbedder};
pub use keys::{CompanyKeyPrefix, CompanyKeys, FakeCompanyKeys, KmsCompanyKeys, NoCompanyKeys};
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
    /// S3 or KMS refused the company's key: it has none (and the bucket requires one), or it is
    /// disabled, scheduled for deletion, or not usable by this role. Permanent: never retried.
    #[error("the company's key is missing or cannot be used")]
    KeyUnavailable,
    #[error("embeddings: {0}")]
    Embed(String),
    #[error("configuration: {0}")]
    Config(String),
}

/// Where a document's text is extracted.
#[derive(Debug, Clone)]
pub enum Extractor {
    /// In this process, on a blocking thread: tests and local runs.
    InProcess,
    /// In a child process with hard limits: the ingest worker.
    Child(child::ChildExtractor),
}

impl Extractor {
    /// The document's text, or why it has none; `Err` only if extraction could not run at all.
    pub async fn extract(
        &self,
        content_type: oryxa_fde_store::ContentType,
        bytes: Vec<u8>,
        deadline: std::time::Instant,
    ) -> Result<Result<String, extract::ExtractError>, ContextError> {
        match self {
            Extractor::InProcess => {
                tokio::task::spawn_blocking(move || extract::extract_guarded(content_type, &bytes, deadline))
                    .await
                    .map_err(|e| ContextError::Config(format!("extraction thread: {e}")))
            }
            Extractor::Child(c) => c.extract(content_type, bytes).await,
        }
    }
}

/// What the context layer runs on: where files live and how text is embedded.
#[derive(Clone)]
pub struct Context {
    pub blobs: Arc<dyn BlobStore>,
    /// Whether a company has its own key: the same answers the blob store's writes use.
    pub keys: Arc<dyn CompanyKeys>,
    pub embedder: Arc<dyn Embedder>,
    /// Older models whose documents ingestion re-embeds with the embedder's model; a document on
    /// any other model is left as it is.
    pub replaces: Vec<String>,
    /// Where documents' text is extracted.
    pub extractor: Extractor,
}

impl Context {
    /// In memory, with the deterministic fake embedder: for tests and local runs.
    pub fn fake() -> Self {
        Self {
            blobs: Arc::new(MemoryBlobs::default()),
            keys: Arc::new(NoCompanyKeys),
            embedder: Arc::new(FakeEmbedder),
            replaces: Vec::new(),
            extractor: Extractor::InProcess,
        }
    }

    /// From the environment: `DOCUMENTS_BUCKET`, `EMBEDDING_PROVIDER` (`bedrock`, the default, or
    /// `fake`) with `EMBEDDING_MODEL`, and `EMBEDDING_REPLACES`, the comma-separated models whose
    /// documents are re-embedded. Name the old model there only once every task runs the new one,
    /// so a rolling deploy never re-embeds back and forth. `COMPANY_KEY_ALIAS_ARN_PREFIX`, if set,
    /// switches company keys on (see [`keys`]); a malformed one stops startup.
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
        let raw = match std::env::var(keys::PREFIX_VAR) {
            Ok(v) => Some(v),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => return Err(ContextError::Config(keys::PREFIX_VAR.into())),
        };
        let blobs = S3Blobs::new(aws_sdk_s3::Client::new(&aws), bucket);
        let region = aws.region().map(|r| r.as_ref().to_owned());
        let (blobs, keys): (S3Blobs, Arc<dyn CompanyKeys>) = match keys::prefix_from(raw.as_deref(), region.as_deref())?
        {
            Some(prefix) => {
                let keys = Arc::new(KmsCompanyKeys::new(aws_sdk_kms::Client::new(&aws), prefix.clone()));
                (blobs.with_company_keys(prefix, keys.clone()), keys)
            }
            None => (blobs, Arc::new(NoCompanyKeys)),
        };
        Ok(Self {
            blobs: Arc::new(blobs),
            keys,
            embedder,
            replaces,
            // Only the ingest worker extracts, and it runs extraction in a child of its own binary.
            extractor: Extractor::Child(
                child::ChildExtractor::this_binary().map_err(|e| ContextError::Config(format!("current exe: {e}")))?,
            ),
        })
    }
}

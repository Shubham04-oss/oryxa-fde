//! A company's documents and search over them. Uploading, listing and searching need `work` on
//! the company, through a project too: a project assignee does not read the company's documents
//! (lead decision on #45). The file goes to S3 under the company's prefix and its row queues
//! `document.uploaded` for the ingestion consumer.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode};
use oryxa_fde_context::search::{search_company, search_project};
use oryxa_fde_context::{ContextError, Hit, SearchQuery, document_key};
use oryxa_fde_core::{CompanyId, DocumentId, ProjectId};
use oryxa_fde_store::{ContentType, Document, DocumentIn, DocumentStatus, Name};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::{IntoParams, ToSchema};

use crate::authz::company;
use crate::records::new;
use crate::{ApiError, App, ErrorBody, Principal, ts};

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum IngestState {
    Pending,
    Ingested,
    Failed,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DocumentOut {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub status: IngestState,
    /// Why ingestion gave up: `unreadable`, `empty`, `too_large`, `too_slow`, `checksum`, or
    /// `key_unavailable` (S3 or KMS refused the company's key: upload it again once the key works).
    pub failure: Option<String>,
    pub chunks: u32,
    pub uploaded_by: String,
    pub created_at: String,
    pub ingested_at: Option<String>,
}

impl From<Document> for DocumentOut {
    fn from(d: Document) -> Self {
        Self {
            id: d.id.to_string(),
            name: d.name.as_str().to_owned(),
            content_type: d.content_type.as_str().to_owned(),
            size_bytes: d.size_bytes,
            sha256: d.sha256,
            status: match d.status {
                DocumentStatus::Pending => IngestState::Pending,
                DocumentStatus::Ingested => IngestState::Ingested,
                DocumentStatus::Failed => IngestState::Failed,
            },
            failure: d.failure,
            chunks: d.chunks,
            uploaded_by: d.uploaded_by.to_string(),
            created_at: ts(d.created_at),
            ingested_at: d.ingested_at.map(ts),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SearchHitOut {
    pub document: String,
    pub document_name: String,
    /// The chunk's place in the document, from 0.
    pub chunk: u32,
    /// The passage.
    pub text: String,
    /// Fused rank score; only its order means anything.
    pub score: f64,
}

impl From<Hit> for SearchHitOut {
    fn from(h: Hit) -> Self {
        Self {
            document: h.document.to_string(),
            document_name: h.document_name.as_str().to_owned(),
            chunk: h.chunk,
            text: h.content.as_str().to_owned(),
            score: h.score,
        }
    }
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct UploadParams {
    /// The document's name, 1 to 200 characters.
    pub name: String,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SearchParams {
    /// What to look for, 1 to 500 characters; words, "quoted phrases" and -exclusions.
    pub q: String,
    /// At most this many passages (1 to 50, default 10).
    pub limit: Option<u32>,
}

impl From<ContextError> for ApiError {
    fn from(e: ContextError) -> Self {
        match e {
            ContextError::Store(e) => e.into(),
            ContextError::KeyUnavailable => ApiError::CompanyKeyMissing,
            e => {
                tracing::error!(error = %e, "context");
                ApiError::Unavailable
            }
        }
    }
}

const DEFAULT_RESULTS: u32 = 10;

fn query(p: SearchParams) -> Result<(SearchQuery, usize), ApiError> {
    let q = SearchQuery::new(p.q).map_err(|_| ApiError::Invalid("query"))?;
    let limit = p.limit.unwrap_or(DEFAULT_RESULTS);
    if !(1..=oryxa_fde_context::search::MAX_RESULTS as u32).contains(&limit) {
        return Err(ApiError::Invalid("limit"));
    }
    Ok((q, limit as usize))
}

/// Upload a document: text, Markdown, PDF or DOCX, at most 20 MiB. It is searchable once
/// ingested.
#[utoipa::path(post, operation_id = "upload_document", path = "/v1/companies/{company}/documents", tag = "context",
    params(("company" = String, Path, description = "Company id"), UploadParams),
    request_body(description = "The file; its Content-Type says which kind it is.",
        content(("text/plain"), ("text/markdown"), ("application/pdf"),
            ("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))),
    responses((status = 201, body = DocumentOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "`company_key_missing`: the company has no usable key of its own and \
            the bucket requires one. Nothing was stored; it works once the company's key is provisioned."),
        (status = 413, description = "Over 20 MiB"), (status = 415, body = ErrorBody)))]
pub(crate) async fn upload(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Query(params): Query<UploadParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<DocumentOut>), ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "work").await?;
    let name = Name::new(params.name).map_err(|_| ApiError::Invalid("name"))?;
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(ContentType::parse)
        .ok_or(ApiError::UnsupportedType)?;
    if body.is_empty() {
        return Err(ApiError::Invalid("body"));
    }
    // The company must exist before its file goes to S3. The file goes first and its row after, so
    // a write S3 refuses (no company key) leaves no row and queues no event. ponytail: a row write
    // that fails after the upload leaves its object behind, unreferenced and never ingested.
    let mut tx = app.store.company(&s).await?;
    tx.get().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;

    let id = new("doc", DocumentId::new)?;
    let key = document_key(&s, &id);
    let v = DocumentIn {
        name,
        content_type,
        size_bytes: body.len() as i64,
        sha256: Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect(),
        blob_key: key.key().to_owned(),
    };
    app.context
        .blobs
        .put(&key, body.to_vec(), content_type.as_str())
        .await?;
    let mut tx = app.store.company(&s).await?;
    let added = tx
        .add_document(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

/// The company's documents, newest first.
#[utoipa::path(get, operation_id = "list_documents", path = "/v1/companies/{company}/documents", tag = "context",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [DocumentOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn list(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Vec<DocumentOut>>, ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "work").await?;
    let mut tx = app.store.company(&s).await?;
    let list = tx.documents().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// One document and where its ingestion stands.
#[utoipa::path(get, operation_id = "get_document", path = "/v1/companies/{company}/documents/{document}", tag = "context",
    params(("company" = String, Path, description = "Company id"), ("document" = String, Path, description = "Document id")),
    responses((status = 200, body = DocumentOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn get(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, d)): Path<(CompanyId, DocumentId)>,
) -> Result<Json<DocumentOut>, ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "work").await?;
    let mut tx = app.store.company(&s).await?;
    let found = tx.document(&d).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(found.into()))
}

/// Search the company's documents: full-text and semantic matches, merged.
#[utoipa::path(get, operation_id = "search_company", path = "/v1/companies/{company}/search", tag = "context",
    params(("company" = String, Path, description = "Company id"), SearchParams),
    responses((status = 200, body = [SearchHitOut]), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub(crate) async fn search(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Query(params): Query<SearchParams>,
) -> Result<Json<Vec<SearchHitOut>>, ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "work").await?;
    let (q, limit) = query(params)?;
    let hits = search_company(&app.context, &app.store, &s, &q, limit).await?;
    Ok(Json(hits.into_iter().map(Into::into).collect()))
}

/// Search the documents of the project's company. Needs `work` on the company, as the document
/// list does; the project must be in it.
#[utoipa::path(get, operation_id = "search_project", path = "/v1/companies/{company}/projects/{project}/search",
    tag = "context",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        SearchParams),
    responses((status = 200, body = [SearchHitOut]), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn search_in_project(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Query(params): Query<SearchParams>,
) -> Result<Json<Vec<SearchHitOut>>, ApiError> {
    let (q, limit) = query(params)?;
    Ok(Json(crate::reads::search(&app, &who, c, p, &q, limit).await?))
}

/// The search behind [`search_in_project`] and the MCP `search_context` tool: `work` on the
/// company, then the project's documents' company searched under the project's scope.
pub(crate) async fn project_search(
    app: &App,
    who: &Principal,
    c: CompanyId,
    p: ProjectId,
    q: &SearchQuery,
    limit: usize,
) -> Result<Vec<SearchHitOut>, ApiError> {
    let s = who.company(c).project(p);
    app.require(who, company(&s.company), "work").await?;
    let hits = search_project(&app.context, &app.store, &s, q, limit)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(hits.into_iter().map(Into::into).collect())
}

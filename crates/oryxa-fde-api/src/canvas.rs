//! Canvas snapshots and shape links, for a company and for each project (see `plan`). The realtime
//! Worker loads and saves a canvas here with the caller's own credentials; Cloudflare keeps none
//! of it. A save names the version it was made on, and loses (409) to any save since.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_fde_context::canvas_key;
use oryxa_fde_core::{AccessRequestId, CompanyId, ProjectId, ScopeItemId, StakeholderId};
use oryxa_fde_store::{
    INLINE_SNAPSHOT_BYTES, LinkTarget, ShapeId, ShapeLink, Snapshot, SnapshotBody, SnapshotId, SnapshotIn, SnapshotMeta,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::plan::Place;
use crate::records::new;
use crate::{ApiError, App, ErrorBody, Principal, ts};

/// Largest snapshot accepted, as stored (compact JSON).
pub const MAX_CANVAS_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize, ToSchema)]
pub struct CanvasBody {
    /// The version this save was made on: the latest, or 0 for a canvas never saved.
    pub base_version: u32,
    /// The canvas library's scene, a JSON object; stored as is.
    #[schema(value_type = Object)]
    pub content: Value,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CanvasOut {
    /// 0 for a canvas never saved.
    pub version: u32,
    /// The scene; null for a canvas never saved.
    #[schema(value_type = Option<Object>)]
    pub content: Option<Value>,
    pub saved_by: Option<String>,
    pub saved_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CanvasVersionOut {
    pub version: u32,
    pub size_bytes: u32,
    pub saved_by: String,
    pub saved_at: String,
}

impl From<SnapshotMeta> for CanvasVersionOut {
    fn from(m: SnapshotMeta) -> Self {
        Self {
            version: m.version,
            size_bytes: m.size_bytes,
            saved_by: m.saved_by.to_string(),
            saved_at: ts(m.saved_at),
        }
    }
}

/// The kind of record a shape stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Stakeholder,
    ScopeItem,
    AccessRequest,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LinkBody {
    pub kind: LinkKind,
    /// The record's id. A stakeholder of the company; a scope item or access request of the
    /// project, or on a company's canvas of any of its projects.
    pub id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct LinkOut {
    pub shape: String,
    pub kind: LinkKind,
    pub id: String,
    pub linked_by: String,
    pub linked_at: String,
}

impl From<ShapeLink> for LinkOut {
    fn from(l: ShapeLink) -> Self {
        let (kind, id) = match l.target {
            LinkTarget::Stakeholder(i) => (LinkKind::Stakeholder, i.to_string()),
            LinkTarget::ScopeItem(i) => (LinkKind::ScopeItem, i.to_string()),
            LinkTarget::AccessRequest(i) => (LinkKind::AccessRequest, i.to_string()),
        };
        Self {
            shape: l.shape.to_string(),
            kind,
            id,
            linked_by: l.linked_by.to_string(),
            linked_at: ts(l.linked_at),
        }
    }
}

impl LinkBody {
    fn parse(self) -> Result<LinkTarget, ApiError> {
        let bad = |_| ApiError::Invalid("id");
        Ok(match self.kind {
            LinkKind::Stakeholder => LinkTarget::Stakeholder(StakeholderId::new(self.id).map_err(bad)?),
            LinkKind::ScopeItem => LinkTarget::ScopeItem(ScopeItemId::new(self.id).map_err(bad)?),
            LinkKind::AccessRequest => LinkTarget::AccessRequest(AccessRequestId::new(self.id).map_err(bad)?),
        })
    }
}

fn shape(raw: String) -> Result<ShapeId, ApiError> {
    ShapeId::new(raw).map_err(|_| ApiError::Invalid("shape"))
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The snapshot's scene, from Postgres or S3; one whose bytes do not match what was saved is
/// refused, never served.
async fn content(app: &App, s: Snapshot) -> Result<CanvasOut, ApiError> {
    let bytes = match s.body {
        SnapshotBody::Inline(b) => b,
        SnapshotBody::Blob(key) => app.context.blobs.get(&key).await?,
    };
    if bytes.len() != s.meta.size_bytes as usize || sha256(&bytes) != s.meta.sha256 {
        tracing::error!(snapshot = %s.meta.id, "canvas snapshot does not match its checksum");
        return Err(ApiError::Internal);
    }
    let content: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::Internal)?;
    Ok(CanvasOut {
        version: s.meta.version,
        content: Some(content),
        saved_by: Some(s.meta.saved_by.to_string()),
        saved_at: Some(ts(s.meta.saved_at)),
    })
}

async fn load(app: &App, who: &Principal, at: Place) -> Result<CanvasOut, ApiError> {
    let mut tx = at.enter(app, who).await?;
    let latest = tx.canvas().await?;
    tx.commit().await?;
    match latest {
        Some(s) => content(app, s).await,
        None => Ok(CanvasOut {
            version: 0,
            content: None,
            saved_by: None,
            saved_at: None,
        }),
    }
}

async fn save(app: &App, who: &Principal, at: Place, body: CanvasBody) -> Result<CanvasVersionOut, ApiError> {
    if !body.content.is_object() {
        return Err(ApiError::Invalid("content"));
    }
    let bytes = serde_json::to_vec(&body.content).map_err(|_| ApiError::Invalid("content"))?;
    if bytes.len() > MAX_CANVAS_BYTES {
        return Err(ApiError::Invalid("content_too_large"));
    }
    let mut tx = at.enter(app, who).await?;
    let id = new("cnv", SnapshotId::new)?;
    let mut v = SnapshotIn {
        id,
        size_bytes: u32::try_from(bytes.len()).map_err(|_| ApiError::Invalid("content_too_large"))?,
        sha256: sha256(&bytes),
        body: SnapshotBody::Inline(Vec::new()),
    };
    if bytes.len() > INLINE_SNAPSHOT_BYTES {
        // Refuse a stale save before uploading, and upload outside any transaction.
        if tx.canvas_head().await? != body.base_version {
            return Err(ApiError::Conflict);
        }
        tx.commit().await?;
        let key = canvas_key(at.scope(), &v.id);
        // ponytail: a save that loses the race after its upload leaves its object behind.
        app.context.blobs.put(&key, bytes, "application/json").await?;
        v.body = SnapshotBody::Blob(key);
        tx = at.open(app).await?;
    } else {
        v.body = SnapshotBody::Inline(bytes);
    }
    let saved = tx
        .save_canvas(body.base_version, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(saved.into())
}

async fn versions(app: &App, who: &Principal, at: Place) -> Result<Vec<CanvasVersionOut>, ApiError> {
    let mut tx = at.enter(app, who).await?;
    let list = tx.canvas_versions().await?;
    tx.commit().await?;
    Ok(list.into_iter().map(Into::into).collect())
}

async fn version(app: &App, who: &Principal, at: Place, n: u32) -> Result<CanvasOut, ApiError> {
    let mut tx = at.enter(app, who).await?;
    let found = tx.canvas_version(n).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    content(app, found).await
}

async fn links(app: &App, who: &Principal, at: Place) -> Result<Vec<LinkOut>, ApiError> {
    let mut tx = at.enter(app, who).await?;
    let list = tx.canvas_links().await?;
    tx.commit().await?;
    Ok(list.into_iter().map(Into::into).collect())
}

async fn link(app: &App, who: &Principal, at: Place, raw: String, body: LinkBody) -> Result<LinkOut, ApiError> {
    let shape = shape(raw)?;
    let target = body.parse()?;
    let mut tx = at.enter(app, who).await?;
    let linked = tx
        .link_shape(&shape, &target, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(linked.into())
}

async fn unlink(app: &App, who: &Principal, at: Place, raw: String) -> Result<StatusCode, ApiError> {
    let shape = shape(raw)?;
    let mut tx = at.enter(app, who).await?;
    if !tx.unlink_shape(&shape, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The company's canvas at its latest version; version 0 and no content if never saved.
#[utoipa::path(get, operation_id = "get_company_canvas", path = "/v1/companies/{company}/canvas", tag = "planning",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = CanvasOut), (status = 403, body = ErrorBody)))]
pub(crate) async fn company_canvas(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<CanvasOut>, ApiError> {
    Ok(Json(load(&app, &who, Place::company(&who, c)).await?))
}

/// Save the company's canvas as a new version, on top of `base_version`.
#[utoipa::path(put, operation_id = "save_company_canvas", path = "/v1/companies/{company}/canvas", tag = "planning",
    request_body = CanvasBody, params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = CanvasVersionOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, description = "Another save came first", body = ErrorBody),
        (status = 413, description = "Over 8 MiB")))]
pub(crate) async fn save_company_canvas(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Json(body): Json<CanvasBody>,
) -> Result<Json<CanvasVersionOut>, ApiError> {
    Ok(Json(save(&app, &who, Place::company(&who, c), body).await?))
}

/// The company canvas's newest versions (up to 100), newest first.
#[utoipa::path(get, operation_id = "list_company_canvas_versions", path = "/v1/companies/{company}/canvas/versions",
    tag = "planning", params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [CanvasVersionOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn company_canvas_versions(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Vec<CanvasVersionOut>>, ApiError> {
    Ok(Json(versions(&app, &who, Place::company(&who, c)).await?))
}

/// One version of the company's canvas.
#[utoipa::path(get, operation_id = "get_company_canvas_version",
    path = "/v1/companies/{company}/canvas/versions/{version}", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("version" = u32, Path, description = "Version")),
    responses((status = 200, body = CanvasOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn company_canvas_version(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, n)): Path<(CompanyId, u32)>,
) -> Result<Json<CanvasOut>, ApiError> {
    Ok(Json(version(&app, &who, Place::company(&who, c), n).await?))
}

/// The company canvas's shape links.
#[utoipa::path(get, operation_id = "list_company_canvas_links", path = "/v1/companies/{company}/canvas/links",
    tag = "planning", params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [LinkOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn company_canvas_links(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Vec<LinkOut>>, ApiError> {
    Ok(Json(links(&app, &who, Place::company(&who, c)).await?))
}

/// Link a shape on the company's canvas to a record, replacing its link if it had one.
#[utoipa::path(put, operation_id = "link_company_shape", path = "/v1/companies/{company}/canvas/shapes/{shape}/link",
    tag = "planning", request_body = LinkBody,
    params(("company" = String, Path, description = "Company id"), ("shape" = String, Path, description = "Shape id")),
    responses((status = 200, body = LinkOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn link_company_shape(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, s)): Path<(CompanyId, String)>,
    Json(body): Json<LinkBody>,
) -> Result<Json<LinkOut>, ApiError> {
    Ok(Json(link(&app, &who, Place::company(&who, c), s, body).await?))
}

/// Remove a shape's link on the company's canvas.
#[utoipa::path(delete, operation_id = "unlink_company_shape",
    path = "/v1/companies/{company}/canvas/shapes/{shape}/link", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("shape" = String, Path, description = "Shape id")),
    responses((status = 204), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn unlink_company_shape(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, s)): Path<(CompanyId, String)>,
) -> Result<StatusCode, ApiError> {
    unlink(&app, &who, Place::company(&who, c), s).await
}

/// The project's canvas at its latest version; version 0 and no content if never saved.
#[utoipa::path(get, operation_id = "get_project_canvas", path = "/v1/companies/{company}/projects/{project}/canvas",
    tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = CanvasOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_canvas(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<CanvasOut>, ApiError> {
    Ok(Json(load(&app, &who, Place::project(&who, c, p)).await?))
}

/// Save the project's canvas as a new version, on top of `base_version`.
#[utoipa::path(put, operation_id = "save_project_canvas", path = "/v1/companies/{company}/projects/{project}/canvas",
    tag = "planning", request_body = CanvasBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = CanvasVersionOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, description = "Another save came first", body = ErrorBody),
        (status = 413, description = "Over 8 MiB")))]
pub(crate) async fn save_project_canvas(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<CanvasBody>,
) -> Result<Json<CanvasVersionOut>, ApiError> {
    Ok(Json(save(&app, &who, Place::project(&who, c, p), body).await?))
}

/// The project canvas's newest versions (up to 100), newest first.
#[utoipa::path(get, operation_id = "list_project_canvas_versions",
    path = "/v1/companies/{company}/projects/{project}/canvas/versions", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [CanvasVersionOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_canvas_versions(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<CanvasVersionOut>>, ApiError> {
    Ok(Json(versions(&app, &who, Place::project(&who, c, p)).await?))
}

/// One version of the project's canvas.
#[utoipa::path(get, operation_id = "get_project_canvas_version",
    path = "/v1/companies/{company}/projects/{project}/canvas/versions/{version}", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("version" = u32, Path, description = "Version")),
    responses((status = 200, body = CanvasOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_canvas_version(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, n)): Path<(CompanyId, ProjectId, u32)>,
) -> Result<Json<CanvasOut>, ApiError> {
    Ok(Json(version(&app, &who, Place::project(&who, c, p), n).await?))
}

/// The project canvas's shape links.
#[utoipa::path(get, operation_id = "list_project_canvas_links",
    path = "/v1/companies/{company}/projects/{project}/canvas/links", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [LinkOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_canvas_links(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<LinkOut>>, ApiError> {
    Ok(Json(links(&app, &who, Place::project(&who, c, p)).await?))
}

/// Link a shape on the project's canvas to a record, replacing its link if it had one.
#[utoipa::path(put, operation_id = "link_project_shape",
    path = "/v1/companies/{company}/projects/{project}/canvas/shapes/{shape}/link", tag = "planning",
    request_body = LinkBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("shape" = String, Path, description = "Shape id")),
    responses((status = 200, body = LinkOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn link_project_shape(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, s)): Path<(CompanyId, ProjectId, String)>,
    Json(body): Json<LinkBody>,
) -> Result<Json<LinkOut>, ApiError> {
    Ok(Json(link(&app, &who, Place::project(&who, c, p), s, body).await?))
}

/// Remove a shape's link on the project's canvas.
#[utoipa::path(delete, operation_id = "unlink_project_shape",
    path = "/v1/companies/{company}/projects/{project}/canvas/shapes/{shape}/link", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("shape" = String, Path, description = "Shape id")),
    responses((status = 204), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn unlink_project_shape(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, s)): Path<(CompanyId, ProjectId, String)>,
) -> Result<StatusCode, ApiError> {
    unlink(&app, &who, Place::project(&who, c, p), s).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_body_names_one_valid_record() {
        let body = |kind, id: &str| LinkBody { kind, id: id.into() };
        assert_eq!(
            body(LinkKind::ScopeItem, "itm_1").parse().unwrap(),
            LinkTarget::ScopeItem(ScopeItemId::new("itm_1").unwrap())
        );
        for bad in ["", "a/b", "a|b"] {
            assert!(
                matches!(body(LinkKind::Stakeholder, bad).parse(), Err(ApiError::Invalid("id"))),
                "{bad:?}"
            );
        }
        assert!(matches!(shape("../x".into()), Err(ApiError::Invalid("shape"))));
    }
}

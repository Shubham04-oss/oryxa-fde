//! A project's lifecycle records: stage, scope and success criteria with sign-off, access requests,
//! tasks and decisions. Reading or changing any of them needs `work` on the project; the store
//! refuses records that are not in the project named by the path.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_fde_core::{
    AccessRequestId, CompanyId, CriterionId, DecisionId, ProjectId, Stage, StakeholderId, SystemId, TaskId,
};
use oryxa_fde_events::AccessStatus;
use oryxa_fde_store::{
    AccessRequest, AccessRequestIn, Comparator, Criterion, CriterionIn, Decision, DecisionIn, ProjectTx, ScopeChange,
    ScopeItem, ScopeItemId, ScopeItemIn, ScopeKind, ScopeOfWork, SignOff, Task, TaskIn, TaskStatus,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use utoipa::ToSchema;

use crate::authz::project;
use crate::projects::{ProjectOut, ProjectStage};
use crate::records::{name, new, text};
use crate::{ApiError, App, ErrorBody, Principal, ts};

async fn project_tx(app: &App, who: &Principal, c: CompanyId, p: ProjectId) -> Result<ProjectTx, ApiError> {
    let s = who.company(c).project(p);
    app.require(who, project(&s), "work").await?;
    Ok(app.store.project(&s).await?)
}

/// Maps between an API enum and the store's, both ways, by variant name.
macro_rules! mirror {
    ($api:ident <=> $store:ident { $($v:ident),* $(,)? }) => {
        impl From<$api> for $store {
            fn from(v: $api) -> Self {
                match v { $($api::$v => $store::$v),* }
            }
        }
        impl From<$store> for $api {
            fn from(v: $store) -> Self {
                match v { $($store::$v => $api::$v),* }
            }
        }
    };
}

impl From<ProjectStage> for Stage {
    fn from(v: ProjectStage) -> Self {
        match v {
            ProjectStage::Discover => Stage::Discover,
            ProjectStage::Scope => Stage::Scope,
            ProjectStage::Access => Stage::Access,
            ProjectStage::Build => Stage::Build,
            ProjectStage::Evaluate => Stage::Evaluate,
            ProjectStage::Deploy => Stage::Deploy,
            ProjectStage::Handoff => Stage::Handoff,
            ProjectStage::Operate => Stage::Operate,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    In,
    Out,
}
mirror!(ItemKind <=> ScopeKind { In, Out });

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TargetComparator {
    AtLeast,
    AtMost,
}
mirror!(TargetComparator <=> Comparator { AtLeast, AtMost });

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AccessState {
    Requested,
    InProgress,
    Granted,
    Denied,
    Revoked,
}
mirror!(AccessState <=> AccessStatus { Requested, InProgress, Granted, Denied, Revoked });

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Todo,
    InProgress,
    WaitingOnCustomer,
    Blocked,
    Done,
}
mirror!(TaskState <=> TaskStatus { Todo, InProgress, WaitingOnCustomer, Blocked, Done });

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct StageBody {
    /// One stage forward, or back to any earlier stage.
    pub stage: ProjectStage,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ScopeItemBody {
    pub kind: ItemKind,
    pub description: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScopeItemOut {
    pub id: String,
    pub kind: ItemKind,
    pub description: String,
    pub updated_at: String,
}

impl From<ScopeItem> for ScopeItemOut {
    fn from(i: ScopeItem) -> Self {
        Self {
            id: i.id.to_string(),
            kind: i.kind.into(),
            description: i.description.as_str().to_owned(),
            updated_at: ts(i.updated_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CriterionBody {
    pub description: String,
    /// What is measured, e.g. "answer accuracy".
    pub metric: String,
    pub comparator: TargetComparator,
    pub target: f64,
    /// e.g. "%" or "s".
    pub unit: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CriterionOut {
    pub id: String,
    pub description: String,
    pub metric: String,
    pub comparator: TargetComparator,
    pub target: f64,
    pub unit: Option<String>,
    pub updated_at: String,
}

impl From<Criterion> for CriterionOut {
    fn from(c: Criterion) -> Self {
        Self {
            id: c.id.to_string(),
            description: c.description.as_str().to_owned(),
            metric: c.metric.as_str().to_owned(),
            comparator: c.comparator.into(),
            target: c.target,
            unit: c.unit.map(|u| u.as_str().to_owned()),
            updated_at: ts(c.updated_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SignOffBody {
    /// The person at the customer who signed off.
    #[schema(value_type = String)]
    pub stakeholder: StakeholderId,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SignOffOut {
    pub version: u32,
    pub stakeholder: String,
    pub recorded_by: String,
    pub signed_at: String,
}

impl From<SignOff> for SignOffOut {
    fn from(s: SignOff) -> Self {
        Self {
            version: s.version,
            stakeholder: s.stakeholder.to_string(),
            recorded_by: s.recorded_by.to_string(),
            signed_at: ts(s.signed_at),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScopeOut {
    /// Bumped by every change to the items or criteria.
    pub version: u32,
    /// The latest sign-off, if any.
    pub sign_off: Option<SignOffOut>,
    /// Whether the latest sign-off covers the current version.
    pub signed_off: bool,
    pub items: Vec<ScopeItemOut>,
    pub criteria: Vec<CriterionOut>,
}

impl From<ScopeOfWork> for ScopeOut {
    fn from(s: ScopeOfWork) -> Self {
        Self {
            version: s.version,
            signed_off: s.sign_off.as_ref().is_some_and(|o| o.version == s.version),
            sign_off: s.sign_off.map(Into::into),
            items: s.items.into_iter().map(Into::into).collect(),
            criteria: s.criteria.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScopeChangeOut {
    pub version: u32,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub at: String,
}

impl From<ScopeChange> for ScopeChangeOut {
    fn from(c: ScopeChange) -> Self {
        Self {
            version: c.version,
            actor: c.actor.to_string(),
            action: c.action,
            target: c.target,
            at: ts(c.at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AccessRequestBody {
    /// What access is needed.
    pub description: String,
    #[schema(value_type = Option<String>)]
    pub system: Option<SystemId>,
    /// The stakeholder at the customer who owns granting it.
    #[schema(value_type = Option<String>)]
    pub owner: Option<StakeholderId>,
    pub status: AccessState,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AccessRequestOut {
    pub id: String,
    pub description: String,
    pub system: Option<String>,
    pub owner: Option<String>,
    pub status: AccessState,
    pub requested_at: String,
    pub status_changed_at: String,
    pub granted_at: Option<String>,
    /// Whole days from the request until it was settled, or until now while it is open.
    pub days_waiting: i64,
}

impl From<AccessRequest> for AccessRequestOut {
    fn from(a: AccessRequest) -> Self {
        Self {
            id: a.id.to_string(),
            description: a.description.as_str().to_owned(),
            system: a.system.map(|s| s.to_string()),
            owner: a.owner.map(|o| o.to_string()),
            status: a.status.into(),
            requested_at: ts(a.requested_at),
            status_changed_at: ts(a.status_changed_at),
            granted_at: a.granted_at.map(ts),
            days_waiting: a.days_waiting,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskBody {
    pub title: String,
    pub status: TaskState,
    /// What blocks the task; required when the status is `blocked`.
    pub blocker: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskOut {
    pub id: String,
    pub title: String,
    pub status: TaskState,
    pub blocker: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Task> for TaskOut {
    fn from(t: Task) -> Self {
        Self {
            id: t.id.to_string(),
            title: t.title.as_str().to_owned(),
            status: t.status.into(),
            blocker: t.blocker.map(|b| b.as_str().to_owned()),
            created_at: ts(t.created_at),
            updated_at: ts(t.updated_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DecisionBody {
    /// What was decided.
    pub title: String,
    /// Why.
    pub rationale: String,
    /// Who decided, often someone at the customer.
    pub decided_by: String,
    /// When, RFC 3339; defaults to now.
    pub decided_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DecisionOut {
    pub id: String,
    pub title: String,
    pub rationale: String,
    pub decided_by: String,
    pub decided_at: String,
    pub recorded_by: String,
    pub created_at: String,
}

impl From<Decision> for DecisionOut {
    fn from(d: Decision) -> Self {
        Self {
            id: d.id.to_string(),
            title: d.title.as_str().to_owned(),
            rationale: d.rationale.as_str().to_owned(),
            decided_by: d.decided_by.as_str().to_owned(),
            decided_at: ts(d.decided_at),
            recorded_by: d.recorded_by.to_string(),
            created_at: ts(d.created_at),
        }
    }
}

impl ScopeItemBody {
    fn parse(self) -> Result<ScopeItemIn, ApiError> {
        Ok(ScopeItemIn {
            kind: self.kind.into(),
            description: text(self.description, "description")?,
        })
    }
}

impl CriterionBody {
    fn parse(self) -> Result<CriterionIn, ApiError> {
        if !self.target.is_finite() {
            return Err(ApiError::Invalid("target"));
        }
        Ok(CriterionIn {
            description: text(self.description, "description")?,
            metric: name(self.metric, "metric")?,
            comparator: self.comparator.into(),
            target: self.target,
            unit: self.unit.map(|u| name(u, "unit")).transpose()?,
        })
    }
}

impl AccessRequestBody {
    fn parse(self) -> Result<AccessRequestIn, ApiError> {
        Ok(AccessRequestIn {
            description: text(self.description, "description")?,
            system: self.system,
            owner: self.owner,
            status: self.status.into(),
        })
    }
}

impl TaskBody {
    fn parse(self) -> Result<TaskIn, ApiError> {
        Ok(TaskIn {
            title: name(self.title, "title")?,
            status: self.status.into(),
            blocker: self.blocker.map(|b| text(b, "blocker")).transpose()?,
        })
    }
}

impl DecisionBody {
    fn parse(self) -> Result<DecisionIn, ApiError> {
        let decided_at = match self.decided_at {
            Some(at) => OffsetDateTime::parse(&at, &Rfc3339).map_err(|_| ApiError::Invalid("decided_at"))?,
            None => OffsetDateTime::now_utc(),
        };
        Ok(DecisionIn {
            title: name(self.title, "title")?,
            rationale: text(self.rationale, "rationale")?,
            decided_by: name(self.decided_by, "decided_by")?,
            decided_at,
        })
    }
}

/// Move the project to another stage: one forward, or back to any earlier one.
#[utoipa::path(put, operation_id = "change_stage", path = "/v1/companies/{company}/projects/{project}/stage", tag = "lifecycle",
    request_body = StageBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = ProjectOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody)))]
pub(crate) async fn change_stage(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<StageBody>,
) -> Result<Json<ProjectOut>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let moved = tx
        .change_stage(body.stage.into(), &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(moved.into()))
}

/// The project's scope: items in and out of scope, success criteria and the latest sign-off.
#[utoipa::path(get, operation_id = "get_scope", path = "/v1/companies/{company}/projects/{project}/scope", tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = ScopeOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn scope(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<ScopeOut>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let scope = tx.scope_of_work().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(scope.into()))
}

#[utoipa::path(post, operation_id = "add_scope_item", path = "/v1/companies/{company}/projects/{project}/scope/items",
    tag = "lifecycle", request_body = ScopeItemBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = ScopeItemOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn add_scope_item(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<ScopeItemBody>,
) -> Result<(StatusCode, Json<ScopeItemOut>), ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let id = new("itm", ScopeItemId::new)?;
    let added = tx
        .add_scope_item(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

#[utoipa::path(put, operation_id = "update_scope_item", path = "/v1/companies/{company}/projects/{project}/scope/items/{item}",
    tag = "lifecycle", request_body = ScopeItemBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("item" = String, Path, description = "Scope item id")),
    responses((status = 200, body = ScopeItemOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_scope_item(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, ScopeItemId)>,
    Json(body): Json<ScopeItemBody>,
) -> Result<Json<ScopeItemOut>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let updated = tx
        .update_scope_item(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

#[utoipa::path(delete, operation_id = "remove_scope_item", path = "/v1/companies/{company}/projects/{project}/scope/items/{item}",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("item" = String, Path, description = "Scope item id")),
    responses((status = 204, description = "Removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_scope_item(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, ScopeItemId)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    if !tx.remove_scope_item(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, operation_id = "add_criterion", path = "/v1/companies/{company}/projects/{project}/scope/criteria",
    tag = "lifecycle", request_body = CriterionBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = CriterionOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn add_criterion(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<CriterionBody>,
) -> Result<(StatusCode, Json<CriterionOut>), ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let id = new("crt", CriterionId::new)?;
    let added = tx
        .add_criterion(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

#[utoipa::path(put, operation_id = "update_criterion",
    path = "/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}", tag = "lifecycle",
    request_body = CriterionBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("criterion" = String, Path, description = "Success criterion id")),
    responses((status = 200, body = CriterionOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_criterion(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, CriterionId)>,
    Json(body): Json<CriterionBody>,
) -> Result<Json<CriterionOut>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let updated = tx
        .update_criterion(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

#[utoipa::path(delete, operation_id = "remove_criterion",
    path = "/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}", tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("criterion" = String, Path, description = "Success criterion id")),
    responses((status = 204, description = "Removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_criterion(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, CriterionId)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    if !tx.remove_criterion(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Record the customer's sign-off of the current scope version.
#[utoipa::path(post, operation_id = "sign_off_scope", path = "/v1/companies/{company}/projects/{project}/scope/sign-offs",
    tag = "lifecycle", request_body = SignOffBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = SignOffOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub(crate) async fn sign_off(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<SignOffBody>,
) -> Result<(StatusCode, Json<SignOffOut>), ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let signed = tx
        .sign_off(&body.stakeholder, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(signed.into())))
}

/// The scope's change log, oldest first.
#[utoipa::path(get, operation_id = "list_scope_changes", path = "/v1/companies/{company}/projects/{project}/scope/changes",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [ScopeChangeOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn scope_changes(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<ScopeChangeOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    tx.get().await?.ok_or(ApiError::NotFound)?;
    let list = tx.scope_changes().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[utoipa::path(get, operation_id = "list_access_requests", path = "/v1/companies/{company}/projects/{project}/access-requests",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [AccessRequestOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn access_requests(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<AccessRequestOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    tx.get().await?.ok_or(ApiError::NotFound)?;
    let list = tx.access_requests().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[utoipa::path(post, operation_id = "add_access_request", path = "/v1/companies/{company}/projects/{project}/access-requests",
    tag = "lifecycle", request_body = AccessRequestBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = AccessRequestOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn add_access_request(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<AccessRequestBody>,
) -> Result<(StatusCode, Json<AccessRequestOut>), ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let id = new("acc", AccessRequestId::new)?;
    let added = tx
        .add_access_request(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

/// Replace an access request; a status change is published as `access_request.status_changed`.
#[utoipa::path(put, operation_id = "update_access_request",
    path = "/v1/companies/{company}/projects/{project}/access-requests/{access_request}", tag = "lifecycle",
    request_body = AccessRequestBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("access_request" = String, Path, description = "Access request id")),
    responses((status = 200, body = AccessRequestOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_access_request(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, AccessRequestId)>,
    Json(body): Json<AccessRequestBody>,
) -> Result<Json<AccessRequestOut>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let updated = tx
        .update_access_request(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

#[utoipa::path(get, operation_id = "list_tasks", path = "/v1/companies/{company}/projects/{project}/tasks", tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [TaskOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn tasks(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<TaskOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    tx.get().await?.ok_or(ApiError::NotFound)?;
    let list = tx.tasks().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[utoipa::path(post, operation_id = "add_task", path = "/v1/companies/{company}/projects/{project}/tasks", tag = "lifecycle",
    request_body = TaskBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = TaskOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub(crate) async fn add_task(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<TaskBody>,
) -> Result<(StatusCode, Json<TaskOut>), ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let id = new("tsk", TaskId::new)?;
    let added = tx.add_task(&id, &v, &who.actor()).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

#[utoipa::path(put, operation_id = "update_task", path = "/v1/companies/{company}/projects/{project}/tasks/{task}",
    tag = "lifecycle", request_body = TaskBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("task" = String, Path, description = "Task id")),
    responses((status = 200, body = TaskOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub(crate) async fn update_task(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, TaskId)>,
    Json(body): Json<TaskBody>,
) -> Result<Json<TaskOut>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let updated = tx.update_task(&id, &v, &who.actor()).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

#[utoipa::path(delete, operation_id = "remove_task", path = "/v1/companies/{company}/projects/{project}/tasks/{task}",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("task" = String, Path, description = "Task id")),
    responses((status = 204, description = "Removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_task(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, TaskId)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    if !tx.remove_task(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The decisions log, newest decision first.
#[utoipa::path(get, operation_id = "list_decisions", path = "/v1/companies/{company}/projects/{project}/decisions",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [DecisionOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn decisions(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<DecisionOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    tx.get().await?.ok_or(ApiError::NotFound)?;
    let list = tx.decisions().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Record a decision: what, who decided, when and why. The log is append-only.
#[utoipa::path(post, operation_id = "record_decision", path = "/v1/companies/{company}/projects/{project}/decisions",
    tag = "lifecycle", request_body = DecisionBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = DecisionOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn record_decision(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<DecisionBody>,
) -> Result<(StatusCode, Json<DecisionOut>), ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let v = body.parse()?;
    let id = new("dec", DecisionId::new)?;
    let recorded = tx
        .record_decision(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(recorded.into())))
}

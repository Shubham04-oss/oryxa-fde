//! A project's lifecycle records: stage, scope and success criteria with sign-off, access requests,
//! tasks and decisions. Reading or changing any of them needs `work` on the project; the store
//! refuses records that are not in the project named by the path.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use oryxa_core::UserId;
use oryxa_fde_core::{
    AccessRequestId, CompanyId, CriterionId, DecisionId, ProjectId, ProjectScope, ScopeItemId, Stage, StakeholderId,
    SystemId, TaskId,
};
use oryxa_fde_events::AccessStatus;
use oryxa_fde_store::{
    AccessRequest, AccessRequestIn, ChecklistItem, Comparator, Criterion, CriterionIn, Decision, DecisionIn, ProjectTx,
    Reason, ScopeChange, ScopeItem, ScopeItemIn, ScopeKind, ScopeOfWork, SignOff, StoreError, Task, TaskIn, TaskStatus,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use utoipa::ToSchema;

use crate::authz::project;
use crate::error::{SaveConflict, StaleBody, saved};
use crate::projects::{ProjectOut, ProjectStage};
use crate::records::{name, new, text};
use crate::{ApiError, App, ErrorBody, Principal, ts};

/// A task's assignee must work on its project: a user of another tenant, or of this one with no
/// access to the project, is refused.
async fn check_assignee(app: &App, who: &Principal, s: &ProjectScope, v: &TaskIn) -> Result<(), ApiError> {
    match &v.assignee {
        Some(a) if !app.works_on(who, a, s).await? => Err(ApiError::Invalid("assignee")),
        _ => Ok(()),
    }
}

/// A create has no version to check against.
pub(crate) fn unversioned(version: Option<u32>) -> Result<(), ApiError> {
    match version {
        Some(_) => Err(ApiError::Invalid("version")),
        None => Ok(()),
    }
}

pub(crate) async fn project_tx(app: &App, who: &Principal, c: CompanyId, p: ProjectId) -> Result<ProjectTx, ApiError> {
    let s = who.company(c).project(p);
    app.require(who, project(&s), "work").await?;
    let mut tx = app.store.project(&s).await?;
    // The permission is on the project, so the path's company must be the project's own.
    if !tx.exists().await? {
        return Err(ApiError::NotFound);
    }
    Ok(tx)
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
    /// Why the project moves forward with items of its stage checklist open: 1 to 500 characters.
    /// Needed only then, and kept in the audit log with the open items; ignored otherwise.
    pub reason: Option<String>,
}

/// One item of the checklist to leave a stage.
#[derive(Debug, Serialize, ToSchema)]
pub struct ChecklistItemOut {
    /// Stable key, e.g. `scope_signed_off`.
    pub key: String,
    pub label: String,
    pub met: bool,
}

impl From<ChecklistItem> for ChecklistItemOut {
    fn from(i: ChecklistItem) -> Self {
        Self {
            key: i.check.key().to_owned(),
            label: i.check.label().to_owned(),
            met: i.met,
        }
    }
}

/// What the project needs to leave its current stage, worked out from its records now.
#[derive(Debug, Serialize, ToSchema)]
pub struct StageChecklistOut {
    /// The project's current stage.
    pub stage: ProjectStage,
    /// Empty for a stage with nothing to check yet.
    pub items: Vec<ChecklistItemOut>,
}

/// A refused stage move: `rejected_stage_transition` for a skip or a no-op, or
/// `rejected_checklist_open` with the items still `open` when a forward move gave no reason.
#[derive(Debug, Serialize, ToSchema)]
pub struct StageConflictBody {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<Vec<ChecklistItemOut>>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ScopeItemBody {
    pub kind: ItemKind,
    pub description: String,
    /// On a `PUT`, the `version` of the record this save was based on. If the record has moved on
    /// since, the answer is 409 `stale_version` with the record as it stands, and nothing changes.
    /// Left out, the save is not checked and the last writer wins. Not allowed on a create.
    pub version: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScopeItemOut {
    pub id: String,
    pub kind: ItemKind,
    pub description: String,
    pub updated_at: String,
    /// Bumped by every change to the record; send it back as `version` on a `PUT`.
    // ponytail: always sent, but optional in the spec until the web's fixtures carry it.
    #[schema(required = false)]
    pub version: u32,
}

impl From<ScopeItem> for ScopeItemOut {
    fn from(i: ScopeItem) -> Self {
        Self {
            id: i.id.to_string(),
            kind: i.kind.into(),
            description: i.description.as_str().to_owned(),
            updated_at: ts(i.updated_at),
            version: i.version,
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
    /// On a `PUT`, the `version` of the record this save was based on. If the record has moved on
    /// since, the answer is 409 `stale_version` with the record as it stands, and nothing changes.
    /// Left out, the save is not checked and the last writer wins. Not allowed on a create.
    pub version: Option<u32>,
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
    /// Bumped by every change to the record; send it back as `version` on a `PUT`.
    // ponytail: always sent, but optional in the spec until the web's fixtures carry it.
    #[schema(required = false)]
    pub version: u32,
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
            version: c.version,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SignOffBody {
    /// The person at the customer who signed off.
    #[schema(value_type = String)]
    pub stakeholder: StakeholderId,
    /// The scope `version` the customer agreed to. If the scope has moved on since, the answer is
    /// 409 `stale_version` with the scope as it stands, and nothing is signed. Left out, the
    /// current version is signed.
    pub version: Option<u32>,
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
    /// Bumped by every change to the items or criteria (a save that changes nothing is none); send
    /// it as `version` with a sign-off.
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
    /// What the change set: the item or criterion, or for `signed_off` the whole signed scope
    /// (`stakeholder`, `items`, `criteria`). Null for changes logged before content was kept.
    #[schema(value_type = Option<Object>)]
    pub content: Option<serde_json::Value>,
    pub at: String,
}

impl From<ScopeChange> for ScopeChangeOut {
    fn from(c: ScopeChange) -> Self {
        Self {
            version: c.version,
            actor: c.actor.to_string(),
            action: c.action,
            target: c.target,
            content: c.content,
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
    /// On a `PUT`, the `version` of the record this save was based on. If the record has moved on
    /// since, the answer is 409 `stale_version` with the record as it stands, and nothing changes.
    /// Left out, the save is not checked and the last writer wins. Not allowed on a create.
    pub version: Option<u32>,
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
    /// Bumped by every change to the record; send it back as `version` on a `PUT`.
    // ponytail: always sent, but optional in the spec until the web's fixtures carry it.
    #[schema(required = false)]
    pub version: u32,
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
            version: a.version,
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
    /// Due date, `YYYY-MM-DD`.
    pub due_on: Option<String>,
    /// The WorkOS user who works it.
    #[schema(value_type = Option<String>)]
    pub assignee: Option<UserId>,
    /// The stakeholder at the customer it waits on.
    #[schema(value_type = Option<String>)]
    pub waiting_on: Option<StakeholderId>,
    /// The project's access request it is blocked on, only while `blocked`: once the request is
    /// granted, the task goes back to `todo`.
    #[schema(value_type = Option<String>)]
    #[serde(default)]
    pub blocked_by: Option<AccessRequestId>,
    /// On a `PUT`, the `version` of the record this save was based on. If the record has moved on
    /// since, the answer is 409 `stale_version` with the record as it stands, and nothing changes.
    /// Left out, the save is not checked and the last writer wins. Not allowed on a create.
    pub version: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TaskOut {
    pub id: String,
    pub title: String,
    pub status: TaskState,
    pub blocker: Option<String>,
    /// `YYYY-MM-DD`.
    pub due_on: Option<String>,
    pub assignee: Option<String>,
    pub waiting_on: Option<String>,
    /// When it started waiting on the customer; set while the status is `waiting_on_customer`.
    pub waiting_since: Option<String>,
    /// The access request it is blocked on.
    pub blocked_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Bumped by every change to the record; send it back as `version` on a `PUT`.
    // ponytail: always sent, but optional in the spec until the web's fixtures carry it.
    #[schema(required = false)]
    pub version: u32,
}

pub(crate) const DATE: &[time::format_description::FormatItem<'static>] =
    time::macros::format_description!("[year]-[month]-[day]");

impl From<Task> for TaskOut {
    fn from(t: Task) -> Self {
        Self {
            id: t.id.to_string(),
            title: t.title.as_str().to_owned(),
            status: t.status.into(),
            blocker: t.blocker.map(|b| b.as_str().to_owned()),
            due_on: t.due_on.and_then(|d| d.format(DATE).ok()),
            assignee: t.assignee.map(|a| a.to_string()),
            waiting_on: t.waiting_on.map(|w| w.to_string()),
            waiting_since: t.waiting_since.map(ts),
            blocked_by: t.blocked_by.map(|a| a.to_string()),
            created_at: ts(t.created_at),
            updated_at: ts(t.updated_at),
            version: t.version,
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
            due_on: self
                .due_on
                .map(|d| time::Date::parse(&d, DATE).map_err(|_| ApiError::Invalid("due_on")))
                .transpose()?,
            assignee: self.assignee,
            waiting_on: self.waiting_on,
            blocked_by: self.blocked_by,
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
///
/// Moving forward with items of the stage checklist open needs a `reason`; without one the answer
/// is 409 with the open items.
#[utoipa::path(put, operation_id = "change_stage", path = "/v1/companies/{company}/projects/{project}/stage", tag = "lifecycle",
    request_body = StageBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = ProjectOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = StageConflictBody)))]
pub(crate) async fn change_stage(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<StageBody>,
) -> Result<Response, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let reason = body
        .reason
        .map(|r| Reason::new(r).map_err(|_| ApiError::Invalid("reason")))
        .transpose()?;
    let moved = match tx.change_stage(body.stage.into(), reason.as_ref(), &who.actor()).await {
        Err(StoreError::ChecklistOpen(open)) => {
            let open = open.into_iter().map(|check| ChecklistItem { check, met: false }.into());
            let body = StageConflictBody {
                error: ApiError::Rejected("checklist_open").code(),
                open: Some(open.collect()),
            };
            return Ok((StatusCode::CONFLICT, Json(body)).into_response());
        }
        moved => moved?.ok_or(ApiError::NotFound)?,
    };
    tx.commit().await?;
    Ok(Json(ProjectOut::from(moved)).into_response())
}

/// The checklist to leave the project's current stage.
#[utoipa::path(get, operation_id = "get_stage_checklist", path = "/v1/companies/{company}/projects/{project}/stage-checklist",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = StageChecklistOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn stage_checklist(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<StageChecklistOut>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let (stage, items) = tx.stage_checklist().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(StageChecklistOut {
        stage: stage.into(),
        items: items.into_iter().map(Into::into).collect(),
    }))
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
    Ok(Json(crate::reads::scope(&app, &who, c, p).await?))
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
    let v = unversioned(body.version).and_then(|()| body.parse())?;
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
        (status = 404, body = ErrorBody), (status = 409, body = StaleBody<ScopeItemOut>)))]
pub(crate) async fn update_scope_item(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, ScopeItemId)>,
    Json(body): Json<ScopeItemBody>,
) -> Result<Response, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let expected = body.version;
    let v = body.parse()?;
    let updated = tx
        .update_scope_item(&id, expected, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(saved(
        StatusCode::OK,
        updated.map(ScopeItemOut::from, ScopeItemOut::from),
    ))
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
    let v = unversioned(body.version).and_then(|()| body.parse())?;
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
        (status = 404, body = ErrorBody), (status = 409, body = StaleBody<CriterionOut>)))]
pub(crate) async fn update_criterion(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, CriterionId)>,
    Json(body): Json<CriterionBody>,
) -> Result<Response, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let expected = body.version;
    let v = body.parse()?;
    let updated = tx
        .update_criterion(&id, expected, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(saved(
        StatusCode::OK,
        updated.map(CriterionOut::from, CriterionOut::from),
    ))
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

/// Record the customer's sign-off of the scope version they read.
///
/// 409 is `stale_version` (with the scope as it stands) when the scope has moved on from that
/// version, `rejected_empty_scope`, or `conflict` when this version is already signed.
#[utoipa::path(post, operation_id = "sign_off_scope", path = "/v1/companies/{company}/projects/{project}/scope/sign-offs",
    tag = "lifecycle", request_body = SignOffBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = SignOffOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = SaveConflict<ScopeOut>)))]
pub(crate) async fn sign_off(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<SignOffBody>,
) -> Result<Response, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let signed = tx
        .sign_off(&body.stakeholder, body.version, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(saved(StatusCode::CREATED, signed.map(SignOffOut::from, ScopeOut::from)))
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
    let v = unversioned(body.version).and_then(|()| body.parse())?;
    let id = new("acc", AccessRequestId::new)?;
    let added = tx
        .add_access_request(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

/// Replace an access request; a status change is published as `access-request.status-changed`.
#[utoipa::path(put, operation_id = "update_access_request",
    path = "/v1/companies/{company}/projects/{project}/access-requests/{access_request}", tag = "lifecycle",
    request_body = AccessRequestBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("access_request" = String, Path, description = "Access request id")),
    responses((status = 200, body = AccessRequestOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = StaleBody<AccessRequestOut>)))]
pub(crate) async fn update_access_request(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, AccessRequestId)>,
    Json(body): Json<AccessRequestBody>,
) -> Result<Response, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let expected = body.version;
    let v = body.parse()?;
    let updated = tx
        .update_access_request(&id, expected, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(saved(
        StatusCode::OK,
        updated.map(AccessRequestOut::from, AccessRequestOut::from),
    ))
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
    let v = unversioned(body.version).and_then(|()| body.parse())?;
    check_assignee(&app, &who, tx.scope(), &v).await?;
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
        (status = 404, body = ErrorBody), (status = 409, body = SaveConflict<TaskOut>)))]
pub(crate) async fn update_task(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, id)): Path<(CompanyId, ProjectId, TaskId)>,
    Json(body): Json<TaskBody>,
) -> Result<Response, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let expected = body.version;
    let v = body.parse()?;
    check_assignee(&app, &who, tx.scope(), &v).await?;
    let updated = tx
        .update_task(&id, expected, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(saved(StatusCode::OK, updated.map(TaskOut::from, TaskOut::from)))
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

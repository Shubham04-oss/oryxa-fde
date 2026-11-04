//! The agent run API, mounted by `oryxa-fde-api`. Every route is under a project of a company, needs a WorkOS
//! access token, and checks SpiceDB before it touches a run: `work` on the project for runs and approvals, `manage`
//! on the company to set a budget. A project addressed through another company is refused.

use std::sync::Arc;

use axum::extract::{FromRequestParts, Path, State};
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use oryxa_fde_core::{AgentRunId, CompanyId, ProjectId, ProjectScope};
use oryxa_fde_store::new_id;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::{OpenApi, ToSchema};

use crate::access::{Access, AccessError, Caller, Permission};
use crate::context::MAX_TEXT_BYTES;
use crate::event::{ApprovalOutcome, Usage};
use crate::git::{Delivery, Repository};
use crate::ids::ApprovalId;
use crate::run::{AgentRun, RunState};
use crate::service::{Deps, Runs, remaining};
use crate::store::{ApprovalRecord, Budget, DecideResult, Decided, RunRecord, RunStore, Spend, StoreError};

const BASE: &str = "/v1/companies/{company}/projects/{project}";
const MAX_BUDGET_MINUTES: u32 = 1_000_000;
const MAX_BUDGET_USD_MICROS: u64 = 1_000_000_000_000;

pub fn router<D: Deps>(runs: Arc<Runs<D>>) -> Router {
    Router::new()
        .route(&format!("{BASE}/agent-runs"), get(list::<D>).post(create::<D>))
        .route(&format!("{BASE}/agent-runs/{{run}}"), get(get_run::<D>))
        .route(&format!("{BASE}/agent-runs/{{run}}/cancel"), post(cancel::<D>))
        .route(&format!("{BASE}/agent-runs/{{run}}/events"), get(events::<D>))
        .route(&format!("{BASE}/agent-runs/{{run}}/approvals"), get(approvals::<D>))
        .route(
            &format!("{BASE}/agent-runs/{{run}}/approvals/{{approval}}/approve"),
            post(approve::<D>),
        )
        .route(
            &format!("{BASE}/agent-runs/{{run}}/approvals/{{approval}}/reject"),
            post(reject::<D>),
        )
        .route(&format!("{BASE}/agent-budget"), get(budget::<D>).put(set_budget::<D>))
        .with_state(runs)
}

#[derive(Debug, thiserror::Error)]
pub enum RunsError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("no organisation selected")]
    NoOrganisation,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("invalid {0}")]
    Invalid(&'static str),
    #[error("rejected: {0}")]
    Rejected(&'static str),
    #[error("unavailable")]
    Unavailable,
}

/// A short machine-readable code, as `oryxa-fde-api` answers.
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

impl IntoResponse for RunsError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            RunsError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_owned()),
            RunsError::NoOrganisation => (StatusCode::FORBIDDEN, "no_organisation".to_owned()),
            RunsError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_owned()),
            RunsError::NotFound => (StatusCode::NOT_FOUND, "not_found".to_owned()),
            RunsError::Invalid(what) => (StatusCode::BAD_REQUEST, format!("invalid_{what}")),
            RunsError::Rejected(why) => (StatusCode::CONFLICT, format!("rejected_{why}")),
            RunsError::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "unavailable".to_owned()),
        };
        (status, Json(ErrorBody { error: code })).into_response()
    }
}

impl From<AccessError> for RunsError {
    fn from(e: AccessError) -> Self {
        match e {
            AccessError::Unauthorized => RunsError::Unauthorized,
            AccessError::NoOrganisation => RunsError::NoOrganisation,
            AccessError::Unavailable => RunsError::Unavailable,
        }
    }
}

impl From<StoreError> for RunsError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => RunsError::NotFound,
            e => {
                tracing::error!(error = %e, "run store");
                RunsError::Unavailable
            }
        }
    }
}

impl<D: Deps> FromRequestParts<Arc<Runs<D>>> for Caller {
    type Rejection = RunsError;

    async fn from_request_parts(parts: &mut Parts, runs: &Arc<Runs<D>>) -> Result<Self, RunsError> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(RunsError::Unauthorized)?;
        Ok(runs.access.caller(token).await?)
    }
}

/// The project scope from the path, under the caller's tenant, once the caller holds `permission` there.
async fn authorize<D: Deps>(
    runs: &Runs<D>,
    caller: &Caller,
    company: CompanyId,
    project: ProjectId,
    permission: Permission,
) -> Result<ProjectScope, RunsError> {
    let scope = oryxa_fde_core::CompanyScope::new(caller.tenant.clone(), company).project(project);
    if runs.access.allowed(caller, &scope, permission).await? {
        Ok(scope)
    } else {
        Err(RunsError::Forbidden)
    }
}

fn ts(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateRun {
    /// What the agent should do. Up to 64 KiB.
    pub task: String,
    pub repository: Repository,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RunOut {
    pub id: String,
    /// `queued`, `running`, `waiting_for_approval`, `finished` or `failed`.
    pub state: String,
    /// The approval the run waits for, while `waiting_for_approval`.
    pub pending_approval: Option<String>,
    /// Why a `failed` run failed, e.g. `approval_rejected`, `cancelled`, `timed_out`, `over_budget`.
    pub failure: Option<String>,
    pub task: String,
    pub repository: Repository,
    /// WorkOS user id.
    pub created_by: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub usage: UsageOut,
    pub delivery: Delivery,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UsageOut {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl From<Usage> for UsageOut {
    fn from(u: Usage) -> Self {
        Self {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
        }
    }
}

fn snake<T: Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value).ok()?.as_str().map(str::to_owned)
}

impl From<RunRecord> for RunOut {
    fn from(r: RunRecord) -> Self {
        let (state, pending_approval, failure) = match r.run.state() {
            RunState::Queued => ("queued", None, None),
            RunState::Running => ("running", None, None),
            RunState::WaitingForApproval { approval } => ("waiting_for_approval", Some(approval.to_string()), None),
            RunState::Finished => ("finished", None, None),
            RunState::Failed { reason } => ("failed", None, snake(reason)),
        };
        Self {
            id: r.run.id().to_string(),
            state: state.to_owned(),
            pending_approval,
            failure,
            task: r.task,
            repository: r.repository,
            created_by: r.created_by.to_string(),
            created_at: ts(r.created_at),
            started_at: r.started_at.map(ts),
            ended_at: r.ended_at.map(ts),
            usage: r.usage.into(),
            delivery: r.delivery,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DecisionOut {
    /// `approved` or `rejected`.
    pub outcome: String,
    pub by: String,
    pub at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ApprovalOut {
    pub id: String,
    /// The action on the approval list, e.g. `deploy`.
    pub action: String,
    pub title: String,
    /// The tool and its full input, exactly as they run if approved.
    pub tool: String,
    #[schema(value_type = Object)]
    pub input: serde_json::Value,
    pub requested_at: String,
    pub decision: Option<DecisionOut>,
}

impl From<ApprovalRecord> for ApprovalOut {
    fn from(a: ApprovalRecord) -> Self {
        Self {
            id: a.id.to_string(),
            action: a.action,
            title: a.title,
            tool: a.tool,
            input: a.input,
            requested_at: ts(a.requested_at),
            decision: a.decision.map(|d| DecisionOut {
                outcome: snake(&d.outcome).unwrap_or_default(),
                by: d.by.to_string(),
                at: ts(d.at),
            }),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EventsOut {
    /// The run's harness events, in order (see `sandbox/harness/README.md`).
    #[schema(value_type = Vec<Object>)]
    pub events: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BudgetOut {
    pub budget: Budget,
    pub used: Spend,
}

// A task becomes a commit message, a pull request body and the agent's prompt: text only.
fn check_task(task: &str) -> Result<(), RunsError> {
    let ok = !task.trim().is_empty()
        && task.len() <= MAX_TEXT_BYTES
        && !task.chars().any(|c| c.is_control() && c != '\n' && c != '\t');
    if ok { Ok(()) } else { Err(RunsError::Invalid("task")) }
}

/// Queue an agent run on the project. It starts when the company's sandbox is free.
#[utoipa::path(post, operation_id = "create_agent_run", path = "/v1/companies/{company}/projects/{project}/agent-runs",
    tag = "agent-runs", request_body = CreateRun,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 202, body = RunOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "The project's budget is used up")))]
pub async fn create<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<CreateRun>,
) -> Result<(StatusCode, Json<RunOut>), RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Work).await?;
    check_task(&body.task)?;
    let (budget, spent) = runs.budget(&scope).await?;
    if remaining(budget, spent).is_none() {
        return Err(RunsError::Rejected("over_budget"));
    }
    let id = AgentRunId::new(new_id("run")).map_err(|_| RunsError::Unavailable)?;
    let record = RunRecord {
        run: AgentRun::new(id.clone(), scope.clone()),
        task: body.task,
        repository: body.repository,
        created_by: caller.user,
        request_id: new_id("req"),
        created_at: OffsetDateTime::now_utc(),
        started_at: None,
        ended_at: None,
        usage: Usage::default(),
        delivery: Delivery::None,
    };
    runs.store.create(&record).await?;
    runs.launch(scope, id);
    Ok((StatusCode::ACCEPTED, Json(record.into())))
}

/// The project's agent runs, newest first.
#[utoipa::path(get, operation_id = "list_agent_runs", path = "/v1/companies/{company}/projects/{project}/agent-runs",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [RunOut]), (status = 403, body = ErrorBody)))]
pub async fn list<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<RunOut>>, RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Work).await?;
    Ok(Json(
        runs.store.runs(&scope).await?.into_iter().map(Into::into).collect(),
    ))
}

/// One agent run.
#[utoipa::path(get, operation_id = "get_agent_run", path = "/v1/companies/{company}/projects/{project}/agent-runs/{run}",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("run" = String, Path, description = "Agent run id")),
    responses((status = 200, body = RunOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub async fn get_run<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p, run)): Path<(CompanyId, ProjectId, AgentRunId)>,
) -> Result<Json<RunOut>, RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Work).await?;
    let record = runs.store.run(&scope, &run).await?.ok_or(RunsError::NotFound)?;
    Ok(Json(record.into()))
}

/// Cancel an agent run. The run stops as soon as its harness hears it.
#[utoipa::path(post, operation_id = "cancel_agent_run", path = "/v1/companies/{company}/projects/{project}/agent-runs/{run}/cancel",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("run" = String, Path, description = "Agent run id")),
    responses((status = 202, body = RunOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "The run has ended")))]
pub async fn cancel<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p, run)): Path<(CompanyId, ProjectId, AgentRunId)>,
) -> Result<(StatusCode, Json<RunOut>), RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Work).await?;
    let record = runs.store.run(&scope, &run).await?.ok_or(RunsError::NotFound)?;
    if record.run.is_ended() {
        return Err(RunsError::Rejected("ended"));
    }
    if !runs.store.request_cancel(&scope, &run, &caller.user).await? {
        return Err(RunsError::NotFound);
    }
    runs.changed();
    Ok((StatusCode::ACCEPTED, Json(record.into())))
}

/// The run's harness events: plan, messages, tool calls, file changes, commands, approval requests and the result.
#[utoipa::path(get, operation_id = "list_agent_run_events", path = "/v1/companies/{company}/projects/{project}/agent-runs/{run}/events",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("run" = String, Path, description = "Agent run id")),
    responses((status = 200, body = EventsOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub async fn events<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p, run)): Path<(CompanyId, ProjectId, AgentRunId)>,
) -> Result<Json<EventsOut>, RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Work).await?;
    let events = runs.store.events(&scope, &run).await?;
    let events = events
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(|_| RunsError::Unavailable)?;
    Ok(Json(EventsOut { events }))
}

/// The run's approval requests, decided or not.
#[utoipa::path(get, operation_id = "list_agent_run_approvals", path = "/v1/companies/{company}/projects/{project}/agent-runs/{run}/approvals",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("run" = String, Path, description = "Agent run id")),
    responses((status = 200, body = [ApprovalOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub async fn approvals<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p, run)): Path<(CompanyId, ProjectId, AgentRunId)>,
) -> Result<Json<Vec<ApprovalOut>>, RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Work).await?;
    let list = runs.store.approvals(&scope, &run).await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Approve the action the run waits on: it runs exactly as requested, and its hosts open for a while.
#[utoipa::path(post, operation_id = "approve_agent_run_action", path = "/v1/companies/{company}/projects/{project}/agent-runs/{run}/approvals/{approval}/approve",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("run" = String, Path, description = "Agent run id"), ("approval" = String, Path, description = "Approval request id")),
    responses((status = 200, body = ApprovalOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "Not pending, or already decided")))]
pub async fn approve<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p, run, approval)): Path<(CompanyId, ProjectId, AgentRunId, ApprovalId)>,
) -> Result<Json<ApprovalOut>, RunsError> {
    decide(&runs, caller, c, p, run, approval, ApprovalOutcome::Approved).await
}

/// Reject the action the run waits on; the run ends.
#[utoipa::path(post, operation_id = "reject_agent_run_action", path = "/v1/companies/{company}/projects/{project}/agent-runs/{run}/approvals/{approval}/reject",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("run" = String, Path, description = "Agent run id"), ("approval" = String, Path, description = "Approval request id")),
    responses((status = 200, body = ApprovalOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "Not pending, or already decided")))]
pub async fn reject<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p, run, approval)): Path<(CompanyId, ProjectId, AgentRunId, ApprovalId)>,
) -> Result<Json<ApprovalOut>, RunsError> {
    decide(&runs, caller, c, p, run, approval, ApprovalOutcome::Rejected).await
}

async fn decide<D: Deps>(
    runs: &Runs<D>,
    caller: Caller,
    c: CompanyId,
    p: ProjectId,
    run: AgentRunId,
    approval: ApprovalId,
    outcome: ApprovalOutcome,
) -> Result<Json<ApprovalOut>, RunsError> {
    let scope = authorize(runs, &caller, c, p, Permission::Work).await?;
    let record = runs.store.run(&scope, &run).await?.ok_or(RunsError::NotFound)?;
    if record.run.state()
        != (&RunState::WaitingForApproval {
            approval: approval.clone(),
        })
    {
        return Err(RunsError::Rejected("not_pending"));
    }
    let decided = Decided {
        outcome,
        by: caller.user,
        at: OffsetDateTime::now_utc(),
    };
    match runs.store.decide(&scope, &run, &approval, &decided).await? {
        DecideResult::Recorded => {}
        DecideResult::AlreadyDecided => return Err(RunsError::Rejected("already_decided")),
        DecideResult::NotFound => return Err(RunsError::NotFound),
    }
    runs.changed();
    let stored = runs.store.approvals(&scope, &run).await?;
    let out = stored
        .into_iter()
        .find(|a| a.id == approval)
        .ok_or(RunsError::NotFound)?;
    Ok(Json(out.into()))
}

/// The project's agent budget and what its runs have used.
#[utoipa::path(get, operation_id = "get_agent_budget", path = "/v1/companies/{company}/projects/{project}/agent-budget",
    tag = "agent-runs",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = BudgetOut), (status = 403, body = ErrorBody)))]
pub async fn budget<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<BudgetOut>, RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Work).await?;
    let (budget, used) = runs.budget(&scope).await?;
    Ok(Json(BudgetOut { budget, used }))
}

/// Set the project's agent budget. A run stops when it is used up.
#[utoipa::path(put, operation_id = "set_agent_budget", path = "/v1/companies/{company}/projects/{project}/agent-budget",
    tag = "agent-runs", request_body = Budget,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = BudgetOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub async fn set_budget<D: Deps>(
    State(runs): State<Arc<Runs<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<Budget>,
) -> Result<Json<BudgetOut>, RunsError> {
    let scope = authorize(&runs, &caller, c, p, Permission::Manage).await?;
    if body.minutes > MAX_BUDGET_MINUTES || body.spend_usd_micros > MAX_BUDGET_USD_MICROS {
        return Err(RunsError::Invalid("budget"));
    }
    runs.store.set_budget(&scope, body, &caller.user).await?;
    let (budget, used) = runs.budget(&scope).await?;
    Ok(Json(BudgetOut { budget, used }))
}

#[derive(OpenApi)]
#[openapi(
    info(title = "oryxa-fde-api: agent runs", version = "0.1.0",
        description = "Agent runs, their approvals and the project's agent budget. Served by oryxa-fde-api."),
    paths(create, list, get_run, cancel, events, approvals, approve, reject, budget, set_budget),
    modifiers(&Bearer),
    security(("bearer" = [])),
    tags((name = "agent-runs", description = "Coding agent runs in the company's sandbox, approvals and budgets"))
)]
pub struct RunsDoc;

/// The run API's spec, with the status's reason phrase on every response that has no description, as OpenAPI 3.1
/// requires (the same rule as `oryxa_fde_api::openapi`).
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut api = RunsDoc::openapi();
    describe_responses(&mut api);
    api
}

pub(crate) fn describe_responses(api: &mut utoipa::openapi::OpenApi) {
    for item in api.paths.paths.values_mut() {
        let ops = [
            &mut item.get,
            &mut item.put,
            &mut item.post,
            &mut item.delete,
            &mut item.patch,
        ];
        for op in ops.into_iter().flatten() {
            for (code, response) in &mut op.responses.responses {
                if let utoipa::openapi::RefOr::T(r) = response
                    && r.description.is_empty()
                {
                    r.description = code
                        .parse::<u16>()
                        .ok()
                        .and_then(|c| StatusCode::from_u16(c).ok())
                        .and_then(|c| c.canonical_reason())
                        .unwrap_or("Response")
                        .to_owned();
                }
            }
        }
    }
}

struct Bearer;

impl utoipa::Modify for Bearer {
    fn modify(&self, api: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
        let scheme = HttpBuilder::new()
            .scheme(HttpAuthScheme::Bearer)
            .bearer_format("WorkOS access token")
            .build();
        api.components
            .get_or_insert_with(Default::default)
            .add_security_scheme("bearer", SecurityScheme::Http(scheme));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = "openapi.json";

    /// The committed spec must match the code. Regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p oryxa-fde-agent openapi`.
    #[test]
    fn openapi_spec_is_committed_and_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SPEC);
        let spec = openapi().to_pretty_json().unwrap() + "\n";
        if std::env::var_os("UPDATE_OPENAPI").is_some() {
            std::fs::write(&path, &spec).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == spec,
            "{SPEC} is out of date: run `UPDATE_OPENAPI=1 cargo test -p oryxa-fde-agent openapi` and commit it"
        );
    }

    #[test]
    fn tasks_are_text_within_the_pack_limit() {
        assert!(check_task("Add a /healthz endpoint.\n\n\tWith a test.").is_ok());
        for bad in ["", "   ", "a\u{0}b", "a\rb", &"x".repeat(MAX_TEXT_BYTES + 1)] {
            assert!(check_task(bad).is_err(), "{bad:?}");
        }
    }
}

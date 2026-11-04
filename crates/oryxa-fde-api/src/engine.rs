//! What the lifecycle engine leaves on a project: its activity feed, open suggestions, and the
//! drafted weekly updates an FDE edits, approves or discards. Everything here needs `work` on the
//! project. Nothing is sent from here: an approved update is only marked approved.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use oryxa_fde_core::{CompanyId, ProjectId};
use oryxa_fde_events::RunOutcome;
use oryxa_fde_store::{Activity, ActivityIn, Suggestion, SuggestionKind, UpdateBody, UpdateDraft, UpdateStatus};
use serde::{Deserialize, Serialize};
use time::Date;
use utoipa::{IntoParams, ToSchema};

use crate::lifecycle::project_tx;
use crate::{ApiError, App, ErrorBody, Principal, ts};

const DATE: &[time::format_description::FormatItem<'static>] =
    time::macros::format_description!("[year]-[month]-[day]");
const DEFAULT_ACTIVITY: u32 = 50;
const MAX_ACTIVITY: u32 = 200;

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    AgentRunFinished,
    EvalRunFinished,
    PullRequestMerged,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcomeOut {
    Succeeded,
    Failed,
    Rejected,
    Cancelled,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ActivityOut {
    pub kind: ActivityKind,
    /// The run's id, or the pull request's number.
    pub subject: String,
    /// How an agent run ended.
    pub outcome: Option<RunOutcomeOut>,
    /// An eval run's cases passed and failed.
    pub passed: Option<u32>,
    pub failed: Option<u32>,
    pub occurred_at: String,
}

impl From<Activity> for ActivityOut {
    fn from(a: Activity) -> Self {
        let occurred_at = ts(a.occurred_at);
        match a.what {
            ActivityIn::AgentRun { run, outcome } => Self {
                kind: ActivityKind::AgentRunFinished,
                subject: run.to_string(),
                outcome: Some(match outcome {
                    RunOutcome::Succeeded => RunOutcomeOut::Succeeded,
                    RunOutcome::Failed => RunOutcomeOut::Failed,
                    RunOutcome::Rejected => RunOutcomeOut::Rejected,
                    RunOutcome::Cancelled => RunOutcomeOut::Cancelled,
                }),
                passed: None,
                failed: None,
                occurred_at,
            },
            ActivityIn::EvalRun { run, passed, failed } => Self {
                kind: ActivityKind::EvalRunFinished,
                subject: run.to_string(),
                outcome: None,
                passed: Some(passed),
                failed: Some(failed),
                occurred_at,
            },
            ActivityIn::PullRequest { number } => Self {
                kind: ActivityKind::PullRequestMerged,
                subject: number.to_string(),
                outcome: None,
                passed: None,
                failed: None,
                occurred_at,
            },
        }
    }
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ActivityParams {
    /// At most this many entries, newest first (1 to 200, default 50).
    pub limit: Option<u32>,
}

/// The project's activity: finished agent runs and eval runs and merged pull requests, newest
/// first.
#[utoipa::path(get, operation_id = "list_activity", path = "/v1/companies/{company}/projects/{project}/activity",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ActivityParams),
    responses((status = 200, body = [ActivityOut]), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn activity(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Query(params): Query<ActivityParams>,
) -> Result<Json<Vec<ActivityOut>>, ApiError> {
    let limit = params.limit.unwrap_or(DEFAULT_ACTIVITY);
    if !(1..=MAX_ACTIVITY).contains(&limit) {
        return Err(ApiError::Invalid("limit"));
    }
    let mut tx = project_tx(&app, &who, c, p).await?;
    let list = tx.activity(limit).await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionKindOut {
    /// Every success criterion meets its target: the project may move to deploy.
    ReadyToDeploy,
}

impl From<SuggestionKindOut> for SuggestionKind {
    fn from(k: SuggestionKindOut) -> Self {
        match k {
            SuggestionKindOut::ReadyToDeploy => SuggestionKind::ReadyToDeploy,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SuggestionOut {
    pub kind: SuggestionKindOut,
    /// The eval run that showed it.
    pub eval_run: String,
    pub raised_at: String,
}

impl From<Suggestion> for SuggestionOut {
    fn from(s: Suggestion) -> Self {
        Self {
            kind: match s.kind {
                SuggestionKind::ReadyToDeploy => SuggestionKindOut::ReadyToDeploy,
            },
            eval_run: s.eval_run.to_string(),
            raised_at: ts(s.raised_at),
        }
    }
}

/// The engine's open suggestions for the project. It never acts on one: moving the stage is the
/// FDE's.
#[utoipa::path(get, operation_id = "list_suggestions", path = "/v1/companies/{company}/projects/{project}/suggestions",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [SuggestionOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn suggestions(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<SuggestionOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let list = tx.suggestions().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Dismiss an open suggestion; the engine raises it again only from a later eval run.
#[utoipa::path(post, operation_id = "dismiss_suggestion",
    path = "/v1/companies/{company}/projects/{project}/suggestions/{kind}/dismiss", tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("kind" = SuggestionKindOut, Path, description = "Which suggestion")),
    responses((status = 204, description = "Dismissed"), (status = 400, body = ErrorBody),
        (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn dismiss_suggestion(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, kind)): Path<(CompanyId, ProjectId, String)>,
) -> Result<axum::http::StatusCode, ApiError> {
    let kind: SuggestionKindOut =
        serde_json::from_value(serde_json::Value::String(kind)).map_err(|_| ApiError::Invalid("kind"))?;
    let mut tx = project_tx(&app, &who, c, p).await?;
    let dismissed = tx.dismiss_suggestion(kind.into(), &who.actor()).await?;
    tx.commit().await?;
    if dismissed {
        Ok(axum::http::StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    Draft,
    Approved,
    Discarded,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UpdateOut {
    /// The Monday of the ISO week it covers, `YYYY-MM-DD`.
    pub week: String,
    pub body: String,
    pub status: UpdateState,
    /// The model that drafted it.
    pub model: String,
    pub drafted_at: String,
    pub edited_by: Option<String>,
    pub edited_at: Option<String>,
    /// Who approved or discarded it.
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
}

impl From<UpdateDraft> for UpdateOut {
    fn from(d: UpdateDraft) -> Self {
        Self {
            week: d.week.format(DATE).unwrap_or_default(),
            body: d.body.as_str().to_owned(),
            status: match d.status {
                UpdateStatus::Draft => UpdateState::Draft,
                UpdateStatus::Approved => UpdateState::Approved,
                UpdateStatus::Discarded => UpdateState::Discarded,
            },
            model: d.model,
            drafted_at: ts(d.drafted_at),
            edited_by: d.edited_by.map(|u| u.to_string()),
            edited_at: d.edited_at.map(ts),
            decided_by: d.decided_by.map(|u| u.to_string()),
            decided_at: d.decided_at.map(ts),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateBodyIn {
    /// The update's text: 1 to 20,000 characters.
    pub body: String,
}

/// A week from the path: a Monday, `YYYY-MM-DD`.
fn week(raw: &str) -> Result<Date, ApiError> {
    Date::parse(raw, DATE)
        .ok()
        .filter(|d| d.weekday() == time::Weekday::Monday)
        .ok_or(ApiError::Invalid("week"))
}

/// The project's weekly updates, newest week first.
#[utoipa::path(get, operation_id = "list_updates", path = "/v1/companies/{company}/projects/{project}/updates",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [UpdateOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn updates(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<UpdateOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let list = tx.update_drafts().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// One week's update.
#[utoipa::path(get, operation_id = "get_update", path = "/v1/companies/{company}/projects/{project}/updates/{week}",
    tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("week" = String, Path, description = "The week's Monday, YYYY-MM-DD")),
    responses((status = 200, body = UpdateOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, w)): Path<(CompanyId, ProjectId, String)>,
) -> Result<Json<UpdateOut>, ApiError> {
    let monday = week(&w)?;
    let mut tx = project_tx(&app, &who, c, p).await?;
    let draft = tx.update_draft(monday).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(draft.into()))
}

/// Edit a drafted update's text; only while it is a draft.
#[utoipa::path(patch, operation_id = "edit_update", path = "/v1/companies/{company}/projects/{project}/updates/{week}",
    tag = "lifecycle", request_body = UpdateBodyIn,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("week" = String, Path, description = "The week's Monday, YYYY-MM-DD")),
    responses((status = 200, body = UpdateOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub(crate) async fn edit_update(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, w)): Path<(CompanyId, ProjectId, String)>,
    Json(body): Json<UpdateBodyIn>,
) -> Result<Json<UpdateOut>, ApiError> {
    let monday = week(&w)?;
    let body = UpdateBody::new(body.body).map_err(|_| ApiError::Invalid("body"))?;
    let mut tx = project_tx(&app, &who, c, p).await?;
    let edited = tx
        .edit_update_draft(monday, &body, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(edited.into()))
}

/// Approve a drafted update. Final; it is only marked approved, and nothing is sent from here.
#[utoipa::path(post, operation_id = "approve_update",
    path = "/v1/companies/{company}/projects/{project}/updates/{week}/approve", tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("week" = String, Path, description = "The week's Monday, YYYY-MM-DD")),
    responses((status = 200, body = UpdateOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub(crate) async fn approve_update(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, w)): Path<(CompanyId, ProjectId, String)>,
) -> Result<Json<UpdateOut>, ApiError> {
    decide(&app, &who, c, p, &w, true).await
}

/// Discard a drafted update. Final.
#[utoipa::path(post, operation_id = "discard_update",
    path = "/v1/companies/{company}/projects/{project}/updates/{week}/discard", tag = "lifecycle",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("week" = String, Path, description = "The week's Monday, YYYY-MM-DD")),
    responses((status = 200, body = UpdateOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub(crate) async fn discard_update(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, w)): Path<(CompanyId, ProjectId, String)>,
) -> Result<Json<UpdateOut>, ApiError> {
    decide(&app, &who, c, p, &w, false).await
}

async fn decide(
    app: &App,
    who: &Principal,
    c: CompanyId,
    p: ProjectId,
    w: &str,
    approve: bool,
) -> Result<Json<UpdateOut>, ApiError> {
    let monday = week(w)?;
    let mut tx = project_tx(app, who, c, p).await?;
    let decided = tx
        .decide_update_draft(monday, approve, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(decided.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_week_in_a_path_is_a_monday() {
        assert_eq!(week("2026-11-02").unwrap().to_string(), "2026-11-02");
        for bad in ["2026-11-03", "2026-13-02", "02-11-2026", "", "2026-11-02T00:00:00Z"] {
            assert!(week(bad).is_err(), "{bad}");
        }
    }
}

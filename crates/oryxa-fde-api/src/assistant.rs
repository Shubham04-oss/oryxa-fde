//! Assistant conversations (#237, ADR 0008 and 0009): the record in AWS behind the assistant Worker's
//! working copy. A conversation is bound when it is made to one person and one scope (a company,
//! maybe one project in it, or the person's home) and that never changes. Only the person who holds
//! it reads it, appends to it or deletes it, and for a company's conversation only while they may
//! still `work` on that company. fde-web's server asks `.../check` before every turn and reconnect.
//!
//! Appending finished turns comes in the next change (#237's second part); a conversation reads back
//! with none until then. Turn content is never logged.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use oryxa_fde_core::{CompanyId, ProjectId};
use oryxa_fde_store::{Conversation, ConversationId, ConversationScope, Turn, TurnState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use crate::authz::{company, project, workspace};
use crate::records::new;
use crate::{ApiError, App, ErrorBody, Principal, ts};

const DEFAULT_LIST: u32 = 20;
const MAX_LIST: u32 = 50;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConversationBody {
    /// The company it is bound to; left out, the person's home conversation.
    #[schema(value_type = Option<String>)]
    pub company: Option<CompanyId>,
    /// A project of that company, to bind it more narrowly.
    #[schema(value_type = Option<String>)]
    pub project: Option<ProjectId>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ConversationOut {
    pub id: String,
    /// The company it is bound to, for good; null for a home conversation.
    pub company: Option<String>,
    pub project: Option<String>,
    pub created_at: String,
    pub last_active_at: String,
}

impl From<Conversation> for ConversationOut {
    fn from(c: Conversation) -> Self {
        Self {
            id: c.id.to_string(),
            company: c.scope.company().map(|s| s.company.to_string()),
            project: c.scope.project().map(|p| p.to_string()),
            created_at: ts(c.created_at),
            last_active_at: ts(c.last_active_at),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    /// Left: neither confirmed nor dismissed.
    Waiting,
    Confirmed,
    Dismissed,
}

/// A proposal as the Worker checked it, and what the person did with it.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProposalEntry {
    #[schema(value_type = Object)]
    pub proposal: Value,
    pub state: ProposalState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinishedState {
    Done,
    Failed,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TurnOut {
    /// Its place, from 1.
    pub n: u32,
    pub id: String,
    pub said: String,
    pub text: String,
    #[schema(value_type = Vec<Object>)]
    pub blocks: Value,
    #[schema(value_type = Vec<ProposalEntry>)]
    pub proposals: Value,
    pub notice: Option<String>,
    pub state: FinishedState,
    pub created_at: String,
}

impl From<Turn> for TurnOut {
    fn from(t: Turn) -> Self {
        Self {
            n: t.n,
            id: t.id.as_str().to_owned(),
            said: t.said.as_str().to_owned(),
            text: t.reply,
            blocks: t.blocks,
            proposals: t.proposals,
            notice: t.notice,
            state: match t.state {
                TurnState::Done => FinishedState::Done,
                TurnState::Failed => FinishedState::Failed,
            },
            created_at: ts(t.created_at),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ConversationDetailOut {
    pub conversation: ConversationOut,
    /// Its finished turns, in order.
    pub turns: Vec<TurnOut>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListParams {
    /// At most this many, 1 to 50; 20 if left out.
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CheckParams {
    /// The company the caller believes it is bound to; left out for a home conversation.
    #[param(value_type = Option<String>)]
    pub company: Option<CompanyId>,
}

/// The scope of `who`'s conversation `id`, while they may still use it; 404 for any other's.
async fn scope_of(app: &App, who: &Principal, id: &ConversationId) -> Result<ConversationScope, ApiError> {
    let scope = app
        .store
        .conversation_scope(&who.tenant, &who.user, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    require(app, who, &scope).await?;
    Ok(scope)
}

/// What using a conversation in `scope` needs: `access` to the workspace for home, so never a
/// customer role (ADR 0005, 0008, as `/v1/home`); `work` on its company, or its project.
async fn require(app: &App, who: &Principal, scope: &ConversationScope) -> Result<(), ApiError> {
    match scope {
        ConversationScope::Home(t) => app.require(who, workspace(t), "access").await,
        ConversationScope::Company(c) => app.require(who, company(c), "work").await,
        ConversationScope::Project(p) => app.require(who, project(p), "work").await,
    }
}

fn conversation_id(raw: String) -> Result<ConversationId, ApiError> {
    ConversationId::new(raw).map_err(|_| ApiError::NotFound)
}

/// Start a conversation, bound for good to the caller and to a company (or a project in it), or to
/// the caller's home. A company needs `work` on it; home needs `access` to the workspace, which a
/// customer role does not have.
#[utoipa::path(post, operation_id = "create_conversation", path = "/v1/assistant/conversations", tag = "assistant",
    request_body = ConversationBody,
    responses((status = 201, body = ConversationOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub(crate) async fn create(
    State(app): State<Arc<App>>,
    who: Principal,
    Json(body): Json<ConversationBody>,
) -> Result<(StatusCode, Json<ConversationOut>), ApiError> {
    let scope = match (body.company, body.project) {
        (None, None) => ConversationScope::Home(who.tenant.clone()),
        (Some(c), None) => ConversationScope::Company(who.company(c)),
        (Some(c), Some(p)) => ConversationScope::Project(who.company(c).project(p)),
        (None, Some(_)) => return Err(ApiError::Invalid("project")),
    };
    require(&app, &who, &scope).await?;
    let id = new("cnv", ConversationId::new)?;
    let mut tx = app.store.assistant(&scope).await?;
    let made = tx.create(&id, &who.user).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(made.into())))
}

/// The caller's conversations, most recently active first: their home ones and those of companies
/// they may still work on. Ids and times only.
#[utoipa::path(get, operation_id = "list_conversations", path = "/v1/assistant/conversations", tag = "assistant",
    params(ListParams),
    responses((status = 200, body = Vec<ConversationOut>), (status = 400, body = ErrorBody)))]
pub(crate) async fn list(
    State(app): State<Arc<App>>,
    who: Principal,
    Query(p): Query<ListParams>,
) -> Result<Json<Vec<ConversationOut>>, ApiError> {
    app.require(&who, workspace(&who.tenant), "access").await?;
    let limit = p.limit.unwrap_or(DEFAULT_LIST);
    if !(1..=MAX_LIST).contains(&limit) {
        return Err(ApiError::Invalid("limit"));
    }
    let companies = app.companies_for(&who).await?;
    let list = app
        .store
        .conversations(&who.tenant, &who.user, &companies, limit)
        .await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// One of the caller's conversations with its turns. Anyone else's is not found.
#[utoipa::path(get, operation_id = "get_conversation", path = "/v1/assistant/conversations/{conversation}",
    tag = "assistant", params(("conversation" = String, Path, description = "Conversation id")),
    responses((status = 200, body = ConversationDetailOut), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn get(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(raw): Path<String>,
) -> Result<Json<ConversationDetailOut>, ApiError> {
    let id = conversation_id(raw)?;
    let scope = scope_of(&app, &who, &id).await?;
    let mut tx = app.store.assistant(&scope).await?;
    let (conversation, turns) = tx.get(&id, &who.user).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(ConversationDetailOut {
        conversation: conversation.into(),
        turns: turns.into_iter().map(Into::into).collect(),
    }))
}

/// Whether the caller holds this conversation, bound to this company (or to home when `company` is
/// left out), and may still use it. fde-web's server asks before every turn and reconnect; anything
/// but 204 refuses.
#[utoipa::path(get, operation_id = "check_conversation", path = "/v1/assistant/conversations/{conversation}/check",
    tag = "assistant", params(("conversation" = String, Path, description = "Conversation id"), CheckParams),
    responses((status = 204, description = "The caller's, bound as asked, and still theirs to use"),
        (status = 404, body = ErrorBody, description = "Any refusal: not the caller's, bound elsewhere, or no longer \
            theirs to use"), (status = 503, body = ErrorBody)))]
pub(crate) async fn check(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(raw): Path<String>,
    Query(p): Query<CheckParams>,
) -> Result<StatusCode, ApiError> {
    let id = conversation_id(raw)?;
    // One answer for every refusal but an outage: the route says no more than it must.
    let scope = scope_of(&app, &who, &id).await.map_err(|e| match e {
        ApiError::Forbidden => ApiError::NotFound,
        e => e,
    })?;
    let bound = scope.company().map(|c| &c.company);
    if bound != p.company.as_ref() {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Delete one of the caller's conversations and its turns. Only its holder, who may delete it even
/// after losing access to its company. An audit row names it; no content is kept.
#[utoipa::path(delete, operation_id = "delete_conversation", path = "/v1/assistant/conversations/{conversation}",
    tag = "assistant", params(("conversation" = String, Path, description = "Conversation id")),
    responses((status = 204, description = "Deleted"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn delete(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(raw): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = conversation_id(raw)?;
    // The holder match alone: no permission is needed to delete one's own.
    let scope = app
        .store
        .conversation_scope(&who.tenant, &who.user, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let mut tx = app.store.assistant(&scope).await?;
    if !tx.delete(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

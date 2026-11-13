//! Assistant conversations (#237, ADR 0008 and 0009): the record in AWS behind the assistant Worker's
//! working copy. A conversation is bound when it is made to one person and one scope (a company,
//! maybe one project in it, or the person's home) and that never changes. Only the person who holds
//! it reads it, appends to it or deletes it, and for a company's conversation only while they may
//! still `work` on that company. fde-web's server asks `.../check` before every turn and reconnect.
//!
//! A finished turn is checked against the Worker's wire format (`assistant/src/catalogue/wire.ts`):
//! its text rules and sizes, the block types and proposal actions of the catalogue, and every record a
//! block or proposal names. In a company's conversation those must be that company's; in a home
//! conversation only a company the person may see (to open its conversation), or a new company. A
//! proposal's answer (confirmed or dismissed) is recorded once the person gives it. Turn content is
//! never logged.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use oryxa_fde_core::{CompanyId, ProjectId};
use oryxa_fde_store::{
    Appended, AssistantTx, Conversation, ConversationId, ConversationScope, MAX_BLOCKS, MAX_PROPOSALS, MAX_TURNS,
    ProposalAnswer, Said, Settled, StoreError, Turn, TurnIn, TurnKey, TurnState, reply_fits,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

use crate::authz::{company, project, workspace};
use crate::records::new;
use crate::{ApiError, App, ErrorBody, Principal, ts};

/// The catalogue's block types (`assistant/src/catalogue/blocks.ts`).
const BLOCK_TYPES: [&str; 6] = ["suggestion", "brief", "plan", "rules", "people", "checklist"];
/// The blocks a home conversation may hold: list-level only (ADR 0008).
const HOME_BLOCK_TYPES: [&str; 1] = ["suggestion"];
/// The catalogue's proposal actions (`wire.ts`).
const PROPOSAL_ACTIONS: [&str; 2] = ["create_company", "open_route"];
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnNotice {
    ToolLimit,
    ReplyLimit,
    TimedOut,
    Failed,
}

impl TurnNotice {
    fn as_str(self) -> &'static str {
        match self {
            TurnNotice::ToolLimit => "tool_limit",
            TurnNotice::ReplyLimit => "reply_limit",
            TurnNotice::TimedOut => "timed_out",
            TurnNotice::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinishedState {
    Done,
    Failed,
}

/// A finished turn, as the Worker folded it.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TurnBody {
    /// The Worker's turn id, `t_` and 1 to 64 of `A-Za-z0-9_-`.
    pub id: String,
    /// What the person said: up to 2000 characters.
    pub said: String,
    /// The assistant's text: up to 8000 characters.
    #[serde(default)]
    pub text: String,
    /// Up to 6 blocks of the catalogue.
    #[serde(default)]
    #[schema(value_type = Vec<Object>)]
    pub blocks: Vec<Value>,
    /// Up to 3 proposals, each with its state.
    #[serde(default)]
    pub proposals: Vec<ProposalEntry>,
    pub notice: Option<TurnNotice>,
    pub state: FinishedState,
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
    responses((status = 200, body = Vec<ConversationOut>), (status = 400, body = ErrorBody),
        (status = 403, body = ErrorBody, description = "A customer role: no access to the workspace"),
        (status = 503, body = ErrorBody)))]
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
    responses((status = 204, description = "Deleted"), (status = 404, body = ErrorBody), (status = 503, body = ErrorBody)))]
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

/// Store a finished turn at place `n` (from 1): the next one, or the same turn again, which changes
/// nothing (200). Only the conversation's holder; blocks and proposals as the scope allows.
#[utoipa::path(put, operation_id = "put_turn", path = "/v1/assistant/conversations/{conversation}/turns/{n}",
    tag = "assistant", request_body = TurnBody,
    params(("conversation" = String, Path, description = "Conversation id"), ("n" = u32, Path, description = "Turn number, from 1")),
    responses((status = 201, body = TurnOut, description = "Stored"),
        (status = 200, body = TurnOut, description = "Stored before with the same contents"),
        (status = 400, body = ErrorBody, description = "`invalid_*` naming what broke a limit or names a record \
            outside the scope (`invalid_destination`), or a block or proposal the scope does not allow"),
        (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "`rejected_turn_taken`: another turn is at `n`, or `n` is \
            not next; `rejected_turn_limit`: the conversation holds 50 turns")))]
pub(crate) async fn put_turn(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((raw, n)): Path<(String, u32)>,
    Json(body): Json<TurnBody>,
) -> Result<Response, ApiError> {
    let id = conversation_id(raw)?;
    let scope = scope_of(&app, &who, &id).await?;
    if !(1..=MAX_TURNS).contains(&n) {
        return Err(ApiError::Invalid("n"));
    }
    let mut tx = app.store.assistant(&scope).await?;
    let v = turn_in(&app, &who, &scope, &mut tx, n, body).await?;
    let appended = tx
        .append(&id, &who.user, &v)
        .await
        .map_err(refused)?
        .ok_or(ApiError::NotFound)?;
    let resp = match appended {
        Appended::Stored(t) => (StatusCode::CREATED, Json(TurnOut::from(t))).into_response(),
        Appended::Already(t) => (StatusCode::OK, Json(TurnOut::from(t))).into_response(),
        Appended::Conflict => return Err(ApiError::Rejected("turn_taken")),
        Appended::Full => return Err(ApiError::Rejected("turn_limit")),
    };
    tx.commit().await?;
    Ok(resp)
}

/// The turn, checked: its sizes and parts ([`shape`]), and every record they name against the scope.
async fn turn_in(
    app: &App,
    who: &Principal,
    scope: &ConversationScope,
    tx: &mut AssistantTx,
    n: u32,
    body: TurnBody,
) -> Result<TurnIn, ApiError> {
    let v = shape(scope.company().is_none(), n, body)?;
    let mut destinations = Vec::new();
    destinations_in(&v.blocks, &mut destinations);
    destinations_in(&v.proposals, &mut destinations);
    check_destinations(app, who, scope, tx, &destinations).await?;
    Ok(v)
}

/// The turn's own limits, the Worker's: its id, sizes, block types (list-level only at home) and
/// proposal actions.
fn shape(home: bool, n: u32, body: TurnBody) -> Result<TurnIn, ApiError> {
    let id = TurnKey::new(&body.id).ok_or(ApiError::Invalid("turn"))?;
    let said = Said::new(&body.said).ok_or(ApiError::Invalid("said"))?;
    if !reply_fits(&body.text) {
        return Err(ApiError::Invalid("text"));
    }
    if body.blocks.len() > MAX_BLOCKS {
        return Err(ApiError::Invalid("blocks"));
    }
    if body.proposals.len() > MAX_PROPOSALS {
        return Err(ApiError::Invalid("proposals"));
    }
    let allowed: &[&str] = if home { &HOME_BLOCK_TYPES } else { &BLOCK_TYPES };
    for block in &body.blocks {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or_default();
        if !allowed.contains(&kind) {
            return Err(ApiError::Invalid("block"));
        }
    }
    // Each proposal is one of the catalogue's actions, with its own id (the wire's `PartId`), so the
    // person's answer can name it.
    let mut ids = HashSet::new();
    for entry in &body.proposals {
        let action = entry.proposal.get("action").and_then(Value::as_str).unwrap_or_default();
        let id = entry.proposal.get("id").and_then(Value::as_str).filter(|i| part_id(i));
        match id {
            Some(id) if PROPOSAL_ACTIONS.contains(&action) && ids.insert(id) => {}
            _ => return Err(ApiError::Invalid("proposal")),
        }
    }
    // The byte caps are the table's, measured in its form by the store.
    let blocks = Value::Array(body.blocks);
    let proposals = serde_json::to_value(&body.proposals).map_err(|_| ApiError::Internal)?;
    Ok(TurnIn {
        n,
        id,
        said,
        reply: body.text,
        blocks,
        proposals,
        notice: body.notice.map(|n| n.as_str().to_owned()),
        state: match body.state {
            FinishedState::Done => TurnState::Done,
            FinishedState::Failed => TurnState::Failed,
        },
    })
}

/// The wire's `PartId`: 1 to 64 of `A-Za-z0-9_-`.
fn part_id(v: &str) -> bool {
    (1..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A refusal from the store's own checks (sizes measured in the table's form, the text rules) as the
/// `400` it is.
fn refused(e: StoreError) -> ApiError {
    match e {
        StoreError::Rejected(what) => ApiError::Invalid(what),
        e => e.into(),
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AnswerBody {
    pub state: AnswerState,
}

/// What the person did with a proposal.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnswerState {
    Confirmed,
    Dismissed,
}

/// Record the person's answer to a proposal of a stored turn: `confirmed` or `dismissed`. A waiting
/// proposal takes it; the same answer again changes nothing; an answered one is not changed. Only
/// the conversation's holder.
#[utoipa::path(put, operation_id = "answer_proposal",
    path = "/v1/assistant/conversations/{conversation}/turns/{n}/proposals/{proposal}", tag = "assistant",
    request_body = AnswerBody,
    params(("conversation" = String, Path, description = "Conversation id"), ("n" = u32, Path, description = "Turn number"),
        ("proposal" = String, Path, description = "The proposal's id in its turn")),
    responses((status = 200, body = TurnOut, description = "The turn, with the answer recorded"),
        (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "`rejected_answered`: it was answered the other way"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn answer(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((raw, n, proposal)): Path<(String, u32, String)>,
    Json(body): Json<AnswerBody>,
) -> Result<Json<TurnOut>, ApiError> {
    let id = conversation_id(raw)?;
    if !part_id(&proposal) {
        return Err(ApiError::NotFound);
    }
    let scope = scope_of(&app, &who, &id).await?;
    let state = match body.state {
        AnswerState::Confirmed => ProposalAnswer::Confirmed,
        AnswerState::Dismissed => ProposalAnswer::Dismissed,
    };
    let mut tx = app.store.assistant(&scope).await?;
    let turn = match tx
        .settle(&id, &who.user, n, &proposal, state)
        .await?
        .ok_or(ApiError::NotFound)?
    {
        Settled::Set(t) | Settled::Already(t) => t,
        Settled::Answered => return Err(ApiError::Rejected("answered")),
    };
    tx.commit().await?;
    Ok(Json(turn.into()))
}

/// Every place a turn's parts send a person: each object with a `screen`, wherever it sits.
fn destinations_in<'a>(v: &'a Value, out: &mut Vec<&'a serde_json::Map<String, Value>>) {
    match v {
        Value::Object(o) => {
            if o.contains_key("screen") {
                out.push(o);
            }
            for child in o.values() {
                destinations_in(child, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|child| destinations_in(child, out)),
        _ => {}
    }
}

/// Each destination names only what the scope allows: in a company's conversation, that company and
/// its projects; at home, a company the caller may work on (to open its conversation) and the lists.
async fn check_destinations(
    app: &App,
    who: &Principal,
    scope: &ConversationScope,
    tx: &mut AssistantTx,
    destinations: &[&serde_json::Map<String, Value>],
) -> Result<(), ApiError> {
    let refuse = || ApiError::Invalid("destination");
    let mut visible: Option<HashSet<String>> = None;
    for d in destinations {
        let field = |k: &str| d.get(k).and_then(Value::as_str);
        match field("screen") {
            Some("today" | "companies" | "new-company") => {}
            Some("company") => {
                let named = field("company")
                    .and_then(|c| CompanyId::new(c).ok())
                    .ok_or_else(refuse)?;
                match scope.company() {
                    Some(c) if c.company == named => {}
                    Some(_) => return Err(refuse()),
                    None => {
                        if visible.is_none() {
                            let list = app.companies_for(who).await?;
                            visible = Some(list.into_iter().map(|c| c.company.to_string()).collect());
                        }
                        if !visible.as_ref().is_some_and(|v| v.contains(named.as_str())) {
                            return Err(refuse());
                        }
                    }
                }
            }
            Some("project") => {
                let c = scope.company().ok_or_else(refuse)?;
                let named = field("company")
                    .and_then(|c| CompanyId::new(c).ok())
                    .ok_or_else(refuse)?;
                let project = field("project")
                    .and_then(|p| ProjectId::new(p).ok())
                    .ok_or_else(refuse)?;
                if c.company != named || !tx.has_project(&project).await? {
                    return Err(refuse());
                }
            }
            _ => return Err(refuse()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn body(v: Value) -> TurnBody {
        let mut base = json!({ "id": "t_1", "said": "Plan the pilot", "text": "Here is a plan.", "state": "done" });
        base.as_object_mut().unwrap().extend(v.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn code(r: Result<TurnIn, ApiError>) -> String {
        r.map(|_| "ok".to_owned()).unwrap_or_else(|e| e.code())
    }

    fn suggestion(to: Value) -> Value {
        json!({ "type": "suggestion", "id": "s1", "title": "Open Acme", "approve": { "label": "Open", "to": to } })
    }

    #[test]
    fn a_turn_keeps_to_the_workers_limits() {
        let ok = shape(false, 1, body(json!({
            "blocks": [{ "type": "plan", "steps": [] }, suggestion(json!({ "screen": "today" }))],
            "proposals": [{ "proposal": { "id": "p1", "action": "open_route", "args": { "to": { "screen": "today" } } },
                           "state": "confirmed" }],
            "notice": "tool_limit",
        })))
        .unwrap();
        assert_eq!(
            (ok.n, ok.id.as_str(), ok.notice.as_deref()),
            (1, "t_1", Some("tool_limit"))
        );
        assert_eq!(ok.proposals[0]["state"], "confirmed");

        let many_blocks = Value::Array(vec![json!({ "type": "brief", "items": [] }); MAX_BLOCKS + 1]);
        let many_proposals = Value::Array(vec![
            json!({ "proposal": { "action": "create_company", "args": { "name": "x" } }, "state": "waiting" });
            MAX_PROPOSALS + 1
        ]);
        for (patch, want) in [
            (json!({ "id": "turn-1" }), "invalid_turn"),
            (json!({ "said": "" }), "invalid_said"),
            (json!({ "said": "x".repeat(2001) }), "invalid_said"),
            (json!({ "text": "x".repeat(8001) }), "invalid_text"),
            (json!({ "text": "a\u{1b}b" }), "invalid_text"),
            (json!({ "blocks": many_blocks }), "invalid_blocks"),
            (json!({ "proposals": many_proposals }), "invalid_proposals"),
            // A reply counts UTF-16 units, as the web's view does: 4001 emoji are 8002.
            (json!({ "text": "😀".repeat(4001) }), "invalid_text"),
            (
                json!({ "proposals": [{ "proposal": { "action": "open_route" }, "state": "waiting" }] }),
                "invalid_proposal",
            ),
            (
                json!({ "proposals": [
                    { "proposal": { "id": "p1", "action": "open_route" }, "state": "waiting" },
                    { "proposal": { "id": "p1", "action": "create_company" }, "state": "waiting" }] }),
                "invalid_proposal",
            ),
            (
                json!({ "blocks": [{ "type": "html", "body": "<b>x</b>" }] }),
                "invalid_block",
            ),
            (
                json!({ "proposals": [{ "proposal": { "id": "p1", "action": "delete_company" }, "state": "waiting" }] }),
                "invalid_proposal",
            ),
        ] {
            assert_eq!(code(shape(false, 1, body(patch.clone()))), want, "{patch}");
        }
        // Pasted text keeps its carriage returns, as on the wire.
        assert_eq!(
            code(shape(false, 1, body(json!({ "said": "one\r\ntwo", "text": "a\r\nb" })))),
            "ok"
        );
        // Unknown fields and states are refused before any of that.
        assert!(serde_json::from_value::<TurnBody>(json!({ "id": "t_1", "said": "x", "state": "live" })).is_err());
        assert!(
            serde_json::from_value::<TurnBody>(json!({ "id": "t_1", "said": "x", "state": "done", "session": "s" }))
                .is_err()
        );
    }

    #[test]
    fn a_home_conversation_holds_list_level_blocks_only() {
        assert_eq!(
            code(shape(
                true,
                1,
                body(json!({ "blocks": [suggestion(json!({ "screen": "companies" }))] }))
            )),
            "ok"
        );
        for kind in ["brief", "plan", "rules", "people", "checklist"] {
            let b = body(json!({ "blocks": [{ "type": kind }] }));
            assert_eq!(code(shape(true, 1, b)), "invalid_block", "{kind}");
        }
    }

    #[test]
    fn every_destination_is_found_wherever_it_sits() {
        let v = json!([
            suggestion(json!({ "screen": "company", "company": "cmp_1" })),
            { "proposal": { "action": "open_route", "args": { "to": { "screen": "project", "company": "cmp_2", "project": "prj_9" } } } },
            { "type": "plan", "steps": [{ "id": "s1", "title": "x" }] },
        ]);
        let mut found = Vec::new();
        destinations_in(&v, &mut found);
        let screens: Vec<&str> = found
            .iter()
            .filter_map(|d| d.get("screen").and_then(Value::as_str))
            .collect();
        assert_eq!(screens, ["company", "project"]);
    }
}

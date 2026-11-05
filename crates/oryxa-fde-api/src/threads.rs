//! Comment threads on a record or a canvas shape, for a company and for each project (see `plan`).
//! A thread's subject must be at its place: a company's thread is about the company's records, a
//! project's about the project's and the company's people and systems. A project's thread can be
//! promoted to its decisions log, once.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use oryxa_fde_core::{CompanyId, DecisionId, ProjectId};
use oryxa_fde_store::{Comment, CommentId, PromoteIn, Subject, Thread, ThreadId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use utoipa::{IntoParams, ToSchema};

use crate::lifecycle::{DecisionOut, project_tx};
use crate::plan::Place;
use crate::records::{name, new, text};
use crate::{ApiError, App, ErrorBody, Principal, ts};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    Stakeholder,
    System,
    Document,
    Task,
    Decision,
    AccessRequest,
    ScopeItem,
    Criterion,
    MeetingNote,
    Shape,
}

impl SubjectKind {
    fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Stakeholder => "stakeholder",
            SubjectKind::System => "system",
            SubjectKind::Document => "document",
            SubjectKind::Task => "task",
            SubjectKind::Decision => "decision",
            SubjectKind::AccessRequest => "access_request",
            SubjectKind::ScopeItem => "scope_item",
            SubjectKind::Criterion => "criterion",
            SubjectKind::MeetingNote => "meeting_note",
            SubjectKind::Shape => "shape",
        }
    }
}

/// A record or a canvas shape, by kind and id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SubjectRef {
    pub kind: SubjectKind,
    pub id: String,
}

impl SubjectRef {
    fn parse(self) -> Result<Subject, ApiError> {
        Subject::parse(self.kind.as_str(), self.id).ok_or(ApiError::Invalid("subject"))
    }
}

impl From<&Subject> for SubjectRef {
    fn from(s: &Subject) -> Self {
        let kind = match s {
            Subject::Stakeholder(_) => SubjectKind::Stakeholder,
            Subject::System(_) => SubjectKind::System,
            Subject::Document(_) => SubjectKind::Document,
            Subject::Task(_) => SubjectKind::Task,
            Subject::Decision(_) => SubjectKind::Decision,
            Subject::AccessRequest(_) => SubjectKind::AccessRequest,
            Subject::ScopeItem(_) => SubjectKind::ScopeItem,
            Subject::Criterion(_) => SubjectKind::Criterion,
            Subject::MeetingNote(_) => SubjectKind::MeetingNote,
            Subject::Shape(_) => SubjectKind::Shape,
        };
        Self {
            kind,
            id: s.id().to_owned(),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ThreadBody {
    pub subject: SubjectRef,
    /// The opening comment.
    pub body: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CommentBody {
    pub body: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PromoteBody {
    /// What was decided.
    pub title: String,
    /// Why; defaults to the thread's opening comment.
    pub rationale: Option<String>,
    /// Who decided, often someone at the customer.
    pub decided_by: String,
    /// When, RFC 3339; defaults to now.
    pub decided_at: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ThreadFilter {
    /// Only threads about this kind of subject; needs `subject_id` too.
    pub subject_kind: Option<SubjectKind>,
    pub subject_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ThreadOut {
    pub id: String,
    pub subject: SubjectRef,
    /// The decision it was promoted to.
    pub decision: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub comments: u32,
    pub last_comment_at: String,
}

impl From<Thread> for ThreadOut {
    fn from(t: Thread) -> Self {
        Self {
            id: t.id.to_string(),
            subject: (&t.subject).into(),
            decision: t.decision.map(|d| d.to_string()),
            created_by: t.created_by.to_string(),
            created_at: ts(t.created_at),
            comments: t.comments,
            last_comment_at: ts(t.last_comment_at),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CommentOut {
    pub id: String,
    pub body: String,
    pub author: String,
    pub created_at: String,
}

impl From<Comment> for CommentOut {
    fn from(c: Comment) -> Self {
        Self {
            id: c.id.to_string(),
            body: c.body.as_str().to_owned(),
            author: c.author.to_string(),
            created_at: ts(c.created_at),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ThreadWithComments {
    pub thread: ThreadOut,
    /// Oldest first.
    pub comments: Vec<CommentOut>,
}

fn thread_id(raw: String) -> Result<ThreadId, ApiError> {
    ThreadId::new(raw).map_err(|_| ApiError::Invalid("thread"))
}

impl ThreadFilter {
    fn parse(self) -> Result<Option<Subject>, ApiError> {
        match (self.subject_kind, self.subject_id) {
            (None, None) => Ok(None),
            (Some(kind), Some(id)) => SubjectRef { kind, id }.parse().map(Some),
            _ => Err(ApiError::Invalid("subject")),
        }
    }
}

impl PromoteBody {
    fn parse(self) -> Result<PromoteIn, ApiError> {
        let decided_at = match self.decided_at {
            Some(at) => OffsetDateTime::parse(&at, &Rfc3339).map_err(|_| ApiError::Invalid("decided_at"))?,
            None => OffsetDateTime::now_utc(),
        };
        Ok(PromoteIn {
            title: name(self.title, "title")?,
            rationale: self.rationale.map(|r| text(r, "rationale")).transpose()?,
            decided_by: name(self.decided_by, "decided_by")?,
            decided_at,
        })
    }
}

async fn list(app: &App, who: &Principal, at: Place, filter: ThreadFilter) -> Result<Vec<ThreadOut>, ApiError> {
    let subject = filter.parse()?;
    let mut tx = at.enter(app, who).await?;
    let list = tx.threads(subject.as_ref()).await?;
    tx.commit().await?;
    Ok(list.into_iter().map(Into::into).collect())
}

async fn start(app: &App, who: &Principal, at: Place, body: ThreadBody) -> Result<ThreadOut, ApiError> {
    let subject = body.subject.parse()?;
    let first = text(body.body, "body")?;
    let mut tx = at.enter(app, who).await?;
    let id = new("thr", ThreadId::new)?;
    let comment = new("cmt", CommentId::new)?;
    let started = tx
        .start_thread(&id, &subject, (&comment, &first), &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(started.into())
}

async fn get(app: &App, who: &Principal, at: Place, raw: String) -> Result<ThreadWithComments, ApiError> {
    let id = thread_id(raw)?;
    let mut tx = at.enter(app, who).await?;
    let thread = tx.thread(&id).await?.ok_or(ApiError::NotFound)?;
    let comments = tx.comments(&id).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(ThreadWithComments {
        thread: thread.into(),
        comments: comments.into_iter().map(Into::into).collect(),
    })
}

async fn comment(
    app: &App,
    who: &Principal,
    at: Place,
    raw: String,
    body: CommentBody,
) -> Result<CommentOut, ApiError> {
    let thread = thread_id(raw)?;
    let body = text(body.body, "body")?;
    let mut tx = at.enter(app, who).await?;
    let id = new("cmt", CommentId::new)?;
    let added = tx
        .comment(&thread, &id, &body, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(added.into())
}

/// The company's threads, most recently active first.
#[utoipa::path(get, operation_id = "list_company_threads", path = "/v1/companies/{company}/threads", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ThreadFilter),
    responses((status = 200, body = [ThreadOut]), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub(crate) async fn company_threads(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Query(filter): Query<ThreadFilter>,
) -> Result<Json<Vec<ThreadOut>>, ApiError> {
    Ok(Json(list(&app, &who, Place::company(&who, c), filter).await?))
}

/// Start a thread about one of the company's records (a stakeholder, system, document or meeting
/// note) or a shape on its canvas.
#[utoipa::path(post, operation_id = "start_company_thread", path = "/v1/companies/{company}/threads", tag = "planning",
    request_body = ThreadBody, params(("company" = String, Path, description = "Company id")),
    responses((status = 201, body = ThreadOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn start_company_thread(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Json(body): Json<ThreadBody>,
) -> Result<(StatusCode, Json<ThreadOut>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(start(&app, &who, Place::company(&who, c), body).await?),
    ))
}

/// One of the company's threads with its comments.
#[utoipa::path(get, operation_id = "get_company_thread", path = "/v1/companies/{company}/threads/{thread}",
    tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("thread" = String, Path, description = "Thread id")),
    responses((status = 200, body = ThreadWithComments), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn company_thread(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, t)): Path<(CompanyId, String)>,
) -> Result<Json<ThreadWithComments>, ApiError> {
    Ok(Json(get(&app, &who, Place::company(&who, c), t).await?))
}

/// Comment on one of the company's threads.
#[utoipa::path(post, operation_id = "comment_company_thread",
    path = "/v1/companies/{company}/threads/{thread}/comments", tag = "planning", request_body = CommentBody,
    params(("company" = String, Path, description = "Company id"), ("thread" = String, Path, description = "Thread id")),
    responses((status = 201, body = CommentOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn comment_company_thread(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, t)): Path<(CompanyId, String)>,
    Json(body): Json<CommentBody>,
) -> Result<(StatusCode, Json<CommentOut>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(comment(&app, &who, Place::company(&who, c), t, body).await?),
    ))
}

/// The project's threads, most recently active first.
#[utoipa::path(get, operation_id = "list_project_threads", path = "/v1/companies/{company}/projects/{project}/threads",
    tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ThreadFilter),
    responses((status = 200, body = [ThreadOut]), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn project_threads(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Query(filter): Query<ThreadFilter>,
) -> Result<Json<Vec<ThreadOut>>, ApiError> {
    Ok(Json(list(&app, &who, Place::project(&who, c, p), filter).await?))
}

/// Start a thread about one of the project's records, the company's stakeholders or systems, or a
/// shape on the project's canvas.
#[utoipa::path(post, operation_id = "start_project_thread", path = "/v1/companies/{company}/projects/{project}/threads",
    tag = "planning", request_body = ThreadBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = ThreadOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn start_project_thread(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<ThreadBody>,
) -> Result<(StatusCode, Json<ThreadOut>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(start(&app, &who, Place::project(&who, c, p), body).await?),
    ))
}

/// One of the project's threads with its comments.
#[utoipa::path(get, operation_id = "get_project_thread",
    path = "/v1/companies/{company}/projects/{project}/threads/{thread}", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("thread" = String, Path, description = "Thread id")),
    responses((status = 200, body = ThreadWithComments), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_thread(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, t)): Path<(CompanyId, ProjectId, String)>,
) -> Result<Json<ThreadWithComments>, ApiError> {
    Ok(Json(get(&app, &who, Place::project(&who, c, p), t).await?))
}

/// Comment on one of the project's threads.
#[utoipa::path(post, operation_id = "comment_project_thread",
    path = "/v1/companies/{company}/projects/{project}/threads/{thread}/comments", tag = "planning",
    request_body = CommentBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("thread" = String, Path, description = "Thread id")),
    responses((status = 201, body = CommentOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn comment_project_thread(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, t)): Path<(CompanyId, ProjectId, String)>,
    Json(body): Json<CommentBody>,
) -> Result<(StatusCode, Json<CommentOut>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(comment(&app, &who, Place::project(&who, c, p), t, body).await?),
    ))
}

/// Promote a project's thread to its decisions log. A thread is promoted once.
#[utoipa::path(post, operation_id = "promote_project_thread",
    path = "/v1/companies/{company}/projects/{project}/threads/{thread}/promote", tag = "planning",
    request_body = PromoteBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("thread" = String, Path, description = "Thread id")),
    responses((status = 201, body = DecisionOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, description = "Already promoted", body = ErrorBody)))]
pub(crate) async fn promote_project_thread(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, t)): Path<(CompanyId, ProjectId, String)>,
    Json(body): Json<PromoteBody>,
) -> Result<(StatusCode, Json<DecisionOut>), ApiError> {
    let thread = thread_id(t)?;
    let v = body.parse()?;
    let mut tx = project_tx(&app, &who, c, p).await?;
    let id = new("dec", DecisionId::new)?;
    let recorded = tx
        .promote_thread(&thread, &id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(recorded.into())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_subject_kind_round_trips_to_the_store() {
        let all = [
            SubjectKind::Stakeholder,
            SubjectKind::System,
            SubjectKind::Document,
            SubjectKind::Task,
            SubjectKind::Decision,
            SubjectKind::AccessRequest,
            SubjectKind::ScopeItem,
            SubjectKind::Criterion,
            SubjectKind::MeetingNote,
            SubjectKind::Shape,
        ];
        for kind in all {
            let subject = SubjectRef { kind, id: "x_1".into() }.parse().unwrap();
            assert_eq!(SubjectRef::from(&subject), SubjectRef { kind, id: "x_1".into() });
            let wire = serde_json::to_value(kind).unwrap();
            assert_eq!(wire, serde_json::json!(kind.as_str()));
        }
        assert!(matches!(
            SubjectRef {
                kind: SubjectKind::Task,
                id: "a/b".into()
            }
            .parse(),
            Err(ApiError::Invalid("subject"))
        ));
    }

    #[test]
    fn a_filter_names_a_whole_subject_or_none() {
        let f = |kind, id: Option<&str>| ThreadFilter {
            subject_kind: kind,
            subject_id: id.map(str::to_owned),
        };
        assert!(f(None, None).parse().unwrap().is_none());
        assert!(f(Some(SubjectKind::Shape), Some("s1")).parse().unwrap().is_some());
        for half in [f(Some(SubjectKind::Shape), None), f(None, Some("s1"))] {
            assert!(matches!(half.parse(), Err(ApiError::Invalid("subject"))));
        }
    }
}

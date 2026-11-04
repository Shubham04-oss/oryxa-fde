//! Meeting notes for a company and for each project (see `plan`), with the people involved: the
//! company's stakeholders, and the workspace's users who work on the place.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_core::UserId;
use oryxa_fde_core::{CompanyId, ProjectId, StakeholderId};
use oryxa_fde_store::{MeetingNote, MeetingNoteId, MeetingNoteIn, NoteText};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::lifecycle::DATE;
use crate::plan::Place;
use crate::records::{name, new};
use crate::{ApiError, App, ErrorBody, Principal, ts};

/// Most stakeholders, and most attendees, on one note.
const MAX_PEOPLE: usize = 50;

#[derive(Debug, Deserialize, ToSchema)]
pub struct MeetingNoteBody {
    pub title: String,
    /// The day of the meeting, `YYYY-MM-DD`.
    pub held_on: String,
    /// The notes, up to 20000 characters.
    pub body: String,
    /// The company's stakeholders who took part.
    #[serde(default)]
    pub stakeholders: Vec<String>,
    /// The workspace's users who took part; each must work on the company or project.
    #[serde(default)]
    pub attendees: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MeetingNoteOut {
    pub id: String,
    pub title: String,
    pub held_on: String,
    pub body: String,
    pub stakeholders: Vec<String>,
    pub attendees: Vec<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<MeetingNote> for MeetingNoteOut {
    fn from(n: MeetingNote) -> Self {
        Self {
            id: n.id.to_string(),
            title: n.title.as_str().to_owned(),
            held_on: n.held_on.format(DATE).unwrap_or_default(),
            body: n.body.as_str().to_owned(),
            stakeholders: n.stakeholders.iter().map(ToString::to_string).collect(),
            attendees: n.attendees.iter().map(ToString::to_string).collect(),
            created_by: n.created_by.to_string(),
            created_at: ts(n.created_at),
            updated_at: ts(n.updated_at),
        }
    }
}

impl MeetingNoteBody {
    fn parse(self) -> Result<MeetingNoteIn, ApiError> {
        if self.stakeholders.len() > MAX_PEOPLE {
            return Err(ApiError::Invalid("stakeholders"));
        }
        if self.attendees.len() > MAX_PEOPLE {
            return Err(ApiError::Invalid("attendees"));
        }
        Ok(MeetingNoteIn {
            title: name(self.title, "title")?,
            held_on: time::Date::parse(&self.held_on, DATE).map_err(|_| ApiError::Invalid("held_on"))?,
            body: NoteText::new(self.body).map_err(|_| ApiError::Invalid("body"))?,
            stakeholders: self
                .stakeholders
                .into_iter()
                .map(|s| StakeholderId::new(s).map_err(|_| ApiError::Invalid("stakeholders")))
                .collect::<Result<_, _>>()?,
            attendees: self
                .attendees
                .into_iter()
                .map(|u| UserId::new(u).map_err(|_| ApiError::Invalid("attendees")))
                .collect::<Result<_, _>>()?,
        })
    }
}

fn note_id(raw: String) -> Result<MeetingNoteId, ApiError> {
    MeetingNoteId::new(raw).map_err(|_| ApiError::Invalid("note"))
}

/// Each attendee must work on the place, as a task's assignee must work on its project.
async fn check_attendees(app: &App, who: &Principal, at: &Place, v: &MeetingNoteIn) -> Result<(), ApiError> {
    for a in &v.attendees {
        if !app.works_at(who, a, at.resource()).await? {
            return Err(ApiError::Invalid("attendees"));
        }
    }
    Ok(())
}

async fn list(app: &App, who: &Principal, at: Place) -> Result<Vec<MeetingNoteOut>, ApiError> {
    let mut tx = at.enter(app, who).await?;
    let list = tx.meeting_notes().await?;
    tx.commit().await?;
    Ok(list.into_iter().map(Into::into).collect())
}

async fn add(app: &App, who: &Principal, at: Place, body: MeetingNoteBody) -> Result<MeetingNoteOut, ApiError> {
    let v = body.parse()?;
    let mut tx = at.enter(app, who).await?;
    check_attendees(app, who, &at, &v).await?;
    let id = new("mtg", MeetingNoteId::new)?;
    let added = tx
        .add_meeting_note(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(added.into())
}

async fn get(app: &App, who: &Principal, at: Place, raw: String) -> Result<MeetingNoteOut, ApiError> {
    let id = note_id(raw)?;
    let mut tx = at.enter(app, who).await?;
    let found = tx.meeting_note(&id).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(found.into())
}

async fn update(
    app: &App,
    who: &Principal,
    at: Place,
    raw: String,
    body: MeetingNoteBody,
) -> Result<MeetingNoteOut, ApiError> {
    let id = note_id(raw)?;
    let v = body.parse()?;
    let mut tx = at.enter(app, who).await?;
    check_attendees(app, who, &at, &v).await?;
    let updated = tx
        .update_meeting_note(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(updated.into())
}

async fn remove(app: &App, who: &Principal, at: Place, raw: String) -> Result<StatusCode, ApiError> {
    let id = note_id(raw)?;
    let mut tx = at.enter(app, who).await?;
    if !tx.remove_meeting_note(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The company's meeting notes, latest meeting first.
#[utoipa::path(get, operation_id = "list_company_meeting_notes", path = "/v1/companies/{company}/meeting-notes",
    tag = "planning", params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [MeetingNoteOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn company_notes(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Vec<MeetingNoteOut>>, ApiError> {
    Ok(Json(list(&app, &who, Place::company(&who, c)).await?))
}

/// Add a meeting note to the company.
#[utoipa::path(post, operation_id = "add_company_meeting_note", path = "/v1/companies/{company}/meeting-notes",
    tag = "planning", request_body = MeetingNoteBody, params(("company" = String, Path, description = "Company id")),
    responses((status = 201, body = MeetingNoteOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn add_company_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Json(body): Json<MeetingNoteBody>,
) -> Result<(StatusCode, Json<MeetingNoteOut>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(add(&app, &who, Place::company(&who, c), body).await?),
    ))
}

/// One of the company's meeting notes.
#[utoipa::path(get, operation_id = "get_company_meeting_note", path = "/v1/companies/{company}/meeting-notes/{note}",
    tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("note" = String, Path, description = "Meeting note id")),
    responses((status = 200, body = MeetingNoteOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn company_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, n)): Path<(CompanyId, String)>,
) -> Result<Json<MeetingNoteOut>, ApiError> {
    Ok(Json(get(&app, &who, Place::company(&who, c), n).await?))
}

/// Replace one of the company's meeting notes.
#[utoipa::path(put, operation_id = "update_company_meeting_note",
    path = "/v1/companies/{company}/meeting-notes/{note}", tag = "planning", request_body = MeetingNoteBody,
    params(("company" = String, Path, description = "Company id"), ("note" = String, Path, description = "Meeting note id")),
    responses((status = 200, body = MeetingNoteOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_company_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, n)): Path<(CompanyId, String)>,
    Json(body): Json<MeetingNoteBody>,
) -> Result<Json<MeetingNoteOut>, ApiError> {
    Ok(Json(update(&app, &who, Place::company(&who, c), n, body).await?))
}

/// Remove one of the company's meeting notes.
#[utoipa::path(delete, operation_id = "remove_company_meeting_note",
    path = "/v1/companies/{company}/meeting-notes/{note}", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("note" = String, Path, description = "Meeting note id")),
    responses((status = 204), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_company_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, n)): Path<(CompanyId, String)>,
) -> Result<StatusCode, ApiError> {
    remove(&app, &who, Place::company(&who, c), n).await
}

/// The project's meeting notes, latest meeting first.
#[utoipa::path(get, operation_id = "list_project_meeting_notes",
    path = "/v1/companies/{company}/projects/{project}/meeting-notes", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [MeetingNoteOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_notes(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<MeetingNoteOut>>, ApiError> {
    Ok(Json(list(&app, &who, Place::project(&who, c, p)).await?))
}

/// Add a meeting note to the project.
#[utoipa::path(post, operation_id = "add_project_meeting_note",
    path = "/v1/companies/{company}/projects/{project}/meeting-notes", tag = "planning", request_body = MeetingNoteBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = MeetingNoteOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn add_project_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<MeetingNoteBody>,
) -> Result<(StatusCode, Json<MeetingNoteOut>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(add(&app, &who, Place::project(&who, c, p), body).await?),
    ))
}

/// One of the project's meeting notes.
#[utoipa::path(get, operation_id = "get_project_meeting_note",
    path = "/v1/companies/{company}/projects/{project}/meeting-notes/{note}", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("note" = String, Path, description = "Meeting note id")),
    responses((status = 200, body = MeetingNoteOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, n)): Path<(CompanyId, ProjectId, String)>,
) -> Result<Json<MeetingNoteOut>, ApiError> {
    Ok(Json(get(&app, &who, Place::project(&who, c, p), n).await?))
}

/// Replace one of the project's meeting notes.
#[utoipa::path(put, operation_id = "update_project_meeting_note",
    path = "/v1/companies/{company}/projects/{project}/meeting-notes/{note}", tag = "planning",
    request_body = MeetingNoteBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("note" = String, Path, description = "Meeting note id")),
    responses((status = 200, body = MeetingNoteOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_project_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, n)): Path<(CompanyId, ProjectId, String)>,
    Json(body): Json<MeetingNoteBody>,
) -> Result<Json<MeetingNoteOut>, ApiError> {
    Ok(Json(update(&app, &who, Place::project(&who, c, p), n, body).await?))
}

/// Remove one of the project's meeting notes.
#[utoipa::path(delete, operation_id = "remove_project_meeting_note",
    path = "/v1/companies/{company}/projects/{project}/meeting-notes/{note}", tag = "planning",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("note" = String, Path, description = "Meeting note id")),
    responses((status = 204), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_project_note(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, n)): Path<(CompanyId, ProjectId, String)>,
) -> Result<StatusCode, ApiError> {
    remove(&app, &who, Place::project(&who, c, p), n).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> MeetingNoteBody {
        MeetingNoteBody {
            title: "Workshop".into(),
            held_on: "2026-11-02".into(),
            body: "Notes".into(),
            stakeholders: vec!["stk_1".into()],
            attendees: vec!["user_1".into()],
        }
    }

    #[test]
    fn a_note_body_is_validated_field_by_field() {
        let v = body().parse().unwrap();
        assert_eq!(v.held_on, time::macros::date!(2026 - 11 - 02));
        type Break = fn(&mut MeetingNoteBody);
        let cases: [(Break, &str); 5] = [
            (|b| b.held_on = "02/11/2026".into(), "held_on"),
            (|b| b.body = " ".into(), "body"),
            (|b| b.stakeholders = vec!["a/b".into()], "stakeholders"),
            (|b| b.attendees = vec!["user_1".into(); MAX_PEOPLE + 1], "attendees"),
            (|b| b.title = String::new(), "title"),
        ];
        for (break_it, field) in cases {
            let mut b = body();
            break_it(&mut b);
            match b.parse() {
                Err(ApiError::Invalid(f)) => assert_eq!(f, field),
                other => panic!("{field}: {other:?}"),
            }
        }
    }
}

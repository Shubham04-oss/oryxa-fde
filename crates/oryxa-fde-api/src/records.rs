//! Company records (stakeholders and systems; `work` on the company to read or change them, or
//! `work` on one of its projects to read them) and the organisation's security answer library
//! (`access` to the workspace).

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_fde_core::{CompanyId, ProjectId, SecurityAnswerId, StakeholderId, SystemId};
use oryxa_fde_store::{
    CompanyTx, Name, OrgTx, SecurityAnswer, SecurityAnswerIn, Stakeholder, StakeholderIn, System, SystemIn, Text,
    new_id,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::authz::{company, workspace};
use crate::lifecycle::project_tx;
use crate::{ApiError, App, ErrorBody, Principal, ts};

pub(crate) fn name(raw: String, what: &'static str) -> Result<Name, ApiError> {
    Name::new(raw).map_err(|_| ApiError::Invalid(what))
}

pub(crate) fn text(raw: String, what: &'static str) -> Result<Text, ApiError> {
    Text::new(raw).map_err(|_| ApiError::Invalid(what))
}

pub(crate) fn new<T, E>(prefix: &str, make: impl FnOnce(String) -> Result<T, E>) -> Result<T, ApiError> {
    make(new_id(prefix)).map_err(|_| ApiError::Internal)
}

async fn company_tx(app: &App, who: &Principal, c: CompanyId) -> Result<CompanyTx, ApiError> {
    let s = who.company(c);
    app.require(who, company(&s), "work").await?;
    Ok(app.store.company(&s).await?)
}

async fn org_tx(app: &App, who: &Principal) -> Result<OrgTx, ApiError> {
    app.require(who, workspace(&who.tenant), "access").await?;
    Ok(app.store.organisation(&who.tenant).await?)
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct StakeholderBody {
    pub name: String,
    /// Their role at the customer, e.g. "VP Engineering".
    pub title: Option<String>,
}

impl StakeholderBody {
    fn parse(self) -> Result<StakeholderIn, ApiError> {
        Ok(StakeholderIn {
            name: name(self.name, "name")?,
            title: self.title.map(|t| name(t, "title")).transpose()?,
        })
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct StakeholderOut {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub updated_at: String,
}

impl From<Stakeholder> for StakeholderOut {
    fn from(s: Stakeholder) -> Self {
        Self {
            id: s.id.to_string(),
            name: s.name.as_str().to_owned(),
            title: s.title.map(|t| t.as_str().to_owned()),
            updated_at: ts(s.updated_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SystemBody {
    pub name: String,
    pub description: Option<String>,
}

impl SystemBody {
    fn parse(self) -> Result<SystemIn, ApiError> {
        Ok(SystemIn {
            name: name(self.name, "name")?,
            description: self.description.map(|d| text(d, "description")).transpose()?,
        })
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SystemOut {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub updated_at: String,
}

impl From<System> for SystemOut {
    fn from(s: System) -> Self {
        Self {
            id: s.id.to_string(),
            name: s.name.as_str().to_owned(),
            description: s.description.map(|d| d.as_str().to_owned()),
            updated_at: ts(s.updated_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SecurityAnswerBody {
    pub question: String,
    pub answer: String,
}

impl SecurityAnswerBody {
    fn parse(self) -> Result<SecurityAnswerIn, ApiError> {
        Ok(SecurityAnswerIn {
            question: text(self.question, "question")?,
            answer: text(self.answer, "answer")?,
        })
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SecurityAnswerOut {
    pub id: String,
    pub question: String,
    pub answer: String,
    pub updated_at: String,
}

impl From<SecurityAnswer> for SecurityAnswerOut {
    fn from(a: SecurityAnswer) -> Self {
        Self {
            id: a.id.to_string(),
            question: a.question.as_str().to_owned(),
            answer: a.answer.as_str().to_owned(),
            updated_at: ts(a.updated_at),
        }
    }
}

/// The company's stakeholders: people at the customer.
#[utoipa::path(get, operation_id = "list_stakeholders", path = "/v1/companies/{company}/stakeholders", tag = "records",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [StakeholderOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn stakeholders(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Vec<StakeholderOut>>, ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    let list = tx.stakeholders().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[utoipa::path(post, operation_id = "add_stakeholder", path = "/v1/companies/{company}/stakeholders", tag = "records",
    request_body = StakeholderBody, params(("company" = String, Path, description = "Company id")),
    responses((status = 201, body = StakeholderOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn add_stakeholder(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Json(body): Json<StakeholderBody>,
) -> Result<(StatusCode, Json<StakeholderOut>), ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    let v = body.parse()?;
    let id = new("stk", StakeholderId::new)?;
    let added = tx
        .add_stakeholder(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

#[utoipa::path(put, operation_id = "update_stakeholder", path = "/v1/companies/{company}/stakeholders/{stakeholder}",
    tag = "records", request_body = StakeholderBody,
    params(("company" = String, Path, description = "Company id"), ("stakeholder" = String, Path, description = "Stakeholder id")),
    responses((status = 200, body = StakeholderOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_stakeholder(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, id)): Path<(CompanyId, StakeholderId)>,
    Json(body): Json<StakeholderBody>,
) -> Result<Json<StakeholderOut>, ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    let v = body.parse()?;
    let updated = tx
        .update_stakeholder(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

/// Remove a stakeholder. Refused (409) once they have signed off a scope.
#[utoipa::path(delete, operation_id = "remove_stakeholder", path = "/v1/companies/{company}/stakeholders/{stakeholder}",
    tag = "records",
    params(("company" = String, Path, description = "Company id"), ("stakeholder" = String, Path, description = "Stakeholder id")),
    responses((status = 204, description = "Removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody)))]
pub(crate) async fn remove_stakeholder(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, id)): Path<(CompanyId, StakeholderId)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    if !tx.remove_stakeholder(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The company's systems: what the work touches at the customer.
#[utoipa::path(get, operation_id = "list_systems", path = "/v1/companies/{company}/systems", tag = "records",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [SystemOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn systems(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Vec<SystemOut>>, ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    let list = tx.systems().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[utoipa::path(post, operation_id = "add_system", path = "/v1/companies/{company}/systems", tag = "records",
    request_body = SystemBody, params(("company" = String, Path, description = "Company id")),
    responses((status = 201, body = SystemOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn add_system(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Json(body): Json<SystemBody>,
) -> Result<(StatusCode, Json<SystemOut>), ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    let v = body.parse()?;
    let id = new("sys", SystemId::new)?;
    let added = tx.add_system(&id, &v, &who.actor()).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

#[utoipa::path(put, operation_id = "update_system", path = "/v1/companies/{company}/systems/{system}", tag = "records",
    request_body = SystemBody,
    params(("company" = String, Path, description = "Company id"), ("system" = String, Path, description = "System id")),
    responses((status = 200, body = SystemOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_system(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, id)): Path<(CompanyId, SystemId)>,
    Json(body): Json<SystemBody>,
) -> Result<Json<SystemOut>, ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    let v = body.parse()?;
    let updated = tx
        .update_system(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

#[utoipa::path(delete, operation_id = "remove_system", path = "/v1/companies/{company}/systems/{system}", tag = "records",
    params(("company" = String, Path, description = "Company id"), ("system" = String, Path, description = "System id")),
    responses((status = 204, description = "Removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_system(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, id)): Path<(CompanyId, SystemId)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = company_tx(&app, &who, c).await?;
    if !tx.remove_system(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The company's stakeholders, for anyone who works on this project: assignees sign off with them
/// and name them as owners of access requests.
#[utoipa::path(get, operation_id = "list_project_stakeholders", path = "/v1/companies/{company}/projects/{project}/stakeholders",
    tag = "records",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [StakeholderOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_stakeholders(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<StakeholderOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let list = tx.company_stakeholders().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// The company's systems, for anyone who works on this project.
#[utoipa::path(get, operation_id = "list_project_systems", path = "/v1/companies/{company}/projects/{project}/systems",
    tag = "records",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [SystemOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn project_systems(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<SystemOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let list = tx.company_systems().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// The organisation's reusable answers to security questionnaires.
#[utoipa::path(get, operation_id = "list_security_answers", path = "/v1/security-answers", tag = "records",
    responses((status = 200, body = [SecurityAnswerOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn security_answers(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<Json<Vec<SecurityAnswerOut>>, ApiError> {
    let mut tx = org_tx(&app, &who).await?;
    let list = tx.security_answers().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[utoipa::path(post, operation_id = "add_security_answer", path = "/v1/security-answers", tag = "records",
    request_body = SecurityAnswerBody,
    responses((status = 201, body = SecurityAnswerOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub(crate) async fn add_security_answer(
    State(app): State<Arc<App>>,
    who: Principal,
    Json(body): Json<SecurityAnswerBody>,
) -> Result<(StatusCode, Json<SecurityAnswerOut>), ApiError> {
    let mut tx = org_tx(&app, &who).await?;
    let v = body.parse()?;
    let id = new("ans", SecurityAnswerId::new)?;
    let added = tx.add_security_answer(&id, &v, &who.actor()).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(added.into())))
}

#[utoipa::path(put, operation_id = "update_security_answer", path = "/v1/security-answers/{answer}", tag = "records",
    request_body = SecurityAnswerBody, params(("answer" = String, Path, description = "Security answer id")),
    responses((status = 200, body = SecurityAnswerOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update_security_answer(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(id): Path<SecurityAnswerId>,
    Json(body): Json<SecurityAnswerBody>,
) -> Result<Json<SecurityAnswerOut>, ApiError> {
    let mut tx = org_tx(&app, &who).await?;
    let v = body.parse()?;
    let updated = tx
        .update_security_answer(&id, &v, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

#[utoipa::path(delete, operation_id = "remove_security_answer", path = "/v1/security-answers/{answer}", tag = "records",
    params(("answer" = String, Path, description = "Security answer id")),
    responses((status = 204, description = "Removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_security_answer(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(id): Path<SecurityAnswerId>,
) -> Result<StatusCode, ApiError> {
    let mut tx = org_tx(&app, &who).await?;
    if !tx.remove_security_answer(&id, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

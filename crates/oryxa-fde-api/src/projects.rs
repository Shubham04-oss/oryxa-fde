//! Projects and their assignees. Reading or renaming a project needs `work` on it; creating one
//! or changing who is assigned needs `manage` on its company. A project is always addressed
//! through its company, and the store refuses a project that is not in that company.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_authz::{SubjectRef, Write};
use oryxa_core::UserId;
use oryxa_fde_core::{CompanyId, ProjectId, ProjectScope, Stage};
use oryxa_fde_store::{Assignee, Project, new_id};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::authz::{company, project, rel, user};
use crate::companies::NameIn;
use crate::{ApiError, App, ErrorBody, Principal, ts};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStage {
    Discover,
    Scope,
    Access,
    Build,
    Evaluate,
    Deploy,
    Handoff,
    Operate,
}

impl From<Stage> for ProjectStage {
    fn from(s: Stage) -> Self {
        match s {
            Stage::Discover => ProjectStage::Discover,
            Stage::Scope => ProjectStage::Scope,
            Stage::Access => ProjectStage::Access,
            Stage::Build => ProjectStage::Build,
            Stage::Evaluate => ProjectStage::Evaluate,
            Stage::Deploy => ProjectStage::Deploy,
            Stage::Handoff => ProjectStage::Handoff,
            Stage::Operate => ProjectStage::Operate,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectOut {
    pub id: String,
    pub company: String,
    pub name: String,
    pub stage: ProjectStage,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Project> for ProjectOut {
    fn from(p: Project) -> Self {
        Self {
            id: p.id.to_string(),
            company: p.company.to_string(),
            name: p.name.as_str().to_owned(),
            stage: p.stage.into(),
            created_at: ts(p.created_at),
            updated_at: ts(p.updated_at),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AssigneeOut {
    /// WorkOS user id.
    pub user: String,
    pub added_at: String,
}

impl From<Assignee> for AssigneeOut {
    fn from(a: Assignee) -> Self {
        Self {
            user: a.user.to_string(),
            added_at: ts(a.added_at),
        }
    }
}

fn scope(who: &Principal, c: CompanyId, p: ProjectId) -> ProjectScope {
    who.company(c).project(p)
}

/// The company's projects.
#[utoipa::path(get, operation_id = "list_projects", path = "/v1/companies/{company}/projects", tag = "projects",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [ProjectOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn list(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Vec<ProjectOut>>, ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "work").await?;
    let mut tx = app.store.company(&s).await?;
    let list = tx.projects().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Create a project in the discover stage.
#[utoipa::path(post, operation_id = "create_project", path = "/v1/companies/{company}/projects", tag = "projects", request_body = NameIn,
    params(("company" = String, Path, description = "Company id")),
    responses((status = 201, body = ProjectOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn create(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Json(body): Json<NameIn>,
) -> Result<(StatusCode, Json<ProjectOut>), ApiError> {
    let cs = who.company(c);
    app.require(&who, company(&cs), "manage").await?;
    let name = body.parse()?;
    let s = cs.project(ProjectId::new(new_id("prj")).map_err(|_| ApiError::Internal)?);
    let mut tx = app.store.project(&s).await?;
    let created = tx.create(&name, &who.actor()).await?.ok_or(ApiError::NotFound)?;
    let write = Write::Touch(rel(project(&s), "company", SubjectRef::object(company(&cs))));
    app.write(&who.tenant, &[write]).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created.into())))
}

/// One project.
#[utoipa::path(get, operation_id = "get_project", path = "/v1/companies/{company}/projects/{project}", tag = "projects",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = ProjectOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn get(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<ProjectOut>, ApiError> {
    let s = scope(&who, c, p);
    app.require(&who, project(&s), "work").await?;
    let mut tx = app.store.project(&s).await?;
    let found = tx.get().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(found.into()))
}

/// Rename a project.
#[utoipa::path(patch, operation_id = "rename_project", path = "/v1/companies/{company}/projects/{project}", tag = "projects", request_body = NameIn,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = ProjectOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn rename(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<NameIn>,
) -> Result<Json<ProjectOut>, ApiError> {
    let s = scope(&who, c, p);
    app.require(&who, project(&s), "work").await?;
    let name = body.parse()?;
    let mut tx = app.store.project(&s).await?;
    let renamed = tx.rename(&name, &who.actor()).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(renamed.into()))
}

/// Users assigned to the project.
#[utoipa::path(get, operation_id = "list_assignees", path = "/v1/companies/{company}/projects/{project}/assignees", tag = "projects",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [AssigneeOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn assignees(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<AssigneeOut>>, ApiError> {
    let s = scope(&who, c, p);
    app.require(&who, project(&s), "work").await?;
    let mut tx = app.store.project(&s).await?;
    tx.get().await?.ok_or(ApiError::NotFound)?;
    let list = tx.assignees().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Assign an engineer to the project.
#[utoipa::path(put, operation_id = "assign", path = "/v1/companies/{company}/projects/{project}/assignees/{user}", tag = "projects",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("user" = String, Path, description = "WorkOS user id")),
    responses((status = 204, description = "Assigned"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn assign(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, assignee)): Path<(CompanyId, ProjectId, UserId)>,
) -> Result<StatusCode, ApiError> {
    let s = scope(&who, c, p);
    app.require(&who, company(&s.company), "manage").await?;
    let mut tx = app.store.project(&s).await?;
    // Checked before the grant: a lead of one company cannot assign into another's project.
    if !tx.assign(&assignee, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    let write = Write::Touch(rel(project(&s), "assignee", user(&who.tenant, &assignee)));
    app.write(&who.tenant, &[write]).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove an engineer from the project.
#[utoipa::path(delete, operation_id = "unassign", path = "/v1/companies/{company}/projects/{project}/assignees/{user}", tag = "projects",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("user" = String, Path, description = "WorkOS user id")),
    responses((status = 204, description = "Unassigned"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn unassign(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, assignee)): Path<(CompanyId, ProjectId, UserId)>,
) -> Result<StatusCode, ApiError> {
    let s = scope(&who, c, p);
    app.require(&who, company(&s.company), "manage").await?;
    let mut tx = app.store.project(&s).await?;
    if !tx.unassign(&assignee, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    let write = Write::Delete(rel(project(&s), "assignee", user(&who.tenant, &assignee)));
    app.write(&who.tenant, &[write]).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

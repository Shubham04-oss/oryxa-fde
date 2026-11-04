//! Companies and their members. Reading needs `work` on the company; changing it, its members or
//! its project list needs `manage`; creating one needs `access` to the workspace.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_authz::{SubjectRef, Write};
use oryxa_core::UserId;
use oryxa_fde_core::CompanyId;
use oryxa_fde_store::{Company, Member, Name, Role, new_id};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::authz::{company, project, rel, user, workspace};
use crate::{ApiError, App, ErrorBody, Principal, ts};

#[derive(Debug, Serialize, ToSchema)]
pub struct CompanyOut {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Company> for CompanyOut {
    fn from(c: Company) -> Self {
        Self {
            id: c.id.to_string(),
            name: c.name.as_str().to_owned(),
            created_at: ts(c.created_at),
            updated_at: ts(c.updated_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct NameIn {
    /// 1 to 200 characters, no control characters.
    pub name: String,
}

impl NameIn {
    pub(crate) fn parse(self) -> Result<Name, ApiError> {
        Name::new(self.name).map_err(|_| ApiError::Invalid("name"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemberRole {
    Lead,
    Engineer,
}

impl From<MemberRole> for Role {
    fn from(r: MemberRole) -> Self {
        match r {
            MemberRole::Lead => Role::Lead,
            MemberRole::Engineer => Role::Engineer,
        }
    }
}

impl From<Role> for MemberRole {
    fn from(r: Role) -> Self {
        match r {
            Role::Lead => MemberRole::Lead,
            Role::Engineer => MemberRole::Engineer,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MemberIn {
    pub role: MemberRole,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MemberOut {
    /// WorkOS user id.
    pub user: String,
    pub role: MemberRole,
    pub added_at: String,
}

impl From<Member> for MemberOut {
    fn from(m: Member) -> Self {
        Self {
            user: m.user.to_string(),
            role: m.role.into(),
            added_at: ts(m.added_at),
        }
    }
}

/// The companies the caller works on.
#[utoipa::path(get, operation_id = "list_companies", path = "/v1/companies", tag = "companies",
    responses((status = 200, body = [CompanyOut]), (status = 401, body = ErrorBody)))]
pub(crate) async fn list(State(app): State<Arc<App>>, who: Principal) -> Result<Json<Vec<CompanyOut>>, ApiError> {
    let scopes = app.companies_for(&who).await?;
    let list = app.store.companies(&scopes).await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Create a company; the caller becomes its lead.
#[utoipa::path(post, operation_id = "create_company", path = "/v1/companies", tag = "companies", request_body = NameIn,
    responses((status = 201, body = CompanyOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub(crate) async fn create(
    State(app): State<Arc<App>>,
    who: Principal,
    Json(body): Json<NameIn>,
) -> Result<(StatusCode, Json<CompanyOut>), ApiError> {
    app.require(&who, workspace(&who.tenant), "access").await?;
    let name = body.parse()?;
    let scope = who.company(CompanyId::new(new_id("cmp")).map_err(|_| ApiError::Internal)?);
    let mut tx = app.store.company(&scope).await?;
    let created = tx.create(&name, &who.actor()).await?;
    let t = &who.tenant;
    app.write(
        t,
        &[
            Write::Touch(rel(company(&scope), "workspace", SubjectRef::object(workspace(t)))),
            Write::Touch(rel(company(&scope), "lead", user(t, &who.user))),
        ],
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created.into())))
}

/// One company.
#[utoipa::path(get, operation_id = "get_company", path = "/v1/companies/{company}", tag = "companies",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = CompanyOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn get(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(id): Path<CompanyId>,
) -> Result<Json<CompanyOut>, ApiError> {
    let scope = who.company(id);
    app.require(&who, company(&scope), "work").await?;
    let mut tx = app.store.company(&scope).await?;
    let found = tx.get().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(found.into()))
}

/// Rename a company.
#[utoipa::path(patch, operation_id = "rename_company", path = "/v1/companies/{company}", tag = "companies", request_body = NameIn,
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = CompanyOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn rename(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(id): Path<CompanyId>,
    Json(body): Json<NameIn>,
) -> Result<Json<CompanyOut>, ApiError> {
    let scope = who.company(id);
    app.require(&who, company(&scope), "manage").await?;
    let name = body.parse()?;
    let mut tx = app.store.company(&scope).await?;
    let renamed = tx.rename(&name, &who.actor()).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(renamed.into()))
}

/// The company's leads and engineers.
#[utoipa::path(get, operation_id = "list_members", path = "/v1/companies/{company}/members", tag = "companies",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = [MemberOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn members(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(id): Path<CompanyId>,
) -> Result<Json<Vec<MemberOut>>, ApiError> {
    let scope = who.company(id);
    app.require(&who, company(&scope), "work").await?;
    let mut tx = app.store.company(&scope).await?;
    let list = tx.members().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Invite a user of the organisation to the company, or change their role.
#[utoipa::path(put, operation_id = "set_member", path = "/v1/companies/{company}/members/{user}", tag = "companies", request_body = MemberIn,
    params(("company" = String, Path, description = "Company id"), ("user" = String, Path, description = "WorkOS user id")),
    responses((status = 204, description = "Member set"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn set_member(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((id, member)): Path<(CompanyId, UserId)>,
    Json(body): Json<MemberIn>,
) -> Result<StatusCode, ApiError> {
    let scope = who.company(id);
    app.require(&who, company(&scope), "manage").await?;
    let role = Role::from(body.role);
    let mut tx = app.store.company(&scope).await?;
    if !tx.set_member(&member, role, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    let other = match role {
        Role::Lead => Role::Engineer,
        Role::Engineer => Role::Lead,
    };
    let t = &who.tenant;
    app.write(
        t,
        &[
            Write::Touch(rel(company(&scope), role.as_str(), user(t, &member))),
            Write::Delete(rel(company(&scope), other.as_str(), user(t, &member))),
        ],
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove a user from the company.
#[utoipa::path(delete, operation_id = "remove_member", path = "/v1/companies/{company}/members/{user}", tag = "companies",
    params(("company" = String, Path, description = "Company id"), ("user" = String, Path, description = "WorkOS user id")),
    responses((status = 204, description = "Member removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_member(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((id, member)): Path<(CompanyId, UserId)>,
) -> Result<StatusCode, ApiError> {
    let scope = who.company(id);
    app.require(&who, company(&scope), "manage").await?;
    let mut tx = app.store.company(&scope).await?;
    let Some(assigned) = tx.remove_member(&member, &who.actor()).await? else {
        return Err(ApiError::NotFound);
    };
    let t = &who.tenant;
    // Revoke the project assignments too: `fde_project.work` includes `assignee`, so a leftover
    // assignment would keep a removed member working on that project.
    let writes: Vec<Write> = Role::ALL
        .into_iter()
        .map(|r| Write::Delete(rel(company(&scope), r.as_str(), user(t, &member))))
        .chain(
            assigned
                .into_iter()
                .map(|p| Write::Delete(rel(project(&scope.project(p)), "assignee", user(t, &member)))),
        )
        .collect();
    app.write(t, &writes).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

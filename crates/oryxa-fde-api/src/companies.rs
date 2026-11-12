//! Companies and their members. Reading needs `work` on the company; changing it, its members or
//! its project list needs `manage`; creating one needs `access` to the workspace.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_authz::Write;
use oryxa_core::UserId;
use oryxa_fde_core::CompanyId;
use oryxa_fde_store::{Company, CompanyIn, CompanySummary, GrantRow, Member, Role, new_id};
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;

use crate::authz::{company, project, rel, user, workspace};
use crate::people::Names;
use crate::projects::ProjectSummaryOut;
use crate::records::{name, text};
use crate::{ApiError, App, ErrorBody, Principal, ts};

#[derive(Debug, Serialize, ToSchema)]
pub struct CompanyOut {
    pub id: String,
    pub name: String,
    pub industry: Option<String>,
    /// Where the company is, e.g. "UK" or "EMEA".
    pub region: Option<String>,
    pub summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Company> for CompanyOut {
    fn from(c: Company) -> Self {
        Self {
            id: c.id.to_string(),
            name: c.name.as_str().to_owned(),
            industry: c.industry.map(|v| v.as_str().to_owned()),
            region: c.region.map(|v| v.as_str().to_owned()),
            summary: c.summary.map(|v| v.as_str().to_owned()),
            created_at: ts(c.created_at),
            updated_at: ts(c.updated_at),
        }
    }
}

/// The caller's role at a company: a member's role, or `admin` for a WorkOS admin who is not a
/// member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CallerRole {
    Lead,
    Engineer,
    Admin,
}

/// A company in the caller's list: the company, the caller's role and its projects.
#[derive(Debug, Serialize, ToSchema)]
pub struct CompanySummaryOut {
    #[serde(flatten)]
    pub company: CompanyOut,
    pub role: Option<CallerRole>,
    pub projects: Vec<ProjectSummaryOut>,
}

impl CompanySummaryOut {
    fn new(s: CompanySummary, admin: bool) -> Self {
        let role = match s.role {
            Some(Role::Lead) => Some(CallerRole::Lead),
            Some(Role::Engineer) => Some(CallerRole::Engineer),
            None if admin => Some(CallerRole::Admin),
            None => None,
        };
        Self {
            company: s.company.into(),
            role,
            projects: s.projects.into_iter().map(Into::into).collect(),
        }
    }
}

/// For PATCH bodies: a missing field is `None` (unchanged), `null` is `Some(None)` (cleared).
pub(crate) fn patch<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Applies a PATCH field: unchanged, cleared or set (validated with `parse`).
pub(crate) fn merge<T>(
    field: Option<Option<String>>,
    current: Option<T>,
    parse: impl FnOnce(String) -> Result<T, ApiError>,
) -> Result<Option<T>, ApiError> {
    match field {
        None => Ok(current),
        Some(None) => Ok(None),
        Some(Some(v)) => parse(v).map(Some),
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CompanyBody {
    /// 1 to 200 characters, no control characters.
    pub name: String,
    pub industry: Option<String>,
    pub region: Option<String>,
    /// Up to 4000 characters.
    pub summary: Option<String>,
}

impl CompanyBody {
    pub(crate) fn parse(self) -> Result<CompanyIn, ApiError> {
        Ok(CompanyIn {
            name: name(self.name, "name")?,
            industry: self.industry.map(|v| name(v, "industry")).transpose()?,
            region: self.region.map(|v| name(v, "region")).transpose()?,
            summary: self.summary.map(|v| text(v, "summary")).transpose()?,
        })
    }
}

/// A change to some of a company's fields: a field left out stays as it is, `null` clears it.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CompanyPatch {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "patch")]
    #[schema(value_type = Option<String>)]
    pub industry: Option<Option<String>>,
    #[serde(default, deserialize_with = "patch")]
    #[schema(value_type = Option<String>)]
    pub region: Option<Option<String>>,
    #[serde(default, deserialize_with = "patch")]
    #[schema(value_type = Option<String>)]
    pub summary: Option<Option<String>>,
}

impl CompanyPatch {
    fn apply(self, current: Company) -> Result<CompanyIn, ApiError> {
        Ok(CompanyIn {
            name: match self.name {
                Some(n) => name(n, "name")?,
                None => current.name,
            },
            industry: merge(self.industry, current.industry, |v| name(v, "industry"))?,
            region: merge(self.region, current.region, |v| name(v, "region"))?,
            summary: merge(self.summary, current.summary, |v| text(v, "summary"))?,
        })
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
    /// Their first and last name in WorkOS; `null` when it has neither, they have left the
    /// organisation, or WorkOS cannot be reached.
    pub name: Option<String>,
    pub role: MemberRole,
    pub added_at: String,
}

impl MemberOut {
    fn new(m: Member, names: &Names) -> Self {
        Self {
            name: names.of(m.user.as_str()),
            user: m.user.to_string(),
            role: m.role.into(),
            added_at: ts(m.added_at),
        }
    }
}

/// The companies the caller works on, each with the caller's role and its projects.
#[utoipa::path(get, operation_id = "list_companies", path = "/v1/companies", tag = "companies",
    responses((status = 200, body = [CompanySummaryOut]), (status = 401, body = ErrorBody)))]
pub(crate) async fn list(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<Json<Vec<CompanySummaryOut>>, ApiError> {
    let scopes = app.companies_for(&who).await?;
    let list = app.store.company_summaries(&scopes, &who.user).await?;
    Ok(Json(
        list.into_iter().map(|s| CompanySummaryOut::new(s, who.admin)).collect(),
    ))
}

/// Create a company; the caller becomes its lead.
#[utoipa::path(post, operation_id = "create_company", path = "/v1/companies", tag = "companies", request_body = CompanyBody,
    responses((status = 201, body = CompanyOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub(crate) async fn create(
    State(app): State<Arc<App>>,
    who: Principal,
    Json(body): Json<CompanyBody>,
) -> Result<(StatusCode, Json<CompanyOut>), ApiError> {
    app.require(&who, workspace(&who.tenant), "access").await?;
    let v = body.parse()?;
    let scope = who.company(CompanyId::new(new_id("cmp")).map_err(|_| ApiError::Internal)?);
    let mut tx = app.store.company(&scope).await?;
    let created = tx.create(&v, &who.actor()).await?;
    tx.commit().await?;
    app.grant(GrantRow::Company(scope.clone())).await;
    app.grant(GrantRow::Member(scope, who.user.clone())).await;
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

/// Whether the company has an encryption key of its own.
#[derive(Debug, Serialize, ToSchema)]
pub struct CompanyKeyOut {
    /// True when the company's own KMS key exists and is enabled: its files are written under it.
    /// False when it has none (or it is disabled, or the check failed): its files are under the
    /// environment's key, which holds sample data only, and once company keys are required its
    /// uploads are refused with `company_key_missing`. Checked against KMS, at most a minute old.
    pub has_key: bool,
}

/// Whether the company has its own encryption key, which real customer data needs (ADR 0003).
/// A route of its own rather than a field on the company, so a company list never waits on KMS.
#[utoipa::path(get, operation_id = "get_company_key", path = "/v1/companies/{company}/key", tag = "companies",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = CompanyKeyOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn key(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(id): Path<CompanyId>,
) -> Result<Json<CompanyKeyOut>, ApiError> {
    let scope = who.company(id);
    app.require(&who, company(&scope), "work").await?;
    // No KMS call for a company that does not exist.
    let mut tx = app.store.company(&scope).await?;
    tx.get().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(CompanyKeyOut {
        has_key: app.context.keys.has_key(&scope).await,
    }))
}

/// Change some of a company's fields.
#[utoipa::path(patch, operation_id = "update_company", path = "/v1/companies/{company}", tag = "companies",
    request_body = CompanyPatch, params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = CompanyOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn update(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(id): Path<CompanyId>,
    Json(body): Json<CompanyPatch>,
) -> Result<Json<CompanyOut>, ApiError> {
    let scope = who.company(id);
    app.require(&who, company(&scope), "manage").await?;
    let mut tx = app.store.company(&scope).await?;
    let current = tx.get_for_update().await?.ok_or(ApiError::NotFound)?;
    let v = body.apply(current)?;
    let updated = tx.update(&v, &who.actor()).await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(updated.into()))
}

/// The company's leads and engineers, with their names.
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
    let names = app.names(&who).await;
    Ok(Json(list.into_iter().map(|m| MemberOut::new(m, &names)).collect()))
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
    // The other role goes before commit, while the membership row is locked; the new one after.
    let revoke = Write::Delete(rel(company(&scope), other.as_str(), user(&who.tenant, &member)));
    app.write(&who.tenant, &[revoke]).await?;
    tx.commit().await?;
    app.grant(GrantRow::Member(scope, member)).await;
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

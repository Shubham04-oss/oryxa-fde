//! Views across the projects and companies one caller works on: the Today view and the company
//! list. The caller's projects and companies come from SpiceDB; each view reads only those.

use std::collections::{BTreeMap, BTreeSet};

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
use sqlx::Row;
use sqlx::postgres::PgRow;

use crate::access::{self, AccessRequest};
use crate::companies::{self, Company, Role};
use crate::projects::{self, Project};
use crate::work::{self, Task};
use crate::{Name, Store, StoreError, id, name, opt};

/// A record's id with its display name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Named<T> {
    pub id: T,
    pub name: Name,
}

/// Something on the caller's Today view, with the company and project it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TodayItem {
    /// A task that is not done.
    Task {
        task: Task,
        company: Named<CompanyId>,
        project: Named<ProjectId>,
    },
    /// An access request that is not granted, with the name of the stakeholder who owns it.
    AccessRequest {
        access: AccessRequest,
        owner: Option<Name>,
        company: Named<CompanyId>,
        project: Named<ProjectId>,
    },
}

/// A company with the caller's role in it and its projects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanySummary {
    pub company: Company,
    /// `None` when the caller works on it without a membership (a WorkOS admin).
    pub role: Option<Role>,
    pub projects: Vec<Project>,
}

impl Store {
    /// The scopes of `projects` in `tenant`, which SpiceDB says the caller works on. A
    /// transaction that names them may read those project rows and no other row.
    pub async fn project_scopes(
        &self,
        tenant: &TenantId,
        projects: &[ProjectId],
    ) -> Result<Vec<ProjectScope>, StoreError> {
        if projects.is_empty() {
            return Ok(Vec::new());
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_app").execute(&mut *tx).await?;
        // Project ids are [a-zA-Z0-9_-], so a comma cannot appear inside one.
        let ids: Vec<&str> = projects.iter().map(ProjectId::as_str).collect();
        sqlx::query("select set_config('fde.tenant', $1, true), set_config('fde.projects', $2, true)")
            .bind(tenant.as_str())
            .bind(ids.join(","))
            .execute(&mut *tx)
            .await?;
        let rows = sqlx::query(
            "select company_id, project_id from projects where tenant_id = $1 and project_id = any ($2)
             order by company_id, project_id",
        )
        .bind(tenant.as_str())
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        rows.into_iter()
            .map(|r| {
                let c = id("company id", CompanyId::new, r.try_get("company_id")?)?;
                let p = id("project id", ProjectId::new, r.try_get("project_id")?)?;
                Ok(CompanyScope::new(tenant.clone(), c).project(p))
            })
            .collect()
    }

    /// Open tasks and unsettled access requests of exactly these projects, oldest first.
    pub async fn today(&self, projects: &[ProjectScope]) -> Result<Vec<TodayItem>, StoreError> {
        let Some(first) = projects.first() else {
            return Ok(Vec::new());
        };
        let tenant = first.tenant().clone();
        if projects.iter().any(|p| p.tenant() != &tenant) {
            return Err(StoreError::MixedTenants);
        }
        let companies: BTreeSet<&CompanyId> = projects.iter().map(|p| &p.company.company).collect();
        let companies: Vec<&CompanyId> = companies.into_iter().collect();
        let mut tx = self.scoped(&tenant, &companies).await?;
        // The (company, project) pairs, so a company in scope shows only the named projects.
        let pair_c: Vec<&str> = projects.iter().map(|p| p.company.company.as_str()).collect();
        let pair_p: Vec<&str> = projects.iter().map(|p| p.project.as_str()).collect();
        let tasks = sqlx::query(&format!(
            "with t as (
                 select {task}, company_id, project_id from tasks
                 where tenant_id = $1 and status <> 'done'
                   and (company_id, project_id) in (select * from unnest($2::text[], $3::text[])))
             select t.*, c.name as company_name, p.name as project_name from t
             join companies c on c.tenant_id = $1 and c.company_id = t.company_id
             join projects p on p.tenant_id = $1 and p.company_id = t.company_id and p.project_id = t.project_id
             order by t.created_at, t.task_id",
            task = work::TASK
        ))
        .bind(tenant.as_str())
        .bind(&pair_c)
        .bind(&pair_p)
        .fetch_all(&mut *tx)
        .await?;
        let access = sqlx::query(&format!(
            "with a as (
                 select {access}, company_id, project_id from access_requests
                 where tenant_id = $1 and status <> 'granted'
                   and (company_id, project_id) in (select * from unnest($2::text[], $3::text[])))
             select a.*, c.name as company_name, p.name as project_name, s.name as owner_name from a
             join companies c on c.tenant_id = $1 and c.company_id = a.company_id
             join projects p on p.tenant_id = $1 and p.company_id = a.company_id and p.project_id = a.project_id
             left join stakeholders s on s.tenant_id = $1 and s.company_id = a.company_id and s.stakeholder_id = a.owner_id
             order by a.requested_at, a.access_request_id",
            access = access::COLUMNS
        ))
        .bind(tenant.as_str())
        .bind(&pair_c)
        .bind(&pair_p)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        let mut items = Vec::with_capacity(tasks.len() + access.len());
        for r in tasks {
            let (company, project) = place(&r)?;
            items.push(TodayItem::Task {
                task: work::task(r)?,
                company,
                project,
            });
        }
        for r in access {
            let (company, project) = place(&r)?;
            let owner = opt(r.try_get("owner_name")?, "owner name", name)?;
            items.push(TodayItem::AccessRequest {
                access: access::access_request(r)?,
                owner,
                company,
                project,
            });
        }
        Ok(items)
    }

    /// The companies in `scopes` (the ones the caller works on) by name, each with the caller's
    /// role and its projects.
    pub async fn company_summaries(
        &self,
        scopes: &[CompanyScope],
        user: &UserId,
    ) -> Result<Vec<CompanySummary>, StoreError> {
        let Some(first) = scopes.first() else {
            return Ok(Vec::new());
        };
        if scopes.iter().any(|s| s.tenant != first.tenant) {
            return Err(StoreError::MixedTenants);
        }
        let tenant = &first.tenant;
        let ids: Vec<&CompanyId> = scopes.iter().map(|s| &s.company).collect();
        let raw: Vec<&str> = ids.iter().map(|c| c.as_str()).collect();
        let mut tx = self.scoped(tenant, &ids).await?;
        let list: Vec<Company> = companies::list(&mut tx, tenant, &ids).await?;
        let roles: BTreeMap<String, String> = sqlx::query(
            "select company_id, role from company_members where tenant_id = $1 and company_id = any ($2) and user_id = $3",
        )
        .bind(tenant.as_str())
        .bind(&raw)
        .bind(user.as_str())
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r| Ok((r.try_get("company_id")?, r.try_get("role")?)))
        .collect::<Result<_, sqlx::Error>>()?;
        let mut by_company: BTreeMap<CompanyId, Vec<Project>> = BTreeMap::new();
        for r in sqlx::query(&format!(
            "select {cols} from projects where tenant_id = $1 and company_id = any ($2) order by created_at, project_id",
            cols = projects::COLUMNS
        ))
        .bind(tenant.as_str())
        .bind(&raw)
        .fetch_all(&mut *tx)
        .await?
        {
            let p = projects::project(r)?;
            by_company.entry(p.company.clone()).or_default().push(p);
        }
        tx.commit().await?;
        list.into_iter()
            .map(|company| {
                let role = roles
                    .get(company.id.as_str())
                    .map(|r| {
                        Role::ALL
                            .into_iter()
                            .find(|x| x.as_str() == r)
                            .ok_or(StoreError::Corrupt("role"))
                    })
                    .transpose()?;
                let projects = by_company.remove(&company.id).unwrap_or_default();
                Ok(CompanySummary {
                    company,
                    role,
                    projects,
                })
            })
            .collect()
    }
}

fn place(r: &PgRow) -> Result<(Named<CompanyId>, Named<ProjectId>), StoreError> {
    Ok((
        Named {
            id: id("company id", CompanyId::new, r.try_get("company_id")?)?,
            name: name(r.try_get("company_name")?, "company name")?,
        },
        Named {
            id: id("project id", ProjectId::new, r.try_get("project_id")?)?,
            name: name(r.try_get("project_name")?, "project name")?,
        },
    ))
}

//! SpiceDB grants that store rows justify (ADR 0002). The API writes a grant only after its row
//! has committed, and only while [`Store::lock_grant`] holds that row's lock. A revocation deletes
//! the row (taking the lock) before it deletes the relationship, so it either waits and revokes
//! after the grant, or the grant finds no row and is skipped: no ordering leaves a grant without
//! its row. A grant whose write fails stays pending (`granted_at` is null), and
//! [`Store::pending_grants`] hands it to the reconciler.

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
use sqlx::{PgConnection, Postgres, Row, Transaction};

use crate::companies::Role;
use crate::{Store, StoreError, id};

/// The row a grant comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantRow {
    Company(CompanyScope),
    Member(CompanyScope, UserId),
    Project(ProjectScope),
    Assignee(ProjectScope, UserId),
}

/// A relationship a row justifies, as the row says now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Grant {
    /// The company belongs to its tenant's workspace.
    CompanyWorkspace(CompanyScope),
    /// A member's current role at the company.
    Member(CompanyScope, UserId, Role),
    /// The project belongs to its company.
    ProjectCompany(ProjectScope),
    Assignee(ProjectScope, UserId),
}

impl Grant {
    pub fn tenant(&self) -> &TenantId {
        match self {
            Grant::CompanyWorkspace(c) | Grant::Member(c, ..) => &c.tenant,
            Grant::ProjectCompany(p) | Grant::Assignee(p, _) => p.tenant(),
        }
    }

    fn company(&self) -> &CompanyId {
        match self {
            Grant::CompanyWorkspace(c) | Grant::Member(c, ..) => &c.company,
            Grant::ProjectCompany(p) | Grant::Assignee(p, _) => &p.company.company,
        }
    }
}

impl GrantRow {
    fn company(&self) -> &CompanyScope {
        match self {
            GrantRow::Company(c) | GrantRow::Member(c, _) => c,
            GrantRow::Project(p) | GrantRow::Assignee(p, _) => &p.company,
        }
    }
}

/// One row locked for its grant. Dropping it without [`PendingGrant::done`] leaves the grant
/// pending for the reconciler.
pub struct PendingGrant {
    tx: Transaction<'static, Postgres>,
    grant: Grant,
}

impl PendingGrant {
    pub fn grant(&self) -> &Grant {
        &self.grant
    }

    /// Call once the grant is written: marks the row granted and releases its lock.
    pub async fn done(mut self) -> Result<(), StoreError> {
        mark(&mut self.tx, &self.grant).await?;
        self.tx.commit().await?;
        Ok(())
    }
}

/// Rows whose grant is not yet written, locked until [`PendingGrants::commit`].
pub struct PendingGrants {
    tx: Transaction<'static, Postgres>,
    grants: Vec<Grant>,
}

impl PendingGrants {
    pub fn grants(&self) -> &[Grant] {
        &self.grants
    }

    /// Marks one of [`PendingGrants::grants`] written.
    pub async fn mark(&mut self, grant: &Grant) -> Result<(), StoreError> {
        mark(&mut self.tx, grant).await
    }

    /// Records a failed write of one of [`PendingGrants::grants`]: it waits 2 s after the first
    /// failure, doubling to ten minutes, before it is taken again. Counted from the failure itself
    /// (`clock_timestamp()`), not from when the transaction began.
    pub async fn mark_failed(&mut self, grant: &Grant) -> Result<(), StoreError> {
        update(
            &mut self.tx,
            grant,
            "grant_attempts = grant_attempts + 1,
             grant_retry_at = clock_timestamp()
                 + make_interval(secs => least(power(2, least(grant_attempts + 1, 20)), 600))",
        )
        .await
    }

    pub async fn commit(self) -> Result<(), StoreError> {
        self.tx.commit().await.map_err(Into::into)
    }
}

impl Store {
    /// Locks `row` and returns the grant it justifies now (a member's current role, say), or
    /// `None` if the row is gone: revoked, rolled back or never there. Waits for a transaction that
    /// holds the row, such as a revocation in flight.
    pub async fn lock_grant(&self, row: &GrantRow) -> Result<Option<PendingGrant>, StoreError> {
        let c = row.company();
        let mut tx = self.scoped(&c.tenant, &[&c.company]).await?;
        let grant = match row {
            GrantRow::Company(c) => {
                sqlx::query("select 1 from companies where tenant_id = $1 and company_id = $2 for update")
                    .bind(c.tenant.as_str())
                    .bind(c.company.as_str())
                    .fetch_optional(&mut *tx)
                    .await?
                    .map(|_| Grant::CompanyWorkspace(c.clone()))
            }
            GrantRow::Member(c, u) => {
                let role: Option<String> = sqlx::query_scalar(
                    "select role from company_members where tenant_id = $1 and company_id = $2 and user_id = $3
                     for update",
                )
                .bind(c.tenant.as_str())
                .bind(c.company.as_str())
                .bind(u.as_str())
                .fetch_optional(&mut *tx)
                .await?;
                role.map(|r| Ok::<_, StoreError>(Grant::Member(c.clone(), u.clone(), role_of(&r)?)))
                    .transpose()?
            }
            GrantRow::Project(p) => sqlx::query(
                "select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3 for update",
            )
            .bind(p.tenant().as_str())
            .bind(p.company.company.as_str())
            .bind(p.project.as_str())
            .fetch_optional(&mut *tx)
            .await?
            .map(|_| Grant::ProjectCompany(p.clone())),
            GrantRow::Assignee(p, u) => sqlx::query(
                "select 1 from project_assignees
                 where tenant_id = $1 and company_id = $2 and project_id = $3 and user_id = $4 for update",
            )
            .bind(p.tenant().as_str())
            .bind(p.company.company.as_str())
            .bind(p.project.as_str())
            .bind(u.as_str())
            .fetch_optional(&mut *tx)
            .await?
            .map(|_| Grant::Assignee(p.clone(), u.clone())),
        };
        Ok(grant.map(|grant| PendingGrant { tx, grant }))
    }

    /// Up to `limit` tenants with a grant not yet written and not backing off, without locking
    /// anything: tenants with a row never tried first, then those whose wait is longest over.
    pub async fn pending_grant_tenants(&self, limit: i64) -> Result<Vec<TenantId>, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_grants").execute(&mut *tx).await?;
        let due = "granted_at is null and (grant_retry_at is null or grant_retry_at <= now())";
        let raw: Vec<String> = sqlx::query_scalar(&format!(
            "select tenant_id from (
                 select tenant_id, grant_retry_at from companies where {due}
                 union all select tenant_id, grant_retry_at from company_members where {due}
                 union all select tenant_id, grant_retry_at from projects where {due}
                 union all select tenant_id, grant_retry_at from project_assignees where {due}
             ) pending
             group by tenant_id
             order by bool_or(grant_retry_at is null) desc, min(grant_retry_at), tenant_id limit $1"
        ))
        .bind(limit)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        raw.into_iter().map(|t| id("tenant id", TenantId::new, t)).collect()
    }

    /// Up to `limit` rows of each kind of one tenant whose grant is not yet written and not
    /// backing off, locked and skipping rows another transaction holds (the API writing that grant
    /// right now). Rows never tried come first, then those whose wait is longest over, so a row
    /// that keeps failing cannot crowd out the rest.
    pub async fn pending_grants(&self, tenant: &TenantId, limit: i64) -> Result<PendingGrants, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_grants").execute(&mut *tx).await?;
        let mut grants = Vec::new();
        for r in sqlx::query(
            "select tenant_id, company_id from companies
             where tenant_id = $2 and granted_at is null and (grant_retry_at is null or grant_retry_at <= now())
             order by grant_retry_at nulls first, tenant_id, company_id limit $1 for update skip locked",
        )
        .bind(limit)
        .bind(tenant.as_str())
        .fetch_all(&mut *tx)
        .await?
        {
            grants.push(Grant::CompanyWorkspace(company_scope(&r)?));
        }
        for r in sqlx::query(
            "select tenant_id, company_id, user_id, role from company_members
             where tenant_id = $2 and granted_at is null and (grant_retry_at is null or grant_retry_at <= now())
             order by grant_retry_at nulls first, tenant_id, company_id, user_id limit $1 for update skip locked",
        )
        .bind(limit)
        .bind(tenant.as_str())
        .fetch_all(&mut *tx)
        .await?
        {
            let user = id("user id", UserId::new, r.try_get("user_id")?)?;
            grants.push(Grant::Member(company_scope(&r)?, user, role_of(r.try_get("role")?)?));
        }
        for r in sqlx::query(
            "select tenant_id, company_id, project_id from projects
             where tenant_id = $2 and granted_at is null and (grant_retry_at is null or grant_retry_at <= now())
             order by grant_retry_at nulls first, tenant_id, project_id limit $1 for update skip locked",
        )
        .bind(limit)
        .bind(tenant.as_str())
        .fetch_all(&mut *tx)
        .await?
        {
            grants.push(Grant::ProjectCompany(project_scope(&r)?));
        }
        for r in sqlx::query(
            "select tenant_id, company_id, project_id, user_id from project_assignees
             where tenant_id = $2 and granted_at is null and (grant_retry_at is null or grant_retry_at <= now())
             order by grant_retry_at nulls first, tenant_id, project_id, user_id limit $1 for update skip locked",
        )
        .bind(limit)
        .bind(tenant.as_str())
        .fetch_all(&mut *tx)
        .await?
        {
            let user = id("user id", UserId::new, r.try_get("user_id")?)?;
            grants.push(Grant::Assignee(project_scope(&r)?, user));
        }
        Ok(PendingGrants { tx, grants })
    }
}

async fn mark(conn: &mut PgConnection, grant: &Grant) -> Result<(), StoreError> {
    update(conn, grant, "granted_at = now()").await
}

/// Updates the row behind `grant` with `set`, a constant assignment list.
async fn update(conn: &mut PgConnection, grant: &Grant, set: &'static str) -> Result<(), StoreError> {
    let (t, c) = (grant.tenant().as_str(), grant.company().as_str());
    let (sql, project, user) = match grant {
        Grant::CompanyWorkspace(_) => (
            format!("update companies set {set} where tenant_id = $1 and company_id = $2"),
            None,
            None,
        ),
        Grant::Member(_, u, _) => (
            format!("update company_members set {set} where tenant_id = $1 and company_id = $2 and user_id = $3"),
            None,
            Some(u),
        ),
        Grant::ProjectCompany(p) => (
            format!("update projects set {set} where tenant_id = $1 and company_id = $2 and project_id = $3"),
            Some(&p.project),
            None,
        ),
        Grant::Assignee(p, u) => (
            format!(
                "update project_assignees set {set}
                 where tenant_id = $1 and company_id = $2 and project_id = $3 and user_id = $4"
            ),
            Some(&p.project),
            Some(u),
        ),
    };
    let mut q = sqlx::query(&sql).bind(t).bind(c);
    if let Some(p) = project {
        q = q.bind(p.as_str());
    }
    if let Some(u) = user {
        q = q.bind(u.as_str());
    }
    q.execute(conn).await?;
    Ok(())
}

fn role_of(raw: &str) -> Result<Role, StoreError> {
    Role::ALL
        .into_iter()
        .find(|r| r.as_str() == raw)
        .ok_or(StoreError::Corrupt("role"))
}

fn company_scope(r: &sqlx::postgres::PgRow) -> Result<CompanyScope, StoreError> {
    Ok(CompanyScope::new(
        id("tenant id", TenantId::new, r.try_get("tenant_id")?)?,
        id("company id", CompanyId::new, r.try_get("company_id")?)?,
    ))
}

fn project_scope(r: &sqlx::postgres::PgRow) -> Result<ProjectScope, StoreError> {
    Ok(company_scope(r)?.project(id("project id", ProjectId::new, r.try_get("project_id")?)?))
}

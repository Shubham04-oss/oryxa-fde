//! Companies and their members.

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId};
use oryxa_fde_events::CompanyCreated;
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Postgres, Row, Transaction};
use time::OffsetDateTime;

use crate::projects::{self, Project};
use crate::{Actor, Name, StoreError, audit, enqueue, id, unique_violation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Company {
    pub id: CompanyId,
    pub name: Name,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

/// A user's role at a company; it is also the SpiceDB relation on `fde_company`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    Lead,
    Engineer,
}

impl Role {
    pub const ALL: [Role; 2] = [Role::Lead, Role::Engineer];

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Lead => "lead",
            Role::Engineer => "engineer",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.as_str() == s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub user: UserId,
    pub role: Role,
    pub added_at: OffsetDateTime,
}

/// A transaction limited to one company. Dropping it without [`CompanyTx::commit`] rolls back.
pub struct CompanyTx {
    tx: Transaction<'static, Postgres>,
    scope: CompanyScope,
}

impl CompanyTx {
    pub(crate) fn new(tx: Transaction<'static, Postgres>, scope: CompanyScope) -> Self {
        Self { tx, scope }
    }

    pub fn scope(&self) -> &CompanyScope {
        &self.scope
    }

    #[cfg(test)]
    pub(crate) fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }

    pub async fn commit(self) -> Result<(), StoreError> {
        self.tx.commit().await.map_err(Into::into)
    }

    /// Creates the company with `by` as its lead, and queues `company.created`.
    pub async fn create(&mut self, name: &Name, by: &Actor) -> Result<Company, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(
            "insert into companies (tenant_id, company_id, name, created_by) values ($1, $2, $3, $4)
             returning company_id, name, created_at, updated_at",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(name.as_str())
        .bind(by.user.as_str())
        .fetch_one(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        let company = company(row)?;
        upsert_member(&mut self.tx, s, &by.user, Role::Lead, &by.user).await?;
        audit(&mut self.tx, s, None, by, "company.created", Some(s.company.as_str())).await?;
        enqueue(
            &mut self.tx,
            s,
            by,
            &CompanyCreated {
                company: s.company.clone(),
            },
        )
        .await?;
        Ok(company)
    }

    pub async fn get(&mut self) -> Result<Option<Company>, StoreError> {
        let s = &self.scope;
        sqlx::query(
            "select company_id, name, created_at, updated_at from companies where tenant_id = $1 and company_id = $2",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(company)
        .transpose()
    }

    pub async fn rename(&mut self, name: &Name, by: &Actor) -> Result<Option<Company>, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(
            "update companies set name = $3, updated_at = now() where tenant_id = $1 and company_id = $2
             returning company_id, name, created_at, updated_at",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(name.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        audit(&mut self.tx, s, None, by, "company.renamed", Some(s.company.as_str())).await?;
        company(row).map(Some)
    }

    pub async fn members(&mut self) -> Result<Vec<Member>, StoreError> {
        let s = &self.scope;
        let rows = sqlx::query(
            "select user_id, role, added_at from company_members where tenant_id = $1 and company_id = $2
             order by added_at, user_id",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .fetch_all(&mut *self.tx)
        .await?;
        rows.into_iter()
            .map(|r| {
                Ok(Member {
                    user: id("user id", UserId::new, r.try_get("user_id")?)?,
                    role: Role::parse(r.try_get::<&str, _>("role")?).ok_or(StoreError::Corrupt("role"))?,
                    added_at: r.try_get("added_at")?,
                })
            })
            .collect()
    }

    /// Adds `user` as a member or changes their role. `false` if the company does not exist.
    pub async fn set_member(&mut self, user: &UserId, role: Role, by: &Actor) -> Result<bool, StoreError> {
        if !self.exists().await? {
            return Ok(false);
        }
        let s = &self.scope;
        upsert_member(&mut self.tx, s, user, role, &by.user).await?;
        let action = match role {
            Role::Lead => "member.set_lead",
            Role::Engineer => "member.set_engineer",
        };
        audit(&mut self.tx, s, None, by, action, Some(user.as_str())).await?;
        Ok(true)
    }

    /// Removes `user` from the company and from every project in it, so no project assignment
    /// outlives the membership. `None` if the company does not exist; otherwise the projects the user
    /// was assigned to, so the caller revokes those grants too.
    pub async fn remove_member(&mut self, user: &UserId, by: &Actor) -> Result<Option<Vec<ProjectId>>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        let s = &self.scope;
        sqlx::query("delete from company_members where tenant_id = $1 and company_id = $2 and user_id = $3")
            .bind(s.tenant.as_str())
            .bind(s.company.as_str())
            .bind(user.as_str())
            .execute(&mut *self.tx)
            .await?;
        let raw: Vec<String> = sqlx::query_scalar(
            "delete from project_assignees where tenant_id = $1 and company_id = $2 and user_id = $3
             returning project_id",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(user.as_str())
        .fetch_all(&mut *self.tx)
        .await?;
        let mut projects = Vec::with_capacity(raw.len());
        for r in raw {
            let project = id("project id", ProjectId::new, r)?;
            audit(
                &mut self.tx,
                s,
                Some(&project),
                by,
                "assignee.removed",
                Some(user.as_str()),
            )
            .await?;
            projects.push(project);
        }
        audit(&mut self.tx, s, None, by, "member.removed", Some(user.as_str())).await?;
        Ok(Some(projects))
    }

    pub async fn projects(&mut self) -> Result<Vec<Project>, StoreError> {
        projects::list(&mut self.tx, &self.scope).await
    }

    async fn exists(&mut self) -> Result<bool, StoreError> {
        let s = &self.scope;
        let found: bool =
            sqlx::query_scalar("select exists (select 1 from companies where tenant_id = $1 and company_id = $2)")
                .bind(s.tenant.as_str())
                .bind(s.company.as_str())
                .fetch_one(&mut *self.tx)
                .await?;
        Ok(found)
    }
}

pub(crate) async fn list(
    conn: &mut PgConnection,
    tenant: &TenantId,
    ids: &[&CompanyId],
) -> Result<Vec<Company>, StoreError> {
    let ids: Vec<&str> = ids.iter().map(|c| c.as_str()).collect();
    let rows = sqlx::query(
        "select company_id, name, created_at, updated_at from companies
         where tenant_id = $1 and company_id = any ($2) order by name, company_id",
    )
    .bind(tenant.as_str())
    .bind(ids)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(company).collect()
}

async fn upsert_member(
    conn: &mut PgConnection,
    s: &CompanyScope,
    user: &UserId,
    role: Role,
    by: &UserId,
) -> Result<(), StoreError> {
    sqlx::query(
        "insert into company_members (tenant_id, company_id, user_id, role, added_by) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, company_id, user_id) do update set role = excluded.role",
    )
    .bind(s.tenant.as_str())
    .bind(s.company.as_str())
    .bind(user.as_str())
    .bind(role.as_str())
    .bind(by.as_str())
    .execute(conn)
    .await?;
    Ok(())
}

fn company(r: PgRow) -> Result<Company, StoreError> {
    Ok(Company {
        id: id("company id", CompanyId::new, r.try_get("company_id")?)?,
        name: Name::new(r.try_get::<String, _>("name")?).map_err(|_| StoreError::Corrupt("name"))?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

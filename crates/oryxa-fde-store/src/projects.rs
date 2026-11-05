//! Projects and their assignees.

use oryxa_core::UserId;
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope, Stage};
use oryxa_fde_events::{ProjectCreated, ProjectStageChanged};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Postgres, Row, Transaction};
use time::OffsetDateTime;

use crate::{Actor, Name, StoreError, Text, audit, enqueue, id, name, opt, text, unique_violation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: ProjectId,
    pub company: CompanyId,
    pub name: Name,
    pub summary: Option<Text>,
    pub stage: Stage,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignee {
    pub user: UserId,
    pub added_at: OffsetDateTime,
}

/// A transaction limited to one project of one company. Dropping it without
/// [`ProjectTx::commit`] rolls back.
pub struct ProjectTx {
    pub(crate) tx: Transaction<'static, Postgres>,
    pub(crate) scope: ProjectScope,
}

/// A project's editable fields.
#[derive(Debug, Clone)]
pub struct ProjectIn {
    pub name: Name,
    pub summary: Option<Text>,
}

impl From<Project> for ProjectIn {
    fn from(p: Project) -> Self {
        Self {
            name: p.name,
            summary: p.summary,
        }
    }
}

pub(crate) const COLUMNS: &str = "project_id, company_id, name, summary, stage, created_at, updated_at";

impl ProjectTx {
    pub(crate) fn new(tx: Transaction<'static, Postgres>, scope: ProjectScope) -> Self {
        Self { tx, scope }
    }

    pub fn scope(&self) -> &ProjectScope {
        &self.scope
    }

    /// The same transaction, back at the project's company.
    pub fn into_company(self) -> crate::CompanyTx {
        crate::CompanyTx::new(self.tx, self.scope.company)
    }

    /// Tenant, company and project ids as bind values, owned so they outlive borrows of `tx`.
    pub(crate) fn keys(&self) -> (String, String, String) {
        let s = &self.scope;
        (
            s.company.tenant.to_string(),
            s.company.company.to_string(),
            s.project.to_string(),
        )
    }

    pub async fn commit(self) -> Result<(), StoreError> {
        self.tx.commit().await.map_err(Into::into)
    }

    /// Creates the project in the discover stage and queues `project.created`. `None` if the
    /// company does not exist.
    pub async fn create(&mut self, v: &ProjectIn, by: &Actor) -> Result<Option<Project>, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(&format!(
            "insert into projects (tenant_id, company_id, project_id, name, summary, created_by)
             select $1, $2, $3, $4, $5, $6
             where exists (select 1 from companies where tenant_id = $1 and company_id = $2)
             returning {COLUMNS}"
        ))
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .bind(v.name.as_str())
        .bind(v.summary.as_ref().map(Text::as_str))
        .bind(by.user.as_str())
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        let Some(row) = row else { return Ok(None) };
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "project.created",
            Some(s.project.as_str()),
        )
        .await?;
        enqueue(&mut self.tx, &s.company, by, &ProjectCreated::new(s)).await?;
        project(row).map(Some)
    }

    pub async fn get(&mut self) -> Result<Option<Project>, StoreError> {
        self.read("").await
    }

    /// The project, locked until this transaction ends: for a read-modify-write such as a PATCH,
    /// so a concurrent change is not lost.
    pub async fn get_for_update(&mut self) -> Result<Option<Project>, StoreError> {
        self.read("for update").await
    }

    async fn read(&mut self, lock: &'static str) -> Result<Option<Project>, StoreError> {
        let s = &self.scope;
        sqlx::query(&format!(
            "select {COLUMNS} from projects where tenant_id = $1 and company_id = $2 and project_id = $3 {lock}"
        ))
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(project)
        .transpose()
    }

    /// Replaces the project's editable fields.
    pub async fn update(&mut self, v: &ProjectIn, by: &Actor) -> Result<Option<Project>, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(&format!(
            "update projects set name = $4, summary = $5, updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 returning {COLUMNS}"
        ))
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .bind(v.name.as_str())
        .bind(v.summary.as_ref().map(Text::as_str))
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "project.updated",
            Some(s.project.as_str()),
        )
        .await?;
        project(row).map(Some)
    }

    /// Moves the project to `to` through [`Stage::transition`] and queues `project.stage-changed`.
    /// `None` if the project is not in this company.
    pub async fn change_stage(&mut self, to: Stage, by: &Actor) -> Result<Option<Project>, StoreError> {
        let s = &self.scope;
        let from: Option<String> = sqlx::query_scalar(
            "select stage from projects where tenant_id = $1 and company_id = $2 and project_id = $3 for update",
        )
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(from) = from else { return Ok(None) };
        let from = stage(&from)?;
        from.transition(to)?;
        let row = sqlx::query(&format!(
            "update projects set stage = $4, updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 returning {COLUMNS}"
        ))
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .bind(to.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "project.stage_changed",
            Some(to.as_str()),
        )
        .await?;
        enqueue(&mut self.tx, &s.company, by, &ProjectStageChanged::new(s, from, to)).await?;
        project(row).map(Some)
    }

    pub async fn assignees(&mut self) -> Result<Vec<Assignee>, StoreError> {
        let s = &self.scope;
        let rows = sqlx::query(
            "select user_id, added_at from project_assignees
             where tenant_id = $1 and company_id = $2 and project_id = $3 order by added_at, user_id",
        )
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .fetch_all(&mut *self.tx)
        .await?;
        rows.into_iter()
            .map(|r| {
                Ok(Assignee {
                    user: id("user id", UserId::new, r.try_get("user_id")?)?,
                    added_at: r.try_get("added_at")?,
                })
            })
            .collect()
    }

    /// Assigns `user` to the project (idempotent). `false` if the project is not in this company.
    pub async fn assign(&mut self, user: &UserId, by: &Actor) -> Result<bool, StoreError> {
        if !self.exists().await? {
            return Ok(false);
        }
        let s = &self.scope;
        sqlx::query(
            "insert into project_assignees (tenant_id, company_id, project_id, user_id, added_by)
             values ($1, $2, $3, $4, $5) on conflict do nothing",
        )
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .bind(user.as_str())
        .bind(by.user.as_str())
        .execute(&mut *self.tx)
        .await?;
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "assignee.added",
            Some(user.as_str()),
        )
        .await?;
        Ok(true)
    }

    /// Removes `user` from the project (idempotent). `false` if the project is not in this company.
    pub async fn unassign(&mut self, user: &UserId, by: &Actor) -> Result<bool, StoreError> {
        if !self.exists().await? {
            return Ok(false);
        }
        let s = &self.scope;
        sqlx::query(
            "delete from project_assignees where tenant_id = $1 and company_id = $2 and project_id = $3
             and user_id = $4",
        )
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .bind(user.as_str())
        .execute(&mut *self.tx)
        .await?;
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "assignee.removed",
            Some(user.as_str()),
        )
        .await?;
        Ok(true)
    }

    /// Whether the project is in this transaction's company.
    pub async fn exists(&mut self) -> Result<bool, StoreError> {
        let s = &self.scope;
        let found: bool = sqlx::query_scalar(
            "select exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)",
        )
        .bind(s.company.tenant.as_str())
        .bind(s.company.company.as_str())
        .bind(s.project.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        Ok(found)
    }
}

pub(crate) async fn list(conn: &mut PgConnection, s: &CompanyScope) -> Result<Vec<Project>, StoreError> {
    let rows = sqlx::query(&format!(
        "select {COLUMNS} from projects where tenant_id = $1 and company_id = $2 order by created_at, project_id"
    ))
    .bind(s.tenant.as_str())
    .bind(s.company.as_str())
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(project).collect()
}

pub(crate) fn stage(raw: &str) -> Result<Stage, StoreError> {
    Stage::ALL
        .into_iter()
        .find(|s| s.as_str() == raw)
        .ok_or(StoreError::Corrupt("stage"))
}

pub(crate) fn project(r: PgRow) -> Result<Project, StoreError> {
    Ok(Project {
        id: id("project id", ProjectId::new, r.try_get("project_id")?)?,
        company: id("company id", CompanyId::new, r.try_get("company_id")?)?,
        name: name(r.try_get("name")?, "name")?,
        summary: opt(r.try_get("summary")?, "summary", text)?,
        stage: stage(r.try_get("stage")?)?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

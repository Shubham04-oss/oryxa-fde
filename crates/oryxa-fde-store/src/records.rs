//! Records on the company: its stakeholders (people at the customer) and its systems.

use oryxa_fde_core::{CompanyScope, StakeholderId, SystemId};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use time::OffsetDateTime;

use crate::{
    Actor, CompanyTx, EmailAddress, Name, ProjectTx, StoreError, Text, audit, id, in_use, name, opt, text,
    unique_violation,
};

/// The part a stakeholder plays in the engagement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StakeholderRole {
    Sponsor,
    Champion,
    User,
    It,
    Security,
    Other,
}

impl StakeholderRole {
    pub const ALL: [StakeholderRole; 6] = [
        StakeholderRole::Sponsor,
        StakeholderRole::Champion,
        StakeholderRole::User,
        StakeholderRole::It,
        StakeholderRole::Security,
        StakeholderRole::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            StakeholderRole::Sponsor => "sponsor",
            StakeholderRole::Champion => "champion",
            StakeholderRole::User => "user",
            StakeholderRole::It => "it",
            StakeholderRole::Security => "security",
            StakeholderRole::Other => "other",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        Self::ALL
            .into_iter()
            .find(|r| r.as_str() == s)
            .ok_or(StoreError::Corrupt("stakeholder role"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stakeholder {
    pub id: StakeholderId,
    pub name: Name,
    /// Their job at the customer, e.g. "VP Engineering".
    pub title: Option<Name>,
    pub role: StakeholderRole,
    /// For the weekly digest, sent to the project's sponsors who have one.
    pub email: Option<EmailAddress>,
    /// Unsubscribed from the digest, and when.
    pub digest_opt_out_at: Option<OffsetDateTime>,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct StakeholderIn {
    pub name: Name,
    pub title: Option<Name>,
    pub role: StakeholderRole,
    pub email: Option<EmailAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct System {
    pub id: SystemId,
    pub name: Name,
    /// What sort of system, e.g. "CRM" or "data warehouse".
    pub kind: Option<Name>,
    pub description: Option<Text>,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct SystemIn {
    pub name: Name,
    pub kind: Option<Name>,
    pub description: Option<Text>,
}

const STAKEHOLDER: &str = "stakeholder_id, name, title, role, email, digest_opt_out_at, updated_at";
const SYSTEM: &str = "system_id, name, kind, description, updated_at";

impl CompanyTx {
    pub async fn stakeholders(&mut self) -> Result<Vec<Stakeholder>, StoreError> {
        stakeholders(&mut self.tx, &self.scope).await
    }

    pub async fn add_stakeholder(
        &mut self,
        id: &StakeholderId,
        v: &StakeholderIn,
        by: &Actor,
    ) -> Result<Option<Stakeholder>, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(&format!(
            "insert into stakeholders (tenant_id, company_id, stakeholder_id, name, title, role, created_by, email)
             select $1, $2, $3, $4, $5, $6, $7, $8
             where exists (select 1 from companies where tenant_id = $1 and company_id = $2)
             returning {STAKEHOLDER}"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(v.name.as_str())
        .bind(v.title.as_ref().map(Name::as_str))
        .bind(v.role.as_str())
        .bind(by.user.as_str())
        .bind(v.email.as_ref().map(EmailAddress::as_str))
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
        audit(&mut self.tx, s, None, by, "stakeholder.added", Some(id.as_str())).await?;
        stakeholder(row).map(Some)
    }

    pub async fn update_stakeholder(
        &mut self,
        id: &StakeholderId,
        v: &StakeholderIn,
        by: &Actor,
    ) -> Result<Option<Stakeholder>, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(&format!(
            "update stakeholders set name = $4, title = $5, role = $6, email = $7,
                 digest_opt_out_at = case when email is distinct from $7 then null else digest_opt_out_at end,
                 updated_at = now()
             where tenant_id = $1 and company_id = $2 and stakeholder_id = $3 returning {STAKEHOLDER}"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(v.name.as_str())
        .bind(v.title.as_ref().map(Name::as_str))
        .bind(v.role.as_str())
        .bind(v.email.as_ref().map(EmailAddress::as_str))
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        audit(&mut self.tx, s, None, by, "stakeholder.updated", Some(id.as_str())).await?;
        stakeholder(row).map(Some)
    }

    /// `false` if there is no such stakeholder; `Conflict` if one has signed off a scope.
    pub async fn remove_stakeholder(&mut self, id: &StakeholderId, by: &Actor) -> Result<bool, StoreError> {
        let s = &self.scope;
        let n =
            sqlx::query("delete from stakeholders where tenant_id = $1 and company_id = $2 and stakeholder_id = $3")
                .bind(s.tenant.as_str())
                .bind(s.company.as_str())
                .bind(id.as_str())
                .execute(&mut *self.tx)
                .await
                .map_err(in_use)?
                .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        audit(&mut self.tx, s, None, by, "stakeholder.removed", Some(id.as_str())).await?;
        Ok(true)
    }

    pub async fn systems(&mut self) -> Result<Vec<System>, StoreError> {
        systems(&mut self.tx, &self.scope).await
    }

    pub async fn add_system(&mut self, id: &SystemId, v: &SystemIn, by: &Actor) -> Result<Option<System>, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(&format!(
            "insert into systems (tenant_id, company_id, system_id, name, kind, description, created_by)
             select $1, $2, $3, $4, $5, $6, $7
             where exists (select 1 from companies where tenant_id = $1 and company_id = $2)
             returning {SYSTEM}"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(v.name.as_str())
        .bind(v.kind.as_ref().map(Name::as_str))
        .bind(v.description.as_ref().map(Text::as_str))
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
        audit(&mut self.tx, s, None, by, "system.added", Some(id.as_str())).await?;
        system(row).map(Some)
    }

    pub async fn update_system(
        &mut self,
        id: &SystemId,
        v: &SystemIn,
        by: &Actor,
    ) -> Result<Option<System>, StoreError> {
        let s = &self.scope;
        let row = sqlx::query(&format!(
            "update systems set name = $4, kind = $5, description = $6, updated_at = now()
             where tenant_id = $1 and company_id = $2 and system_id = $3 returning {SYSTEM}"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(v.name.as_str())
        .bind(v.kind.as_ref().map(Name::as_str))
        .bind(v.description.as_ref().map(Text::as_str))
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        audit(&mut self.tx, s, None, by, "system.updated", Some(id.as_str())).await?;
        system(row).map(Some)
    }

    /// `false` if there is no such system. Access requests naming it keep their record, unlinked.
    pub async fn remove_system(&mut self, id: &SystemId, by: &Actor) -> Result<bool, StoreError> {
        let s = &self.scope;
        let n = sqlx::query("delete from systems where tenant_id = $1 and company_id = $2 and system_id = $3")
            .bind(s.tenant.as_str())
            .bind(s.company.as_str())
            .bind(id.as_str())
            .execute(&mut *self.tx)
            .await
            .map_err(in_use)?
            .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        audit(&mut self.tx, s, None, by, "system.removed", Some(id.as_str())).await?;
        Ok(true)
    }
}

/// Read-only views of the company's records for whoever works on one of its projects: an assignee
/// signs off with a stakeholder and names owners and systems on access requests.
impl ProjectTx {
    /// `None` if the project is not in this company.
    pub async fn company_stakeholders(&mut self) -> Result<Option<Vec<Stakeholder>>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        stakeholders(&mut self.tx, &self.scope.company).await.map(Some)
    }

    /// `None` if the project is not in this company.
    pub async fn company_systems(&mut self) -> Result<Option<Vec<System>>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        systems(&mut self.tx, &self.scope.company).await.map(Some)
    }
}

async fn stakeholders(conn: &mut PgConnection, s: &CompanyScope) -> Result<Vec<Stakeholder>, StoreError> {
    sqlx::query(&format!(
        "select {STAKEHOLDER} from stakeholders where tenant_id = $1 and company_id = $2 order by name, stakeholder_id"
    ))
    .bind(s.tenant.as_str())
    .bind(s.company.as_str())
    .fetch_all(conn)
    .await?
    .into_iter()
    .map(stakeholder)
    .collect()
}

async fn systems(conn: &mut PgConnection, s: &CompanyScope) -> Result<Vec<System>, StoreError> {
    sqlx::query(&format!(
        "select {SYSTEM} from systems where tenant_id = $1 and company_id = $2 order by name, system_id"
    ))
    .bind(s.tenant.as_str())
    .bind(s.company.as_str())
    .fetch_all(conn)
    .await?
    .into_iter()
    .map(system)
    .collect()
}

fn stakeholder(r: PgRow) -> Result<Stakeholder, StoreError> {
    Ok(Stakeholder {
        id: id("stakeholder id", StakeholderId::new, r.try_get("stakeholder_id")?)?,
        name: name(r.try_get("name")?, "name")?,
        title: opt(r.try_get("title")?, "title", name)?,
        role: StakeholderRole::parse(r.try_get("role")?)?,
        email: r
            .try_get::<Option<String>, _>("email")?
            .map(|e| EmailAddress::new(e).map_err(|_| StoreError::Corrupt("email")))
            .transpose()?,
        digest_opt_out_at: r.try_get("digest_opt_out_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

fn system(r: PgRow) -> Result<System, StoreError> {
    Ok(System {
        id: id("system id", SystemId::new, r.try_get("system_id")?)?,
        name: name(r.try_get("name")?, "name")?,
        kind: opt(r.try_get("kind")?, "kind", name)?,
        description: opt(r.try_get("description")?, "description", text)?,
        updated_at: r.try_get("updated_at")?,
    })
}

//! Records on the company: its stakeholders (people at the customer) and its systems.

use oryxa_fde_core::{CompanyScope, StakeholderId, SystemId};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use time::OffsetDateTime;

use crate::{
    Actor, CompanyTx, EmailAddress, Name, ProjectTx, Saved, StoreError, Text, audit, id, in_use, name, opt,
    row_version, stale, text, unique_violation,
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
    /// Bumped by every change to the stakeholder; a save names the version it read.
    pub version: u32,
}

impl Stakeholder {
    /// Whether the stakeholder already holds these values, so saving them would change nothing.
    fn holds(&self, v: &StakeholderIn) -> bool {
        self.name == v.name && self.title == v.title && self.role == v.role && self.email == v.email
    }
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
    /// Bumped by every change to the system; a save names the version it read.
    pub version: u32,
}

impl System {
    /// Whether the system already holds these values, so saving them would change nothing.
    fn holds(&self, v: &SystemIn) -> bool {
        self.name == v.name && self.kind == v.kind && self.description == v.description
    }
}

#[derive(Debug, Clone)]
pub struct SystemIn {
    pub name: Name,
    pub kind: Option<Name>,
    pub description: Option<Text>,
}

const STAKEHOLDER: &str = "stakeholder_id, name, title, role, email, digest_opt_out_at, updated_at, version";
const SYSTEM: &str = "system_id, name, kind, description, updated_at, version";

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

    /// Replaces the stakeholder's fields, unless they have moved on from version `expected` or
    /// already hold them. `None` if there is no such stakeholder.
    pub async fn update_stakeholder(
        &mut self,
        id: &StakeholderId,
        expected: Option<u32>,
        v: &StakeholderIn,
        by: &Actor,
    ) -> Result<Option<Saved<Stakeholder>>, StoreError> {
        let s = &self.scope;
        // The row lock orders concurrent saves: the later one reads what the earlier one wrote.
        let row = sqlx::query(&format!(
            "select {STAKEHOLDER} from stakeholders
             where tenant_id = $1 and company_id = $2 and stakeholder_id = $3 for update"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let current = stakeholder(row)?;
        if stale(expected, current.version) {
            return Ok(Some(Saved::Stale(current)));
        }
        if current.holds(v) {
            return Ok(Some(Saved::Current(current)));
        }
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
        .fetch_one(&mut *self.tx)
        .await?;
        audit(&mut self.tx, s, None, by, "stakeholder.updated", Some(id.as_str())).await?;
        Ok(Some(Saved::Current(stakeholder(row)?)))
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

    /// Replaces the system's fields, unless it has moved on from version `expected` or already
    /// holds them. `None` if there is no such system.
    pub async fn update_system(
        &mut self,
        id: &SystemId,
        expected: Option<u32>,
        v: &SystemIn,
        by: &Actor,
    ) -> Result<Option<Saved<System>>, StoreError> {
        let s = &self.scope;
        // The row lock orders concurrent saves: the later one reads what the earlier one wrote.
        let row = sqlx::query(&format!(
            "select {SYSTEM} from systems where tenant_id = $1 and company_id = $2 and system_id = $3 for update"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let current = system(row)?;
        if stale(expected, current.version) {
            return Ok(Some(Saved::Stale(current)));
        }
        if current.holds(v) {
            return Ok(Some(Saved::Current(current)));
        }
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
        .fetch_one(&mut *self.tx)
        .await?;
        audit(&mut self.tx, s, None, by, "system.updated", Some(id.as_str())).await?;
        Ok(Some(Saved::Current(system(row)?)))
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
    /// The project's sponsors, who get its weekly digest.
    pub async fn project_sponsors(&mut self) -> Result<Vec<Stakeholder>, StoreError> {
        let (t, c, p) = self.keys();
        let cols = STAKEHOLDER
            .split(", ")
            .map(|col| format!("s.{col}"))
            .collect::<Vec<_>>()
            .join(", ");
        sqlx::query(&format!(
            "select {cols} from stakeholders s
             join project_sponsors ps on ps.tenant_id = s.tenant_id and ps.company_id = s.company_id
                 and ps.stakeholder_id = s.stakeholder_id
             where ps.tenant_id = $1 and ps.company_id = $2 and ps.project_id = $3
             order by s.name, s.stakeholder_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(stakeholder)
        .collect()
    }

    /// Names a stakeholder of the company, whose part is sponsor, a sponsor of this project. `None`
    /// if the project or the stakeholder is not in this company; `Rejected("not_a_sponsor")` for a
    /// stakeholder whose part is another.
    pub async fn add_project_sponsor(
        &mut self,
        id: &StakeholderId,
        by: &Actor,
    ) -> Result<Option<Stakeholder>, StoreError> {
        let (t, c, p) = self.keys();
        let role: Option<String> = sqlx::query_scalar(
            "select s.role from stakeholders s
             where s.tenant_id = $1 and s.company_id = $2 and s.stakeholder_id = $3
                 and exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $4)",
        )
        .bind(&t)
        .bind(&c)
        .bind(id.as_str())
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?;
        match role.as_deref() {
            None => return Ok(None),
            Some(r) if r != StakeholderRole::Sponsor.as_str() => return Err(StoreError::Rejected("not_a_sponsor")),
            Some(_) => {}
        }
        sqlx::query(
            "insert into project_sponsors (tenant_id, company_id, project_id, stakeholder_id, added_by)
             values ($1, $2, $3, $4, $5) on conflict do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(by.user.as_str())
        .execute(&mut *self.tx)
        .await?;
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "project.sponsor_added",
            Some(id.as_str()),
        )
        .await?;
        Ok(self.project_sponsors().await?.into_iter().find(|s| &s.id == id))
    }

    /// `false` if the stakeholder was not a sponsor of this project.
    pub async fn remove_project_sponsor(&mut self, id: &StakeholderId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "delete from project_sponsors
             where tenant_id = $1 and company_id = $2 and project_id = $3 and stakeholder_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 1 {
            let s = self.scope.clone();
            audit(
                &mut self.tx,
                &s.company,
                Some(&s.project),
                by,
                "project.sponsor_removed",
                Some(id.as_str()),
            )
            .await?;
        }
        Ok(n == 1)
    }

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
        version: row_version(r.try_get("version")?)?,
    })
}

fn system(r: PgRow) -> Result<System, StoreError> {
    Ok(System {
        id: id("system id", SystemId::new, r.try_get("system_id")?)?,
        name: name(r.try_get("name")?, "name")?,
        kind: opt(r.try_get("kind")?, "kind", name)?,
        description: opt(r.try_get("description")?, "description", text)?,
        updated_at: r.try_get("updated_at")?,
        version: row_version(r.try_get("version")?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stakeholder_holds_a_save_only_when_every_field_matches() {
        let v = StakeholderIn {
            name: Name::new("Sam Lee").unwrap(),
            title: Some(Name::new("VP Engineering").unwrap()),
            role: StakeholderRole::Sponsor,
            email: Some(EmailAddress::new("sam@example.com").unwrap()),
        };
        let stored = Stakeholder {
            id: StakeholderId::new("stk_1").unwrap(),
            name: v.name.clone(),
            title: v.title.clone(),
            role: v.role,
            email: v.email.clone(),
            digest_opt_out_at: Some(OffsetDateTime::UNIX_EPOCH),
            updated_at: OffsetDateTime::UNIX_EPOCH,
            version: 5,
        };
        assert!(stored.holds(&v));
        let changes: [fn(&mut StakeholderIn); 4] = [
            |v| v.name = Name::new("Sam Leigh").unwrap(),
            |v| v.title = None,
            |v| v.role = StakeholderRole::Champion,
            |v| v.email = None,
        ];
        for (i, change) in changes.into_iter().enumerate() {
            let mut other = v.clone();
            change(&mut other);
            assert!(!stored.holds(&other), "field {i}");
        }
    }

    #[test]
    fn a_system_holds_a_save_only_when_every_field_matches() {
        let v = SystemIn {
            name: Name::new("Snowflake").unwrap(),
            kind: Some(Name::new("data warehouse").unwrap()),
            description: Some(Text::new("Sales data").unwrap()),
        };
        let stored = System {
            id: SystemId::new("sys_1").unwrap(),
            name: v.name.clone(),
            kind: v.kind.clone(),
            description: v.description.clone(),
            updated_at: OffsetDateTime::UNIX_EPOCH,
            version: 1,
        };
        assert!(stored.holds(&v));
        let changes: [fn(&mut SystemIn); 3] = [
            |v| v.name = Name::new("BigQuery").unwrap(),
            |v| v.kind = None,
            |v| v.description = None,
        ];
        for (i, change) in changes.into_iter().enumerate() {
            let mut other = v.clone();
            change(&mut other);
            assert!(!stored.holds(&other), "field {i}");
        }
    }
}

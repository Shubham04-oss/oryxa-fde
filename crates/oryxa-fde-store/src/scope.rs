//! A project's scope: in-scope and out-of-scope items, success criteria with measurable targets,
//! a change log and the customer's sign-off. Every change bumps the scope version; a sign-off pins
//! the version the customer agreed to and queues `scope.signed_off`.

use oryxa_core::UserId;
use oryxa_fde_core::{CriterionId, StakeholderId};
use oryxa_fde_events::ScopeSignedOff;
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{
    Actor, Name, ProjectTx, ScopeItemId, StoreError, Text, audit, enqueue, id, name, opt, text, unique_violation,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeKind {
    In,
    Out,
}

impl ScopeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeKind::In => "in",
            ScopeKind::Out => "out",
        }
    }
    fn parse(s: &str) -> Result<Self, StoreError> {
        [ScopeKind::In, ScopeKind::Out]
            .into_iter()
            .find(|k| k.as_str() == s)
            .ok_or(StoreError::Corrupt("scope kind"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeItem {
    pub id: ScopeItemId,
    pub kind: ScopeKind,
    pub description: Text,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct ScopeItemIn {
    pub kind: ScopeKind,
    pub description: Text,
}

/// Which side of the target passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comparator {
    AtLeast,
    AtMost,
}

impl Comparator {
    pub fn as_str(self) -> &'static str {
        match self {
            Comparator::AtLeast => "at_least",
            Comparator::AtMost => "at_most",
        }
    }
    fn parse(s: &str) -> Result<Self, StoreError> {
        [Comparator::AtLeast, Comparator::AtMost]
            .into_iter()
            .find(|c| c.as_str() == s)
            .ok_or(StoreError::Corrupt("comparator"))
    }
}

/// A success criterion: `metric` must be `comparator` `target` (in `unit`), e.g. answer accuracy
/// at least 90 %.
#[derive(Debug, Clone, PartialEq)]
pub struct Criterion {
    pub id: CriterionId,
    pub description: Text,
    pub metric: Name,
    pub comparator: Comparator,
    pub target: f64,
    pub unit: Option<Name>,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct CriterionIn {
    pub description: Text,
    pub metric: Name,
    pub comparator: Comparator,
    pub target: f64,
    pub unit: Option<Name>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignOff {
    pub version: u32,
    pub stakeholder: StakeholderId,
    pub recorded_by: UserId,
    pub signed_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScopeOfWork {
    pub version: u32,
    /// The latest sign-off; it covers the current scope only if its version equals `version`.
    pub sign_off: Option<SignOff>,
    pub items: Vec<ScopeItem>,
    pub criteria: Vec<Criterion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeChange {
    pub version: u32,
    pub actor: UserId,
    /// `item_added`, `item_updated`, `item_removed`, `criterion_added`, `criterion_updated`,
    /// `criterion_removed` or `signed_off`.
    pub action: String,
    /// The item, criterion or signing stakeholder id.
    pub target: String,
    pub at: OffsetDateTime,
}

const ITEM: &str = "item_id, kind, description, updated_at";
const CRITERION: &str = "criterion_id, description, metric, comparator, target, unit, updated_at";

impl ProjectTx {
    /// `None` if the project is not in this company.
    pub async fn scope_of_work(&mut self) -> Result<Option<ScopeOfWork>, StoreError> {
        let (t, c, p) = self.keys();
        let version: Option<i32> = sqlx::query_scalar(
            "select scope_version from projects where tenant_id = $1 and company_id = $2 and project_id = $3",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(version) = version else { return Ok(None) };
        let sign_off = sqlx::query(
            "select version, stakeholder_id, recorded_by, signed_at from scope_signoffs
             where tenant_id = $1 and company_id = $2 and project_id = $3 order by version desc limit 1",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?
        .map(|r| {
            Ok::<_, StoreError>(SignOff {
                version: version_of(r.try_get("version")?)?,
                stakeholder: id("stakeholder id", StakeholderId::new, r.try_get("stakeholder_id")?)?,
                recorded_by: id("user id", UserId::new, r.try_get("recorded_by")?)?,
                signed_at: r.try_get("signed_at")?,
            })
        })
        .transpose()?;
        let items = sqlx::query(&format!(
            "select {ITEM} from scope_items where tenant_id = $1 and company_id = $2 and project_id = $3
             order by created_at, item_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(item)
        .collect::<Result<_, _>>()?;
        let criteria = sqlx::query(&format!(
            "select {CRITERION} from criteria where tenant_id = $1 and company_id = $2 and project_id = $3
             order by created_at, criterion_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(criterion)
        .collect::<Result<_, _>>()?;
        Ok(Some(ScopeOfWork {
            version: version_of(version)?,
            sign_off,
            items,
            criteria,
        }))
    }

    pub async fn add_scope_item(
        &mut self,
        id: &ScopeItemId,
        v: &ScopeItemIn,
        by: &Actor,
    ) -> Result<Option<ScopeItem>, StoreError> {
        let Some(version) = self.bump().await? else {
            return Ok(None);
        };
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "insert into scope_items (tenant_id, company_id, project_id, item_id, kind, description, created_by)
             values ($1, $2, $3, $4, $5, $6, $7) returning {ITEM}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.kind.as_str())
        .bind(v.description.as_str())
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
        self.log_change(version, "item_added", id.as_str(), by).await?;
        item(row).map(Some)
    }

    pub async fn update_scope_item(
        &mut self,
        id: &ScopeItemId,
        v: &ScopeItemIn,
        by: &Actor,
    ) -> Result<Option<ScopeItem>, StoreError> {
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "update scope_items set kind = $5, description = $6, updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and item_id = $4 returning {ITEM}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.kind.as_str())
        .bind(v.description.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        self.log_change(version, "item_updated", id.as_str(), by).await?;
        item(row).map(Some)
    }

    pub async fn remove_scope_item(&mut self, id: &ScopeItemId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "delete from scope_items where tenant_id = $1 and company_id = $2 and project_id = $3 and item_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        self.log_change(version, "item_removed", id.as_str(), by).await?;
        Ok(true)
    }

    pub async fn add_criterion(
        &mut self,
        id: &CriterionId,
        v: &CriterionIn,
        by: &Actor,
    ) -> Result<Option<Criterion>, StoreError> {
        finite(v.target)?;
        let Some(version) = self.bump().await? else {
            return Ok(None);
        };
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "insert into criteria (tenant_id, company_id, project_id, criterion_id, description, metric, comparator,
                 target, unit, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning {CRITERION}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.description.as_str())
        .bind(v.metric.as_str())
        .bind(v.comparator.as_str())
        .bind(v.target)
        .bind(v.unit.as_ref().map(Name::as_str))
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
        self.log_change(version, "criterion_added", id.as_str(), by).await?;
        criterion(row).map(Some)
    }

    pub async fn update_criterion(
        &mut self,
        id: &CriterionId,
        v: &CriterionIn,
        by: &Actor,
    ) -> Result<Option<Criterion>, StoreError> {
        finite(v.target)?;
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "update criteria set description = $5, metric = $6, comparator = $7, target = $8, unit = $9,
                 updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and criterion_id = $4 returning {CRITERION}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.description.as_str())
        .bind(v.metric.as_str())
        .bind(v.comparator.as_str())
        .bind(v.target)
        .bind(v.unit.as_ref().map(Name::as_str))
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        self.log_change(version, "criterion_updated", id.as_str(), by).await?;
        criterion(row).map(Some)
    }

    pub async fn remove_criterion(&mut self, id: &CriterionId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "delete from criteria where tenant_id = $1 and company_id = $2 and project_id = $3 and criterion_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        self.log_change(version, "criterion_removed", id.as_str(), by).await?;
        Ok(true)
    }

    /// Records that `stakeholder` (a person at the customer) signed off the current scope version,
    /// and queues `scope.signed_off`. `None` if the project is not in this company.
    pub async fn sign_off(&mut self, stakeholder: &StakeholderId, by: &Actor) -> Result<Option<SignOff>, StoreError> {
        let (t, c, p) = self.keys();
        let version: Option<i32> = sqlx::query_scalar(
            "select scope_version from projects where tenant_id = $1 and company_id = $2 and project_id = $3
             for update",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(version) = version else { return Ok(None) };
        let empty: bool = sqlx::query_scalar(
            "select not exists (select 1 from scope_items where tenant_id = $1 and company_id = $2 and project_id = $3)
                and not exists (select 1 from criteria where tenant_id = $1 and company_id = $2 and project_id = $3)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_one(&mut *self.tx)
        .await?;
        if empty {
            return Err(StoreError::Rejected("empty_scope"));
        }
        let known: bool = sqlx::query_scalar(
            "select exists (select 1 from stakeholders where tenant_id = $1 and company_id = $2 and stakeholder_id = $3)",
        )
        .bind(&t)
        .bind(&c)
        .bind(stakeholder.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        if !known {
            return Err(StoreError::Missing("stakeholder"));
        }
        let row = sqlx::query(
            "insert into scope_signoffs (tenant_id, company_id, project_id, version, stakeholder_id, recorded_by)
             values ($1, $2, $3, $4, $5, $6) returning signed_at",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(version)
        .bind(stakeholder.as_str())
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
        self.log_change(version, "signed_off", stakeholder.as_str(), by).await?;
        let version = version_of(version)?;
        let s = self.scope.clone();
        let event = ScopeSignedOff {
            company: s.company.company.clone(),
            project: s.project.clone(),
            version,
        };
        enqueue(&mut self.tx, &s.company, by, &event).await?;
        Ok(Some(SignOff {
            version,
            stakeholder: stakeholder.clone(),
            recorded_by: by.user.clone(),
            signed_at: row.try_get("signed_at")?,
        }))
    }

    /// The scope's change log, oldest first.
    pub async fn scope_changes(&mut self) -> Result<Vec<ScopeChange>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "select version, actor, action, target, at from scope_changes
             where tenant_id = $1 and company_id = $2 and project_id = $3 order by id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            Ok(ScopeChange {
                version: version_of(r.try_get("version")?)?,
                actor: id("user id", UserId::new, r.try_get("actor")?)?,
                action: r.try_get("action")?,
                target: r.try_get("target")?,
                at: r.try_get("at")?,
            })
        })
        .collect()
    }

    /// Bumps the scope version; `None` if the project is not in this company.
    async fn bump(&mut self) -> Result<Option<i32>, StoreError> {
        let (t, c, p) = self.keys();
        let v = sqlx::query_scalar(
            "update projects set scope_version = scope_version + 1, updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 returning scope_version",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?;
        Ok(v)
    }

    async fn log_change(
        &mut self,
        version: i32,
        action: &'static str,
        target: &str,
        by: &Actor,
    ) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into scope_changes (tenant_id, company_id, project_id, version, actor, action, target)
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(version)
        .bind(by.user.as_str())
        .bind(action)
        .bind(target)
        .execute(&mut *self.tx)
        .await?;
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            audit_action(action),
            Some(target),
        )
        .await
    }
}

fn audit_action(change: &'static str) -> &'static str {
    match change {
        "item_added" => "scope.item_added",
        "item_updated" => "scope.item_updated",
        "item_removed" => "scope.item_removed",
        "criterion_added" => "scope.criterion_added",
        "criterion_updated" => "scope.criterion_updated",
        "criterion_removed" => "scope.criterion_removed",
        _ => "scope.signed_off",
    }
}

fn finite(target: f64) -> Result<(), StoreError> {
    if target.is_finite() {
        Ok(())
    } else {
        Err(StoreError::Rejected("target"))
    }
}

fn version_of(v: i32) -> Result<u32, StoreError> {
    u32::try_from(v).map_err(|_| StoreError::Corrupt("scope version"))
}

fn item(r: PgRow) -> Result<ScopeItem, StoreError> {
    Ok(ScopeItem {
        id: id("scope item id", ScopeItemId::new, r.try_get("item_id")?)?,
        kind: ScopeKind::parse(r.try_get("kind")?)?,
        description: text(r.try_get("description")?, "description")?,
        updated_at: r.try_get("updated_at")?,
    })
}

fn criterion(r: PgRow) -> Result<Criterion, StoreError> {
    Ok(Criterion {
        id: id("criterion id", CriterionId::new, r.try_get("criterion_id")?)?,
        description: text(r.try_get("description")?, "description")?,
        metric: name(r.try_get("metric")?, "metric")?,
        comparator: Comparator::parse(r.try_get("comparator")?)?,
        target: r.try_get("target")?,
        unit: opt(r.try_get("unit")?, "unit", name)?,
        updated_at: r.try_get("updated_at")?,
    })
}

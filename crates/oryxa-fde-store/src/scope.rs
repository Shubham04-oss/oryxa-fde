//! A project's scope: in-scope and out-of-scope items, success criteria with measurable targets,
//! a change log and the customer's sign-off. Every change bumps the scope version (a save that
//! changes nothing is not a change); a sign-off pins the version the customer agreed to and queues
//! `scope.signed-off`.

use oryxa_core::UserId;
use oryxa_fde_core::{CriterionId, ScopeItemId, StakeholderId};
use oryxa_fde_events::ScopeSignedOff;
use serde_json::{Value, json};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{
    Actor, Name, ProjectTx, Saved, StoreError, Text, audit, enqueue, id, name, opt, row_version, stale, text,
    unique_violation,
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
    /// The item's own version, bumped by every change to it; a save names the version it read.
    pub version: u32,
}

impl ScopeItem {
    /// Whether the item already holds these values, so saving them would change nothing.
    fn holds(&self, v: &ScopeItemIn) -> bool {
        self.kind == v.kind && self.description == v.description
    }
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
    /// The value measured before the work, in the target's unit.
    pub baseline: Option<f64>,
    /// How it will be proven: an eval suite, an uploaded result.
    pub proof: Option<Proof>,
    pub updated_at: OffsetDateTime,
    /// The criterion's own version, bumped by every change to it; a save names the version it read.
    pub version: u32,
}

impl Criterion {
    /// Whether the criterion already holds these values, so saving them would change nothing.
    fn holds(&self, v: &CriterionIn) -> bool {
        self.description == v.description
            && self.metric == v.metric
            && self.comparator == v.comparator
            && self.target == v.target
            && self.unit == v.unit
    }

    fn holds_proof(&self, m: &CriterionProof) -> bool {
        self.baseline == m.baseline && self.proof == m.proof
    }
}

#[derive(Debug, Clone)]
pub struct CriterionIn {
    pub description: Text,
    pub metric: Name,
    pub comparator: Comparator,
    pub target: f64,
    pub unit: Option<Name>,
}

/// A criterion's measured baseline and how it will be proven (direction sections 4 and 9). Kept
/// apart from [`CriterionIn`] so a caller that sets neither need not name them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CriterionProof {
    /// The value measured before the work, in the target's unit.
    pub baseline: Option<f64>,
    pub proof: Option<Proof>,
}

pub const MAX_PROOF_CHARS: usize = 500;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("a proof must be 1..={MAX_PROOF_CHARS} characters with no control characters but newlines and tabs")]
pub struct ProofError;

/// How a success criterion will be proven, in a few words. Customer text: it stays in Postgres and
/// is shown as text, never as markup, so `Debug` shows only its length.
#[derive(Clone, PartialEq, Eq)]
pub struct Proof(String);

impl Proof {
    pub fn new(value: impl AsRef<str>) -> Result<Self, ProofError> {
        let v = value.as_ref().trim();
        let chars = v.chars().count();
        let ok = (1..=MAX_PROOF_CHARS).contains(&chars) && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t');
        if ok { Ok(Self(v.to_owned())) } else { Err(ProofError) }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Proof {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Proof({} chars)", self.0.chars().count())
    }
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
    /// What the change set: the item or criterion as added, updated or removed, or for a sign-off
    /// the whole signed scope (`stakeholder`, `items`, `criteria`). `None` on rows logged before
    /// content was kept.
    pub content: Option<Value>,
    pub at: OffsetDateTime,
}

const ITEM: &str = "item_id, kind, description, updated_at, version";
const CRITERION: &str =
    "criterion_id, description, metric, comparator, target, unit, baseline, proof, updated_at, version";

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
        let (items, criteria) = self.items_and_criteria().await?;
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
        let added = item(row)?;
        self.log_change(version, "item_added", id.as_str(), item_json(&added), by)
            .await?;
        Ok(Some(added))
    }

    /// Replaces the item, unless it has moved on from version `expected` or already holds these
    /// values: then neither the item nor the scope version changes. `None` if there is no such item.
    pub async fn update_scope_item(
        &mut self,
        id: &ScopeItemId,
        expected: Option<u32>,
        v: &ScopeItemIn,
        by: &Actor,
    ) -> Result<Option<Saved<ScopeItem>>, StoreError> {
        let (t, c, p) = self.keys();
        // The row lock orders concurrent saves: the later one reads what the earlier one wrote.
        let row = sqlx::query(&format!(
            "select {ITEM} from scope_items
             where tenant_id = $1 and company_id = $2 and project_id = $3 and item_id = $4 for update"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let current = item(row)?;
        if stale(expected, current.version) {
            return Ok(Some(Saved::Stale(current)));
        }
        if current.holds(v) {
            return Ok(Some(Saved::Current(current)));
        }
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
        .fetch_one(&mut *self.tx)
        .await?;
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        let updated = item(row)?;
        self.log_change(version, "item_updated", id.as_str(), item_json(&updated), by)
            .await?;
        Ok(Some(Saved::Current(updated)))
    }

    pub async fn remove_scope_item(&mut self, id: &ScopeItemId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "delete from scope_items where tenant_id = $1 and company_id = $2 and project_id = $3 and item_id = $4
             returning {ITEM}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(false) };
        let removed = item(row)?;
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        self.log_change(version, "item_removed", id.as_str(), item_json(&removed), by)
            .await?;
        Ok(true)
    }

    pub async fn add_criterion(
        &mut self,
        id: &CriterionId,
        v: &CriterionIn,
        by: &Actor,
    ) -> Result<Option<Criterion>, StoreError> {
        self.add_criterion_with(id, v, &CriterionProof::default(), by).await
    }

    /// [`Self::add_criterion`] with a baseline and how it will be proven.
    pub async fn add_criterion_with(
        &mut self,
        id: &CriterionId,
        v: &CriterionIn,
        m: &CriterionProof,
        by: &Actor,
    ) -> Result<Option<Criterion>, StoreError> {
        finite(v, m)?;
        let Some(version) = self.bump().await? else {
            return Ok(None);
        };
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "insert into criteria (tenant_id, company_id, project_id, criterion_id, description, metric, comparator,
                 target, unit, created_by, baseline, proof)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning {CRITERION}"
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
        .bind(m.baseline)
        .bind(m.proof.as_ref().map(Proof::as_str))
        .fetch_one(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        let added = criterion(row)?;
        self.log_change(version, "criterion_added", id.as_str(), criterion_json(&added), by)
            .await?;
        Ok(Some(added))
    }

    /// Replaces the criterion, unless it has moved on from version `expected` or already holds
    /// these values: then neither the criterion nor the scope version changes. `None` if there is
    /// no such criterion.
    pub async fn update_criterion(
        &mut self,
        id: &CriterionId,
        expected: Option<u32>,
        v: &CriterionIn,
        m: &CriterionProof,
        by: &Actor,
    ) -> Result<Option<Saved<Criterion>>, StoreError> {
        finite(v, m)?;
        let (t, c, p) = self.keys();
        // The row lock orders concurrent saves: the later one reads what the earlier one wrote.
        let row = sqlx::query(&format!(
            "select {CRITERION} from criteria
             where tenant_id = $1 and company_id = $2 and project_id = $3 and criterion_id = $4 for update"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let current = criterion(row)?;
        if stale(expected, current.version) {
            return Ok(Some(Saved::Stale(current)));
        }
        if current.holds(v) && current.holds_proof(m) {
            return Ok(Some(Saved::Current(current)));
        }
        let row = sqlx::query(&format!(
            "update criteria set description = $5, metric = $6, comparator = $7, target = $8, unit = $9,
                 baseline = $10, proof = $11, updated_at = now()
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
        .bind(m.baseline)
        .bind(m.proof.as_ref().map(Proof::as_str))
        .fetch_one(&mut *self.tx)
        .await?;
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        let updated = criterion(row)?;
        self.log_change(version, "criterion_updated", id.as_str(), criterion_json(&updated), by)
            .await?;
        Ok(Some(Saved::Current(updated)))
    }

    pub async fn remove_criterion(&mut self, id: &CriterionId, by: &Actor) -> Result<bool, StoreError> {
        // Unlinking the criterion's tasks updates task rows: the order lock first, as in every task write.
        self.lock_task_order().await?;
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "delete from criteria where tenant_id = $1 and company_id = $2 and project_id = $3 and criterion_id = $4
             returning {CRITERION}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(false) };
        let removed = criterion(row)?;
        let version = self.bump().await?.ok_or(StoreError::Corrupt("project"))?;
        self.log_change(version, "criterion_removed", id.as_str(), criterion_json(&removed), by)
            .await?;
        Ok(true)
    }

    /// Records that `stakeholder` (a person at the customer) signed off the current scope version,
    /// and queues `scope.signed-off`. Stale, with the scope as it stands, if the scope has moved on
    /// from version `expected` (the one the person read). `None` if the project is not in this
    /// company.
    pub async fn sign_off(
        &mut self,
        stakeholder: &StakeholderId,
        expected: Option<u32>,
        by: &Actor,
    ) -> Result<Option<Saved<SignOff, ScopeOfWork>>, StoreError> {
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
        // The project row stays locked, so no change can land between this check and the sign-off.
        if stale(expected, version_of(version)?) {
            let current = self.scope_of_work().await?.ok_or(StoreError::Corrupt("project"))?;
            return Ok(Some(Saved::Stale(current)));
        }
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
        let (items, criteria) = self.items_and_criteria().await?;
        let signed = json!({
            "stakeholder": stakeholder.as_str(),
            "items": items.iter().map(item_json).collect::<Vec<_>>(),
            "criteria": criteria.iter().map(criterion_json).collect::<Vec<_>>(),
        });
        self.log_change(version, "signed_off", stakeholder.as_str(), signed, by)
            .await?;
        let version = version_of(version)?;
        let s = self.scope.clone();
        enqueue(&mut self.tx, &s.company, by, &ScopeSignedOff::new(&s, version)).await?;
        Ok(Some(Saved::Current(SignOff {
            version,
            stakeholder: stakeholder.clone(),
            recorded_by: by.user.clone(),
            signed_at: row.try_get("signed_at")?,
        })))
    }

    /// The scope's change log, oldest first.
    pub async fn scope_changes(&mut self) -> Result<Vec<ScopeChange>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "select version, actor, action, target, content, at from scope_changes
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
                content: r.try_get("content")?,
                at: r.try_get("at")?,
            })
        })
        .collect()
    }

    async fn items_and_criteria(&mut self) -> Result<(Vec<ScopeItem>, Vec<Criterion>), StoreError> {
        let (t, c, p) = self.keys();
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
        Ok((items, criteria))
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
        content: Value,
        by: &Actor,
    ) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into scope_changes (tenant_id, company_id, project_id, version, actor, action, target, content)
             values ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(version)
        .bind(by.user.as_str())
        .bind(action)
        .bind(target)
        .bind(content)
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

fn item_json(i: &ScopeItem) -> Value {
    json!({"id": i.id.as_str(), "kind": i.kind.as_str(), "description": i.description.as_str()})
}

fn criterion_json(c: &Criterion) -> Value {
    json!({
        "id": c.id.as_str(),
        "description": c.description.as_str(),
        "metric": c.metric.as_str(),
        "comparator": c.comparator.as_str(),
        "target": c.target,
        "unit": c.unit.as_ref().map(Name::as_str),
        "baseline": c.baseline,
        "proof": c.proof.as_ref().map(Proof::as_str),
    })
}

/// A target and a baseline are numbers, never NaN or infinite.
fn finite(v: &CriterionIn, m: &CriterionProof) -> Result<(), StoreError> {
    if !v.target.is_finite() {
        return Err(StoreError::Rejected("target"));
    }
    if m.baseline.is_some_and(|b| !b.is_finite()) {
        return Err(StoreError::Rejected("baseline"));
    }
    Ok(())
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
        version: row_version(r.try_get("version")?)?,
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
        baseline: r.try_get("baseline")?,
        proof: {
            let raw: Option<String> = r.try_get("proof")?;
            raw.map(|p| Proof::new(p).map_err(|_| StoreError::Corrupt("proof")))
                .transpose()?
        },
        updated_at: r.try_get("updated_at")?,
        version: row_version(r.try_get("version")?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proof_is_short_text_with_no_control_characters() {
        assert_eq!(
            Proof::new("  The support eval suite  ").unwrap().as_str(),
            "The support eval suite"
        );
        assert!(Proof::new("line one\nline two").is_ok());
        assert!(Proof::new("x".repeat(MAX_PROOF_CHARS)).is_ok());
        for bad in ["", "   ", "a\u{7}b", "a\u{1b}[31mb"] {
            assert!(Proof::new(bad).is_err(), "{bad:?}");
        }
        assert!(Proof::new("x".repeat(MAX_PROOF_CHARS + 1)).is_err());
        assert_eq!(format!("{:?}", Proof::new("secret plan").unwrap()), "Proof(11 chars)");
    }

    #[test]
    fn an_item_holds_a_save_only_when_kind_and_description_match() {
        let v = ScopeItemIn {
            kind: ScopeKind::In,
            description: Text::new("Answer support tickets").unwrap(),
        };
        let stored = ScopeItem {
            id: ScopeItemId::new("itm_1").unwrap(),
            kind: v.kind,
            description: v.description.clone(),
            updated_at: OffsetDateTime::UNIX_EPOCH,
            version: 2,
        };
        assert!(stored.holds(&v));
        assert!(!stored.holds(&ScopeItemIn {
            kind: ScopeKind::Out,
            ..v.clone()
        }));
        assert!(!stored.holds(&ScopeItemIn {
            description: Text::new("Answer every ticket").unwrap(),
            ..v
        }));
    }

    #[test]
    fn a_criterion_holds_a_save_only_when_every_field_matches() {
        let v = CriterionIn {
            description: Text::new("Answers are right").unwrap(),
            metric: Name::new("answer accuracy").unwrap(),
            comparator: Comparator::AtLeast,
            target: 90.0,
            unit: Some(Name::new("%").unwrap()),
        };
        let stored = Criterion {
            id: CriterionId::new("crt_1").unwrap(),
            description: v.description.clone(),
            metric: v.metric.clone(),
            comparator: v.comparator,
            target: v.target,
            unit: v.unit.clone(),
            baseline: None,
            proof: None,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            version: 1,
        };
        assert!(stored.holds(&v));
        let changes: [fn(&mut CriterionIn); 5] = [
            |v| v.description = Text::new("Answers are mostly right").unwrap(),
            |v| v.metric = Name::new("precision").unwrap(),
            |v| v.comparator = Comparator::AtMost,
            |v| v.target = 90.5,
            |v| v.unit = None,
        ];
        for (i, change) in changes.into_iter().enumerate() {
            let mut other = v.clone();
            change(&mut other);
            assert!(!stored.holds(&other), "field {i}");
        }
    }
}

//! Access requests on a project: what access is needed, to which system, who at the customer owns
//! it, its status and how long it has been waiting. A status change queues
//! `access-request.status-changed`.

use oryxa_fde_core::{AccessRequestId, StakeholderId, SystemId};
use oryxa_fde_events::{AccessRequestStatusChanged, AccessStatus};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{
    Actor, ProjectTx, Saved, StoreError, Text, audit, enqueue, id, row_version, stale, text, unique_violation,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRequest {
    pub id: AccessRequestId,
    pub description: Text,
    pub system: Option<SystemId>,
    /// The person at the customer who can grant it.
    pub owner: Option<StakeholderId>,
    pub status: AccessStatus,
    pub requested_at: OffsetDateTime,
    pub status_changed_at: OffsetDateTime,
    pub granted_at: Option<OffsetDateTime>,
    /// Whole days from the request until it was granted, refused or revoked, or until now while
    /// it is still open.
    pub days_waiting: i64,
    /// Bumped by every change to the request; a save names the version it read.
    pub version: u32,
}

impl AccessRequest {
    /// Whether the request already holds these values, so saving them would change nothing.
    fn holds(&self, v: &AccessRequestIn) -> bool {
        self.description == v.description && self.system == v.system && self.owner == v.owner && self.status == v.status
    }
}

#[derive(Debug, Clone)]
pub struct AccessRequestIn {
    pub description: Text,
    pub system: Option<SystemId>,
    pub owner: Option<StakeholderId>,
    pub status: AccessStatus,
}

const ALL: [AccessStatus; 5] = [
    AccessStatus::Requested,
    AccessStatus::InProgress,
    AccessStatus::Granted,
    AccessStatus::Denied,
    AccessStatus::Revoked,
];

fn as_str(s: AccessStatus) -> &'static str {
    match s {
        AccessStatus::Requested => "requested",
        AccessStatus::InProgress => "in_progress",
        AccessStatus::Granted => "granted",
        AccessStatus::Denied => "denied",
        AccessStatus::Revoked => "revoked",
    }
}

pub(crate) fn parse(s: &str) -> Result<AccessStatus, StoreError> {
    ALL.into_iter()
        .find(|a| as_str(*a) == s)
        .ok_or(StoreError::Corrupt("access status"))
}

pub(crate) const COLUMNS: &str =
    "access_request_id, description, system_id, owner_id, status, requested_at, status_changed_at,
    granted_at, floor(extract(epoch from (
        case when status in ('requested', 'in_progress') then now() else coalesce(granted_at, status_changed_at) end
        - requested_at)) / 86400)::bigint as days_waiting, version";

impl ProjectTx {
    pub async fn access_requests(&mut self) -> Result<Vec<AccessRequest>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {COLUMNS} from access_requests where tenant_id = $1 and company_id = $2 and project_id = $3
             order by requested_at, access_request_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(access_request)
        .collect()
    }

    /// A request starts as requested or in progress: a status change is what reports it settled,
    /// so one created settled would never be reported. `None` if the project is not in this
    /// company.
    pub async fn add_access_request(
        &mut self,
        id: &AccessRequestId,
        v: &AccessRequestIn,
        by: &Actor,
    ) -> Result<Option<AccessRequest>, StoreError> {
        if !matches!(v.status, AccessStatus::Requested | AccessStatus::InProgress) {
            return Err(StoreError::Rejected("initial_status"));
        }
        if !self.exists().await? {
            return Ok(None);
        }
        self.check_refs(v).await?;
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "insert into access_requests (tenant_id, company_id, project_id, access_request_id, description, system_id,
                 owner_id, status, requested_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning {COLUMNS}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.description.as_str())
        .bind(v.system.as_ref().map(SystemId::as_str))
        .bind(v.owner.as_ref().map(StakeholderId::as_str))
        .bind(as_str(v.status))
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
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "access_request.added",
            Some(id.as_str()),
        )
        .await?;
        access_request(row).map(Some)
    }

    /// Replaces the request's fields, unless it has moved on from version `expected` or already
    /// holds them. A status change stamps the time, sets or clears `granted_at` and queues
    /// `access-request.status-changed`. `None` if there is no such request.
    pub async fn update_access_request(
        &mut self,
        id: &AccessRequestId,
        expected: Option<u32>,
        v: &AccessRequestIn,
        by: &Actor,
    ) -> Result<Option<Saved<AccessRequest>>, StoreError> {
        let (t, c, p) = self.keys();
        // The row lock orders concurrent saves: the later one reads what the earlier one wrote.
        let row = sqlx::query(&format!(
            "select {COLUMNS} from access_requests
             where tenant_id = $1 and company_id = $2 and project_id = $3 and access_request_id = $4 for update"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let current = access_request(row)?;
        if stale(expected, current.version) {
            return Ok(Some(Saved::Stale(current)));
        }
        self.check_refs(v).await?;
        if current.holds(v) {
            return Ok(Some(Saved::Current(current)));
        }
        let from = current.status;
        let changed = from != v.status;
        let row = sqlx::query(&format!(
            "update access_requests set description = $5, system_id = $6, owner_id = $7, status = $8,
                 status_changed_at = case when $9 then now() else status_changed_at end,
                 granted_at = case
                     when not $9 then granted_at
                     when $8 = 'granted' then now()
                     when $8 in ('requested', 'in_progress') then null
                     else granted_at end,
                 updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and access_request_id = $4
             returning {COLUMNS}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.description.as_str())
        .bind(v.system.as_ref().map(SystemId::as_str))
        .bind(v.owner.as_ref().map(StakeholderId::as_str))
        .bind(as_str(v.status))
        .bind(changed)
        .fetch_one(&mut *self.tx)
        .await?;
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "access_request.updated",
            Some(id.as_str()),
        )
        .await?;
        if changed {
            let event = AccessRequestStatusChanged::new(&s, id.clone(), from, v.status);
            enqueue(&mut self.tx, &s.company, by, &event).await?;
        }
        Ok(Some(Saved::Current(access_request(row)?)))
    }

    /// The system and owner must belong to this company.
    async fn check_refs(&mut self, v: &AccessRequestIn) -> Result<(), StoreError> {
        let (t, c, _) = self.keys();
        let refs = [
            (
                "systems",
                "system_id",
                v.system.as_ref().map(SystemId::as_str),
                "system",
            ),
            (
                "stakeholders",
                "stakeholder_id",
                v.owner.as_ref().map(StakeholderId::as_str),
                "owner",
            ),
        ];
        for (table, column, value, what) in refs {
            let Some(value) = value else { continue };
            let found: bool = sqlx::query_scalar(&format!(
                "select exists (select 1 from {table} where tenant_id = $1 and company_id = $2 and {column} = $3)"
            ))
            .bind(&t)
            .bind(&c)
            .bind(value)
            .fetch_one(&mut *self.tx)
            .await?;
            if !found {
                return Err(StoreError::Missing(what));
            }
        }
        Ok(())
    }
}

pub(crate) fn access_request(r: PgRow) -> Result<AccessRequest, StoreError> {
    let system: Option<String> = r.try_get("system_id")?;
    let owner: Option<String> = r.try_get("owner_id")?;
    Ok(AccessRequest {
        id: id(
            "access request id",
            AccessRequestId::new,
            r.try_get("access_request_id")?,
        )?,
        description: text(r.try_get("description")?, "description")?,
        system: system.map(|s| id("system id", SystemId::new, s)).transpose()?,
        owner: owner.map(|o| id("stakeholder id", StakeholderId::new, o)).transpose()?,
        status: parse(r.try_get("status")?)?,
        requested_at: r.try_get("requested_at")?,
        status_changed_at: r.try_get("status_changed_at")?,
        granted_at: r.try_get("granted_at")?,
        days_waiting: r.try_get("days_waiting")?,
        version: row_version(r.try_get("version")?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_holds_a_save_only_when_every_field_matches() {
        let at = OffsetDateTime::UNIX_EPOCH;
        let v = AccessRequestIn {
            description: Text::new("Read access to the warehouse").unwrap(),
            system: Some(SystemId::new("sys_1").unwrap()),
            owner: Some(StakeholderId::new("stk_1").unwrap()),
            status: AccessStatus::InProgress,
        };
        let stored = AccessRequest {
            id: AccessRequestId::new("acc_1").unwrap(),
            description: v.description.clone(),
            system: v.system.clone(),
            owner: v.owner.clone(),
            status: v.status,
            requested_at: at,
            status_changed_at: at,
            granted_at: None,
            days_waiting: 4,
            version: 2,
        };
        assert!(stored.holds(&v));
        let changes: [fn(&mut AccessRequestIn); 4] = [
            |v| v.description = Text::new("Write access").unwrap(),
            |v| v.system = None,
            |v| v.owner = None,
            |v| v.status = AccessStatus::Granted,
        ];
        for (i, change) in changes.into_iter().enumerate() {
            let mut other = v.clone();
            change(&mut other);
            assert!(!stored.holds(&other), "field {i}");
        }
    }
}

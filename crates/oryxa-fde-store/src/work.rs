//! A project's tasks (with blockers and a "waiting on customer" state) and its decisions log.

use oryxa_core::UserId;
use oryxa_fde_core::{DecisionId, StakeholderId, TaskId};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::{Date, OffsetDateTime};

use crate::{Actor, Name, ProjectTx, StoreError, Text, audit, id, name, opt, text, unique_violation};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Todo,
    InProgress,
    WaitingOnCustomer,
    Blocked,
    Done,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 5] = [
        TaskStatus::Todo,
        TaskStatus::InProgress,
        TaskStatus::WaitingOnCustomer,
        TaskStatus::Blocked,
        TaskStatus::Done,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::WaitingOnCustomer => "waiting_on_customer",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Done => "done",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        Self::ALL
            .into_iter()
            .find(|t| t.as_str() == s)
            .ok_or(StoreError::Corrupt("task status"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: TaskId,
    pub title: Name,
    pub status: TaskStatus,
    /// What blocks it; required while the task is blocked.
    pub blocker: Option<Text>,
    pub due_on: Option<Date>,
    /// Who works it.
    pub assignee: Option<UserId>,
    /// The stakeholder at the customer it waits on.
    pub waiting_on: Option<StakeholderId>,
    /// Since when it has waited on the customer; set while the status is `WaitingOnCustomer`.
    pub waiting_since: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct TaskIn {
    pub title: Name,
    pub status: TaskStatus,
    pub blocker: Option<Text>,
    pub due_on: Option<Date>,
    pub assignee: Option<UserId>,
    pub waiting_on: Option<StakeholderId>,
}

impl TaskIn {
    fn check(&self) -> Result<(), StoreError> {
        if self.status == TaskStatus::Blocked && self.blocker.is_none() {
            Err(StoreError::Rejected("blocker_required"))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub id: DecisionId,
    pub title: Name,
    pub rationale: Text,
    /// Who made the decision; often someone at the customer, so a name rather than a user id.
    pub decided_by: Name,
    pub decided_at: OffsetDateTime,
    pub recorded_by: UserId,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct DecisionIn {
    pub title: Name,
    pub rationale: Text,
    pub decided_by: Name,
    pub decided_at: OffsetDateTime,
}

/// One page of a list, in the list's order; `more` says whether anything follows its last item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub more: bool,
}

impl<T> Page<T> {
    /// `limit + 1` rows were asked for, so a row past `limit` means another page follows.
    fn of(mut rows: Vec<T>, limit: u32) -> Self {
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        Self { items: rows, more }
    }
}

pub(crate) const TASK: &str =
    "task_id, title, status, blocker, due_on, assignee, waiting_on, waiting_since, created_at, updated_at";
const DECISION: &str = "decision_id, title, rationale, decided_by, decided_at, recorded_by, created_at";

impl ProjectTx {
    /// Up to `limit` tasks, oldest first, after task `after` (the last of the previous page).
    /// `StoreError::Missing("after")` if `after` is not a task of this project.
    pub async fn tasks_page(&mut self, after: Option<&TaskId>, limit: u32) -> Result<Page<Task>, StoreError> {
        let (t, c, p) = self.keys();
        let from: Option<(OffsetDateTime, String)> = match after {
            None => None,
            Some(a) => Some(
                sqlx::query_as(
                    "select created_at, task_id from tasks
                     where tenant_id = $1 and company_id = $2 and project_id = $3 and task_id = $4",
                )
                .bind(&t)
                .bind(&c)
                .bind(&p)
                .bind(a.as_str())
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(StoreError::Missing("after"))?,
            ),
        };
        let (at, id) = from.unzip();
        let rows = sqlx::query(&format!(
            "select {TASK} from tasks where tenant_id = $1 and company_id = $2 and project_id = $3
                 and ($4::timestamptz is null or (created_at, task_id) > ($4, $5))
             order by created_at, task_id limit $6"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(at)
        .bind(id)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(task)
        .collect::<Result<_, _>>()?;
        Ok(Page::of(rows, limit))
    }

    pub async fn tasks(&mut self) -> Result<Vec<Task>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {TASK} from tasks where tenant_id = $1 and company_id = $2 and project_id = $3
             order by created_at, task_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(task)
        .collect()
    }

    /// `None` if the project is not in this company.
    pub async fn add_task(&mut self, id: &TaskId, v: &TaskIn, by: &Actor) -> Result<Option<Task>, StoreError> {
        v.check()?;
        self.check_waiting_on(v).await?;
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "insert into tasks (tenant_id, company_id, project_id, task_id, title, status, blocker, due_on, assignee,
                 waiting_on, waiting_since, created_by)
             select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $6 = 'waiting_on_customer' then now() end, $11
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             returning {TASK}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.title.as_str())
        .bind(v.status.as_str())
        .bind(v.blocker.as_ref().map(Text::as_str))
        .bind(v.due_on)
        .bind(v.assignee.as_ref().map(UserId::as_str))
        .bind(v.waiting_on.as_ref().map(StakeholderId::as_str))
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
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "task.added",
            Some(id.as_str()),
        )
        .await?;
        task(row).map(Some)
    }

    /// Replaces the task's fields. Waiting on the customer keeps its start time while the status
    /// stays `WaitingOnCustomer` and clears when it leaves.
    pub async fn update_task(&mut self, id: &TaskId, v: &TaskIn, by: &Actor) -> Result<Option<Task>, StoreError> {
        v.check()?;
        self.check_waiting_on(v).await?;
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "update tasks set title = $5, status = $6, blocker = $7, due_on = $8, assignee = $9, waiting_on = $10,
                 waiting_since = case when $6 = 'waiting_on_customer' then coalesce(waiting_since, now()) end,
                 updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and task_id = $4 returning {TASK}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.title.as_str())
        .bind(v.status.as_str())
        .bind(v.blocker.as_ref().map(Text::as_str))
        .bind(v.due_on)
        .bind(v.assignee.as_ref().map(UserId::as_str))
        .bind(v.waiting_on.as_ref().map(StakeholderId::as_str))
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "task.updated",
            Some(id.as_str()),
        )
        .await?;
        task(row).map(Some)
    }

    pub async fn remove_task(&mut self, id: &TaskId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "delete from tasks where tenant_id = $1 and company_id = $2 and project_id = $3 and task_id = $4",
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
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "task.removed",
            Some(id.as_str()),
        )
        .await?;
        Ok(true)
    }

    /// The stakeholder a task waits on must belong to this company.
    async fn check_waiting_on(&mut self, v: &TaskIn) -> Result<(), StoreError> {
        let Some(who) = &v.waiting_on else { return Ok(()) };
        let (t, c, _) = self.keys();
        let found: bool = sqlx::query_scalar(
            "select exists (select 1 from stakeholders where tenant_id = $1 and company_id = $2 and stakeholder_id = $3)",
        )
        .bind(&t)
        .bind(&c)
        .bind(who.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        if found {
            Ok(())
        } else {
            Err(StoreError::Missing("waiting_on"))
        }
    }

    /// The decisions log, newest decision first.
    pub async fn decisions(&mut self) -> Result<Vec<Decision>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {DECISION} from decisions where tenant_id = $1 and company_id = $2 and project_id = $3
             order by decided_at desc, decision_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(decision)
        .collect()
    }

    /// Up to `limit` decisions, newest decision first, after decision `after` (the last of the
    /// previous page). `StoreError::Missing("after")` if `after` is not a decision of this project.
    pub async fn decisions_page(
        &mut self,
        after: Option<&DecisionId>,
        limit: u32,
    ) -> Result<Page<Decision>, StoreError> {
        let (t, c, p) = self.keys();
        let from: Option<(OffsetDateTime, String)> = match after {
            None => None,
            Some(a) => Some(
                sqlx::query_as(
                    "select decided_at, decision_id from decisions
                     where tenant_id = $1 and company_id = $2 and project_id = $3 and decision_id = $4",
                )
                .bind(&t)
                .bind(&c)
                .bind(&p)
                .bind(a.as_str())
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(StoreError::Missing("after"))?,
            ),
        };
        let (at, id) = from.unzip();
        // The order mixes directions (decided_at desc, decision_id asc), so no row comparison.
        let rows = sqlx::query(&format!(
            "select {DECISION} from decisions where tenant_id = $1 and company_id = $2 and project_id = $3
                 and ($4::timestamptz is null or decided_at < $4 or (decided_at = $4 and decision_id > $5))
             order by decided_at desc, decision_id limit $6"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(at)
        .bind(id)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(decision)
        .collect::<Result<_, _>>()?;
        Ok(Page::of(rows, limit))
    }

    /// Appends a decision; the log has no update or delete. `None` if the project is not in this
    /// company.
    pub async fn record_decision(
        &mut self,
        id: &DecisionId,
        v: &DecisionIn,
        by: &Actor,
    ) -> Result<Option<Decision>, StoreError> {
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "insert into decisions (tenant_id, company_id, project_id, decision_id, title, rationale, decided_by,
                 decided_at, recorded_by)
             select $1, $2, $3, $4, $5, $6, $7, $8, $9
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             returning {DECISION}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.title.as_str())
        .bind(v.rationale.as_str())
        .bind(v.decided_by.as_str())
        .bind(v.decided_at)
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
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "decision.recorded",
            Some(id.as_str()),
        )
        .await?;
        decision(row).map(Some)
    }
}

pub(crate) fn task(r: PgRow) -> Result<Task, StoreError> {
    let assignee: Option<String> = r.try_get("assignee")?;
    let waiting_on: Option<String> = r.try_get("waiting_on")?;
    Ok(Task {
        id: id("task id", TaskId::new, r.try_get("task_id")?)?,
        title: name(r.try_get("title")?, "title")?,
        status: TaskStatus::parse(r.try_get("status")?)?,
        blocker: opt(r.try_get("blocker")?, "blocker", text)?,
        due_on: r.try_get("due_on")?,
        assignee: assignee.map(|a| id("user id", UserId::new, a)).transpose()?,
        waiting_on: waiting_on
            .map(|w| id("stakeholder id", StakeholderId::new, w))
            .transpose()?,
        waiting_since: r.try_get("waiting_since")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

fn decision(r: PgRow) -> Result<Decision, StoreError> {
    Ok(Decision {
        id: id("decision id", DecisionId::new, r.try_get("decision_id")?)?,
        title: name(r.try_get("title")?, "title")?,
        rationale: text(r.try_get("rationale")?, "rationale")?,
        decided_by: name(r.try_get("decided_by")?, "decided by")?,
        decided_at: r.try_get("decided_at")?,
        recorded_by: id("user id", UserId::new, r.try_get("recorded_by")?)?,
        created_at: r.try_get("created_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_holds_at_most_its_limit_and_says_whether_more_follow() {
        assert_eq!(
            Page::of(vec![1, 2, 3], 2),
            Page {
                items: vec![1, 2],
                more: true
            }
        );
        assert_eq!(
            Page::of(vec![1, 2], 2),
            Page {
                items: vec![1, 2],
                more: false
            }
        );
        assert_eq!(
            Page::of(Vec::<u8>::new(), 2),
            Page {
                items: vec![],
                more: false
            }
        );
    }

    #[test]
    fn a_blocked_task_needs_a_blocker() {
        let mut t = TaskIn {
            title: Name::new("Get VPN access").unwrap(),
            status: TaskStatus::Blocked,
            blocker: None,
            due_on: None,
            assignee: None,
            waiting_on: None,
        };
        assert!(matches!(t.check(), Err(StoreError::Rejected("blocker_required"))));
        t.blocker = Some(Text::new("Waiting on IT ticket").unwrap());
        assert!(t.check().is_ok());
        t.status = TaskStatus::WaitingOnCustomer;
        t.blocker = None;
        assert!(t.check().is_ok());
    }
}

//! A project's tasks (with blockers and a "waiting on customer" state) and its decisions log.

use oryxa_core::UserId;
use oryxa_fde_core::{AccessRequestId, CriterionId, DecisionId, Stage, StakeholderId, TaskId};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::{Date, OffsetDateTime};

use crate::{
    Actor, Name, ProjectTx, Saved, StoreError, Text, audit, id, name, opt, row_version, stale, text, unique_violation,
};

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
    /// The project's access request it is blocked on: granted, it unblocks the task.
    pub blocked_by: Option<AccessRequestId>,
    /// The project's success criterion it works towards.
    pub criterion: Option<CriterionId>,
    /// The stage of the plan it belongs to; tasks from before stages were kept have none.
    pub stage: Option<Stage>,
    /// Its place in the project's order; lists are sorted by it.
    pub position: i64,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    /// Bumped by every change to the task; a save names the version it read.
    pub version: u32,
}

impl Task {
    /// Whether the task already holds these fields. Its place is not one: whether a move would change
    /// it depends on the column it is in (`ProjectTx::at_place`).
    fn holds(&self, v: &TaskIn) -> bool {
        self.title == v.title
            && self.status == v.status
            && self.blocker == v.blocker
            && self.due_on == v.due_on
            && self.assignee == v.assignee
            && self.waiting_on == v.waiting_on
            && self.blocked_by == v.blocked_by
            && self.criterion == v.criterion
            && self.stage == v.stage
    }
}

#[derive(Debug, Clone)]
pub struct TaskIn {
    pub title: Name,
    pub status: TaskStatus,
    pub blocker: Option<Text>,
    pub due_on: Option<Date>,
    pub assignee: Option<UserId>,
    pub waiting_on: Option<StakeholderId>,
    /// Only while the task is blocked.
    pub blocked_by: Option<AccessRequestId>,
    pub criterion: Option<CriterionId>,
    pub stage: Option<Stage>,
    /// Where it goes. `None` puts a new task, or one whose status changes, after the project's last
    /// task, and leaves any other task where it is.
    pub place: Option<TaskPlace>,
}

/// Next to another task of the project, one with the status the moved task will have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskPlace {
    Before(TaskId),
    After(TaskId),
}

/// The gap between neighbouring positions after an append or a renumbering.
const STEP: i64 = 1 << 16;

impl TaskIn {
    /// What the save itself must hold, before anything is looked up.
    pub fn check(&self) -> Result<(), StoreError> {
        if self.status == TaskStatus::Blocked && self.blocker.is_none() {
            Err(StoreError::Rejected("blocker_required"))
        } else if self.blocked_by.is_some() && self.status != TaskStatus::Blocked {
            Err(StoreError::Rejected("blocked_by_needs_blocked"))
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

pub(crate) const TASK: &str = "task_id, title, status, blocker, due_on, assignee, waiting_on, waiting_since, blocked_by, \
     criterion, stage, position, created_at, updated_at, version";
const DECISION: &str = "decision_id, title, rationale, decided_by, decided_at, recorded_by, created_at";

impl ProjectTx {
    /// Up to `limit` tasks, in the project's order, after task `after` (the last of the previous page).
    /// `StoreError::Missing("after")` if `after` is not a task of this project.
    pub async fn tasks_page(&mut self, after: Option<&TaskId>, limit: u32) -> Result<Page<Task>, StoreError> {
        let (t, c, p) = self.keys();
        let from: Option<(i64, String)> = match after {
            None => None,
            Some(a) => Some(
                sqlx::query_as(
                    "select position, task_id from tasks
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
                 and ($4::bigint is null or (position, task_id) > ($4, $5))
             order by position, task_id limit $6"
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

    /// The project's tasks in its order; with `criterion`, only those linked to it.
    pub async fn tasks(&mut self, criterion: Option<&CriterionId>) -> Result<Vec<Task>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {TASK} from tasks where tenant_id = $1 and company_id = $2 and project_id = $3
                 and ($4::text is null or criterion = $4)
             order by position, task_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(criterion.map(CriterionId::as_str))
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
        self.check_blocked_by(v).await?;
        self.check_criterion(v).await?;
        let position = self.position(None, v).await?;
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "insert into tasks (tenant_id, company_id, project_id, task_id, title, status, blocker, due_on, assignee,
                 waiting_on, waiting_since, created_by, blocked_by, done_at, criterion, position, stage)
             select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $6 = 'waiting_on_customer' then now() end, $11,
                 $12, case when $6 = 'done' then now() end, $13, $14, $15
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
        .bind(v.blocked_by.as_ref().map(AccessRequestId::as_str))
        .bind(v.criterion.as_ref().map(CriterionId::as_str))
        .bind(position)
        .bind(v.stage.map(Stage::as_str))
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

    /// Takes the order lock and the task's row lock, then checks the version: the task, or `Stale`
    /// with it if it has moved on from version `expected`. `None` if there is no such task. A save
    /// runs this before it looks at any id it names, so a stale save answers stale.
    pub async fn lock_task(&mut self, id: &TaskId, expected: Option<u32>) -> Result<Option<Saved<Task>>, StoreError> {
        let (t, c, p) = self.keys();
        // The order lock before the row lock: a renumbering under the order lock locks every task row.
        self.lock_task_order().await?;
        // The row lock orders concurrent saves: the later one reads what the earlier one wrote.
        let row = sqlx::query(&format!(
            "select {TASK} from tasks
             where tenant_id = $1 and company_id = $2 and project_id = $3 and task_id = $4 for update"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let current = task(row)?;
        Ok(Some(if stale(expected, current.version) {
            Saved::Stale(current)
        } else {
            Saved::Current(current)
        }))
    }

    /// Replaces the task's fields, unless it has moved on from version `expected` or already holds
    /// them at the place named. Waiting on the customer keeps its start time while the status stays
    /// `WaitingOnCustomer` and clears when it leaves. `None` if there is no such task.
    pub async fn update_task(
        &mut self,
        id: &TaskId,
        expected: Option<u32>,
        v: &TaskIn,
        by: &Actor,
    ) -> Result<Option<Saved<Task>>, StoreError> {
        v.check()?;
        let current = match self.lock_task(id, expected).await? {
            None => return Ok(None),
            Some(Saved::Stale(current)) => return Ok(Some(Saved::Stale(current))),
            Some(Saved::Current(current)) => current,
        };
        self.check_waiting_on(v).await?;
        self.check_blocked_by(v).await?;
        self.check_criterion(v).await?;
        // The anchor is checked even when nothing else changes.
        let at_place = self.at_place(&current, v).await?;
        if at_place && current.holds(v) {
            return Ok(Some(Saved::Current(current)));
        }
        let position = if !at_place || current.status != v.status {
            Some(self.position(Some(id), v).await?)
        } else {
            None
        };
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "update tasks set title = $5, status = $6, blocker = $7, due_on = $8, assignee = $9, waiting_on = $10,
                 waiting_since = case when $6 = 'waiting_on_customer' then coalesce(waiting_since, now()) end,
                 done_at = case when $6 = 'done' then coalesce(done_at, now()) end,
                 blocked_by = $11, criterion = $12, position = coalesce($13, position), stage = $14,
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
        .bind(v.blocked_by.as_ref().map(AccessRequestId::as_str))
        .bind(v.criterion.as_ref().map(CriterionId::as_str))
        .bind(position)
        .bind(v.stage.map(Stage::as_str))
        .fetch_one(&mut *self.tx)
        .await?;
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
        Ok(Some(Saved::Current(task(row)?)))
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

    /// Holds the project's task-order lock until the transaction ends, so two moves never pick the
    /// same gap. Taking it again in the same transaction is a no-op. Anything that updates task rows
    /// of the project takes it first, so it cannot deadlock with a renumbering.
    pub(crate) async fn lock_task_order(&mut self) -> Result<(), StoreError> {
        let (t, _, p) = self.keys();
        sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("oryxa-fde|task-order|{t}|{p}"))
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    /// Whether `current` already stands where `v` puts it: no place named, or directly after (or
    /// before) the anchor in the column of the status it keeps. The anchor must be another task of
    /// this project with that status, or `Missing("before")` / `Missing("after")`.
    async fn at_place(&mut self, current: &Task, v: &TaskIn) -> Result<bool, StoreError> {
        let (anchor, after, field) = match &v.place {
            None => return Ok(true),
            Some(TaskPlace::Before(a)) => (a, false, "before"),
            Some(TaskPlace::After(a)) => (a, true, "after"),
        };
        let (t, c, p) = self.keys();
        // Positions are unique in a project, so they alone give the (position, task_id) order.
        let adjacent: Option<bool> = sqlx::query_scalar(
            "select case when $7 then a.position < $8 else a.position > $8 end
                 and not exists (select 1 from tasks n
                     where n.tenant_id = $1 and n.company_id = $2 and n.project_id = $3 and n.status = $6
                       and n.position > least(a.position, $8) and n.position < greatest(a.position, $8))
             from tasks a
             where a.tenant_id = $1 and a.company_id = $2 and a.project_id = $3 and a.task_id = $4
               and a.task_id <> $5 and a.status = $6",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(anchor.as_str())
        .bind(current.id.as_str())
        .bind(v.status.as_str())
        .bind(after)
        .bind(current.position)
        .fetch_optional(&mut *self.tx)
        .await?;
        let adjacent = adjacent.ok_or(StoreError::Missing(field))?;
        Ok(adjacent && current.status == v.status)
    }

    /// Where task `me` (`None` while it is added) goes for `v`: next to its anchor, or after the
    /// project's last task. Takes the order lock.
    async fn position(&mut self, me: Option<&TaskId>, v: &TaskIn) -> Result<i64, StoreError> {
        self.lock_task_order().await?;
        let (t, c, p) = self.keys();
        let (anchor, after, field) = match &v.place {
            None => {
                let last: Option<i64> = sqlx::query_scalar(
                    "select max(position) from tasks where tenant_id = $1 and company_id = $2 and project_id = $3",
                )
                .bind(&t)
                .bind(&c)
                .bind(&p)
                .fetch_one(&mut *self.tx)
                .await?;
                return Ok(last.unwrap_or(0) + STEP);
            }
            Some(TaskPlace::Before(a)) => (a, false, "before"),
            Some(TaskPlace::After(a)) => (a, true, "after"),
        };
        // At most one renumbering: it leaves a gap of STEP between every two tasks.
        for _ in 0..2 {
            // The anchor's position and its neighbour's on the side the task goes, the task itself aside.
            let found: Option<(i64, Option<i64>)> = sqlx::query_as(
                "select a.position,
                     (select case when $6 then min(n.position) else max(n.position) end from tasks n
                      where n.tenant_id = $1 and n.company_id = $2 and n.project_id = $3
                        and n.task_id is distinct from $5
                        and case when $6 then n.position > a.position else n.position < a.position end)
                 from tasks a
                 where a.tenant_id = $1 and a.company_id = $2 and a.project_id = $3 and a.task_id = $4
                   and a.task_id is distinct from $5 and a.status = $7",
            )
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(anchor.as_str())
            .bind(me.map(TaskId::as_str))
            .bind(after)
            .bind(v.status.as_str())
            .fetch_optional(&mut *self.tx)
            .await?;
            let (at, next) = found.ok_or(StoreError::Missing(field))?;
            match next {
                None if after => return Ok(at + STEP),
                None => return Ok(at - STEP),
                Some(n) if (n - at).abs() > 1 => return Ok(at + (n - at) / 2),
                Some(_) => self.renumber_tasks().await?,
            }
        }
        Err(StoreError::Corrupt("task order"))
    }

    /// Spaces the project's tasks STEP apart, keeping their order. Runs under the order lock. Only
    /// positions change, so the tasks keep their versions (the `tasks_version` trigger, 0020).
    // ponytail: removing a stakeholder (company-wide, so it takes no project's order lock) can still
    // deadlock with a renumbering through `waiting_on`'s `on delete set null`; Postgres aborts one.
    async fn renumber_tasks(&mut self) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "update tasks t set position = o.n * $4
             from (select task_id, row_number() over (order by position, task_id) as n from tasks
                   where tenant_id = $1 and company_id = $2 and project_id = $3) o
             where t.tenant_id = $1 and t.company_id = $2 and t.project_id = $3 and t.task_id = o.task_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(STEP)
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// The criterion a task works towards must be one of this project's.
    async fn check_criterion(&mut self, v: &TaskIn) -> Result<(), StoreError> {
        let Some(criterion) = &v.criterion else { return Ok(()) };
        let (t, c, p) = self.keys();
        let found: bool = sqlx::query_scalar(
            "select exists (select 1 from criteria
                 where tenant_id = $1 and company_id = $2 and project_id = $3 and criterion_id = $4)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(criterion.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        if found {
            Ok(())
        } else {
            Err(StoreError::Missing("criterion"))
        }
    }

    /// The access request a task is blocked on must be one of this project's.
    async fn check_blocked_by(&mut self, v: &TaskIn) -> Result<(), StoreError> {
        let Some(access) = &v.blocked_by else { return Ok(()) };
        let (t, c, p) = self.keys();
        let found: bool = sqlx::query_scalar(
            "select exists (select 1 from access_requests
                 where tenant_id = $1 and company_id = $2 and project_id = $3 and access_request_id = $4)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(access.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        if found {
            Ok(())
        } else {
            Err(StoreError::Missing("blocked_by"))
        }
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
    let blocked_by: Option<String> = r.try_get("blocked_by")?;
    let criterion: Option<String> = r.try_get("criterion")?;
    let stage: Option<String> = r.try_get("stage")?;
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
        blocked_by: blocked_by
            .map(|a| id("access request id", AccessRequestId::new, a))
            .transpose()?,
        criterion: criterion.map(|c| id("criterion id", CriterionId::new, c)).transpose()?,
        stage: stage.as_deref().map(crate::projects::stage).transpose()?,
        position: r.try_get("position")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
        version: row_version(r.try_get("version")?)?,
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
    fn a_task_holds_a_save_only_when_every_field_matches() {
        let at = OffsetDateTime::UNIX_EPOCH;
        let v = TaskIn {
            title: Name::new("Get VPN access").unwrap(),
            status: TaskStatus::Blocked,
            blocker: Some(Text::new("IT ticket").unwrap()),
            due_on: Some(Date::from_calendar_date(2026, time::Month::November, 20).unwrap()),
            assignee: Some(UserId::new("user_1").unwrap()),
            waiting_on: Some(StakeholderId::new("stk_1").unwrap()),
            blocked_by: Some(AccessRequestId::new("acc_1").unwrap()),
            criterion: Some(CriterionId::new("crt_1").unwrap()),
            stage: Some(Stage::Access),
            place: None,
        };
        let stored = Task {
            id: TaskId::new("tsk_1").unwrap(),
            title: v.title.clone(),
            status: v.status,
            blocker: v.blocker.clone(),
            due_on: v.due_on,
            assignee: v.assignee.clone(),
            waiting_on: v.waiting_on.clone(),
            waiting_since: Some(at),
            blocked_by: v.blocked_by.clone(),
            criterion: v.criterion.clone(),
            stage: v.stage,
            position: 1 << 16,
            created_at: at,
            updated_at: at,
            version: 3,
        };
        assert!(
            stored.holds(&v),
            "the stamps, the version and the position are not the caller's to set"
        );
        // A move to where the task already is holds too; whether it is there is the column's to say.
        let moved = TaskIn {
            place: Some(TaskPlace::After(TaskId::new("tsk_2").unwrap())),
            ..v.clone()
        };
        assert!(stored.holds(&moved));
        let changes: [fn(&mut TaskIn); 10] = [
            |v| v.title = Name::new("Get VPN access now").unwrap(),
            |v| v.status = TaskStatus::Todo,
            |v| v.blocker = None,
            |v| v.due_on = None,
            |v| v.assignee = None,
            |v| v.waiting_on = None,
            |v| v.blocked_by = None,
            |v| v.criterion = None,
            |v| v.stage = None,
            |v| v.stage = Some(Stage::Build),
        ];
        for (i, change) in changes.into_iter().enumerate() {
            let mut other = v.clone();
            change(&mut other);
            assert!(!stored.holds(&other), "field {i}");
        }
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
            blocked_by: None,
            criterion: None,
            stage: None,
            place: None,
        };
        assert!(matches!(t.check(), Err(StoreError::Rejected("blocker_required"))));
        t.blocker = Some(Text::new("Waiting on IT ticket").unwrap());
        assert!(t.check().is_ok());
        t.blocked_by = Some(AccessRequestId::new("acc_1").unwrap());
        assert!(t.check().is_ok(), "blocked on an access request");
        t.status = TaskStatus::WaitingOnCustomer;
        t.blocker = None;
        assert!(matches!(
            t.check(),
            Err(StoreError::Rejected("blocked_by_needs_blocked"))
        ));
        t.blocked_by = None;
        assert!(t.check().is_ok());
    }
}

//! What the lifecycle engine keeps for a project: the events it has acted on, the activity feed,
//! the latest eval result of each success criterion, and suggestions to the FDE. Drafted weekly
//! updates are in `updates`.

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{AccessRequestId, AgentRunId, CompanyId, CriterionId, EvalRunId, ProjectId, ProjectScope, TaskId};
use oryxa_fde_events::RunOutcome;
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{Actor, ProjectTx, Store, StoreError, audit, id};

/// An event id from a verified envelope (`evt_<hex>`), checked again before it reaches SQL.
fn event_key(raw: &str) -> Result<&str, StoreError> {
    let ok =
        !raw.is_empty() && raw.len() <= 128 && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(raw)
    } else {
        Err(StoreError::Rejected("event_id"))
    }
}

/// One entry of a project's activity: what happened, as ids, outcomes and counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityIn {
    AgentRun {
        run: AgentRunId,
        outcome: RunOutcome,
    },
    EvalRun {
        run: EvalRunId,
        passed: u32,
        failed: u32,
    },
    /// A pull request merged.
    PullRequest {
        number: u32,
    },
    PullRequestOpened {
        number: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    /// The event it came from.
    pub event_id: String,
    pub what: ActivityIn,
    pub occurred_at: OffsetDateTime,
}

fn outcome_str(o: RunOutcome) -> &'static str {
    match o {
        RunOutcome::Succeeded => "succeeded",
        RunOutcome::Failed => "failed",
        RunOutcome::Rejected => "rejected",
        RunOutcome::Cancelled => "cancelled",
    }
}

fn outcome_of(raw: &str) -> Result<RunOutcome, StoreError> {
    [
        RunOutcome::Succeeded,
        RunOutcome::Failed,
        RunOutcome::Rejected,
        RunOutcome::Cancelled,
    ]
    .into_iter()
    .find(|o| outcome_str(*o) == raw)
    .ok_or(StoreError::Corrupt("run outcome"))
}

/// What the engine may suggest; it never acts on a suggestion itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestionKind {
    /// Every success criterion passes: the FDE may move the project to deploy.
    ReadyToDeploy,
}

impl SuggestionKind {
    pub const ALL: [SuggestionKind; 1] = [SuggestionKind::ReadyToDeploy];

    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionKind::ReadyToDeploy => "ready_to_deploy",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        Self::ALL
            .into_iter()
            .find(|k| k.as_str() == raw)
            .ok_or(StoreError::Corrupt("suggestion kind"))
    }
}

/// The latest value an eval run measured for one success criterion, and whether it meets the
/// criterion's target.
#[derive(Debug, Clone, PartialEq)]
pub struct CriterionResult {
    pub criterion: CriterionId,
    pub value: f64,
    pub passing: bool,
    pub measured_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub kind: SuggestionKind,
    /// The eval run that showed it.
    pub eval_run: EvalRunId,
    pub raised_at: OffsetDateTime,
}

const ACTIVITY: &str = "event_id, kind, subject, outcome, passed, failed, occurred_at";

impl ProjectTx {
    /// Records that the engine acts on `event_id` in this transaction: `false` if it already has,
    /// and the event must change nothing.
    pub async fn first_delivery(&mut self, event_id: &str) -> Result<bool, StoreError> {
        let (t, c, _) = self.keys();
        let n = sqlx::query(
            "insert into processed_events (tenant_id, company_id, event_id) values ($1, $2, $3)
             on conflict do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(event_key(event_id)?)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(n == 1)
    }

    /// Adds an entry to the project's activity, once per event.
    pub async fn record_activity(
        &mut self,
        event_id: &str,
        what: &ActivityIn,
        at: OffsetDateTime,
    ) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        let (kind, subject, outcome, passed, failed) = match what {
            ActivityIn::AgentRun { run, outcome } => (
                "agent_run_finished",
                run.to_string(),
                Some(outcome_str(*outcome)),
                None,
                None,
            ),
            ActivityIn::EvalRun { run, passed, failed } => (
                "eval_run_finished",
                run.to_string(),
                None,
                Some(i32::try_from(*passed).map_err(|_| StoreError::Rejected("passed"))?),
                Some(i32::try_from(*failed).map_err(|_| StoreError::Rejected("failed"))?),
            ),
            ActivityIn::PullRequest { number } => ("pull_request_merged", number.to_string(), None, None, None),
            ActivityIn::PullRequestOpened { number } => ("pull_request_opened", number.to_string(), None, None, None),
        };
        sqlx::query(
            "insert into project_activity (tenant_id, company_id, project_id, event_id, kind, subject, outcome, passed,
                 failed, occurred_at)
             select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             on conflict do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(event_key(event_id)?)
        .bind(kind)
        .bind(subject)
        .bind(outcome)
        .bind(passed)
        .bind(failed)
        .bind(at)
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// The project's activity, newest first.
    pub async fn activity(&mut self, limit: u32) -> Result<Vec<Activity>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {ACTIVITY} from project_activity where tenant_id = $1 and company_id = $2 and project_id = $3
             order by occurred_at desc, event_id limit $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(i64::from(limit))
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(activity)
        .collect()
    }

    /// The project's activity in `[from, to)`, oldest first.
    pub async fn activity_between(
        &mut self,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<Activity>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {ACTIVITY} from project_activity where tenant_id = $1 and company_id = $2 and project_id = $3
                 and occurred_at >= $4 and occurred_at < $5
             order by occurred_at, event_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(from)
        .bind(to)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(activity)
        .collect()
    }

    /// Unblocks the project's tasks blocked on `access`, if the request is still granted: back to
    /// do, with the blocker cleared. Returns the tasks it moved. The request's row is locked until
    /// commit, so a revocation cannot land between the check and the unblock.
    pub async fn unblock_tasks_blocked_by(
        &mut self,
        access: &AccessRequestId,
        by: &Actor,
    ) -> Result<Vec<TaskId>, StoreError> {
        let (t, c, p) = self.keys();
        // The event says it was granted; the store says whether it still is (a late delivery).
        let status: Option<String> = sqlx::query_scalar(
            "select status from access_requests
             where tenant_id = $1 and company_id = $2 and project_id = $3 and access_request_id = $4 for share",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(access.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        if status.as_deref() != Some("granted") {
            return Ok(Vec::new());
        }
        let raw: Vec<String> = sqlx::query_scalar(
            "update tasks set status = 'todo', blocker = null, blocked_by = null, updated_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and blocked_by = $4 and status = 'blocked'
             returning task_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(access.as_str())
        .fetch_all(&mut *self.tx)
        .await?;
        let s = self.scope.clone();
        let mut moved = Vec::with_capacity(raw.len());
        for r in raw {
            let task = id("task id", TaskId::new, r)?;
            audit(
                &mut self.tx,
                &s.company,
                Some(&s.project),
                by,
                "task.unblocked",
                Some(task.as_str()),
            )
            .await?;
            moved.push(task);
        }
        Ok(moved)
    }

    /// Records the value an eval run measured for one of the project's criteria, replacing the
    /// last. `false` if the criterion is not this project's.
    pub async fn record_criterion_result(
        &mut self,
        criterion: &CriterionId,
        eval_run: &EvalRunId,
        value: f64,
    ) -> Result<bool, StoreError> {
        if !value.is_finite() {
            return Err(StoreError::Rejected("value"));
        }
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "insert into criterion_results (tenant_id, company_id, project_id, criterion_id, eval_run_id, value)
             select $1, $2, $3, $4, $5, $6
             where exists (select 1 from criteria
                 where tenant_id = $1 and company_id = $2 and project_id = $3 and criterion_id = $4)
             on conflict (tenant_id, criterion_id) do update
                 set eval_run_id = excluded.eval_run_id, value = excluded.value, measured_at = now()",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(criterion.as_str())
        .bind(eval_run.as_str())
        .bind(value)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(n == 1)
    }

    /// Whether the project has success criteria and every one's latest result meets its target.
    pub async fn criteria_met(&mut self) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let met: bool = sqlx::query_scalar(
            "select coalesce(bool_and(r.value is not null and case c.comparator
                     when 'at_least' then r.value >= c.target
                     when 'at_most' then r.value <= c.target end), false)
             from criteria c
             left join criterion_results r on r.tenant_id = c.tenant_id and r.criterion_id = c.criterion_id
             where c.tenant_id = $1 and c.company_id = $2 and c.project_id = $3",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_one(&mut *self.tx)
        .await?;
        Ok(met)
    }

    /// The latest result of each of the project's criteria that has one, judged as
    /// [`ProjectTx::criteria_met`] judges them.
    pub async fn latest_criterion_results(&mut self) -> Result<Vec<CriterionResult>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "select r.criterion_id, r.value, r.measured_at,
                 case c.comparator when 'at_least' then r.value >= c.target when 'at_most' then r.value <= c.target end
                     as passing
             from criterion_results r
             join criteria c on c.tenant_id = r.tenant_id and c.criterion_id = r.criterion_id
             where r.tenant_id = $1 and r.company_id = $2 and r.project_id = $3
             order by r.criterion_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            Ok(CriterionResult {
                criterion: id("criterion id", CriterionId::new, r.try_get("criterion_id")?)?,
                value: r.try_get("value")?,
                passing: r.try_get::<Option<bool>, _>("passing")?.unwrap_or(false),
                measured_at: r.try_get("measured_at")?,
            })
        })
        .collect()
    }

    /// Raises a suggestion unless one of its kind is open: `true` if raised (new, or again after it
    /// was dismissed).
    pub async fn raise_suggestion(&mut self, kind: SuggestionKind, eval_run: &EvalRunId) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let raised: Option<i32> = sqlx::query_scalar(
            "insert into suggestions (tenant_id, company_id, project_id, kind, eval_run_id)
             select $1, $2, $3, $4, $5
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             on conflict (tenant_id, project_id, kind) do update
                 set eval_run_id = excluded.eval_run_id, raised_at = now(), dismissed_by = null, dismissed_at = null
                 where suggestions.dismissed_at is not null
             returning 1",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(kind.as_str())
        .bind(eval_run.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        Ok(raised.is_some())
    }

    /// The project's open suggestions.
    pub async fn suggestions(&mut self) -> Result<Vec<Suggestion>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "select kind, eval_run_id, raised_at from suggestions
             where tenant_id = $1 and company_id = $2 and project_id = $3 and dismissed_at is null order by kind",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            Ok(Suggestion {
                kind: SuggestionKind::parse(r.try_get("kind")?)?,
                eval_run: id("eval run id", EvalRunId::new, r.try_get("eval_run_id")?)?,
                raised_at: r.try_get("raised_at")?,
            })
        })
        .collect()
    }

    /// Dismisses an open suggestion. `false` if there is none of that kind.
    pub async fn dismiss_suggestion(&mut self, kind: SuggestionKind, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "update suggestions set dismissed_by = $5, dismissed_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and kind = $4 and dismissed_at is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(kind.as_str())
        .bind(by.user.as_str())
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
                "suggestion.dismissed",
                Some(kind.as_str()),
            )
            .await?;
        }
        Ok(n == 1)
    }
}

impl Store {
    /// Every project's keys, across tenants, for the weekly drafts: read through the reconciler's
    /// role, which reads exactly these and nothing else of a project. Each draft then reads its
    /// project, stage included, under that project's own scope.
    pub async fn projects_for_weekly_updates(&self) -> Result<Vec<ProjectScope>, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_grants").execute(&mut *tx).await?;
        let rows = sqlx::query(
            "select tenant_id, company_id, project_id from projects order by tenant_id, company_id, project_id",
        )
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        rows.into_iter()
            .map(|r| {
                let tenant = id("tenant id", TenantId::new, r.try_get("tenant_id")?)?;
                let company = id("company id", CompanyId::new, r.try_get("company_id")?)?;
                let project = id("project id", ProjectId::new, r.try_get("project_id")?)?;
                Ok(oryxa_fde_core::CompanyScope::new(tenant, company).project(project))
            })
            .collect()
    }
}

fn activity(r: PgRow) -> Result<Activity, StoreError> {
    let kind: String = r.try_get("kind")?;
    let subject: String = r.try_get("subject")?;
    let count = |col: &str| -> Result<u32, StoreError> {
        let v: Option<i32> = r.try_get(col)?;
        v.and_then(|n| u32::try_from(n).ok())
            .ok_or(StoreError::Corrupt("activity count"))
    };
    let what = match kind.as_str() {
        "agent_run_finished" => ActivityIn::AgentRun {
            run: id("agent run id", AgentRunId::new, subject)?,
            outcome: outcome_of(
                r.try_get::<Option<&str>, _>("outcome")?
                    .ok_or(StoreError::Corrupt("outcome"))?,
            )?,
        },
        "eval_run_finished" => ActivityIn::EvalRun {
            run: id("eval run id", EvalRunId::new, subject)?,
            passed: count("passed")?,
            failed: count("failed")?,
        },
        "pull_request_merged" => ActivityIn::PullRequest {
            number: subject
                .parse()
                .map_err(|_| StoreError::Corrupt("pull request number"))?,
        },
        "pull_request_opened" => ActivityIn::PullRequestOpened {
            number: subject
                .parse()
                .map_err(|_| StoreError::Corrupt("pull request number"))?,
        },
        _ => return Err(StoreError::Corrupt("activity kind")),
    };
    Ok(Activity {
        event_id: r.try_get("event_id")?,
        what,
        occurred_at: r.try_get("occurred_at")?,
    })
}

/// Who the engine's own changes are recorded as, for the event that caused them.
pub fn engine_actor(event_id: &str) -> Result<Actor, StoreError> {
    Ok(Actor {
        user: UserId::new("fde_lifecycle").map_err(|_| StoreError::Corrupt("engine actor"))?,
        request_id: event_key(event_id)?.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids_are_checked_before_they_reach_sql() {
        assert!(event_key("evt_0193f2a1b2c3").is_ok());
        for bad in ["", "evt 1", "evt;drop", "evt|x", &"e".repeat(129)] {
            assert!(event_key(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn outcomes_and_kinds_round_trip() {
        for o in [
            RunOutcome::Succeeded,
            RunOutcome::Failed,
            RunOutcome::Rejected,
            RunOutcome::Cancelled,
        ] {
            assert_eq!(outcome_of(outcome_str(o)).unwrap(), o);
        }
        for k in SuggestionKind::ALL {
            assert_eq!(SuggestionKind::parse(k.as_str()).unwrap(), k);
        }
        assert_eq!(engine_actor("evt_1").unwrap().user.as_str(), "fde_lifecycle");
    }
}

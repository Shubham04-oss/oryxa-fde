//! Agent runs (`oryxa-fde-agent`): each run, its transcript, the approvals it asked for, the project's agent
//! budget, and which run holds the company's sandbox. Every function is on a [`ProjectTx`], so it reads and writes
//! one project of one company (the sandbox lease: one company); row-level security holds the rest back. A run's
//! end, the project's budget use and `agent-run.finished` commit together.
//!
//! Any API task may drive a run, so what must hold across tasks lives here: the company's sandbox goes to one run
//! at a time, and a run's share of the budget is reserved under a lock on the project's budget row when it starts.
//! A run's driver keeps `alive_until` ahead of now; a run whose driver is gone stops counting against the budget,
//! and its lease lapses.
//!
//! The run's state machine is the agent's to define: it is kept as JSON (`state`) and not read here.

use std::time::Duration;

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{AgentRunId, CompanyId, CompanyScope, ProjectId, ProjectScope};
use oryxa_fde_events::{AgentRunFinished, RunOutcome};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{Actor, ProjectTx, Store, StoreError, audit, enqueue, id, unique_violation};

/// A run as stored. Approval and tool call ids are `oryxa-fde-agent`'s validated ids, passed as text.
// ponytail: ApprovalId and ToolCallId live in oryxa-fde-agent; move them to oryxa-fde-core to type them here too.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRunRow {
    pub id: AgentRunId,
    /// The FDE's text: never in events or logs.
    pub task: String,
    pub repository: serde_json::Value,
    pub created_by: UserId,
    pub request_id: String,
    pub created_at: OffsetDateTime,
    pub started_at: Option<OffsetDateTime>,
    pub ended_at: Option<OffsetDateTime>,
    /// The agent's run state machine, as it serialises it.
    pub state: serde_json::Value,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub delivery: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDecision {
    /// `approved` or `rejected`.
    pub outcome: String,
    pub by: UserId,
    pub at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentApprovalRow {
    pub run: AgentRunId,
    pub id: String,
    pub tool_call_id: String,
    pub action: String,
    pub title: String,
    pub tool: String,
    /// The tool's full input, as JSON text.
    pub input: String,
    pub requested_at: OffsetDateTime,
    pub decision: Option<AgentDecision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentDecided {
    Recorded,
    /// Someone decided first; the first decision stands.
    AlreadyDecided,
    NotFound,
}

/// A project's own agent budget; `None` parts fall back to the service's default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AgentBudget {
    pub minutes: Option<u32>,
    pub spend_usd_micros: Option<u64>,
}

/// What a project's ended runs used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AgentSpend {
    pub seconds: u64,
    pub usd_micros: u64,
}

// JSON goes in and out as text (cast in SQL), so the store needs no JSON support from sqlx.
const RUN: &str = "run_id, task, repository::text as repository, created_by, request_id, created_at, started_at, \
    ended_at, state::text as state, input_tokens, output_tokens, delivery::text as delivery";
const APPROVAL: &str = "run_id, approval_id, tool_call_id, action, title, tool, input, requested_at, decision, \
    decided_by, decided_at";

fn count(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::Rejected("count_too_large"))
}

fn uncount(value: i64, what: &'static str) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::Corrupt(what))
}

fn json(raw: String, what: &'static str) -> Result<serde_json::Value, StoreError> {
    serde_json::from_str(&raw).map_err(|_| StoreError::Corrupt(what))
}

fn run_row(r: PgRow) -> Result<AgentRunRow, StoreError> {
    Ok(AgentRunRow {
        id: id("agent run id", AgentRunId::new, r.try_get("run_id")?)?,
        task: r.try_get("task")?,
        repository: json(r.try_get("repository")?, "repository")?,
        created_by: id("user id", UserId::new, r.try_get("created_by")?)?,
        request_id: r.try_get("request_id")?,
        created_at: r.try_get("created_at")?,
        started_at: r.try_get("started_at")?,
        ended_at: r.try_get("ended_at")?,
        state: json(r.try_get("state")?, "agent run state")?,
        input_tokens: uncount(r.try_get("input_tokens")?, "input tokens")?,
        output_tokens: uncount(r.try_get("output_tokens")?, "output tokens")?,
        delivery: json(r.try_get("delivery")?, "delivery")?,
    })
}

fn approval_row(r: PgRow) -> Result<AgentApprovalRow, StoreError> {
    let decision = match r.try_get::<Option<String>, _>("decision")? {
        None => None,
        Some(outcome) => Some(AgentDecision {
            outcome,
            by: id("user id", UserId::new, r.try_get("decided_by")?)?,
            at: r.try_get("decided_at")?,
        }),
    };
    Ok(AgentApprovalRow {
        run: id("agent run id", AgentRunId::new, r.try_get("run_id")?)?,
        id: r.try_get("approval_id")?,
        tool_call_id: r.try_get("tool_call_id")?,
        action: r.try_get("action")?,
        title: r.try_get("title")?,
        tool: r.try_get("tool")?,
        input: r.try_get("input")?,
        requested_at: r.try_get("requested_at")?,
        decision,
    })
}

impl ProjectTx {
    /// Stores a new run in this project. A run id already used in the tenant is a conflict.
    pub async fn create_agent_run(&mut self, run: &AgentRunRow, by: &Actor) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into agent_runs (tenant_id, company_id, project_id, run_id, task, repository, created_by,
                 request_id, created_at, state, delivery)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.id.as_str())
        .bind(&run.task)
        .bind(run.repository.to_string())
        .bind(run.created_by.as_str())
        .bind(&run.request_id)
        .bind(run.created_at)
        .bind(run.state.to_string())
        .bind(run.delivery.to_string())
        .execute(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        audit(
            &mut self.tx,
            &self.scope.company,
            Some(&self.scope.project),
            by,
            "agent_run_created",
            Some(run.id.as_str()),
        )
        .await
    }

    pub async fn agent_run(&mut self, run: &AgentRunId) -> Result<Option<AgentRunRow>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {RUN} from agent_runs where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(run_row)
        .transpose()
    }

    /// The project's runs, newest first.
    pub async fn agent_runs(&mut self) -> Result<Vec<AgentRunRow>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {RUN} from agent_runs where tenant_id = $1 and company_id = $2 and project_id = $3
             order by created_at desc, run_id desc"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(run_row)
        .collect()
    }

    /// Saves what the run's driver changes: state, times, use and delivery. `false` if there is no such run, or it
    /// has ended: an ended run is never changed.
    pub async fn update_agent_run(&mut self, run: &AgentRunRow) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let updated = sqlx::query(
            "update agent_runs set started_at = $5, ended_at = $6, state = $7::jsonb, input_tokens = $8,
                 output_tokens = $9, delivery = $10::jsonb
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 and ended_at is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.id.as_str())
        .bind(run.started_at)
        .bind(run.ended_at)
        .bind(run.state.to_string())
        .bind(count(run.input_tokens)?)
        .bind(count(run.output_tokens)?)
        .bind(run.delivery.to_string())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(updated == 1)
    }

    /// Appends one harness line; a line already stored under `seq` is left as it is.
    pub async fn append_agent_event(&mut self, run: &AgentRunId, seq: u64, line: &str) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into agent_run_events (tenant_id, company_id, project_id, run_id, seq, line)
             values ($1, $2, $3, $4, $5, $6) on conflict (tenant_id, run_id, seq) do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .bind(count(seq)?)
        .bind(line)
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// The run's harness lines, in order.
    pub async fn agent_events(&mut self, run: &AgentRunId) -> Result<Vec<String>, StoreError> {
        let (t, c, p) = self.keys();
        Ok(sqlx::query_scalar(
            "select line from agent_run_events
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 order by seq",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_all(&mut *self.tx)
        .await?)
    }

    pub async fn add_agent_approval(&mut self, a: &AgentApprovalRow) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into agent_approvals (tenant_id, company_id, project_id, run_id, approval_id, tool_call_id,
                 action, title, tool, input, requested_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(a.run.as_str())
        .bind(&a.id)
        .bind(&a.tool_call_id)
        .bind(&a.action)
        .bind(&a.title)
        .bind(&a.tool)
        .bind(&a.input)
        .bind(a.requested_at)
        .execute(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        Ok(())
    }

    pub async fn agent_approvals(&mut self, run: &AgentRunId) -> Result<Vec<AgentApprovalRow>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {APPROVAL} from agent_approvals
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4
             order by requested_at, approval_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(approval_row)
        .collect()
    }

    /// Records an FDE's decision if the approval has none yet, and audits it.
    pub async fn decide_agent_approval(
        &mut self,
        run: &AgentRunId,
        approval: &str,
        outcome: &str,
        by: &Actor,
    ) -> Result<AgentDecided, StoreError> {
        if !matches!(outcome, "approved" | "rejected") {
            return Err(StoreError::Rejected("decision"));
        }
        let (t, c, p) = self.keys();
        let updated = sqlx::query(
            "update agent_approvals set decision = $6, decided_by = $7, decided_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 and approval_id = $5
               and decision is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .bind(approval)
        .bind(outcome)
        .bind(by.user.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if updated == 1 {
            let action = if outcome == "approved" {
                "agent_approval_approved"
            } else {
                "agent_approval_rejected"
            };
            audit(
                &mut self.tx,
                &self.scope.company,
                Some(&self.scope.project),
                by,
                action,
                Some(approval),
            )
            .await?;
            return Ok(AgentDecided::Recorded);
        }
        let exists: bool = sqlx::query_scalar(
            "select exists (select 1 from agent_approvals
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 and approval_id = $5)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .bind(approval)
        .fetch_one(&mut *self.tx)
        .await?;
        Ok(if exists {
            AgentDecided::AlreadyDecided
        } else {
            AgentDecided::NotFound
        })
    }

    /// Asks the run to stop; `false` if there is no such run.
    pub async fn request_agent_cancel(&mut self, run: &AgentRunId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let updated = sqlx::query(
            "update agent_runs set cancel_requested = true
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if updated == 1 {
            audit(
                &mut self.tx,
                &self.scope.company,
                Some(&self.scope.project),
                by,
                "agent_run_cancelled",
                Some(run.as_str()),
            )
            .await?;
        }
        Ok(updated == 1)
    }

    /// Whether a cancel was asked for; `None` if there is no such run.
    pub async fn agent_cancel_requested(&mut self, run: &AgentRunId) -> Result<Option<bool>, StoreError> {
        let (t, c, p) = self.keys();
        Ok(sqlx::query_scalar(
            "select cancel_requested from agent_runs
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_optional(&mut *self.tx)
        .await?)
    }

    /// The project's own budget, and what its ended runs used.
    pub async fn agent_budget(&mut self) -> Result<(AgentBudget, AgentSpend), StoreError> {
        let (t, c, p) = self.keys();
        let row = sqlx::query(
            "select minutes, spend_usd_micros, used_seconds, used_usd_micros from agent_budgets
             where tenant_id = $1 and company_id = $2 and project_id = $3",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(r) = row else {
            return Ok((AgentBudget::default(), AgentSpend::default()));
        };
        let minutes: Option<i32> = r.try_get("minutes")?;
        let spend: Option<i64> = r.try_get("spend_usd_micros")?;
        Ok((
            AgentBudget {
                minutes: minutes
                    .map(|m| u32::try_from(m).map_err(|_| StoreError::Corrupt("budget")))
                    .transpose()?,
                spend_usd_micros: spend.map(|s| uncount(s, "budget")).transpose()?,
            },
            AgentSpend {
                seconds: uncount(r.try_get("used_seconds")?, "budget use")?,
                usd_micros: uncount(r.try_get("used_usd_micros")?, "budget use")?,
            },
        ))
    }

    /// Sets the project's own budget, and audits it.
    pub async fn set_agent_budget(&mut self, budget: AgentBudget, by: &Actor) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        let minutes = budget
            .minutes
            .map(|m| i32::try_from(m).map_err(|_| StoreError::Rejected("budget")))
            .transpose()?;
        let spend = budget.spend_usd_micros.map(count).transpose()?;
        sqlx::query(
            "insert into agent_budgets (tenant_id, company_id, project_id, minutes, spend_usd_micros)
             values ($1, $2, $3, $4, $5)
             on conflict (tenant_id, project_id)
             do update set minutes = excluded.minutes, spend_usd_micros = excluded.spend_usd_micros, updated_at = now()",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(minutes)
        .bind(spend)
        .execute(&mut *self.tx)
        .await?;
        audit(
            &mut self.tx,
            &self.scope.company,
            Some(&self.scope.project),
            by,
            "agent_budget_set",
            None,
        )
        .await
    }

    /// Saves the ended run, adds what it used to the project's budget use, lets go of the company's sandbox if the
    /// run holds it, and enqueues `agent-run.finished`, all in this transaction. A run that has already ended is left
    /// as it is: `false`, with nothing added or enqueued.
    pub async fn finish_agent_run(
        &mut self,
        run: &AgentRunRow,
        used: AgentSpend,
        outcome: RunOutcome,
        by: &Actor,
    ) -> Result<bool, StoreError> {
        if !self.update_agent_run(run).await? {
            return match self.agent_run(&run.id).await? {
                Some(_) => Ok(false),
                None => Err(StoreError::Missing("agent run")),
            };
        }
        self.settle_agent_run(&run.id, used, outcome, by).await?;
        Ok(true)
    }

    /// Ends a run whose driver stopped renewing it (its API task stopped): saves `run` as the driver last left it
    /// with the state, end and use the sweep gives it, counts its time up to when it was last kept alive and
    /// `usd_micros`, lets go of the sandbox, and enqueues `agent-run.finished`. `false`, with nothing changed, if
    /// the run has ended or was renewed meanwhile: a run that is still driven is never ended here.
    pub async fn settle_lapsed_agent_run(
        &mut self,
        run: &AgentRunRow,
        usd_micros: u64,
        outcome: RunOutcome,
        by: &Actor,
    ) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let seconds: Option<i64> = sqlx::query_scalar(
            "update agent_runs set ended_at = $5, state = $6::jsonb, input_tokens = $7, output_tokens = $8,
                 delivery = $9::jsonb
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4
               and ended_at is null and alive_until < now()
             returning greatest(0, ceil(extract(epoch from alive_until - coalesce(started_at, alive_until))))::bigint",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.id.as_str())
        .bind(run.ended_at)
        .bind(run.state.to_string())
        .bind(count(run.input_tokens)?)
        .bind(count(run.output_tokens)?)
        .bind(run.delivery.to_string())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(seconds) = seconds else {
            return Ok(false);
        };
        let used = AgentSpend {
            seconds: uncount(seconds, "run time")?,
            usd_micros,
        };
        self.settle_agent_run(&run.id, used, outcome, by).await?;
        Ok(true)
    }

    /// What a run's end adds: its use, the sandbox let go, and `agent-run.finished`.
    async fn settle_agent_run(
        &mut self,
        run: &AgentRunId,
        used: AgentSpend,
        outcome: RunOutcome,
        by: &Actor,
    ) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into agent_budgets (tenant_id, company_id, project_id, used_seconds, used_usd_micros)
             values ($1, $2, $3, $4, $5)
             on conflict (tenant_id, project_id)
             do update set used_seconds = agent_budgets.used_seconds + excluded.used_seconds,
                 used_usd_micros = agent_budgets.used_usd_micros + excluded.used_usd_micros, updated_at = now()",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(count(used.seconds)?)
        .bind(count(used.usd_micros)?)
        .execute(&mut *self.tx)
        .await?;
        self.release_sandbox(run.as_str()).await?;
        let event = AgentRunFinished::new(&self.scope, run.clone(), outcome);
        enqueue(&mut self.tx, &self.scope.company, by, &event).await?;
        Ok(())
    }

    /// Keeps an unended run alive for `ttl`; `false` if it has ended or does not exist.
    async fn keep_alive(&mut self, run: &AgentRunId, ttl: Duration) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let updated = sqlx::query(
            "update agent_runs set alive_until = now() + make_interval(secs => $5)
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 and ended_at is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .bind(ttl.as_secs_f64())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(updated == 1)
    }

    /// Takes the company's sandbox for `run` for `ttl`: only when no live lease is someone else's and no older run of
    /// the company is still waiting for it, so runs take turns in the order they were created. The run is kept
    /// alive either way. `Missing` if the run has ended or does not exist.
    pub async fn take_agent_sandbox(&mut self, run: &AgentRunId, ttl: Duration) -> Result<bool, StoreError> {
        if !self.keep_alive(run, ttl).await? {
            return Err(StoreError::Missing("agent run"));
        }
        let (t, c, _) = self.keys();
        let behind: bool = sqlx::query_scalar(
            "select exists (select 1 from agent_runs w join agent_runs me on me.tenant_id = w.tenant_id
                 where me.tenant_id = $1 and me.run_id = $3 and w.company_id = $2 and w.ended_at is null
                   and w.started_at is null and w.alive_until > now()
                   and (w.created_at, w.run_id) < (me.created_at, me.run_id))",
        )
        .bind(&t)
        .bind(&c)
        .bind(run.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        if behind {
            return Ok(false);
        }
        self.lease_sandbox(run.as_str(), ttl).await
    }

    /// Extends a held lease and keeps the run alive; `false` if the run no longer holds the sandbox.
    pub async fn renew_agent_sandbox(&mut self, run: &AgentRunId, ttl: Duration) -> Result<bool, StoreError> {
        if !self.keep_alive(run, ttl).await? {
            return Ok(false);
        }
        let (t, c, _) = self.keys();
        let updated = sqlx::query(
            "update agent_sandbox_leases set expires_at = now() + make_interval(secs => $4)
             where tenant_id = $1 and company_id = $2 and holder = $3",
        )
        .bind(&t)
        .bind(&c)
        .bind(run.as_str())
        .bind(ttl.as_secs_f64())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(updated == 1)
    }

    /// The company's sandbox lease for `holder` (an agent or eval run), if it is free, lapsed or already theirs.
    async fn lease_sandbox(&mut self, holder: &str, ttl: Duration) -> Result<bool, StoreError> {
        let (t, c, _) = self.keys();
        let taken: Option<String> = sqlx::query_scalar(
            "insert into agent_sandbox_leases (tenant_id, company_id, holder, expires_at)
             values ($1, $2, $3, now() + make_interval(secs => $4))
             on conflict (tenant_id, company_id) do update set holder = excluded.holder, expires_at = excluded.expires_at
                 where agent_sandbox_leases.expires_at <= now() or agent_sandbox_leases.holder = excluded.holder
             returning holder",
        )
        .bind(&t)
        .bind(&c)
        .bind(holder)
        .bind(ttl.as_secs_f64())
        .fetch_optional(&mut *self.tx)
        .await?;
        Ok(taken.is_some())
    }

    async fn release_sandbox(&mut self, holder: &str) -> Result<(), StoreError> {
        let (t, c, _) = self.keys();
        sqlx::query(
            "update agent_sandbox_leases set expires_at = now()
             where tenant_id = $1 and company_id = $2 and holder = $3",
        )
        .bind(&t)
        .bind(&c)
        .bind(holder)
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// Locks the project's budget row until this transaction ends, and returns the project's own budget, what its
    /// ended runs used, and what its other live runs hold in reservation.
    pub async fn lock_agent_budget(
        &mut self,
        run: &AgentRunId,
    ) -> Result<(AgentBudget, AgentSpend, AgentSpend), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into agent_budgets (tenant_id, company_id, project_id) values ($1, $2, $3)
             on conflict (tenant_id, project_id) do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .execute(&mut *self.tx)
        .await?;
        sqlx::query(
            "select 1 from agent_budgets where tenant_id = $1 and company_id = $2 and project_id = $3 for update",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .execute(&mut *self.tx)
        .await?;
        let (budget, used) = self.agent_budget().await?;
        let r = sqlx::query(
            "select coalesce(sum(reserved_seconds), 0)::bigint as seconds,
                 coalesce(sum(reserved_usd_micros), 0)::bigint as usd_micros
             from agent_runs where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id <> $4
                 and ended_at is null and alive_until > now()",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        let reserved = AgentSpend {
            seconds: uncount(r.try_get("seconds")?, "reservation")?,
            usd_micros: uncount(r.try_get("usd_micros")?, "reservation")?,
        };
        Ok((budget, used, reserved))
    }

    /// Holds `reserved` of the project's budget for an unended run until it ends; call it under
    /// [`Self::lock_agent_budget`]. `false` if the run has ended or does not exist.
    pub async fn reserve_agent_budget(&mut self, run: &AgentRunId, reserved: AgentSpend) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let updated = sqlx::query(
            "update agent_runs set reserved_seconds = $5, reserved_usd_micros = $6
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 and ended_at is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .bind(count(reserved.seconds)?)
        .bind(count(reserved.usd_micros)?)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(updated == 1)
    }
}

impl Store {
    /// Unended agent runs in any tenant whose driver stopped renewing them, oldest lapse first: their ids only,
    /// read as the relay. Each is then ended through its own project's transaction.
    pub async fn lapsed_agent_runs(&self, limit: u32) -> Result<Vec<(ProjectScope, AgentRunId)>, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_relay").execute(&mut *tx).await?;
        let rows = sqlx::query(
            "select tenant_id, company_id, project_id, run_id from agent_runs
             where ended_at is null and alive_until < now() order by alive_until limit $1",
        )
        .bind(i64::from(limit))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        rows.into_iter()
            .map(|r| {
                let company = CompanyScope::new(
                    id("tenant id", TenantId::new, r.try_get("tenant_id")?)?,
                    id("company id", CompanyId::new, r.try_get("company_id")?)?,
                );
                Ok((
                    company.project(id("project id", ProjectId::new, r.try_get("project_id")?)?),
                    id("agent run id", AgentRunId::new, r.try_get("run_id")?)?,
                ))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    //! Against Postgres, on a fresh runtime login, like `live.rs`.

    use oryxa_core::TenantId;
    use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
    use serde_json::json;

    use super::*;
    use crate::{CompanyIn, Name, ProjectIn, Store, new_id};

    fn actor() -> Actor {
        Actor {
            user: UserId::new("usr_lead").unwrap(),
            request_id: new_id("req"),
        }
    }

    async fn project(store: &Store, tenant: &TenantId) -> ProjectScope {
        let company = CompanyScope::new(tenant.clone(), CompanyId::new(new_id("cmp")).unwrap());
        let mut tx = store.company(&company).await.unwrap();
        let input = CompanyIn {
            name: Name::new("Sample company").unwrap(),
            industry: None,
            region: None,
            summary: None,
        };
        tx.create(&input, &actor()).await.unwrap();
        tx.commit().await.unwrap();
        let scope = company.project(ProjectId::new(new_id("prj")).unwrap());
        let mut tx = store.project(&scope).await.unwrap();
        let input = ProjectIn {
            name: Name::new("Status page").unwrap(),
            summary: None,
        };
        tx.create(&input, &actor()).await.unwrap().unwrap();
        tx.commit().await.unwrap();
        scope
    }

    fn run() -> AgentRunRow {
        AgentRunRow {
            id: AgentRunId::new(new_id("run")).unwrap(),
            task: "Add a /healthz endpoint.".into(),
            repository: json!({ "owner": "sample-org", "name": "status-page", "base": "main" }),
            created_by: UserId::new("usr_lead").unwrap(),
            request_id: new_id("req"),
            created_at: OffsetDateTime::now_utc().replace_nanosecond(0).unwrap(),
            started_at: None,
            ended_at: None,
            state: json!({ "state": "queued" }),
            input_tokens: 0,
            output_tokens: 0,
            delivery: json!({ "status": "none" }),
        }
    }

    fn approval(run: &AgentRunRow) -> AgentApprovalRow {
        AgentApprovalRow {
            run: run.id.clone(),
            id: "apr_1".into(),
            tool_call_id: "toolu_1".into(),
            action: "deploy".into(),
            title: "Run: npx wrangler deploy".into(),
            tool: "Bash".into(),
            input: "{\"command\":\"npx wrangler deploy\"}".into(),
            requested_at: OffsetDateTime::now_utc().replace_nanosecond(0).unwrap(),
            decision: None,
        }
    }

    async fn with_run(store: &Store, scope: &ProjectScope) -> AgentRunRow {
        let r = run();
        let mut tx = store.project(scope).await.unwrap();
        tx.create_agent_run(&r, &actor()).await.unwrap();
        tx.append_agent_event(
            &r.id,
            0,
            "{\"v\":1,\"seq\":0,\"type\":\"message\",\"text\":\"\\u0000 ok\"}",
        )
        .await
        .unwrap();
        tx.add_agent_approval(&approval(&r)).await.unwrap();
        tx.commit().await.unwrap();
        r
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn runs_approvals_and_events_stay_in_their_project() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let a = project(&store, &tenant).await;
        let b = project(&store, &tenant).await;
        let r = with_run(&store, &a).await;

        let mut tx = store.project(&a).await.unwrap();
        assert_eq!(tx.agent_run(&r.id).await.unwrap(), Some(r.clone()));
        assert_eq!(tx.agent_runs().await.unwrap(), vec![r.clone()]);
        assert_eq!(tx.agent_approvals(&r.id).await.unwrap(), vec![approval(&r)]);
        assert_eq!(tx.agent_events(&r.id).await.unwrap().len(), 1);
        tx.commit().await.unwrap();

        // Another project of the same tenant, the same project through another company, and the same ids in another
        // tenant: nothing.
        let other_tenant = TenantId::new(new_id("org")).unwrap();
        for scope in [
            b.clone(),
            b.company.project(a.project.clone()),
            CompanyScope::new(other_tenant, a.company.company.clone()).project(a.project.clone()),
        ] {
            let mut tx = store.project(&scope).await.unwrap();
            assert_eq!(tx.agent_run(&r.id).await.unwrap(), None);
            assert!(tx.agent_runs().await.unwrap().is_empty());
            assert!(tx.agent_approvals(&r.id).await.unwrap().is_empty());
            assert!(tx.agent_events(&r.id).await.unwrap().is_empty());
            assert_eq!(tx.agent_cancel_requested(&r.id).await.unwrap(), None);
            assert!(!tx.request_agent_cancel(&r.id, &actor()).await.unwrap());
            assert_eq!(
                tx.decide_agent_approval(&r.id, "apr_1", "approved", &actor())
                    .await
                    .unwrap(),
                AgentDecided::NotFound
            );
            tx.commit().await.unwrap();
        }
        // A run cannot be filed under a company its project is not in.
        let mut tx = store.project(&b.company.project(a.project.clone())).await.unwrap();
        assert!(tx.create_agent_run(&run(), &actor()).await.is_err());
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_decision_is_recorded_once_and_a_cancel_is_kept() {
        let store = crate::testing::store().await;
        let scope = project(&store, &TenantId::new(new_id("org")).unwrap()).await;
        let r = with_run(&store, &scope).await;
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(
            tx.decide_agent_approval(&r.id, "apr_1", "maybe", &actor())
                .await
                .unwrap_err()
                .to_string(),
            "decision"
        );
        assert_eq!(
            tx.decide_agent_approval(&r.id, "apr_1", "approved", &actor())
                .await
                .unwrap(),
            AgentDecided::Recorded
        );
        assert_eq!(
            tx.decide_agent_approval(&r.id, "apr_1", "rejected", &actor())
                .await
                .unwrap(),
            AgentDecided::AlreadyDecided
        );
        assert_eq!(
            tx.decide_agent_approval(&r.id, "apr_9", "approved", &actor())
                .await
                .unwrap(),
            AgentDecided::NotFound
        );
        assert_eq!(tx.agent_cancel_requested(&r.id).await.unwrap(), Some(false));
        assert!(tx.request_agent_cancel(&r.id, &actor()).await.unwrap());
        tx.commit().await.unwrap();
        let mut tx = store.project(&scope).await.unwrap();
        let decided = tx.agent_approvals(&r.id).await.unwrap().remove(0).decision.unwrap();
        assert_eq!(
            (decided.outcome.as_str(), decided.by.as_str()),
            ("approved", "usr_lead")
        );
        assert_eq!(tx.agent_cancel_requested(&r.id).await.unwrap(), Some(true));
        // A replayed line is the same row.
        tx.append_agent_event(&r.id, 0, "{\"replayed\":true}").await.unwrap();
        assert!(!tx.agent_events(&r.id).await.unwrap()[0].contains("replayed"));
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_runs_end_its_use_and_its_event_commit_or_roll_back_together() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let scope = project(&store, &tenant).await;
        let r = with_run(&store, &scope).await;
        let mut ended = r.clone();
        ended.state = json!({ "state": "finished" });
        ended.ended_at = Some(OffsetDateTime::now_utc().replace_nanosecond(0).unwrap());
        ended.input_tokens = 2400;
        let used = AgentSpend {
            seconds: 90,
            usd_micros: 36_000,
        };

        // Rolled back: nothing changes and no event is queued.
        let mut tx = store.project(&scope).await.unwrap();
        tx.finish_agent_run(&ended, used, RunOutcome::Succeeded, &actor())
            .await
            .unwrap();
        drop(tx);
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(tx.agent_run(&r.id).await.unwrap().unwrap().ended_at, None);
        assert_eq!(tx.agent_budget().await.unwrap().1, AgentSpend::default());
        tx.commit().await.unwrap();
        assert!(finished_events(&store, &tenant).await.is_empty());

        // Finished once: a second finish, or a save after it, changes nothing and queues nothing.
        for first in [true, false] {
            let mut tx = store.project(&scope).await.unwrap();
            let mut again = ended.clone();
            again.state = json!({ "state": "failed", "reason": "timed_out" });
            let row = if first { &ended } else { &again };
            assert_eq!(
                tx.finish_agent_run(row, used, RunOutcome::Succeeded, &actor())
                    .await
                    .unwrap(),
                first
            );
            assert!(!tx.update_agent_run(&again).await.unwrap());
            tx.commit().await.unwrap();
        }
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(tx.agent_run(&r.id).await.unwrap(), Some(ended));
        assert_eq!(tx.agent_budget().await.unwrap().1, used);
        tx.set_agent_budget(
            AgentBudget {
                minutes: Some(30),
                spend_usd_micros: None,
            },
            &actor(),
        )
        .await
        .unwrap();
        assert_eq!(tx.agent_budget().await.unwrap().0.minutes, Some(30));
        tx.commit().await.unwrap();
        // The event: once, ids and the outcome only, in the project's group.
        let events = finished_events(&store, &tenant).await;
        assert_eq!(events.len(), 1);
        let (group, detail) = &events[0];
        assert_eq!(group, &format!("{}/{}", tenant, scope.project));
        let data: serde_json::Value = serde_json::from_str(detail).unwrap();
        assert_eq!(
            data["data"],
            json!({ "company": scope.company.company.as_str(), "project": scope.project.as_str(), "agent_run": r.id.as_str(), "outcome": "succeeded" })
        );
    }

    const LEASE: Duration = Duration::from_secs(60);

    async fn queued(store: &Store, scope: &ProjectScope) -> AgentRunRow {
        let r = run();
        let mut tx = store.project(scope).await.unwrap();
        tx.create_agent_run(&r, &actor()).await.unwrap();
        tx.commit().await.unwrap();
        r
    }

    async fn take(store: &Store, scope: &ProjectScope, run: &AgentRunRow) -> bool {
        let mut tx = store.project(scope).await.unwrap();
        let taken = tx.take_agent_sandbox(&run.id, LEASE).await.unwrap();
        tx.commit().await.unwrap();
        taken
    }

    async fn end(store: &Store, scope: &ProjectScope, run: &AgentRunRow) {
        let mut ended = run.clone();
        ended.state = json!({ "state": "failed", "reason": "cancelled" });
        ended.ended_at = Some(OffsetDateTime::now_utc());
        let mut tx = store.project(scope).await.unwrap();
        assert!(
            tx.finish_agent_run(&ended, AgentSpend::default(), RunOutcome::Cancelled, &actor())
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_companys_sandbox_goes_to_one_run_at_a_time_in_order() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let a = project(&store, &tenant).await;
        // Another project of the same company shares its sandbox; another company has its own.
        let a2 = a.company.project(ProjectId::new(new_id("prj")).unwrap());
        let mut tx = store.project(&a2).await.unwrap();
        let input = ProjectIn {
            name: Name::new("Second project").unwrap(),
            summary: None,
        };
        tx.create(&input, &actor()).await.unwrap().unwrap();
        tx.commit().await.unwrap();
        let elsewhere = project(&store, &tenant).await;

        let first = queued(&store, &a).await;
        let second = queued(&store, &a2).await;
        let third = queued(&store, &a).await;
        // The newest run waits behind the second, which waits behind the holder.
        assert!(take(&store, &a, &first).await);
        assert!(take(&store, &a, &first).await, "the holder takes it again");
        assert!(!take(&store, &a, &third).await);
        assert!(!take(&store, &a2, &second).await);
        assert!(take(&store, &elsewhere, &queued(&store, &elsewhere).await).await);

        let mut tx = store.project(&a).await.unwrap();
        assert!(tx.renew_agent_sandbox(&first.id, LEASE).await.unwrap());
        assert!(!tx.renew_agent_sandbox(&third.id, LEASE).await.unwrap());
        tx.commit().await.unwrap();

        // Its end lets go: the older waiter goes next, not the newer one.
        end(&store, &a, &first).await;
        assert!(!take(&store, &a, &third).await);
        assert!(take(&store, &a2, &second).await);
        let mut tx = store.project(&a).await.unwrap();
        assert!(!tx.renew_agent_sandbox(&first.id, LEASE).await.unwrap());
        assert!(matches!(
            tx.take_agent_sandbox(&first.id, LEASE).await,
            Err(StoreError::Missing(_))
        ));
        drop(tx);

        // A holder whose driver is gone lapses, and so does an older waiter's place in line.
        let mut tx = store.project(&a2).await.unwrap();
        assert!(
            tx.take_agent_sandbox(&second.id, Duration::from_millis(1))
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(take(&store, &a, &third).await);
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_reservation_holds_budget_while_its_run_lives_and_ends_with_it() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let scope = project(&store, &tenant).await;
        let (one, two) = (queued(&store, &scope).await, queued(&store, &scope).await);
        let held = AgentSpend {
            seconds: 600,
            usd_micros: 5_000_000,
        };

        // Reserved under the lock: another transaction waits for the lock and then sees the reservation.
        let mut tx = store.project(&scope).await.unwrap();
        let (_, used, reserved) = tx.lock_agent_budget(&one.id).await.unwrap();
        assert_eq!((used, reserved), (AgentSpend::default(), AgentSpend::default()));
        assert!(tx.take_agent_sandbox(&one.id, LEASE).await.unwrap());
        assert!(tx.reserve_agent_budget(&one.id, held).await.unwrap());
        let waiter = {
            let store = store.clone();
            let (scope, id) = (scope.clone(), two.id.clone());
            tokio::spawn(async move {
                let mut tx = store.project(&scope).await.unwrap();
                let locked = tx.lock_agent_budget(&id).await.unwrap();
                tx.commit().await.unwrap();
                locked.2
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!waiter.is_finished(), "the second lock waits for the first transaction");
        tx.commit().await.unwrap();
        assert_eq!(waiter.await.unwrap(), held);

        // It ends with its run, whose use is then counted instead.
        end(&store, &scope, &one).await;
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(tx.lock_agent_budget(&two.id).await.unwrap().2, AgentSpend::default());
        assert!(!tx.reserve_agent_budget(&one.id, held).await.unwrap());
        drop(tx);

        // A run whose driver is gone holds nothing.
        let mut tx = store.project(&scope).await.unwrap();
        assert!(tx.take_agent_sandbox(&two.id, Duration::from_millis(1)).await.unwrap());
        assert!(tx.reserve_agent_budget(&two.id, held).await.unwrap());
        tx.commit().await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let three = queued(&store, &scope).await;
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(tx.lock_agent_budget(&three.id).await.unwrap().2, AgentSpend::default());
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_run_whose_driver_stopped_is_found_in_any_tenant_and_ended_once() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let scope = project(&store, &tenant).await;
        let other = project(&store, &TenantId::new(new_id("org")).unwrap()).await;
        // One run started 30 s before its driver stopped renewing it; one still driven, in another tenant.
        let mut lapsed = queued(&store, &scope).await;
        let live = queued(&store, &other).await;
        let mut tx = store.project(&scope).await.unwrap();
        lapsed.started_at = Some(OffsetDateTime::now_utc() - time::Duration::seconds(30));
        assert!(tx.update_agent_run(&lapsed).await.unwrap());
        assert!(
            tx.take_agent_sandbox(&lapsed.id, Duration::from_millis(1))
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        let found = store.lapsed_agent_runs(1000).await.unwrap();
        assert!(found.contains(&(scope.clone(), lapsed.id.clone())));
        assert!(!found.iter().any(|(_, id)| id == &live.id));
        // The relay sees the ids of lapsed runs only: no task text, nothing still driven.
        let mut tx = store.pool.begin().await.unwrap();
        sqlx::query("set local role oryxa_fde_relay")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert!(
            sqlx::query("select task from agent_runs")
                .execute(&mut *tx)
                .await
                .is_err()
        );
        drop(tx);

        let mut ended = lapsed.clone();
        ended.state = json!({ "state": "failed", "reason": "interrupted" });
        ended.ended_at = Some(OffsetDateTime::now_utc());
        let mut tx = store.project(&other).await.unwrap();
        let mut live_ended = live.clone();
        live_ended.ended_at = ended.ended_at;
        assert!(
            !tx.settle_lapsed_agent_run(&live_ended, 1, RunOutcome::Failed, &actor())
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();
        for first in [true, false] {
            let mut tx = store.project(&scope).await.unwrap();
            assert_eq!(
                tx.settle_lapsed_agent_run(&ended, 4_000, RunOutcome::Failed, &actor())
                    .await
                    .unwrap(),
                first
            );
            tx.commit().await.unwrap();
        }
        let mut tx = store.project(&scope).await.unwrap();
        let stored = tx.agent_run(&lapsed.id).await.unwrap().unwrap();
        assert_eq!(stored.state, ended.state);
        let used = tx.agent_budget().await.unwrap().1;
        assert!((30..=31).contains(&used.seconds), "{used:?}");
        assert_eq!(used.usd_micros, 4_000);
        tx.commit().await.unwrap();
        assert_eq!(finished_events(&store, &tenant).await.len(), 1);
        assert!(
            !store
                .lapsed_agent_runs(1000)
                .await
                .unwrap()
                .iter()
                .any(|(_, id)| id == &lapsed.id)
        );
    }

    /// `agent-run.finished` rows of one tenant, as (group, detail), read as the relay.
    async fn finished_events(store: &Store, tenant: &TenantId) -> Vec<(String, String)> {
        let mut tx = store.pool.begin().await.unwrap();
        sqlx::query("set local role oryxa_fde_relay")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "select group_key, detail from outbox where tenant_id = $1 and detail_type = 'fde.agent-run.finished.v1'
             order by seq",
        )
        .bind(tenant.as_str())
        .fetch_all(&mut *tx)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.get("group_key"), r.get("detail")))
        .collect()
    }
}

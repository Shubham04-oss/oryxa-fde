//! Agent runs (`oryxa-fde-agent`): each run, its transcript, the approvals it asked for, and the project's agent
//! budget. Every function is on a [`ProjectTx`], so it reads and writes one project of one company; row-level
//! security holds the rest back. A run's end, the project's budget use and `agent-run.finished` commit together.
//!
//! The run's state machine is the agent's to define: it is kept as JSON (`state`) and not read here.

use oryxa_core::UserId;
use oryxa_fde_core::AgentRunId;
use oryxa_fde_events::{AgentRunFinished, RunOutcome};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{Actor, ProjectTx, StoreError, audit, enqueue, id, unique_violation};

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

    /// Saves what the run's driver changes: state, times, use and delivery. `false` if there is no such run.
    pub async fn update_agent_run(&mut self, run: &AgentRunRow) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let updated = sqlx::query(
            "update agent_runs set started_at = $5, ended_at = $6, state = $7::jsonb, input_tokens = $8,
                 output_tokens = $9, delivery = $10::jsonb
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4",
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

    /// Saves the ended run, adds what it used to the project's budget use, and enqueues `agent-run.finished`, all
    /// in this transaction.
    pub async fn finish_agent_run(
        &mut self,
        run: &AgentRunRow,
        used: AgentSpend,
        outcome: RunOutcome,
        by: &Actor,
    ) -> Result<(), StoreError> {
        if !self.update_agent_run(run).await? {
            return Err(StoreError::Missing("agent run"));
        }
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
        let event = AgentRunFinished::new(&self.scope, run.id.clone(), outcome);
        enqueue(&mut self.tx, &self.scope.company, by, &event).await?;
        Ok(())
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

        for _ in 0..2 {
            let mut tx = store.project(&scope).await.unwrap();
            tx.finish_agent_run(&ended, used, RunOutcome::Succeeded, &actor())
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(tx.agent_run(&r.id).await.unwrap(), Some(ended));
        assert_eq!(
            tx.agent_budget().await.unwrap().1,
            AgentSpend {
                seconds: 180,
                usd_micros: 72_000
            }
        );
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
        // The event: ids and the outcome only, in the project's group.
        let events = finished_events(&store, &tenant).await;
        assert_eq!(events.len(), 2);
        let (group, detail) = &events[0];
        assert_eq!(group, &format!("{}/{}", tenant, scope.project));
        let data: serde_json::Value = serde_json::from_str(detail).unwrap();
        assert_eq!(
            data["data"],
            json!({ "company": scope.company.company.as_str(), "project": scope.project.as_str(), "agent_run": r.id.as_str(), "outcome": "succeeded" })
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

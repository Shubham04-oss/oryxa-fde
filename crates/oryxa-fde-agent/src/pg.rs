//! `RunStore` on the FDE store (Postgres, `oryxa-fde-store`'s agent run tables): each call is one transaction
//! scoped to the project, and a run's end commits with its `agent-run.finished` event.

use std::time::Duration;

use oryxa_core::UserId;
use oryxa_fde_core::{AgentRunId, ProjectScope};
use oryxa_fde_events::RunOutcome;
use oryxa_fde_store::{
    Actor, AgentApprovalRow, AgentBudget, AgentDecided, AgentDecision, AgentRunRow, AgentSpend, ProjectTx, Store,
    StoreError as PgError, new_id,
};

use crate::event::{ApprovalOutcome, EventLine, Usage};
use crate::gateway::LeaseToken;
use crate::ids::{ApprovalId, ToolCallId};
use crate::run::AgentRun;
use crate::service::{Remaining, remaining};
use crate::store::{
    ApprovalRecord, Budget, DecideResult, Decided, RunRecord, RunStore, Spend, StoreError, reservation,
};

fn failed(e: PgError) -> StoreError {
    match e {
        PgError::Conflict => StoreError::Conflict,
        PgError::Missing(_) => StoreError::NotFound,
        e => {
            tracing::error!(error = %e, "agent run store");
            StoreError::Unavailable
        }
    }
}

fn corrupt(what: &'static str) -> StoreError {
    tracing::error!(what, "stored agent run data is invalid");
    StoreError::Unavailable
}

fn actor(user: &UserId) -> Actor {
    Actor {
        user: user.clone(),
        request_id: new_id("req"),
    }
}

/// One transaction on the project: `f` runs in it, and it commits.
async fn on<T>(
    store: &Store,
    scope: &ProjectScope,
    f: impl AsyncFnOnce(&mut ProjectTx) -> Result<T, PgError>,
) -> Result<T, StoreError> {
    let mut tx = store.project(scope).await.map_err(failed)?;
    let value = f(&mut tx).await.map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    Ok(value)
}

fn json<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, StoreError> {
    serde_json::to_value(value).map_err(|_| corrupt("encode"))
}

fn row(r: &RunRecord) -> Result<AgentRunRow, StoreError> {
    Ok(AgentRunRow {
        id: r.run.id().clone(),
        task: r.task.clone(),
        repository: json(&r.repository)?,
        created_by: r.created_by.clone(),
        request_id: r.request_id.clone(),
        created_at: r.created_at,
        started_at: r.started_at,
        ended_at: r.ended_at,
        state: json(&r.run)?,
        input_tokens: r.usage.input_tokens,
        output_tokens: r.usage.output_tokens,
        delivery: json(&r.delivery)?,
    })
}

fn record(scope: &ProjectScope, r: AgentRunRow) -> Result<RunRecord, StoreError> {
    let run: AgentRun = serde_json::from_value(r.state).map_err(|_| corrupt("run state"))?;
    // The state belongs to the row it was read from, never to another run or scope.
    if run.id() != &r.id || run.scope() != scope {
        return Err(corrupt("run state"));
    }
    Ok(RunRecord {
        run,
        task: r.task,
        repository: serde_json::from_value(r.repository).map_err(|_| corrupt("repository"))?,
        created_by: r.created_by,
        request_id: r.request_id,
        created_at: r.created_at,
        started_at: r.started_at,
        ended_at: r.ended_at,
        usage: Usage {
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
        },
        delivery: serde_json::from_value(r.delivery).map_err(|_| corrupt("delivery"))?,
    })
}

fn outcome_text(o: ApprovalOutcome) -> &'static str {
    match o {
        ApprovalOutcome::Approved => "approved",
        ApprovalOutcome::Rejected => "rejected",
    }
}

fn approval(a: AgentApprovalRow) -> Result<ApprovalRecord, StoreError> {
    let decision = a
        .decision
        .map(|d: AgentDecision| {
            let outcome = match d.outcome.as_str() {
                "approved" => ApprovalOutcome::Approved,
                "rejected" => ApprovalOutcome::Rejected,
                _ => return Err(corrupt("decision")),
            };
            Ok(Decided {
                outcome,
                by: d.by,
                at: d.at,
            })
        })
        .transpose()?;
    Ok(ApprovalRecord {
        id: ApprovalId::new(a.id).map_err(|_| corrupt("approval id"))?,
        run: a.run,
        tool_call_id: ToolCallId::new(a.tool_call_id).map_err(|_| corrupt("tool call id"))?,
        action: a.action,
        title: a.title,
        tool: a.tool,
        input: serde_json::from_str(&a.input).map_err(|_| corrupt("approval input"))?,
        requested_at: a.requested_at,
        decision,
    })
}

impl RunStore for Store {
    async fn create(&self, run: &RunRecord) -> Result<(), StoreError> {
        let row = row(run)?;
        let by = Actor {
            user: run.created_by.clone(),
            request_id: run.request_id.clone(),
        };
        on(self, run.run.scope(), async |tx| tx.create_agent_run(&row, &by).await).await
    }

    async fn run(&self, scope: &ProjectScope, id: &AgentRunId) -> Result<Option<RunRecord>, StoreError> {
        let found = on(self, scope, async |tx| tx.agent_run(id).await).await?;
        found.map(|r| record(scope, r)).transpose()
    }

    async fn runs(&self, scope: &ProjectScope) -> Result<Vec<RunRecord>, StoreError> {
        let rows = on(self, scope, async |tx| tx.agent_runs().await).await?;
        rows.into_iter().map(|r| record(scope, r)).collect()
    }

    async fn update(&self, run: &RunRecord) -> Result<(), StoreError> {
        let row = row(run)?;
        match on(self, run.run.scope(), async |tx| tx.update_agent_run(&row).await).await? {
            true => Ok(()),
            false => Err(StoreError::NotFound),
        }
    }

    async fn append_event(&self, scope: &ProjectScope, run: &AgentRunId, line: &EventLine) -> Result<(), StoreError> {
        let text = serde_json::to_string(line).map_err(|_| corrupt("event"))?;
        on(self, scope, async |tx| {
            tx.append_agent_event(run, line.seq, &text).await
        })
        .await
    }

    async fn events(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<Vec<EventLine>, StoreError> {
        let lines = on(self, scope, async |tx| tx.agent_events(run).await).await?;
        lines
            .iter()
            .map(|l| serde_json::from_str(l).map_err(|_| corrupt("event")))
            .collect()
    }

    async fn add_approval(&self, scope: &ProjectScope, a: &ApprovalRecord) -> Result<(), StoreError> {
        let row = AgentApprovalRow {
            run: a.run.clone(),
            id: a.id.to_string(),
            tool_call_id: a.tool_call_id.to_string(),
            action: a.action.clone(),
            title: a.title.clone(),
            tool: a.tool.clone(),
            input: a.input.to_string(),
            requested_at: a.requested_at,
            decision: None,
        };
        on(self, scope, async |tx| tx.add_agent_approval(&row).await).await
    }

    async fn approvals(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<Vec<ApprovalRecord>, StoreError> {
        let rows = on(self, scope, async |tx| tx.agent_approvals(run).await).await?;
        rows.into_iter().map(approval).collect()
    }

    async fn decide(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        id: &ApprovalId,
        decided: &Decided,
    ) -> Result<DecideResult, StoreError> {
        let by = actor(&decided.by);
        let outcome = outcome_text(decided.outcome);
        let result = on(self, scope, async |tx| {
            tx.decide_agent_approval(run, id.as_str(), outcome, &by).await
        })
        .await?;
        Ok(match result {
            AgentDecided::Recorded => DecideResult::Recorded,
            AgentDecided::AlreadyDecided => DecideResult::AlreadyDecided,
            AgentDecided::NotFound => DecideResult::NotFound,
        })
    }

    async fn request_cancel(&self, scope: &ProjectScope, run: &AgentRunId, by: &UserId) -> Result<bool, StoreError> {
        let by = actor(by);
        on(self, scope, async |tx| tx.request_agent_cancel(run, &by).await).await
    }

    async fn cancel_requested(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<bool, StoreError> {
        on(self, scope, async |tx| tx.agent_cancel_requested(run).await)
            .await?
            .ok_or(StoreError::NotFound)
    }

    async fn budget(&self, scope: &ProjectScope) -> Result<Option<Budget>, StoreError> {
        let (budget, _) = on(self, scope, async |tx| tx.agent_budget().await).await?;
        Ok(match (budget.minutes, budget.spend_usd_micros) {
            (Some(minutes), Some(spend_usd_micros)) => Some(Budget {
                minutes,
                spend_usd_micros,
            }),
            _ => None,
        })
    }

    async fn set_budget(&self, scope: &ProjectScope, budget: Budget, by: &UserId) -> Result<(), StoreError> {
        let by = actor(by);
        let budget = AgentBudget {
            minutes: Some(budget.minutes),
            spend_usd_micros: Some(budget.spend_usd_micros),
        };
        on(self, scope, async |tx| tx.set_agent_budget(budget, &by).await).await
    }

    async fn spend(&self, scope: &ProjectScope) -> Result<Spend, StoreError> {
        let (_, used) = on(self, scope, async |tx| tx.agent_budget().await).await?;
        Ok(Spend {
            seconds: used.seconds,
            usd_micros: used.usd_micros,
        })
    }

    async fn finish(&self, run: &RunRecord, used: Spend, outcome: RunOutcome) -> Result<(), StoreError> {
        let row = row(run)?;
        let by = Actor {
            user: run.created_by.clone(),
            request_id: run.request_id.clone(),
        };
        let used = AgentSpend {
            seconds: used.seconds,
            usd_micros: used.usd_micros,
        };
        // A run that already ended stays as it ended.
        on(self, run.run.scope(), async |tx| {
            tx.finish_agent_run(&row, used, outcome, &by).await
        })
        .await
        .map(|_| ())
    }

    async fn lapsed(&self, limit: u32) -> Result<Vec<(ProjectScope, AgentRunId)>, StoreError> {
        self.lapsed_agent_runs(limit).await.map_err(failed)
    }

    async fn settle_lapsed(&self, run: &RunRecord, usd_micros: u64, outcome: RunOutcome) -> Result<bool, StoreError> {
        let row = row(run)?;
        let by = Actor {
            user: run.created_by.clone(),
            request_id: run.request_id.clone(),
        };
        on(self, run.run.scope(), async |tx| {
            tx.settle_lapsed_agent_run(&row, usd_micros, outcome, &by).await
        })
        .await
    }

    async fn take_sandbox(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        lease: Duration,
    ) -> Result<Option<LeaseToken>, StoreError> {
        let generation = on(self, scope, async |tx| tx.take_agent_sandbox(run, lease).await).await?;
        Ok(generation.map(LeaseToken))
    }

    async fn renew_sandbox(&self, scope: &ProjectScope, run: &AgentRunId, lease: Duration) -> Result<bool, StoreError> {
        on(self, scope, async |tx| tx.renew_agent_sandbox(run, lease).await).await
    }

    async fn reserve(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        default: Budget,
        max_run: Duration,
    ) -> Result<Option<Remaining>, StoreError> {
        on(self, scope, async |tx| {
            let (own, used, held) = tx.lock_agent_budget(run).await?;
            let budget = match (own.minutes, own.spend_usd_micros) {
                (Some(minutes), Some(spend_usd_micros)) => Budget {
                    minutes,
                    spend_usd_micros,
                },
                _ => default,
            };
            let spent = Spend {
                seconds: used.seconds,
                usd_micros: used.usd_micros,
            }
            .plus(Spend {
                seconds: held.seconds,
                usd_micros: held.usd_micros,
            });
            let Some(left) = remaining(budget, spent) else {
                return Ok(None);
            };
            let hold = reservation(left, max_run);
            let hold = AgentSpend {
                seconds: hold.seconds,
                usd_micros: hold.usd_micros,
            };
            if !tx.reserve_agent_budget(run, hold).await? {
                return Err(PgError::Missing("agent run"));
            }
            Ok(Some(left))
        })
        .await
    }
}

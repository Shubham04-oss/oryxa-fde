//! Where runs, their approvals, transcripts and the project's budget live. `RunStore` is what runs need;
//! `InMemoryRuns` implements it until the store crate does on Postgres (with `finish` writing the outbox in the
//! same transaction). Every lookup takes the full `ProjectScope`, so a run of one company is never found through
//! another's.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use oryxa_core::UserId;
use oryxa_fde_core::{AgentRunId, ProjectScope};
use oryxa_fde_events::AgentRunFinished;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::event::{ApprovalOutcome, EventLine, Usage};
use crate::git::{Delivery, Repository};
use crate::ids::{ApprovalId, ToolCallId};
use crate::run::AgentRun;

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub run: AgentRun,
    /// What the FDE asked for. Their text: it stays in the store and the sandbox, never in events or logs.
    pub task: String,
    pub repository: Repository,
    pub created_by: UserId,
    /// The request that created the run; the correlation id on its event.
    pub request_id: String,
    pub created_at: OffsetDateTime,
    pub started_at: Option<OffsetDateTime>,
    pub ended_at: Option<OffsetDateTime>,
    /// Model use as last reported by the harness.
    pub usage: Usage,
    pub delivery: Delivery,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decided {
    pub outcome: ApprovalOutcome,
    pub by: UserId,
    pub at: OffsetDateTime,
}

/// An action on the approval list that a run asked to take, exactly as it would run.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRecord {
    pub id: ApprovalId,
    pub run: AgentRunId,
    pub tool_call_id: ToolCallId,
    pub action: String,
    pub title: String,
    pub tool: String,
    pub input: serde_json::Value,
    pub requested_at: OffsetDateTime,
    pub decision: Option<Decided>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecideResult {
    Recorded,
    /// Someone decided first; the first decision stands.
    AlreadyDecided,
    NotFound,
}

/// A project's agent budget across all its runs: harness time and model spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Budget {
    pub minutes: u32,
    /// US dollars, in millionths.
    pub spend_usd_micros: u64,
}

/// What a project's runs have used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
pub struct Spend {
    pub seconds: u64,
    pub usd_micros: u64,
}

impl Spend {
    pub fn plus(self, other: Spend) -> Spend {
        Spend {
            seconds: self.seconds.saturating_add(other.seconds),
            usd_micros: self.usd_micros.saturating_add(other.usd_micros),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("already exists")]
    Conflict,
    #[error("no such run")]
    NotFound,
    #[error("run store unavailable")]
    Unavailable,
}

pub trait RunStore: Send + Sync + 'static {
    fn create(&self, run: &RunRecord) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn run(
        &self,
        scope: &ProjectScope,
        id: &AgentRunId,
    ) -> impl Future<Output = Result<Option<RunRecord>, StoreError>> + Send;
    /// The project's runs, newest first.
    fn runs(&self, scope: &ProjectScope) -> impl Future<Output = Result<Vec<RunRecord>, StoreError>> + Send;
    /// Saves the orchestrator's view of a run: state, times, use and delivery.
    fn update(&self, run: &RunRecord) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn append_event(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        line: &EventLine,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn events(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
    ) -> impl Future<Output = Result<Vec<EventLine>, StoreError>> + Send;
    fn add_approval(
        &self,
        scope: &ProjectScope,
        approval: &ApprovalRecord,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn approvals(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
    ) -> impl Future<Output = Result<Vec<ApprovalRecord>, StoreError>> + Send;
    /// Records a decision if the approval has none yet.
    fn decide(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        approval: &ApprovalId,
        decided: &Decided,
    ) -> impl Future<Output = Result<DecideResult, StoreError>> + Send;
    /// Asks the run to stop; false if there is no such run.
    fn request_cancel(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    fn cancel_requested(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    fn budget(&self, scope: &ProjectScope) -> impl Future<Output = Result<Option<Budget>, StoreError>> + Send;
    fn set_budget(&self, scope: &ProjectScope, budget: Budget) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn spend(&self, scope: &ProjectScope) -> impl Future<Output = Result<Spend, StoreError>> + Send;
    /// Saves the ended run, adds its use to the project's spend and enqueues `event`, all or nothing.
    fn finish(
        &self,
        run: &RunRecord,
        used: Spend,
        event: &AgentRunFinished,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
}

struct Entry {
    record: RunRecord,
    order: u64,
    events: Vec<EventLine>,
    approvals: Vec<ApprovalRecord>,
    cancel: bool,
}

#[derive(Default)]
struct Inner {
    runs: HashMap<(ProjectScope, AgentRunId), Entry>,
    budgets: HashMap<ProjectScope, Budget>,
    spend: HashMap<ProjectScope, Spend>,
    outbox: Vec<AgentRunFinished>,
    next: u64,
}

/// Runs held in the API process.
// ponytail: in memory until the store crate implements `RunStore` on Postgres. One API task only, and a restart
// loses runs (each fails closed: its harness waits until the gateway's time limit) and the projects' budget use.
#[derive(Default)]
pub struct InMemoryRuns {
    inner: Mutex<Inner>,
}

impl InMemoryRuns {
    /// The events `finish` enqueued, as the outbox would hold them.
    pub fn outbox(&self) -> Vec<AgentRunFinished> {
        self.lock().outbox.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn with<T>(&self, scope: &ProjectScope, run: &AgentRunId, f: impl FnOnce(&mut Entry) -> T) -> Option<T> {
        self.lock().runs.get_mut(&(scope.clone(), run.clone())).map(f)
    }
}

fn key(run: &RunRecord) -> (ProjectScope, AgentRunId) {
    (run.run.scope().clone(), run.run.id().clone())
}

impl RunStore for InMemoryRuns {
    async fn create(&self, run: &RunRecord) -> Result<(), StoreError> {
        let mut inner = self.lock();
        if inner.runs.contains_key(&key(run)) {
            return Err(StoreError::Conflict);
        }
        let order = inner.next;
        inner.next += 1;
        inner.runs.insert(
            key(run),
            Entry {
                record: run.clone(),
                order,
                events: Vec::new(),
                approvals: Vec::new(),
                cancel: false,
            },
        );
        Ok(())
    }

    async fn run(&self, scope: &ProjectScope, id: &AgentRunId) -> Result<Option<RunRecord>, StoreError> {
        Ok(self.with(scope, id, |e| e.record.clone()))
    }

    async fn runs(&self, scope: &ProjectScope) -> Result<Vec<RunRecord>, StoreError> {
        let inner = self.lock();
        let mut list: Vec<_> = inner
            .runs
            .iter()
            .filter(|((s, _), _)| s == scope)
            .map(|(_, e)| e)
            .collect();
        list.sort_by_key(|e| std::cmp::Reverse(e.order));
        Ok(list.into_iter().map(|e| e.record.clone()).collect())
    }

    async fn update(&self, run: &RunRecord) -> Result<(), StoreError> {
        let (scope, id) = key(run);
        self.with(&scope, &id, |e| e.record = run.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn append_event(&self, scope: &ProjectScope, run: &AgentRunId, line: &EventLine) -> Result<(), StoreError> {
        self.with(scope, run, |e| e.events.push(line.clone()))
            .ok_or(StoreError::NotFound)
    }

    async fn events(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<Vec<EventLine>, StoreError> {
        self.with(scope, run, |e| e.events.clone()).ok_or(StoreError::NotFound)
    }

    async fn add_approval(&self, scope: &ProjectScope, approval: &ApprovalRecord) -> Result<(), StoreError> {
        self.with(scope, &approval.run, |e| {
            if e.approvals.iter().any(|a| a.id == approval.id) {
                return Err(StoreError::Conflict);
            }
            e.approvals.push(approval.clone());
            Ok(())
        })
        .ok_or(StoreError::NotFound)?
    }

    async fn approvals(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<Vec<ApprovalRecord>, StoreError> {
        self.with(scope, run, |e| e.approvals.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn decide(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        approval: &ApprovalId,
        decided: &Decided,
    ) -> Result<DecideResult, StoreError> {
        Ok(self
            .with(scope, run, |e| {
                match e.approvals.iter_mut().find(|a| &a.id == approval) {
                    None => DecideResult::NotFound,
                    Some(a) if a.decision.is_some() => DecideResult::AlreadyDecided,
                    Some(a) => {
                        a.decision = Some(decided.clone());
                        DecideResult::Recorded
                    }
                }
            })
            .unwrap_or(DecideResult::NotFound))
    }

    async fn request_cancel(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<bool, StoreError> {
        Ok(self.with(scope, run, |e| e.cancel = true).is_some())
    }

    async fn cancel_requested(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<bool, StoreError> {
        self.with(scope, run, |e| e.cancel).ok_or(StoreError::NotFound)
    }

    async fn budget(&self, scope: &ProjectScope) -> Result<Option<Budget>, StoreError> {
        Ok(self.lock().budgets.get(scope).copied())
    }

    async fn set_budget(&self, scope: &ProjectScope, budget: Budget) -> Result<(), StoreError> {
        self.lock().budgets.insert(scope.clone(), budget);
        Ok(())
    }

    async fn spend(&self, scope: &ProjectScope) -> Result<Spend, StoreError> {
        Ok(self.lock().spend.get(scope).copied().unwrap_or_default())
    }

    async fn finish(&self, run: &RunRecord, used: Spend, event: &AgentRunFinished) -> Result<(), StoreError> {
        let mut inner = self.lock();
        let (scope, id) = key(run);
        let entry = inner.runs.get_mut(&(scope.clone(), id)).ok_or(StoreError::NotFound)?;
        entry.record = run.clone();
        let total = inner.spend.entry(scope).or_default();
        *total = total.plus(used);
        inner.outbox.push(event.clone());
        Ok(())
    }
}

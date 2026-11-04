//! Where runs, their approvals, transcripts and the project's budget live. `RunStore` is what runs need; the FDE
//! store implements it on Postgres (`pg.rs`), with `finish` writing `agent-run.finished` to the outbox in the same
//! transaction. `InMemoryRuns` is for tests. Every lookup takes the full `ProjectScope`, so a run of one company is
//! never found through another's.
//!
//! Any API task may drive a run, so the store also holds what must hold across tasks: which run has the company's
//! sandbox (a lease the run's driver renews), and each live run's reservation against the project's budget.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use oryxa_core::UserId;
use oryxa_fde_core::{AgentRunId, CompanyScope, ProjectScope};
use oryxa_fde_events::{AgentRunFinished, RunOutcome};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::time::Instant;
use utoipa::ToSchema;

use crate::event::{ApprovalOutcome, EventLine, Usage};
use crate::git::{Delivery, Repository};
use crate::ids::{ApprovalId, ToolCallId};
use crate::run::AgentRun;
use crate::service::{Remaining, remaining};

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
        by: &UserId,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    fn cancel_requested(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    fn budget(&self, scope: &ProjectScope) -> impl Future<Output = Result<Option<Budget>, StoreError>> + Send;
    fn set_budget(
        &self,
        scope: &ProjectScope,
        budget: Budget,
        by: &UserId,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn spend(&self, scope: &ProjectScope) -> impl Future<Output = Result<Spend, StoreError>> + Send;
    /// Gives the company's sandbox to the run for `lease` if no other live run holds it and no older run of the
    /// company is waiting for it, and keeps the run alive either way. `NotFound` once the run has ended.
    fn take_sandbox(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        lease: Duration,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    /// Extends the run's lease on the sandbox and keeps it alive; `false` if it no longer holds the sandbox.
    fn renew_sandbox(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        lease: Duration,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    /// What is left of the project's budget (`default` unless it has its own) after its ended runs' use and its
    /// other live runs' reservations; reserved for this run, its seconds capped at `max_run`, until it ends. Done
    /// under a lock on the project's budget, so two runs never both get the same part. `None` when used up.
    fn reserve(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        default: Budget,
        max_run: Duration,
    ) -> impl Future<Output = Result<Option<Remaining>, StoreError>> + Send;
    /// Unended runs in any tenant whose driver stopped renewing them (its API task stopped), oldest lapse first.
    fn lapsed(&self, limit: u32) -> impl Future<Output = Result<Vec<(ProjectScope, AgentRunId)>, StoreError>> + Send;
    /// Ends such a run as `run` says, counting its time up to when it was last kept alive and `usd_micros`, and
    /// enqueues `agent-run.finished` with `outcome`, all or nothing. `false` if it has ended or is driven again.
    fn settle_lapsed(
        &self,
        run: &RunRecord,
        usd_micros: u64,
        outcome: RunOutcome,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;
    /// Saves the ended run, adds its use to the project's spend, lets go of the sandbox and enqueues
    /// `agent-run.finished` with `outcome`, all or nothing. A run that has already ended is left as it is.
    fn finish(
        &self,
        run: &RunRecord,
        used: Spend,
        outcome: RunOutcome,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
}

/// How long a new run counts as driven before its driver first renews it.
pub const NEW_RUN_GRACE: Duration = Duration::from_secs(60);

/// What a live run holds back from the budget: what is left, its seconds capped at the longest a run may take.
pub fn reservation(left: Remaining, max_run: Duration) -> Spend {
    Spend {
        seconds: left.seconds.min(max_run.as_secs()),
        usd_micros: left.usd_micros,
    }
}

struct Entry {
    record: RunRecord,
    order: u64,
    events: Vec<EventLine>,
    approvals: Vec<ApprovalRecord>,
    cancel: bool,
    alive_until: Instant,
    reserved: Spend,
    started: Option<Instant>,
}

impl Entry {
    fn live(&self, now: Instant) -> bool {
        self.record.ended_at.is_none() && self.alive_until > now
    }
}

#[derive(Default)]
struct Inner {
    runs: HashMap<(ProjectScope, AgentRunId), Entry>,
    budgets: HashMap<ProjectScope, Budget>,
    spend: HashMap<ProjectScope, Spend>,
    leases: HashMap<CompanyScope, (AgentRunId, Instant)>,
    outbox: Vec<AgentRunFinished>,
    next: u64,
}

/// Runs held in memory, for tests; production uses the FDE store.
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
                alive_until: Instant::now() + NEW_RUN_GRACE,
                reserved: Spend::default(),
                started: None,
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
        self.with(&scope, &id, |e| {
            // An ended run is never changed.
            if e.record.ended_at.is_some() {
                return Err(StoreError::NotFound);
            }
            if run.started_at.is_some() && e.started.is_none() {
                e.started = Some(Instant::now());
            }
            e.record = run.clone();
            Ok(())
        })
        .ok_or(StoreError::NotFound)?
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

    async fn request_cancel(&self, scope: &ProjectScope, run: &AgentRunId, _: &UserId) -> Result<bool, StoreError> {
        Ok(self.with(scope, run, |e| e.cancel = true).is_some())
    }

    async fn cancel_requested(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<bool, StoreError> {
        self.with(scope, run, |e| e.cancel).ok_or(StoreError::NotFound)
    }

    async fn budget(&self, scope: &ProjectScope) -> Result<Option<Budget>, StoreError> {
        Ok(self.lock().budgets.get(scope).copied())
    }

    async fn set_budget(&self, scope: &ProjectScope, budget: Budget, _: &UserId) -> Result<(), StoreError> {
        self.lock().budgets.insert(scope.clone(), budget);
        Ok(())
    }

    async fn spend(&self, scope: &ProjectScope) -> Result<Spend, StoreError> {
        Ok(self.lock().spend.get(scope).copied().unwrap_or_default())
    }

    async fn take_sandbox(&self, scope: &ProjectScope, run: &AgentRunId, lease: Duration) -> Result<bool, StoreError> {
        let mut inner = self.lock();
        let now = Instant::now();
        let me = inner
            .runs
            .get_mut(&(scope.clone(), run.clone()))
            .filter(|e| e.record.ended_at.is_none())
            .ok_or(StoreError::NotFound)?;
        me.alive_until = now + lease;
        let mine = (me.record.created_at, me.order);
        let behind = inner.runs.iter().any(|((s, _), e)| {
            s.company == scope.company
                && e.live(now)
                && e.record.started_at.is_none()
                && (e.record.created_at, e.order) < mine
        });
        let free = match inner.leases.get(&scope.company) {
            Some((holder, until)) => holder == run || *until <= now,
            None => true,
        };
        if behind || !free {
            return Ok(false);
        }
        inner.leases.insert(scope.company.clone(), (run.clone(), now + lease));
        Ok(true)
    }

    async fn renew_sandbox(&self, scope: &ProjectScope, run: &AgentRunId, lease: Duration) -> Result<bool, StoreError> {
        let mut inner = self.lock();
        let now = Instant::now();
        match inner.runs.get_mut(&(scope.clone(), run.clone())) {
            Some(e) if e.record.ended_at.is_none() => e.alive_until = now + lease,
            _ => return Ok(false),
        }
        match inner.leases.get_mut(&scope.company) {
            Some((holder, until)) if holder == run => {
                *until = now + lease;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn reserve(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        default: Budget,
        max_run: Duration,
    ) -> Result<Option<Remaining>, StoreError> {
        let mut inner = self.lock();
        let now = Instant::now();
        let held = inner
            .runs
            .iter()
            .filter(|((s, id), e)| s == scope && id != run && e.live(now))
            .fold(Spend::default(), |sum, (_, e)| sum.plus(e.reserved));
        let budget = inner.budgets.get(scope).copied().unwrap_or(default);
        let used = inner.spend.get(scope).copied().unwrap_or_default();
        let left = remaining(budget, used.plus(held));
        let entry = inner
            .runs
            .get_mut(&(scope.clone(), run.clone()))
            .filter(|e| e.record.ended_at.is_none())
            .ok_or(StoreError::NotFound)?;
        if let Some(left) = left {
            entry.reserved = reservation(left, max_run);
        }
        Ok(left)
    }

    async fn lapsed(&self, limit: u32) -> Result<Vec<(ProjectScope, AgentRunId)>, StoreError> {
        let inner = self.lock();
        let now = Instant::now();
        let mut lapsed: Vec<_> = inner
            .runs
            .iter()
            .filter(|(_, e)| e.record.ended_at.is_none() && e.alive_until <= now)
            .map(|(key, e)| (e.alive_until, key.clone()))
            .collect();
        lapsed.sort_by_key(|(until, _)| *until);
        Ok(lapsed.into_iter().take(limit as usize).map(|(_, key)| key).collect())
    }

    async fn settle_lapsed(&self, run: &RunRecord, usd_micros: u64, outcome: RunOutcome) -> Result<bool, StoreError> {
        let mut inner = self.lock();
        let (scope, id) = key(run);
        let Some(entry) = inner.runs.get_mut(&(scope.clone(), id.clone())) else {
            return Err(StoreError::NotFound);
        };
        if entry.record.ended_at.is_some() || entry.alive_until > Instant::now() {
            return Ok(false);
        }
        let seconds = entry
            .started
            .map_or(Duration::ZERO, |s| entry.alive_until.saturating_duration_since(s));
        entry.record = run.clone();
        let used = Spend {
            seconds: seconds.as_secs(),
            usd_micros,
        };
        if inner
            .leases
            .get(&scope.company)
            .is_some_and(|(holder, _)| holder == &id)
        {
            inner.leases.remove(&scope.company);
        }
        let total = inner.spend.entry(scope.clone()).or_default();
        *total = total.plus(used);
        inner.outbox.push(AgentRunFinished::new(&scope, id, outcome));
        Ok(true)
    }

    async fn finish(&self, run: &RunRecord, used: Spend, outcome: RunOutcome) -> Result<(), StoreError> {
        let mut inner = self.lock();
        let (scope, id) = key(run);
        let event = AgentRunFinished::new(&scope, id.clone(), outcome);
        let entry = inner
            .runs
            .get_mut(&(scope.clone(), id.clone()))
            .ok_or(StoreError::NotFound)?;
        if entry.record.ended_at.is_some() {
            return Ok(());
        }
        entry.record = run.clone();
        if inner
            .leases
            .get(&scope.company)
            .is_some_and(|(holder, _)| holder == &id)
        {
            inner.leases.remove(&scope.company);
        }
        let total = inner.spend.entry(scope).or_default();
        *total = total.plus(used);
        inner.outbox.push(event);
        Ok(())
    }
}

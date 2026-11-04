//! Where suites and runs live. `EvalStore` is what evals need: Postgres implements it in `pg`, and `InMemoryEvals`
//! for tests. Every lookup takes the full `ProjectScope`, so one company's suites and results are never found
//! through another's. A run that uses the company's sandbox holds it through the store, so agent and eval runs on
//! any API task take turns.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use oryxa_core::UserId;
use oryxa_fde_core::{CompanyScope, EvalRunId, ProjectScope};
use oryxa_fde_events::EvalRunFinished;
use time::OffsetDateTime;
use tokio::time::Instant;

use crate::ids::SuiteId;
use crate::runner::Report;
use crate::suite::{Case, Suite};

#[derive(Debug, Clone, PartialEq)]
pub struct EvalRun {
    pub id: EvalRunId,
    pub scope: ProjectScope,
    pub suite: SuiteId,
    /// True when the outputs were imported rather than produced by the target.
    pub imported: bool,
    pub created_by: UserId,
    /// The request that started the run; the correlation id on its event.
    pub request_id: String,
    pub created_at: OffsetDateTime,
    pub ended_at: Option<OffsetDateTime>,
    /// Present once the run has finished.
    pub report: Option<Report>,
}

#[derive(Debug, thiserror::Error)]
pub enum EvalStoreError {
    #[error("already exists")]
    Conflict,
    #[error("not found")]
    NotFound,
    #[error("eval store unavailable")]
    Unavailable,
}

pub trait EvalStore: Send + Sync + 'static {
    fn create_suite(&self, suite: &Suite, by: &UserId) -> impl Future<Output = Result<(), EvalStoreError>> + Send;
    fn suite(
        &self,
        scope: &ProjectScope,
        id: &SuiteId,
    ) -> impl Future<Output = Result<Option<Suite>, EvalStoreError>> + Send;
    fn suites(&self, scope: &ProjectScope) -> impl Future<Output = Result<Vec<Suite>, EvalStoreError>> + Send;
    /// Appends cases; a case id already in the suite is a conflict and nothing is added.
    fn add_cases(
        &self,
        scope: &ProjectScope,
        id: &SuiteId,
        cases: Vec<Case>,
        by: &UserId,
    ) -> impl Future<Output = Result<Suite, EvalStoreError>> + Send;
    fn create_run(&self, run: &EvalRun) -> impl Future<Output = Result<(), EvalStoreError>> + Send;
    fn run(
        &self,
        scope: &ProjectScope,
        id: &EvalRunId,
    ) -> impl Future<Output = Result<Option<EvalRun>, EvalStoreError>> + Send;
    /// The project's runs, newest first.
    fn runs(&self, scope: &ProjectScope) -> impl Future<Output = Result<Vec<EvalRun>, EvalStoreError>> + Send;
    /// Gives the company's sandbox to the unfinished run for `lease` if no live lease is someone else's, with the
    /// lease's generation: the run's token at the gateway, higher than the last holder's. `NotFound` once the run
    /// has finished.
    fn take_sandbox(
        &self,
        scope: &ProjectScope,
        run: &EvalRunId,
        lease: Duration,
    ) -> impl Future<Output = Result<Option<u64>, EvalStoreError>> + Send;
    /// Extends the run's lease; `false` if it no longer holds the sandbox.
    fn renew_sandbox(
        &self,
        scope: &ProjectScope,
        run: &EvalRunId,
        lease: Duration,
    ) -> impl Future<Output = Result<bool, EvalStoreError>> + Send;
    /// Ends the run with its report, once (a run already ended is a conflict), lets go of the sandbox, and enqueues
    /// its [`finished_event`], all or nothing.
    fn finish(&self, run: &EvalRun, report: &Report) -> impl Future<Output = Result<(), EvalStoreError>> + Send;
}

/// `eval-run.finished` for a run with this report: a case that could not be graded did not pass.
pub fn finished_event(run: &EvalRun, report: &Report) -> EvalRunFinished {
    EvalRunFinished::new(
        &run.scope,
        run.id.clone(),
        report.passed,
        report.failed.saturating_add(report.errored),
    )
}

#[derive(Default)]
struct Inner {
    suites: HashMap<(ProjectScope, SuiteId), (u64, Suite)>,
    runs: HashMap<(ProjectScope, EvalRunId), (u64, EvalRun)>,
    /// Each company's lease: its holder, until when, and its generation.
    leases: HashMap<CompanyScope, (EvalRunId, Instant, u64)>,
    outbox: Vec<EvalRunFinished>,
    next: u64,
}

/// Suites and runs held in memory, for tests.
#[derive(Default)]
pub struct InMemoryEvals {
    inner: Mutex<Inner>,
}

impl InMemoryEvals {
    /// The events `finish` enqueued, as the outbox would hold them.
    pub fn outbox(&self) -> Vec<EvalRunFinished> {
        self.lock().outbox.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn newest_first<T: Clone>(mut items: Vec<&(u64, T)>) -> Vec<T> {
    items.sort_by_key(|(order, _)| std::cmp::Reverse(*order));
    items.into_iter().map(|(_, t)| t.clone()).collect()
}

impl EvalStore for InMemoryEvals {
    async fn create_suite(&self, suite: &Suite, _by: &UserId) -> Result<(), EvalStoreError> {
        let mut inner = self.lock();
        let key = (suite.scope.clone(), suite.id.clone());
        if inner.suites.contains_key(&key) {
            return Err(EvalStoreError::Conflict);
        }
        let order = inner.next;
        inner.next += 1;
        inner.suites.insert(key, (order, suite.clone()));
        Ok(())
    }

    async fn suite(&self, scope: &ProjectScope, id: &SuiteId) -> Result<Option<Suite>, EvalStoreError> {
        Ok(self
            .lock()
            .suites
            .get(&(scope.clone(), id.clone()))
            .map(|(_, s)| s.clone()))
    }

    async fn suites(&self, scope: &ProjectScope) -> Result<Vec<Suite>, EvalStoreError> {
        let inner = self.lock();
        Ok(newest_first(
            inner
                .suites
                .iter()
                .filter(|((s, _), _)| s == scope)
                .map(|(_, v)| v)
                .collect(),
        ))
    }

    async fn add_cases(
        &self,
        scope: &ProjectScope,
        id: &SuiteId,
        cases: Vec<Case>,
        _by: &UserId,
    ) -> Result<Suite, EvalStoreError> {
        let mut inner = self.lock();
        let (_, suite) = inner
            .suites
            .get_mut(&(scope.clone(), id.clone()))
            .ok_or(EvalStoreError::NotFound)?;
        if cases.iter().any(|c| suite.cases.iter().any(|e| e.id == c.id)) {
            return Err(EvalStoreError::Conflict);
        }
        suite.cases.extend(cases);
        Ok(suite.clone())
    }

    async fn create_run(&self, run: &EvalRun) -> Result<(), EvalStoreError> {
        let mut inner = self.lock();
        let key = (run.scope.clone(), run.id.clone());
        if inner.runs.contains_key(&key) {
            return Err(EvalStoreError::Conflict);
        }
        let order = inner.next;
        inner.next += 1;
        inner.runs.insert(key, (order, run.clone()));
        Ok(())
    }

    async fn run(&self, scope: &ProjectScope, id: &EvalRunId) -> Result<Option<EvalRun>, EvalStoreError> {
        Ok(self
            .lock()
            .runs
            .get(&(scope.clone(), id.clone()))
            .map(|(_, r)| r.clone()))
    }

    async fn runs(&self, scope: &ProjectScope) -> Result<Vec<EvalRun>, EvalStoreError> {
        let inner = self.lock();
        Ok(newest_first(
            inner
                .runs
                .iter()
                .filter(|((s, _), _)| s == scope)
                .map(|(_, v)| v)
                .collect(),
        ))
    }

    async fn finish(&self, run: &EvalRun, report: &Report) -> Result<(), EvalStoreError> {
        let mut inner = self.lock();
        let (_, stored) = inner
            .runs
            .get_mut(&(run.scope.clone(), run.id.clone()))
            .ok_or(EvalStoreError::NotFound)?;
        if stored.report.is_some() {
            return Err(EvalStoreError::Conflict);
        }
        stored.ended_at = Some(OffsetDateTime::now_utc());
        stored.report = Some(report.clone());
        // Let go, keeping the generation: the next holder's is higher.
        if let Some((holder, until, _)) = inner.leases.get_mut(&run.scope.company)
            && holder == &run.id
        {
            *until = Instant::now();
        }
        inner.outbox.push(finished_event(run, report));
        Ok(())
    }

    async fn take_sandbox(
        &self,
        scope: &ProjectScope,
        run: &EvalRunId,
        lease: Duration,
    ) -> Result<Option<u64>, EvalStoreError> {
        let mut inner = self.lock();
        match inner.runs.get(&(scope.clone(), run.clone())) {
            Some((_, r)) if r.report.is_none() => {}
            _ => return Err(EvalStoreError::NotFound),
        }
        let now = Instant::now();
        let generation = match inner.leases.get(&scope.company) {
            Some((holder, _, generation)) if holder == run => *generation,
            Some((_, until, _)) if *until > now => return Ok(None),
            Some((_, _, generation)) => generation + 1,
            None => 1,
        };
        inner
            .leases
            .insert(scope.company.clone(), (run.clone(), now + lease, generation));
        Ok(Some(generation))
    }

    async fn renew_sandbox(
        &self,
        scope: &ProjectScope,
        run: &EvalRunId,
        lease: Duration,
    ) -> Result<bool, EvalStoreError> {
        let mut inner = self.lock();
        match inner.leases.get_mut(&scope.company) {
            Some((holder, until, _)) if holder == run => {
                *until = Instant::now() + lease;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

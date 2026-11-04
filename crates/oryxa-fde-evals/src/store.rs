//! Where suites and runs live. `EvalStore` is what evals need; `InMemoryEvals` implements it until the store crate
//! does on Postgres (with `finish` writing the outbox in the same transaction). Every lookup takes the full
//! `ProjectScope`, so one company's suites and results are never found through another's.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use oryxa_core::UserId;
use oryxa_fde_core::{EvalRunId, ProjectScope};
use oryxa_fde_events::EvalRunFinished;
use time::OffsetDateTime;

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
    fn create_suite(&self, suite: &Suite) -> impl Future<Output = Result<(), EvalStoreError>> + Send;
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
    ) -> impl Future<Output = Result<Suite, EvalStoreError>> + Send;
    fn create_run(&self, run: &EvalRun) -> impl Future<Output = Result<(), EvalStoreError>> + Send;
    fn run(
        &self,
        scope: &ProjectScope,
        id: &EvalRunId,
    ) -> impl Future<Output = Result<Option<EvalRun>, EvalStoreError>> + Send;
    /// The project's runs, newest first.
    fn runs(&self, scope: &ProjectScope) -> impl Future<Output = Result<Vec<EvalRun>, EvalStoreError>> + Send;
    /// Saves the finished run and enqueues `event`, all or nothing.
    fn finish(&self, run: &EvalRun, event: &EvalRunFinished)
    -> impl Future<Output = Result<(), EvalStoreError>> + Send;
}

#[derive(Default)]
struct Inner {
    suites: HashMap<(ProjectScope, SuiteId), (u64, Suite)>,
    runs: HashMap<(ProjectScope, EvalRunId), (u64, EvalRun)>,
    outbox: Vec<EvalRunFinished>,
    next: u64,
}

/// Suites and runs held in the API process.
// ponytail: in memory until the store crate implements `EvalStore` on Postgres; one API task only, and a restart
// loses suites, results and their events.
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
    async fn create_suite(&self, suite: &Suite) -> Result<(), EvalStoreError> {
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

    async fn add_cases(&self, scope: &ProjectScope, id: &SuiteId, cases: Vec<Case>) -> Result<Suite, EvalStoreError> {
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

    async fn finish(&self, run: &EvalRun, event: &EvalRunFinished) -> Result<(), EvalStoreError> {
        let mut inner = self.lock();
        let (_, stored) = inner
            .runs
            .get_mut(&(run.scope.clone(), run.id.clone()))
            .ok_or(EvalStoreError::NotFound)?;
        *stored = run.clone();
        inner.outbox.push(event.clone());
        Ok(())
    }
}

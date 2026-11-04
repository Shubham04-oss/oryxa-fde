//! `EvalStore` on the FDE store (Postgres, `oryxa-fde-store`'s eval tables): each call is one transaction scoped to
//! the project, and a run's report commits with its `eval-run.finished` event.

use std::time::Duration;

use oryxa_core::UserId;
use oryxa_fde_core::{CriterionId, EvalRunId, ProjectScope};
use oryxa_fde_store::{
    Actor, EvalCaseResultRow, EvalCaseRow, EvalCriterionRow, EvalResults, EvalRunRow, EvalSuiteRow, ProjectTx, Store,
    StoreError as PgError, new_id,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::grade::{CaseOutcome, CaseResult, Verdict};
use crate::ids::{CaseId, SuiteId};
use crate::runner::{CriterionRate, Report};
use crate::store::{EvalRun, EvalStore, EvalStoreError};
use crate::suite::{Case, Command, Grader, Suite};

/// What the store keeps of a suite besides its name and cases.
#[derive(Serialize, Deserialize)]
struct Definition {
    criteria: Vec<CriterionId>,
    target: Option<Command>,
    graders: Vec<Grader>,
}

fn failed(e: PgError) -> EvalStoreError {
    match e {
        PgError::Conflict => EvalStoreError::Conflict,
        PgError::Missing(_) => EvalStoreError::NotFound,
        e => {
            tracing::error!(error = %e, "eval store");
            EvalStoreError::Unavailable
        }
    }
}

fn corrupt(what: &'static str) -> EvalStoreError {
    tracing::error!(what, "stored eval data is invalid");
    EvalStoreError::Unavailable
}

fn actor(user: &UserId, request_id: Option<&str>) -> Actor {
    Actor {
        user: user.clone(),
        request_id: request_id.map_or_else(|| new_id("req"), str::to_owned),
    }
}

/// One transaction on the project: `f` runs in it, and it commits.
async fn on<T>(
    store: &Store,
    scope: &ProjectScope,
    f: impl AsyncFnOnce(&mut ProjectTx) -> Result<T, EvalStoreError>,
) -> Result<T, EvalStoreError> {
    let mut tx = store.project(scope).await.map_err(failed)?;
    let value = f(&mut tx).await?;
    tx.commit().await.map_err(failed)?;
    Ok(value)
}

fn case_row(c: &Case) -> EvalCaseRow {
    EvalCaseRow {
        id: c.id.to_string(),
        input: c.input.clone(),
        expected: c.expected.clone(),
        criteria: c.criteria.clone(),
    }
}

fn suite_row(s: &Suite, by: &UserId) -> Result<EvalSuiteRow, EvalStoreError> {
    let definition = Definition {
        criteria: s.criteria.clone(),
        target: s.target.clone(),
        graders: s.graders.clone(),
    };
    Ok(EvalSuiteRow {
        id: s.id.to_string(),
        name: s.name.clone(),
        definition: serde_json::to_value(&definition).map_err(|_| corrupt("encode"))?,
        created_by: by.clone(),
        created_at: OffsetDateTime::now_utc(),
        cases: s.cases.iter().map(case_row).collect(),
    })
}

fn suite(scope: &ProjectScope, r: EvalSuiteRow) -> Result<Suite, EvalStoreError> {
    let d: Definition = serde_json::from_value(r.definition).map_err(|_| corrupt("suite definition"))?;
    Ok(Suite {
        id: SuiteId::new(r.id).map_err(|_| corrupt("suite id"))?,
        scope: scope.clone(),
        name: r.name,
        criteria: d.criteria,
        target: d.target,
        graders: d.graders,
        cases: r
            .cases
            .into_iter()
            .map(|c| {
                Ok(Case {
                    id: CaseId::new(c.id).map_err(|_| corrupt("case id"))?,
                    input: c.input,
                    expected: c.expected,
                    criteria: c.criteria,
                })
            })
            .collect::<Result<_, EvalStoreError>>()?,
    })
}

fn outcome_text(o: CaseOutcome) -> &'static str {
    match o {
        CaseOutcome::Passed => "passed",
        CaseOutcome::Failed => "failed",
        CaseOutcome::Errored => "errored",
    }
}

fn results(report: &Report) -> Result<EvalResults, EvalStoreError> {
    Ok(EvalResults {
        cases: report
            .cases
            .iter()
            .map(|c| {
                Ok(EvalCaseResultRow {
                    case: c.case.to_string(),
                    outcome: outcome_text(c.outcome).into(),
                    output: c.output.clone(),
                    verdicts: serde_json::to_string(&c.verdicts).map_err(|_| corrupt("encode"))?,
                    error: c.error.clone(),
                })
            })
            .collect::<Result<_, EvalStoreError>>()?,
        criteria: report
            .criteria
            .iter()
            .map(|c| {
                let rate = EvalCriterionRow {
                    passed: c.passed,
                    total: c.total,
                };
                (c.criterion.clone(), rate)
            })
            .collect(),
        passed: report.passed,
        failed: report.failed,
        errored: report.errored,
    })
}

fn report(r: EvalResults) -> Result<Report, EvalStoreError> {
    let cases = r
        .cases
        .into_iter()
        .map(|c| {
            let outcome = match c.outcome.as_str() {
                "passed" => CaseOutcome::Passed,
                "failed" => CaseOutcome::Failed,
                "errored" => CaseOutcome::Errored,
                _ => return Err(corrupt("case outcome")),
            };
            let verdicts: Vec<Verdict> = serde_json::from_str(&c.verdicts).map_err(|_| corrupt("verdicts"))?;
            Ok(CaseResult {
                case: CaseId::new(c.case).map_err(|_| corrupt("case id"))?,
                output: c.output,
                outcome,
                verdicts,
                error: c.error,
            })
        })
        .collect::<Result<_, EvalStoreError>>()?;
    let criteria = r
        .criteria
        .into_iter()
        .map(|(criterion, c)| CriterionRate {
            criterion,
            passed: c.passed,
            total: c.total,
            rate: if c.total == 0 {
                0.0
            } else {
                f64::from(c.passed) / f64::from(c.total)
            },
        })
        .collect();
    Ok(Report {
        cases,
        criteria,
        passed: r.passed,
        failed: r.failed,
        errored: r.errored,
    })
}

fn run(scope: &ProjectScope, r: EvalRunRow) -> Result<EvalRun, EvalStoreError> {
    Ok(EvalRun {
        id: r.id,
        scope: scope.clone(),
        suite: SuiteId::new(r.suite).map_err(|_| corrupt("suite id"))?,
        imported: r.imported,
        created_by: r.created_by,
        request_id: r.request_id,
        created_at: r.created_at,
        ended_at: r.ended_at,
        report: r.results.map(report).transpose()?,
    })
}

impl EvalStore for Store {
    async fn create_suite(&self, s: &Suite, by: &UserId) -> Result<(), EvalStoreError> {
        let row = suite_row(s, by)?;
        on(self, &s.scope, async |tx| {
            tx.create_eval_suite(&row, &actor(by, None)).await.map_err(failed)
        })
        .await
    }

    async fn suite(&self, scope: &ProjectScope, id: &SuiteId) -> Result<Option<Suite>, EvalStoreError> {
        let row = on(self, scope, async |tx| tx.eval_suite(id.as_str()).await.map_err(failed)).await?;
        row.map(|r| suite(scope, r)).transpose()
    }

    async fn suites(&self, scope: &ProjectScope) -> Result<Vec<Suite>, EvalStoreError> {
        let rows = on(self, scope, async |tx| tx.eval_suites().await.map_err(failed)).await?;
        rows.into_iter().map(|r| suite(scope, r)).collect()
    }

    async fn add_cases(
        &self,
        scope: &ProjectScope,
        id: &SuiteId,
        cases: Vec<Case>,
        by: &UserId,
    ) -> Result<Suite, EvalStoreError> {
        let rows: Vec<EvalCaseRow> = cases.iter().map(case_row).collect();
        let row = on(self, scope, async |tx| {
            if !tx
                .add_eval_cases(id.as_str(), &rows, &actor(by, None))
                .await
                .map_err(failed)?
            {
                return Err(EvalStoreError::NotFound);
            }
            tx.eval_suite(id.as_str()).await.map_err(failed)
        })
        .await?;
        suite(scope, row.ok_or(EvalStoreError::NotFound)?)
    }

    async fn create_run(&self, r: &EvalRun) -> Result<(), EvalStoreError> {
        let row = EvalRunRow {
            id: r.id.clone(),
            suite: r.suite.to_string(),
            imported: r.imported,
            created_by: r.created_by.clone(),
            request_id: r.request_id.clone(),
            created_at: r.created_at,
            ended_at: None,
            results: None,
        };
        on(self, &r.scope, async |tx| {
            tx.create_eval_run(&row, &actor(&r.created_by, Some(&r.request_id)))
                .await
                .map_err(failed)
        })
        .await
    }

    async fn run(&self, scope: &ProjectScope, id: &EvalRunId) -> Result<Option<EvalRun>, EvalStoreError> {
        let row = on(self, scope, async |tx| tx.eval_run(id).await.map_err(failed)).await?;
        row.map(|r| run(scope, r)).transpose()
    }

    async fn runs(&self, scope: &ProjectScope) -> Result<Vec<EvalRun>, EvalStoreError> {
        let rows = on(self, scope, async |tx| tx.eval_runs().await.map_err(failed)).await?;
        rows.into_iter().map(|r| run(scope, r)).collect()
    }

    async fn take_sandbox(
        &self,
        scope: &ProjectScope,
        run: &EvalRunId,
        lease: Duration,
    ) -> Result<bool, EvalStoreError> {
        on(self, scope, async |tx| {
            tx.take_eval_sandbox(run, lease).await.map_err(failed)
        })
        .await
    }

    async fn renew_sandbox(
        &self,
        scope: &ProjectScope,
        run: &EvalRunId,
        lease: Duration,
    ) -> Result<bool, EvalStoreError> {
        on(self, scope, async |tx| {
            tx.renew_eval_sandbox(run, lease).await.map_err(failed)
        })
        .await
    }

    async fn finish(&self, r: &EvalRun, report: &Report) -> Result<(), EvalStoreError> {
        let results = results(report)?;
        // The run's own request is the event's correlation id.
        on(self, &r.scope, async |tx| {
            tx.finish_eval_run(&r.id, &results, &actor(&r.created_by, Some(&r.request_id)))
                .await
                .map_err(failed)
        })
        .await
    }
}

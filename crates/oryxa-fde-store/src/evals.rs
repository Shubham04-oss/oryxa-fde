//! Evals (`oryxa-fde-evals`): suites of cases linked to a project's success criteria, eval runs, and their results
//! per case and per criterion. Every function is on a [`ProjectTx`], so it reads and writes one project of one
//! company; row-level security holds the rest back. A run's results and `eval-run.finished` commit together.
//!
//! An eval run that uses the company's sandbox holds it through the same lease as agent runs (`runs.rs`), so the
//! two never share it, whichever API task drives them.
//!
//! Suite and case ids are `oryxa-fde-evals`' validated ids, passed as text; what a suite's graders and target are
//! is the evals crate's to define (`definition`), kept as JSON and not read here. The criteria a suite measures are
//! rows referencing the project's criteria, so a suite never names another project's, and loses one that is removed.

use std::time::Duration;

use oryxa_core::UserId;
use oryxa_fde_core::{CriterionId, EvalRunId};
use oryxa_fde_events::EvalRunFinished;
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{Actor, ProjectTx, StoreError, audit, enqueue, id, unique_violation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalCaseRow {
    pub id: String,
    pub input: String,
    pub expected: Option<String>,
    pub criteria: Vec<CriterionId>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvalSuiteRow {
    pub id: String,
    pub name: String,
    /// The project's success criteria the suite measures, in order.
    pub criteria: Vec<CriterionId>,
    /// Target and graders, as the evals crate serialises them.
    pub definition: serde_json::Value,
    pub created_by: UserId,
    pub created_at: OffsetDateTime,
    /// In the order they were added.
    pub cases: Vec<EvalCaseRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalCaseResultRow {
    pub case: String,
    /// `passed`, `failed` or `errored`.
    pub outcome: String,
    pub output: Option<String>,
    /// Each grader's verdict, as JSON text.
    pub verdicts: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvalCriterionRow {
    pub passed: u32,
    pub total: u32,
}

/// A finished run's results, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalResults {
    pub cases: Vec<EvalCaseResultRow>,
    pub criteria: Vec<(CriterionId, EvalCriterionRow)>,
    pub passed: u32,
    pub failed: u32,
    pub errored: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalRunRow {
    pub id: EvalRunId,
    pub suite: String,
    pub imported: bool,
    pub created_by: UserId,
    pub request_id: String,
    pub created_at: OffsetDateTime,
    pub ended_at: Option<OffsetDateTime>,
    /// Present once the run has finished.
    pub results: Option<EvalResults>,
}

fn small(value: u32) -> Result<i32, StoreError> {
    i32::try_from(value).map_err(|_| StoreError::Rejected("count_too_large"))
}

fn unsmall(value: i32, what: &'static str) -> Result<u32, StoreError> {
    u32::try_from(value).map_err(|_| StoreError::Corrupt(what))
}

fn case_row(r: PgRow) -> Result<EvalCaseRow, StoreError> {
    let criteria: Vec<String> = r.try_get("criteria")?;
    Ok(EvalCaseRow {
        id: r.try_get("case_id")?,
        input: r.try_get("input")?,
        expected: r.try_get("expected")?,
        criteria: criteria
            .into_iter()
            .map(|c| id("criterion id", CriterionId::new, c))
            .collect::<Result<_, _>>()?,
    })
}

impl ProjectTx {
    async fn suite_exists(&mut self, suite: &str) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        Ok(sqlx::query_scalar(
            "select exists (select 1 from eval_suites
             where tenant_id = $1 and company_id = $2 and project_id = $3 and suite_id = $4)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(suite)
        .fetch_one(&mut *self.tx)
        .await?)
    }

    async fn insert_cases(&mut self, suite: &str, cases: &[EvalCaseRow]) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        for case in cases {
            let criteria: Vec<&str> = case.criteria.iter().map(CriterionId::as_str).collect();
            sqlx::query(
                "insert into eval_cases (tenant_id, company_id, project_id, suite_id, case_id, input, expected, criteria)
                 values ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(suite)
            .bind(&case.id)
            .bind(&case.input)
            .bind(&case.expected)
            .bind(&criteria)
            .execute(&mut *self.tx)
            .await
            .map_err(|e| if unique_violation(&e) { StoreError::Conflict } else { e.into() })?;
        }
        Ok(())
    }

    /// Stores a new suite with its criteria and cases. A suite id already used in the tenant is a conflict, and a
    /// criterion that is not the project's is `Missing`.
    pub async fn create_eval_suite(&mut self, suite: &EvalSuiteRow, by: &Actor) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into eval_suites (tenant_id, company_id, project_id, suite_id, name, definition, created_by,
                 created_at)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(&suite.id)
        .bind(&suite.name)
        .bind(suite.definition.to_string())
        .bind(suite.created_by.as_str())
        .bind(suite.created_at)
        .execute(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        for (position, criterion) in suite.criteria.iter().enumerate() {
            sqlx::query(
                "insert into eval_suite_criteria (tenant_id, company_id, project_id, suite_id, criterion_id, position)
                 values ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(&suite.id)
            .bind(criterion.as_str())
            .bind(i32::try_from(position).map_err(|_| StoreError::Rejected("count_too_large"))?)
            .execute(&mut *self.tx)
            .await
            .map_err(|e| match &e {
                sqlx::Error::Database(d) if d.is_foreign_key_violation() => StoreError::Missing("criterion"),
                _ if unique_violation(&e) => StoreError::Rejected("duplicate_criterion"),
                _ => e.into(),
            })?;
        }
        self.insert_cases(&suite.id, &suite.cases).await?;
        audit(
            &mut self.tx,
            &self.scope.company,
            Some(&self.scope.project),
            by,
            "eval_suite_created",
            Some(&suite.id),
        )
        .await
    }

    /// Adds cases to a suite: `false` if there is no such suite, a conflict if a case id is taken.
    pub async fn add_eval_cases(&mut self, suite: &str, cases: &[EvalCaseRow], by: &Actor) -> Result<bool, StoreError> {
        if !self.suite_exists(suite).await? {
            return Ok(false);
        }
        self.insert_cases(suite, cases).await?;
        audit(
            &mut self.tx,
            &self.scope.company,
            Some(&self.scope.project),
            by,
            "eval_cases_added",
            Some(suite),
        )
        .await?;
        Ok(true)
    }

    async fn eval_cases(&mut self, suite: &str) -> Result<Vec<EvalCaseRow>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "select case_id, input, expected, criteria from eval_cases
             where tenant_id = $1 and company_id = $2 and project_id = $3 and suite_id = $4 order by position",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(suite)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(case_row)
        .collect()
    }

    async fn suite_criteria(&mut self, suite: &str) -> Result<Vec<CriterionId>, StoreError> {
        let (t, c, p) = self.keys();
        let rows: Vec<String> = sqlx::query_scalar(
            "select criterion_id from eval_suite_criteria
             where tenant_id = $1 and company_id = $2 and project_id = $3 and suite_id = $4 order by position",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(suite)
        .fetch_all(&mut *self.tx)
        .await?;
        rows.into_iter()
            .map(|r| id("criterion id", CriterionId::new, r))
            .collect()
    }

    async fn suite_rows(&mut self, suite: Option<&str>) -> Result<Vec<EvalSuiteRow>, StoreError> {
        let (t, c, p) = self.keys();
        let rows = sqlx::query(
            "select suite_id, name, definition::text as definition, created_by, created_at from eval_suites
             where tenant_id = $1 and company_id = $2 and project_id = $3 and ($4::text is null or suite_id = $4)
             order by created_at desc, suite_id desc",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(suite)
        .fetch_all(&mut *self.tx)
        .await?;
        let mut suites = Vec::with_capacity(rows.len());
        for r in rows {
            let id: String = r.try_get("suite_id")?;
            let definition: String = r.try_get("definition")?;
            suites.push(EvalSuiteRow {
                criteria: self.suite_criteria(&id).await?,
                cases: self.eval_cases(&id).await?,
                id,
                name: r.try_get("name")?,
                definition: serde_json::from_str(&definition).map_err(|_| StoreError::Corrupt("suite definition"))?,
                created_by: id_user(r.try_get("created_by")?)?,
                created_at: r.try_get("created_at")?,
            });
        }
        Ok(suites)
    }

    pub async fn eval_suite(&mut self, suite: &str) -> Result<Option<EvalSuiteRow>, StoreError> {
        Ok(self.suite_rows(Some(suite)).await?.pop())
    }

    /// The project's suites with their cases, newest first.
    pub async fn eval_suites(&mut self) -> Result<Vec<EvalSuiteRow>, StoreError> {
        self.suite_rows(None).await
    }

    /// Stores a new, unfinished run of a suite of this project.
    pub async fn create_eval_run(&mut self, run: &EvalRunRow, by: &Actor) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into eval_runs (tenant_id, company_id, project_id, run_id, suite_id, imported, created_by,
                 request_id, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.id.as_str())
        .bind(&run.suite)
        .bind(run.imported)
        .bind(run.created_by.as_str())
        .bind(&run.request_id)
        .bind(run.created_at)
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
            "eval_run_started",
            Some(run.id.as_str()),
        )
        .await
    }

    async fn run_rows(&mut self, run: Option<&EvalRunId>) -> Result<Vec<EvalRunRow>, StoreError> {
        let (t, c, p) = self.keys();
        let rows = sqlx::query(
            "select run_id, suite_id, imported, created_by, request_id, created_at, ended_at, passed, failed, errored
             from eval_runs where tenant_id = $1 and company_id = $2 and project_id = $3
               and ($4::text is null or run_id = $4)
             order by created_at desc, run_id desc",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.map(EvalRunId::as_str))
        .fetch_all(&mut *self.tx)
        .await?;
        let mut runs = Vec::with_capacity(rows.len());
        for r in rows {
            let id = id("eval run id", EvalRunId::new, r.try_get("run_id")?)?;
            let results = match r.try_get::<Option<i32>, _>("passed")? {
                None => None,
                Some(passed) => Some(EvalResults {
                    cases: self.case_results(&id).await?,
                    criteria: self.criterion_results(&id).await?,
                    passed: unsmall(passed, "eval counts")?,
                    failed: unsmall(r.try_get("failed")?, "eval counts")?,
                    errored: unsmall(r.try_get("errored")?, "eval counts")?,
                }),
            };
            runs.push(EvalRunRow {
                id,
                suite: r.try_get("suite_id")?,
                imported: r.try_get("imported")?,
                created_by: id_user(r.try_get("created_by")?)?,
                request_id: r.try_get("request_id")?,
                created_at: r.try_get("created_at")?,
                ended_at: r.try_get("ended_at")?,
                results,
            });
        }
        Ok(runs)
    }

    async fn case_results(&mut self, run: &EvalRunId) -> Result<Vec<EvalCaseResultRow>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "select case_id, outcome, output, verdicts, error from eval_case_results
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 order by position",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            Ok(EvalCaseResultRow {
                case: r.try_get("case_id")?,
                outcome: r.try_get("outcome")?,
                output: r.try_get("output")?,
                verdicts: r.try_get("verdicts")?,
                error: r.try_get("error")?,
            })
        })
        .collect()
    }

    async fn criterion_results(&mut self, run: &EvalRunId) -> Result<Vec<(CriterionId, EvalCriterionRow)>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "select criterion_id, passed, total from eval_criterion_results
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 order by position",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            Ok((
                id("criterion id", CriterionId::new, r.try_get("criterion_id")?)?,
                EvalCriterionRow {
                    passed: unsmall(r.try_get("passed")?, "criterion result")?,
                    total: unsmall(r.try_get("total")?, "criterion result")?,
                },
            ))
        })
        .collect()
    }

    async fn eval_run_open(&mut self, run: &EvalRunId) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        Ok(sqlx::query_scalar(
            "select exists (select 1 from eval_runs
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 and ended_at is null)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .fetch_one(&mut *self.tx)
        .await?)
    }

    /// Takes the company's sandbox for an unfinished eval run for `ttl`, if no live lease is someone else's.
    /// `Missing` once the run has finished or if there is no such run.
    pub async fn take_eval_sandbox(&mut self, run: &EvalRunId, ttl: Duration) -> Result<Option<u64>, StoreError> {
        if !self.eval_run_open(run).await? {
            return Err(StoreError::Missing("eval run"));
        }
        self.lease_sandbox(run.as_str(), ttl).await
    }

    /// Extends the eval run's lease; `false` if it has finished or no longer holds the sandbox.
    pub async fn renew_eval_sandbox(&mut self, run: &EvalRunId, ttl: Duration) -> Result<bool, StoreError> {
        if !self.eval_run_open(run).await? {
            return Ok(false);
        }
        self.renew_lease(run.as_str(), ttl).await
    }

    pub async fn eval_run(&mut self, run: &EvalRunId) -> Result<Option<EvalRunRow>, StoreError> {
        Ok(self.run_rows(Some(run)).await?.pop())
    }

    /// The project's runs with their results, newest first.
    pub async fn eval_runs(&mut self) -> Result<Vec<EvalRunRow>, StoreError> {
        self.run_rows(None).await
    }

    /// Records a run's results, once, with each measured criterion's pass rate as its latest result (`Rejected` if a
    /// criterion is not the project's), lets go of the company's sandbox if the run holds it, and enqueues
    /// `eval-run.finished` (an errored case counted as failed), all in this transaction. A run that already has
    /// results is a conflict.
    pub async fn finish_eval_run(
        &mut self,
        run: &EvalRunId,
        results: &EvalResults,
        by: &Actor,
    ) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        let updated = sqlx::query(
            "update eval_runs set ended_at = now(), passed = $5, failed = $6, errored = $7
             where tenant_id = $1 and company_id = $2 and project_id = $3 and run_id = $4 and ended_at is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(run.as_str())
        .bind(small(results.passed)?)
        .bind(small(results.failed)?)
        .bind(small(results.errored)?)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(StoreError::Conflict);
        }
        for (position, case) in results.cases.iter().enumerate() {
            sqlx::query(
                "insert into eval_case_results (tenant_id, company_id, project_id, run_id, case_id, position, outcome,
                     output, verdicts, error)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            )
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(run.as_str())
            .bind(&case.case)
            .bind(i32::try_from(position).map_err(|_| StoreError::Rejected("count_too_large"))?)
            .bind(&case.outcome)
            .bind(&case.output)
            .bind(&case.verdicts)
            .bind(&case.error)
            .execute(&mut *self.tx)
            .await?;
        }
        for (position, (criterion, rate)) in results.criteria.iter().enumerate() {
            sqlx::query(
                "insert into eval_criterion_results (tenant_id, company_id, project_id, run_id, criterion_id, position,
                     passed, total)
                 values ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(run.as_str())
            .bind(criterion.as_str())
            .bind(i32::try_from(position).map_err(|_| StoreError::Rejected("count_too_large"))?)
            .bind(small(rate.passed)?)
            .bind(small(rate.total)?)
            .execute(&mut *self.tx)
            .await?;
            // A criterion no case measured has no new value; its latest result stays the last measured one.
            if rate.total > 0
                && !self
                    .record_criterion_result(criterion, run, f64::from(rate.passed) / f64::from(rate.total))
                    .await?
            {
                return Err(StoreError::Rejected("criterion"));
            }
        }
        self.release_sandbox(run.as_str()).await?;
        let failed = results.failed.saturating_add(results.errored);
        let event = EvalRunFinished::new(&self.scope, run.clone(), results.passed, failed);
        enqueue(&mut self.tx, &self.scope.company, by, &event).await?;
        Ok(())
    }
}

fn id_user(raw: String) -> Result<UserId, StoreError> {
    id("user id", UserId::new, raw)
}

#[cfg(test)]
mod tests {
    //! Against Postgres, on a fresh runtime login, like `live.rs`.

    use oryxa_core::TenantId;
    use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
    use serde_json::json;
    use sqlx::Row;

    use super::*;
    use crate::{CompanyIn, Comparator, CriterionIn, Name, ProjectIn, Store, Text, new_id};

    fn actor() -> Actor {
        Actor {
            user: UserId::new("usr_lead").unwrap(),
            request_id: new_id("req"),
        }
    }

    /// A project with one success criterion: answer accuracy, at least 0.9.
    async fn project(store: &Store, tenant: &TenantId) -> (ProjectScope, CriterionId) {
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
            name: Name::new("Support triage").unwrap(),
            summary: None,
        };
        tx.create(&input, &actor()).await.unwrap().unwrap();
        let criterion = CriterionId::new(new_id("crt")).unwrap();
        let accuracy = CriterionIn {
            description: Text::new("Labels tickets correctly").unwrap(),
            metric: Name::new("label accuracy").unwrap(),
            comparator: Comparator::AtLeast,
            target: 0.9,
            unit: None,
        };
        tx.add_criterion(&criterion, &accuracy, &actor())
            .await
            .unwrap()
            .unwrap();
        tx.commit().await.unwrap();
        (scope, criterion)
    }

    fn case(id: &str, criterion: &CriterionId) -> EvalCaseRow {
        EvalCaseRow {
            id: id.into(),
            input: format!("Sample ticket {id}: the export button does nothing."),
            expected: Some("bug".into()),
            criteria: vec![criterion.clone()],
        }
    }

    fn suite(criterion: &CriterionId) -> EvalSuiteRow {
        EvalSuiteRow {
            id: new_id("sut"),
            name: "Triage labels".into(),
            criteria: vec![criterion.clone()],
            definition: json!({ "graders": [{ "kind": "exact" }] }),
            created_by: UserId::new("usr_lead").unwrap(),
            created_at: OffsetDateTime::now_utc().replace_nanosecond(0).unwrap(),
            cases: vec![case("cas_b", criterion), case("cas_a", criterion)],
        }
    }

    fn run(suite: &EvalSuiteRow) -> EvalRunRow {
        EvalRunRow {
            id: EvalRunId::new(new_id("evr")).unwrap(),
            suite: suite.id.clone(),
            imported: false,
            created_by: UserId::new("usr_lead").unwrap(),
            request_id: new_id("req"),
            created_at: OffsetDateTime::now_utc().replace_nanosecond(0).unwrap(),
            ended_at: None,
            results: None,
        }
    }

    fn results(criterion: &CriterionId) -> EvalResults {
        EvalResults {
            cases: vec![
                EvalCaseResultRow {
                    case: "cas_b".into(),
                    outcome: "passed".into(),
                    output: Some("bug".into()),
                    verdicts: "[{\"pass\":true}]".into(),
                    error: None,
                },
                EvalCaseResultRow {
                    case: "cas_a".into(),
                    outcome: "errored".into(),
                    output: None,
                    // A judge may quote output, escaped as JSON: text keeps what jsonb would refuse.
                    verdicts: "[{\"verdict\":\"errored\",\"reason\":\"\\u0000\"}]".into(),
                    error: Some("the target timed out".into()),
                },
            ],
            criteria: vec![(criterion.clone(), EvalCriterionRow { passed: 1, total: 2 })],
            passed: 1,
            failed: 0,
            errored: 1,
        }
    }

    async fn with_suite_and_run(
        store: &Store,
        scope: &ProjectScope,
        criterion: &CriterionId,
    ) -> (EvalSuiteRow, EvalRunRow) {
        let s = suite(criterion);
        let r = run(&s);
        let mut tx = store.project(scope).await.unwrap();
        tx.create_eval_suite(&s, &actor()).await.unwrap();
        tx.create_eval_run(&r, &actor()).await.unwrap();
        tx.commit().await.unwrap();
        (s, r)
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn suites_and_runs_stay_in_their_project() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let (a, crit) = project(&store, &tenant).await;
        let (b, _) = project(&store, &tenant).await;
        let (s, r) = with_suite_and_run(&store, &a, &crit).await;

        let mut tx = store.project(&a).await.unwrap();
        assert_eq!(tx.eval_suite(&s.id).await.unwrap(), Some(s.clone()));
        assert_eq!(tx.eval_suites().await.unwrap(), vec![s.clone()]);
        assert_eq!(tx.eval_run(&r.id).await.unwrap(), Some(r.clone()));
        assert!(
            tx.add_eval_cases(&s.id, &[case("cas_c", &crit)], &actor())
                .await
                .unwrap()
        );
        let ids: Vec<String> = tx
            .eval_suite(&s.id)
            .await
            .unwrap()
            .unwrap()
            .cases
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, ["cas_b", "cas_a", "cas_c"]);
        assert!(matches!(
            tx.add_eval_cases(&s.id, &[case("cas_a", &crit)], &actor()).await,
            Err(StoreError::Conflict)
        ));
        drop(tx);

        // Another project of the same tenant, the same project through another company, and the same ids in another
        // tenant: nothing, and nothing can be added or finished there.
        let other_tenant = TenantId::new(new_id("org")).unwrap();
        for scope in [
            b.clone(),
            b.company.project(a.project.clone()),
            CompanyScope::new(other_tenant, a.company.company.clone()).project(a.project.clone()),
        ] {
            let mut tx = store.project(&scope).await.unwrap();
            assert_eq!(tx.eval_suite(&s.id).await.unwrap(), None);
            assert!(tx.eval_suites().await.unwrap().is_empty());
            assert_eq!(tx.eval_run(&r.id).await.unwrap(), None);
            assert!(tx.eval_runs().await.unwrap().is_empty());
            assert!(
                !tx.add_eval_cases(&s.id, &[case("cas_x", &crit)], &actor())
                    .await
                    .unwrap()
            );
            assert!(matches!(
                tx.finish_eval_run(&r.id, &results(&crit), &actor()).await,
                Err(StoreError::Conflict)
            ));
            drop(tx);
            // A run of a suite the scope cannot see is refused.
            let mut tx = store.project(&scope).await.unwrap();
            assert!(tx.create_eval_run(&run(&s), &actor()).await.is_err());
        }
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_runs_results_and_its_event_commit_or_roll_back_together() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let (scope, crit) = project(&store, &tenant).await;
        let (_, r) = with_suite_and_run(&store, &scope, &crit).await;

        // Rolled back: no results, no criterion result and no event.
        let mut tx = store.project(&scope).await.unwrap();
        tx.finish_eval_run(&r.id, &results(&crit), &actor()).await.unwrap();
        drop(tx);
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(tx.eval_run(&r.id).await.unwrap(), Some(r.clone()));
        assert_eq!(criterion_result(&mut tx, &crit).await, None);
        tx.commit().await.unwrap();
        assert!(finished_events(&store, &tenant).await.is_empty());

        let mut tx = store.project(&scope).await.unwrap();
        tx.finish_eval_run(&r.id, &results(&crit), &actor()).await.unwrap();
        tx.commit().await.unwrap();
        // Results are written once.
        let mut tx = store.project(&scope).await.unwrap();
        assert!(matches!(
            tx.finish_eval_run(&r.id, &results(&crit), &actor()).await,
            Err(StoreError::Conflict)
        ));
        drop(tx);
        let mut tx = store.project(&scope).await.unwrap();
        let ended = tx.eval_run(&r.id).await.unwrap().unwrap();
        assert!(ended.ended_at.is_some());
        assert_eq!(ended.results, Some(results(&crit)));
        // The criterion's pass rate is its latest result, which the lifecycle engine reads.
        assert_eq!(criterion_result(&mut tx, &crit).await, Some((r.id.to_string(), 0.5)));
        assert_eq!(tx.eval_runs().await.unwrap(), vec![ended]);
        tx.commit().await.unwrap();

        // The event: ids and counts only (an errored case counts as failed), in the project's group.
        let events = finished_events(&store, &tenant).await;
        assert_eq!(events.len(), 1);
        let (group, detail) = &events[0];
        assert_eq!(group, &format!("{}/{}", tenant, scope.project));
        let data: serde_json::Value = serde_json::from_str(detail).unwrap();
        assert_eq!(
            data["data"],
            json!({ "company": scope.company.company.as_str(), "project": scope.project.as_str(), "eval_run": r.id.as_str(), "passed": 1, "failed": 1 })
        );
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn agent_and_eval_runs_take_turns_on_the_companys_sandbox() {
        use crate::AgentRunRow;
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let (scope, crit) = project(&store, &tenant).await;
        let (_, r) = with_suite_and_run(&store, &scope, &crit).await;
        let agent = AgentRunRow {
            id: oryxa_fde_core::AgentRunId::new(new_id("run")).unwrap(),
            task: "Add a /healthz endpoint.".into(),
            repository: json!({ "owner": "sample-org", "name": "status-page", "base": "main" }),
            created_by: UserId::new("usr_lead").unwrap(),
            request_id: new_id("req"),
            created_at: OffsetDateTime::now_utc(),
            started_at: None,
            ended_at: None,
            state: json!({ "state": "queued" }),
            input_tokens: 0,
            output_tokens: 0,
            delivery: json!({ "status": "none" }),
        };
        let lease = Duration::from_secs(60);
        let mut tx = store.project(&scope).await.unwrap();
        tx.create_agent_run(&agent, &actor()).await.unwrap();
        let held = tx.take_eval_sandbox(&r.id, lease).await.unwrap().unwrap();
        assert_eq!(tx.take_agent_sandbox(&agent.id, lease).await.unwrap(), None);
        assert!(tx.renew_eval_sandbox(&r.id, lease).await.unwrap());
        tx.commit().await.unwrap();

        // The eval run's results let it go; a finished run can neither take nor renew it.
        let mut tx = store.project(&scope).await.unwrap();
        tx.finish_eval_run(&r.id, &results(&crit), &actor()).await.unwrap();
        assert!(!tx.renew_eval_sandbox(&r.id, lease).await.unwrap());
        assert!(matches!(
            tx.take_eval_sandbox(&r.id, lease).await,
            Err(StoreError::Missing(_))
        ));
        // The agent run that takes it next gets a higher generation, so the eval run's late calls are refused.
        assert_eq!(tx.take_agent_sandbox(&agent.id, lease).await.unwrap(), Some(held + 1));
        tx.commit().await.unwrap();
        let (_, other) = with_suite_and_run(&store, &scope, &crit).await;
        let mut tx = store.project(&scope).await.unwrap();
        assert_eq!(tx.take_eval_sandbox(&other.id, lease).await.unwrap(), None);
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_suite_measures_only_its_projects_criteria_and_loses_one_that_is_removed() {
        let store = crate::testing::store().await;
        let tenant = TenantId::new(new_id("org")).unwrap();
        let (a, crit) = project(&store, &tenant).await;
        let (b, theirs) = project(&store, &tenant).await;

        // Another project's criterion, or one that does not exist, is refused, and nothing of the suite is kept.
        for criteria in [
            vec![theirs.clone()],
            vec![crit.clone(), CriterionId::new(new_id("crt")).unwrap()],
        ] {
            let mut s = suite(&crit);
            s.criteria = criteria;
            let mut tx = store.project(&a).await.unwrap();
            assert!(matches!(
                tx.create_eval_suite(&s, &actor()).await,
                Err(StoreError::Missing("criterion"))
            ));
            drop(tx);
            let mut tx = store.project(&a).await.unwrap();
            assert_eq!(tx.eval_suite(&s.id).await.unwrap(), None);
        }

        // A run's results for a criterion that is not the project's roll back, with nothing recorded.
        let (s, r) = with_suite_and_run(&store, &a, &crit).await;
        let mut tx = store.project(&a).await.unwrap();
        let mut foreign = results(&crit);
        foreign
            .criteria
            .push((theirs.clone(), EvalCriterionRow { passed: 1, total: 1 }));
        assert!(matches!(
            tx.finish_eval_run(&r.id, &foreign, &actor()).await,
            Err(StoreError::Rejected("criterion"))
        ));
        drop(tx);
        let mut tx = store.project(&b).await.unwrap();
        assert_eq!(criterion_result(&mut tx, &theirs).await, None);
        drop(tx);

        // A criterion no case measured keeps its last result.
        let mut tx = store.project(&a).await.unwrap();
        let mut unmeasured = results(&crit);
        unmeasured.criteria[0].1 = EvalCriterionRow { passed: 0, total: 0 };
        tx.finish_eval_run(&r.id, &unmeasured, &actor()).await.unwrap();
        assert_eq!(criterion_result(&mut tx, &crit).await, None);
        tx.commit().await.unwrap();

        // Removing the criterion takes it off the suite.
        let mut tx = store.project(&a).await.unwrap();
        assert!(tx.remove_criterion(&crit, &actor()).await.unwrap());
        tx.commit().await.unwrap();
        let mut tx = store.project(&a).await.unwrap();
        assert!(tx.eval_suite(&s.id).await.unwrap().unwrap().criteria.is_empty());
    }

    /// The criterion's latest result, as (eval run, value), read in the project's transaction.
    async fn criterion_result(tx: &mut ProjectTx, criterion: &CriterionId) -> Option<(String, f64)> {
        sqlx::query("select eval_run_id, value from criterion_results where criterion_id = $1")
            .bind(criterion.as_str())
            .fetch_optional(&mut *tx.tx)
            .await
            .unwrap()
            .map(|r| (r.get("eval_run_id"), r.get("value")))
    }

    /// `eval-run.finished` rows of one tenant, as (group, detail), read as the relay.
    async fn finished_events(store: &Store, tenant: &TenantId) -> Vec<(String, String)> {
        let mut tx = store.pool.begin().await.unwrap();
        sqlx::query("set local role oryxa_fde_relay")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "select group_key, detail from outbox where tenant_id = $1 and detail_type = 'fde.eval-run.finished.v1'
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

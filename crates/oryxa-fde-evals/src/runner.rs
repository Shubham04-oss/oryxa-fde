//! Runs a suite: each case's output (from the target in the sandbox, or imported), every grader on it, then the
//! pass rate of each success criterion the suite measures.

use std::collections::HashMap;

use oryxa_fde_core::CriterionId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::grade::{CaseOutcome, CaseResult, EvalSandbox, Judge, grade, produce};
use crate::ids::CaseId;
use crate::suite::{Grader, Suite};

/// Where a run's outputs come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// The suite's target, run in the sandbox for each case.
    Target,
    /// Outputs imported as CSV, by case.
    Imported(HashMap<CaseId, String>),
}

/// One criterion's result in a run: the cases that measure it, and how many passed. Errored cases count as not
/// passed, so a run that could not grade never shows a better rate than it earned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct CriterionRate {
    #[schema(value_type = String)]
    pub criterion: CriterionId,
    pub passed: u32,
    pub total: u32,
    /// `passed / total`, 0 when no case measures it.
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Report {
    pub cases: Vec<CaseResult>,
    pub criteria: Vec<CriterionRate>,
    pub passed: u32,
    pub failed: u32,
    pub errored: u32,
}

pub async fn run(suite: &Suite, source: &Source, sandbox: &impl EvalSandbox, judge: &impl Judge) -> Report {
    let uses_sandbox = matches!(source, Source::Target) || suite.graders.iter().any(|g| matches!(g, Grader::Script(_)));
    let started = !uses_sandbox || sandbox.start().await.is_ok();
    let mut cases = Vec::with_capacity(suite.cases.len());
    for case in &suite.cases {
        let output = if !started {
            Err("the sandbox could not start".to_owned())
        } else {
            match (source, &suite.target) {
                (Source::Target, Some(target)) => produce(sandbox, target, case).await,
                (Source::Target, None) => Err("the suite has no target".to_owned()),
                (Source::Imported(outputs), _) => outputs
                    .get(&case.id)
                    .cloned()
                    .ok_or_else(|| "no output was imported for this case".to_owned()),
            }
        };
        cases.push(match output {
            Err(error) => CaseResult {
                case: case.id.clone(),
                output: None,
                outcome: CaseOutcome::Errored,
                verdicts: vec![],
                error: Some(error),
            },
            Ok(output) => {
                let mut verdicts = Vec::with_capacity(suite.graders.len());
                for grader in &suite.graders {
                    verdicts.push(grade(grader, case, &output, sandbox, judge).await);
                }
                CaseResult {
                    case: case.id.clone(),
                    outcome: CaseOutcome::of(&verdicts),
                    output: Some(output),
                    verdicts,
                    error: None,
                }
            }
        });
    }
    report(suite, cases)
}

/// Counts and per-criterion rates for a run's case results.
pub fn report(suite: &Suite, cases: Vec<CaseResult>) -> Report {
    let count = |o| cases.iter().filter(|c| c.outcome == o).count() as u32;
    let outcome: HashMap<&CaseId, CaseOutcome> = cases.iter().map(|c| (&c.case, c.outcome)).collect();
    let criteria = suite
        .criteria
        .iter()
        .map(|criterion| {
            let measured: Vec<_> = suite
                .cases
                .iter()
                .filter(|c| suite.criteria_of(c).contains(criterion))
                .filter_map(|c| outcome.get(&c.id))
                .collect();
            let total = measured.len() as u32;
            let passed = measured.iter().filter(|o| ***o == CaseOutcome::Passed).count() as u32;
            CriterionRate {
                criterion: criterion.clone(),
                passed,
                total,
                rate: if total == 0 {
                    0.0
                } else {
                    f64::from(passed) / f64::from(total)
                },
            }
        })
        .collect();
    Report {
        passed: count(CaseOutcome::Passed),
        failed: count(CaseOutcome::Failed),
        errored: count(CaseOutcome::Errored),
        cases,
        criteria,
    }
}

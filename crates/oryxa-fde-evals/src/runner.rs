//! Runs a suite: each case's output (from the target in the sandbox, or imported), every grader on it, then the
//! pass rate of each success criterion the suite measures.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use oryxa_fde_core::CriterionId;
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, timeout_at};
use utoipa::ToSchema;

use crate::grade::{CaseOutcome, CaseResult, EvalSandbox, Judge, JudgeFailed, grade, produce};
use crate::ids::CaseId;
use crate::suite::{Case, Grader, Suite};

/// How far one run may go, so it neither holds the company's sandbox nor calls the model without end. Past the
/// deadline, or once the judge's calls are spent, the cases left error.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub deadline: Instant,
    /// Model calls the judge grader may make in the run.
    pub judge_calls: u32,
}

const OUT_OF_TIME: &str = "the run reached its time limit";
const OUT_OF_CALLS: &str = "the run used all the judge's model calls";

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

/// Whether a run needs the company's sandbox: for the target, a script grader, or the judge (which calls the model
/// from the sandbox).
pub fn uses_sandbox(suite: &Suite, source: &Source) -> bool {
    matches!(source, Source::Target)
        || suite
            .graders
            .iter()
            .any(|g| matches!(g, Grader::Script(_) | Grader::Judge { .. }))
}

pub async fn run(
    suite: &Suite,
    source: &Source,
    sandbox: &impl EvalSandbox,
    judge: &impl Judge,
    limits: Limits,
) -> Report {
    let judge = Allowance {
        judge,
        left: Mutex::new(limits.judge_calls),
    };
    let judged = suite.graders.iter().any(|g| matches!(g, Grader::Judge { .. }));
    let started =
        !uses_sandbox(suite, source) || matches!(timeout_at(limits.deadline, sandbox.start()).await, Ok(Ok(())));
    let mut cases = Vec::with_capacity(suite.cases.len());
    for case in &suite.cases {
        cases.push(if Instant::now() >= limits.deadline {
            errored(case, OUT_OF_TIME.into())
        } else if judged && judge.left() == 0 {
            errored(case, OUT_OF_CALLS.into())
        } else {
            timeout_at(limits.deadline, run_case(suite, source, case, started, sandbox, &judge))
                .await
                .unwrap_or_else(|_| errored(case, OUT_OF_TIME.into()))
        });
    }
    report(suite, cases)
}

async fn run_case(
    suite: &Suite,
    source: &Source,
    case: &Case,
    started: bool,
    sandbox: &impl EvalSandbox,
    judge: &impl Judge,
) -> CaseResult {
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
    let output = match output {
        Ok(output) => output,
        Err(error) => return errored(case, error),
    };
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

fn errored(case: &Case, error: String) -> CaseResult {
    CaseResult {
        case: case.id.clone(),
        output: None,
        outcome: CaseOutcome::Errored,
        verdicts: vec![],
        error: Some(error),
    }
}

/// The run's judge: each call is counted before it is made, and one past the run's allowance is refused.
struct Allowance<'a, J> {
    judge: &'a J,
    left: Mutex<u32>,
}

impl<J> Allowance<'_, J> {
    fn left(&self) -> u32 {
        *self.left.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl<J: Judge> Judge for Allowance<'_, J> {
    async fn complete(&self, system: &str, prompt: &str) -> Result<String, JudgeFailed> {
        {
            let mut left = self.left.lock().unwrap_or_else(PoisonError::into_inner);
            *left = left.checked_sub(1).ok_or(JudgeFailed)?;
        }
        self.judge.complete(system, prompt).await
    }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use oryxa_core::TenantId;
    use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId};

    use super::*;
    use crate::grade::{CommandOutput, SandboxFailed, Verdict};
    use crate::ids::SuiteId;
    use crate::suite::Command;

    /// A target that takes 40 seconds to answer `yes`.
    struct Slow;

    impl EvalSandbox for Slow {
        async fn start(&self) -> Result<(), SandboxFailed> {
            Ok(())
        }
        async fn run(
            &self,
            _: &[String],
            _: BTreeMap<String, String>,
            _: Duration,
        ) -> Result<CommandOutput, SandboxFailed> {
            tokio::time::sleep(Duration::from_secs(40)).await;
            Ok(CommandOutput {
                exit_code: Some(0),
                stdout: "yes".into(),
                timed_out: false,
            })
        }
    }

    /// A judge that passes everything and counts its calls.
    #[derive(Default)]
    struct Counting(Mutex<u32>);

    impl Judge for Counting {
        async fn complete(&self, _: &str, _: &str) -> Result<String, JudgeFailed> {
            *self.0.lock().unwrap() += 1;
            Ok("{\"pass\": true}".into())
        }
    }

    fn cases(n: usize) -> Vec<Case> {
        (0..n)
            .map(|i| Case {
                id: CaseId::new(format!("case_{i}")).unwrap(),
                input: "Is the API up?".into(),
                expected: Some("yes".into()),
                criteria: vec![],
            })
            .collect()
    }

    fn errors(report: &Report) -> Vec<Option<&str>> {
        report.cases.iter().map(|c| c.error.as_deref()).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_stops_at_its_deadline_and_the_cases_left_error() {
        let mut s = suite(vec![Grader::ExactMatch { ignore_case: false }]);
        s.target = Some(Command {
            argv: vec!["node".into(), "answer.mjs".into()],
            timeout_secs: 60,
        });
        s.cases = cases(4);
        let limits = Limits {
            deadline: Instant::now() + Duration::from_secs(100),
            judge_calls: 0,
        };
        let report = run(&s, &Source::Target, &Slow, &Counting::default(), limits).await;
        // Two cases finish by 80s; the third is cut off at 100s, and the fourth never starts.
        assert_eq!(errors(&report), [None, None, Some(OUT_OF_TIME), Some(OUT_OF_TIME)]);
        assert_eq!((report.passed, report.errored), (2, 2));
        assert_eq!(Instant::now(), limits.deadline);
    }

    #[tokio::test]
    async fn the_judge_is_never_called_past_the_runs_allowance() {
        let judge = Grader::Judge {
            rubric: "Is it right?".into(),
        };
        let mut s = suite(vec![judge.clone(), judge]);
        s.cases = cases(3);
        let outputs = s.cases.iter().map(|c| (c.id.clone(), "yes".to_owned())).collect();
        let limits = Limits {
            deadline: Instant::now() + Duration::from_secs(3600),
            judge_calls: 3,
        };
        let model = Counting::default();
        let report = run(&s, &Source::Imported(outputs), &Slow, &model, limits).await;
        assert_eq!(*model.0.lock().unwrap(), 3);
        // The second case's second judgement is refused, not made, and the third case is not graded at all.
        assert_eq!(report.cases[0].outcome, CaseOutcome::Passed);
        assert_eq!(report.cases[1].outcome, CaseOutcome::Errored);
        assert!(matches!(report.cases[1].verdicts[1], Verdict::Errored { .. }));
        assert_eq!(errors(&report), [None, None, Some(OUT_OF_CALLS)]);
    }

    fn suite(graders: Vec<Grader>) -> Suite {
        Suite {
            id: SuiteId::new("suite_1".to_owned()).unwrap(),
            scope: CompanyScope::new(TenantId::new("org_a").unwrap(), CompanyId::new("cmp_1").unwrap())
                .project(ProjectId::new("prj_1").unwrap()),
            name: "Sample".into(),
            criteria: vec![],
            target: None,
            graders,
            cases: vec![],
        }
    }

    #[test]
    fn a_run_needs_the_sandbox_for_the_target_a_script_or_the_judge() {
        let imported = Source::Imported(HashMap::new());
        let script = Grader::Script(Command {
            argv: vec!["sh".into()],
            timeout_secs: 5,
        });
        let judge = Grader::Judge {
            rubric: "Is it right?".into(),
        };
        let exact = Grader::ExactMatch { ignore_case: false };
        assert!(uses_sandbox(&suite(vec![exact.clone()]), &Source::Target));
        assert!(uses_sandbox(&suite(vec![exact.clone(), script]), &imported));
        assert!(uses_sandbox(&suite(vec![judge]), &imported));
        assert!(!uses_sandbox(&suite(vec![exact]), &imported));
    }
}

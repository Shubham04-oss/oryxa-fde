//! Evals for a project: suites of cases with graders, linked to the project's success criteria; a runner that
//! produces and grades each case's output in the company's sandbox; and pass rates per criterion. The run API
//! lives with the agent run API in `oryxa-fde-agent`, which supplies the sandbox and the model.
//!
//! The only bus event is `EvalRunFinished`: ids and counts.

pub mod grade;
pub mod ids;
pub mod import;
pub mod runner;
pub mod schema;
pub mod store;
pub mod suite;

pub use grade::{CaseOutcome, CaseResult, CommandOutput, EvalSandbox, Judge, JudgeFailed, SandboxFailed, Verdict};
pub use ids::{CaseId, SuiteId};
pub use runner::{CriterionRate, Report, Source};
pub use store::{EvalRun, EvalStore, EvalStoreError, InMemoryEvals};
pub use suite::{Case, Command, Grader, Suite, SuiteError};

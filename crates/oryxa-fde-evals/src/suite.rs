//! An eval suite: cases, the graders every case goes through, and the project's success criteria it measures.
//! A suite can name a target command that produces each case's output in the company's sandbox; without one,
//! its runs grade outputs imported as CSV.

use oryxa_fde_core::{CriterionId, ProjectScope};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::ids::{CaseId, SuiteId};
use crate::schema;

/// Each case's input, expected output and stored output. Matches the gateway's limit on one environment value,
/// since a target or a script grader gets them as environment variables.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_CASES: usize = 10_000;
pub const MAX_GRADERS: usize = 8;
pub const MAX_CRITERIA: usize = 64;
pub const MAX_RUBRIC_BYTES: usize = 8 * 1024;
const MAX_NAME_CHARS: usize = 200;
const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 4096;
const MAX_PATTERN_BYTES: usize = 512;
const MAX_TIMEOUT_SECS: u32 = 600;

/// A command run in the sandbox as `agent`, in `/workspace`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Command {
    pub argv: Vec<String>,
    pub timeout_secs: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Grader {
    /// The output equals the expected output, ignoring surrounding whitespace.
    ExactMatch {
        #[serde(default)]
        ignore_case: bool,
    },
    /// The output matches a regular expression.
    Regex { pattern: String },
    /// The output is JSON valid against a schema (a strict subset of JSON Schema).
    JsonSchema {
        #[schema(value_type = Object)]
        schema: serde_json::Value,
    },
    /// A command in the sandbox decides: exit code 0 passes. It gets `EVAL_CASE`, `EVAL_INPUT`, `EVAL_OUTPUT` and
    /// `EVAL_EXPECTED` in its environment.
    Script(Command),
    /// A model grades the output against a rubric.
    Judge { rubric: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Case {
    #[schema(value_type = String)]
    pub id: CaseId,
    pub input: String,
    #[serde(default)]
    pub expected: Option<String>,
    /// The suite's criteria this case measures; empty means all of them.
    #[serde(default)]
    #[schema(value_type = Vec<String>)]
    pub criteria: Vec<CriterionId>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Suite {
    pub id: SuiteId,
    pub scope: ProjectScope,
    pub name: String,
    pub criteria: Vec<CriterionId>,
    /// Produces each case's output from `EVAL_CASE` and `EVAL_INPUT`; its stdout is the output.
    pub target: Option<Command>,
    pub graders: Vec<Grader>,
    pub cases: Vec<Case>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SuiteError {
    #[error("invalid {0}")]
    Invalid(&'static str),
    #[error("too many {0}")]
    TooMany(&'static str),
    #[error(transparent)]
    Schema(#[from] schema::SchemaError),
}

fn text_ok(text: &str) -> bool {
    text.len() <= MAX_TEXT_BYTES && !text.contains('\0')
}

fn command_ok(c: &Command) -> bool {
    (1..=MAX_ARGS).contains(&c.argv.len())
        && c.argv.iter().all(|a| a.len() <= MAX_ARG_BYTES && !a.contains('\0'))
        && !c.argv[0].is_empty()
        && (1..=MAX_TIMEOUT_SECS).contains(&c.timeout_secs)
}

/// The regex grader's pattern, compiled with a bound on its size so a pattern cannot exhaust memory.
pub fn compile(pattern: &str) -> Option<Regex> {
    (pattern.len() <= MAX_PATTERN_BYTES)
        .then(|| RegexBuilder::new(pattern).size_limit(1 << 20).build().ok())
        .flatten()
}

impl Suite {
    /// Refuses a suite that could not run as written: bad commands, patterns or schemas, oversized text, unknown
    /// criteria (against the project's own), or duplicate case ids.
    pub fn check(&self, project_criteria: &[CriterionId]) -> Result<(), SuiteError> {
        let chars = self.name.trim().chars().count();
        if chars == 0 || chars > MAX_NAME_CHARS || self.name.chars().any(char::is_control) {
            return Err(SuiteError::Invalid("name"));
        }
        if self.criteria.is_empty() || self.criteria.iter().any(|c| !project_criteria.contains(c)) {
            return Err(SuiteError::Invalid("criteria"));
        }
        if self.criteria.len() > MAX_CRITERIA {
            return Err(SuiteError::TooMany("criteria"));
        }
        if self.target.as_ref().is_some_and(|t| !command_ok(t)) {
            return Err(SuiteError::Invalid("target"));
        }
        if self.graders.is_empty() {
            return Err(SuiteError::Invalid("graders"));
        }
        if self.graders.len() > MAX_GRADERS {
            return Err(SuiteError::TooMany("graders"));
        }
        for grader in &self.graders {
            match grader {
                Grader::ExactMatch { .. } => {}
                Grader::Regex { pattern } => {
                    compile(pattern).ok_or(SuiteError::Invalid("regex"))?;
                }
                Grader::JsonSchema { schema } => schema::check(schema)?,
                Grader::Script(c) if !command_ok(c) => return Err(SuiteError::Invalid("script")),
                Grader::Script(_) => {}
                Grader::Judge { rubric } => {
                    if rubric.trim().is_empty() || rubric.len() > MAX_RUBRIC_BYTES {
                        return Err(SuiteError::Invalid("rubric"));
                    }
                }
            }
        }
        self.check_cases(&self.cases)
    }

    /// Checks cases to add to this suite, alone and together with the ones it has.
    pub fn check_cases(&self, cases: &[Case]) -> Result<(), SuiteError> {
        if cases.len() > MAX_CASES {
            return Err(SuiteError::TooMany("cases"));
        }
        let mut seen = std::collections::HashSet::new();
        for case in cases {
            if !seen.insert(&case.id) {
                return Err(SuiteError::Invalid("case ids"));
            }
            if !text_ok(&case.input) || !case.expected.as_deref().is_none_or(text_ok) {
                return Err(SuiteError::Invalid("case text"));
            }
            if case.criteria.iter().any(|c| !self.criteria.contains(c)) {
                return Err(SuiteError::Invalid("case criteria"));
            }
        }
        Ok(())
    }

    /// The criteria a case measures.
    pub fn criteria_of<'a>(&'a self, case: &'a Case) -> &'a [CriterionId] {
        if case.criteria.is_empty() {
            &self.criteria
        } else {
            &case.criteria
        }
    }
}

#[cfg(test)]
mod tests {
    use oryxa_core::TenantId;
    use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId};
    use serde_json::json;

    use super::*;

    fn crit(id: &str) -> CriterionId {
        CriterionId::new(id).unwrap()
    }

    fn suite() -> Suite {
        Suite {
            id: SuiteId::new("suite_1").unwrap(),
            scope: CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap())
                .project(ProjectId::new("prj_1").unwrap()),
            name: "Answer quality".into(),
            criteria: vec![crit("crit_accuracy")],
            target: Some(Command {
                argv: vec!["node".into(), "eval/answer.mjs".into()],
                timeout_secs: 30,
            }),
            graders: vec![
                Grader::ExactMatch { ignore_case: true },
                Grader::Regex { pattern: "^ok".into() },
                Grader::JsonSchema {
                    schema: json!({ "type": "object" }),
                },
                Grader::Script(Command {
                    argv: vec!["python3".into(), "grade.py".into()],
                    timeout_secs: 10,
                }),
                Grader::Judge {
                    rubric: "Correct and polite.".into(),
                },
            ],
            cases: vec![Case {
                id: CaseId::new("c1").unwrap(),
                input: "What is the status?".into(),
                expected: Some("ok".into()),
                criteria: vec![],
            }],
        }
    }

    #[test]
    fn a_well_formed_suite_passes_its_checks() {
        assert_eq!(suite().check(&[crit("crit_accuracy"), crit("crit_other")]), Ok(()));
    }

    #[test]
    fn refuses_suites_that_could_not_run_as_written() {
        let project = [crit("crit_accuracy")];
        let mut cases = Vec::new();
        let mut s = suite();
        s.criteria = vec![crit("crit_elsewhere")];
        cases.push((s, SuiteError::Invalid("criteria")));
        let mut s = suite();
        s.graders = vec![];
        cases.push((s, SuiteError::Invalid("graders")));
        let mut s = suite();
        s.graders = vec![Grader::Regex { pattern: "(".into() }];
        cases.push((s, SuiteError::Invalid("regex")));
        let mut s = suite();
        s.target = Some(Command {
            argv: vec!["sh".into(), "a\0b".into()],
            timeout_secs: 5,
        });
        cases.push((s, SuiteError::Invalid("target")));
        let mut s = suite();
        s.graders = vec![Grader::Script(Command {
            argv: vec!["sh".into()],
            timeout_secs: 0,
        })];
        cases.push((s, SuiteError::Invalid("script")));
        let mut s = suite();
        s.graders = vec![Grader::Judge { rubric: " ".into() }];
        cases.push((s, SuiteError::Invalid("rubric")));
        let mut s = suite();
        s.cases.push(s.cases[0].clone());
        cases.push((s, SuiteError::Invalid("case ids")));
        let mut s = suite();
        s.cases[0].input = "x".repeat(MAX_TEXT_BYTES + 1);
        cases.push((s, SuiteError::Invalid("case text")));
        let mut s = suite();
        s.cases[0].criteria = vec![crit("crit_other")];
        cases.push((s, SuiteError::Invalid("case criteria")));
        for (s, error) in cases {
            assert_eq!(s.check(&project), Err(error));
        }
        let mut s = suite();
        s.graders = vec![Grader::JsonSchema {
            schema: json!({ "anyOf": [] }),
        }];
        assert!(matches!(s.check(&project), Err(SuiteError::Schema(_))));
    }

    #[test]
    fn graders_read_as_tagged_json() {
        let g: Vec<Grader> = serde_json::from_value(json!([
            { "kind": "exact_match" },
            { "kind": "regex", "pattern": "ok" },
            { "kind": "json_schema", "schema": { "type": "object" } },
            { "kind": "script", "argv": ["sh", "grade.sh"], "timeout_secs": 5 },
            { "kind": "judge", "rubric": "Polite." }
        ]))
        .unwrap();
        assert_eq!(g[0], Grader::ExactMatch { ignore_case: false });
        assert!(serde_json::from_value::<Grader>(json!({ "kind": "eval", "code": "x" })).is_err());
    }
}

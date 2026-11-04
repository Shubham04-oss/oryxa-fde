//! The context pack: the project's agreed scope, success criteria, decisions, conventions and agent config,
//! written into the sandbox before the agent starts. It holds ids and text the FDE workspace already shows, never
//! secrets: model credentials are added by the gateway's outbound handler.

use std::collections::HashMap;
use std::future::Future;

use oryxa_fde_core::{AgentRunId, CriterionId, DecisionId, ProjectScope};
use serde::{Deserialize, Serialize};

pub const CONTEXT_PACK_VERSION: u8 = 1;
/// Where the API writes the pack in the sandbox, through the gateway's file API.
pub const CONTEXT_PACK_PATH: &str = "/workspace/.oryxa/context.json";

const MAX_TEXT: usize = 64 * 1024;
const MAX_ITEMS: usize = 200;
const MAX_APPROVAL_RULES: usize = 64;
const MAX_PATTERN: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextPack {
    pub v: u8,
    pub run: AgentRunId,
    pub scope: ProjectScope,
    /// What the FDE asked this run to do.
    pub task: String,
    pub scope_of_work: String,
    pub success_criteria: Vec<Criterion>,
    pub decisions: Vec<Decision>,
    pub conventions: Vec<String>,
    pub config: AgentConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Criterion {
    pub id: CriterionId,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub id: DecisionId,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Bedrock model or inference profile id, from the layered org, company and project config.
    pub model: String,
    /// AWS region of the Bedrock endpoint the outbound handler allows.
    pub region: String,
    pub max_turns: u32,
    /// The company's approval list.
    pub approvals: Vec<ApprovalRule>,
}

/// A tool call that needs an FDE's approval: the tool's name (`*` for any) and, optionally, a regular expression
/// over its command (`Bash`) or its JSON input (other tools).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalRule {
    pub action: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

/// Everything about a project the pack carries, as the store holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectContext {
    pub scope_of_work: String,
    pub success_criteria: Vec<Criterion>,
    pub decisions: Vec<Decision>,
    pub conventions: Vec<String>,
    pub config: AgentConfig,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ContextError {
    #[error("no context for this project")]
    NotFound,
    #[error("{0} is too large for a context pack")]
    TooLarge(&'static str),
    #[error("{0} is invalid")]
    Invalid(&'static str),
    #[error("context source failed: {0}")]
    Source(String),
}

/// Where a pack's project context comes from. The store implements it once it lands; until then,
/// `InMemoryContext`. Every lookup takes the full `ProjectScope`, so one company never reads another's.
pub trait ContextSource {
    fn project_context(
        &self,
        scope: &ProjectScope,
    ) -> impl Future<Output = Result<ProjectContext, ContextError>> + Send;
}

impl ContextPack {
    /// Builds the pack for one run, refusing context too large or malformed to hand to an agent.
    pub async fn build(
        source: &impl ContextSource,
        run: AgentRunId,
        scope: ProjectScope,
        task: String,
    ) -> Result<Self, ContextError> {
        let context = source.project_context(&scope).await?;
        let pack = Self {
            v: CONTEXT_PACK_VERSION,
            run,
            scope,
            task,
            scope_of_work: context.scope_of_work,
            success_criteria: context.success_criteria,
            decisions: context.decisions,
            conventions: context.conventions,
            config: context.config,
        };
        pack.check()?;
        Ok(pack)
    }

    fn check(&self) -> Result<(), ContextError> {
        let text = |name: &'static str, value: &str| {
            if value.len() > MAX_TEXT {
                Err(ContextError::TooLarge(name))
            } else {
                Ok(())
            }
        };
        let count = |name: &'static str, len: usize, max: usize| {
            if len > max {
                Err(ContextError::TooLarge(name))
            } else {
                Ok(())
            }
        };
        text("task", &self.task)?;
        text("scope of work", &self.scope_of_work)?;
        count("success criteria", self.success_criteria.len(), MAX_ITEMS)?;
        count("decisions", self.decisions.len(), MAX_ITEMS)?;
        count("conventions", self.conventions.len(), MAX_ITEMS)?;
        count("approval rules", self.config.approvals.len(), MAX_APPROVAL_RULES)?;
        for c in &self.success_criteria {
            text("success criterion", &c.text)?;
        }
        for d in &self.decisions {
            text("decision", &d.text)?;
        }
        for c in &self.conventions {
            text("convention", c)?;
        }
        let config = &self.config;
        if !safe_token(&config.model, b".:_/-") {
            return Err(ContextError::Invalid("model"));
        }
        if !safe_token(&config.region, b"-") {
            return Err(ContextError::Invalid("region"));
        }
        if config.max_turns == 0 {
            return Err(ContextError::Invalid("max turns"));
        }
        for rule in &config.approvals {
            if !safe_token(&rule.action, b"_-") || (rule.tool != "*" && !safe_token(&rule.tool, b"_-")) {
                return Err(ContextError::Invalid("approval rule"));
            }
            if rule
                .pattern
                .as_ref()
                .is_some_and(|p| p.is_empty() || p.len() > MAX_PATTERN)
            {
                return Err(ContextError::Invalid("approval pattern"));
            }
        }
        Ok(())
    }
}

/// 1..=128 ASCII letters and digits plus `extra`. These values reach the harness's command line and env.
fn safe_token(value: &str, extra: &[u8]) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}

/// Project context held in memory, keyed by the full scope.
#[derive(Debug, Default)]
pub struct InMemoryContext {
    projects: HashMap<ProjectScope, ProjectContext>,
}

impl InMemoryContext {
    pub fn insert(&mut self, scope: ProjectScope, context: ProjectContext) {
        self.projects.insert(scope, context);
    }
}

impl ContextSource for InMemoryContext {
    async fn project_context(&self, scope: &ProjectScope) -> Result<ProjectContext, ContextError> {
        self.projects.get(scope).cloned().ok_or(ContextError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use oryxa_core::TenantId;
    use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId};

    use super::*;

    fn scope(tenant: &str, company: &str) -> ProjectScope {
        CompanyScope::new(TenantId::new(tenant).unwrap(), CompanyId::new(company).unwrap())
            .project(ProjectId::new("prj_1").unwrap())
    }

    fn context() -> ProjectContext {
        ProjectContext {
            scope_of_work: "Sample scope".into(),
            success_criteria: vec![],
            decisions: vec![],
            conventions: vec![],
            config: AgentConfig {
                model: "anthropic.claude-opus-5-5".into(),
                region: "eu-west-1".into(),
                max_turns: 40,
                approvals: vec![],
            },
        }
    }

    async fn build(source: &InMemoryContext, scope: ProjectScope) -> Result<ContextPack, ContextError> {
        ContextPack::build(source, AgentRunId::new("run_1").unwrap(), scope, "Sample task".into()).await
    }

    #[tokio::test]
    async fn reads_only_the_requested_company() {
        let mut source = InMemoryContext::default();
        source.insert(scope("org_1", "cmp_1"), context());
        assert!(build(&source, scope("org_1", "cmp_1")).await.is_ok());
        // Same project id, another company or tenant: nothing.
        assert_eq!(
            build(&source, scope("org_1", "cmp_2")).await,
            Err(ContextError::NotFound)
        );
        assert_eq!(
            build(&source, scope("org_2", "cmp_1")).await,
            Err(ContextError::NotFound)
        );
    }

    #[tokio::test]
    async fn refuses_oversized_or_malformed_context() {
        let mut big = context();
        big.scope_of_work = "x".repeat(MAX_TEXT + 1);
        let mut bad_model = context();
        bad_model.config.model = "model --dangerously-skip-permissions".into();
        let mut bad_rule = context();
        bad_rule.config.approvals.push(ApprovalRule {
            action: "deploy".into(),
            tool: "Bash".into(),
            pattern: Some(String::new()),
        });
        let mut no_turns = context();
        no_turns.config.max_turns = 0;
        for (context, error) in [
            (big, ContextError::TooLarge("scope of work")),
            (bad_model, ContextError::Invalid("model")),
            (bad_rule, ContextError::Invalid("approval pattern")),
            (no_turns, ContextError::Invalid("max turns")),
        ] {
            let mut source = InMemoryContext::default();
            source.insert(scope("org_1", "cmp_1"), context);
            assert_eq!(build(&source, scope("org_1", "cmp_1")).await, Err(error));
        }
    }
}

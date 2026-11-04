//! The context pack: the project's agreed scope, success criteria, decisions, conventions and agent config,
//! written into the sandbox before the agent starts. It holds ids and text the FDE workspace already shows, never
//! secrets: model credentials are added by the gateway's outbound handler.
//!
//! The gateway writes the pack as root to a directory only root can open, so the agent's processes (including
//! ones left running by an earlier run) can neither read nor replace it. The API compares the digest the gateway
//! reads back with `EncodedPack::sha256`, and the harness refuses a pack whose digest differs.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::future::Future;

use oryxa_fde_core::{AgentRunId, CriterionId, DecisionId, ProjectScope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CONTEXT_PACK_VERSION: u8 = 1;

// The harness applies the same limits (`sandbox/harness/src/pack.ts`); both sides' tests check them against
// `sandbox/harness/test/fixtures/pack-limits.json`, so a pack one side accepts the other never refuses.
/// The whole pack, as JSON.
pub const MAX_PACK_BYTES: usize = 1024 * 1024;
/// Each text field: the task, the scope of work, each criterion, decision and convention.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
/// Success criteria, decisions and conventions, each.
pub const MAX_ITEMS: usize = 200;
pub const MAX_APPROVAL_RULES: usize = 64;
pub const MAX_PATTERN_BYTES: usize = 512;
/// The model, region and approval rule names.
pub const MAX_TOKEN_BYTES: usize = 128;

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
    #[error("the context pack in the sandbox differs from the one written")]
    WriteMismatch,
}

/// A pack as the bytes the gateway writes, with their SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedPack {
    pub bytes: Vec<u8>,
    /// Lowercase hex. The harness gets it on its command line and refuses a pack that does not match.
    pub sha256: String,
}

impl EncodedPack {
    /// Checks the digest the gateway reported for the file it wrote and read back. Fails closed on any difference.
    pub fn check_written(&self, sha256_in_sandbox: &str) -> Result<(), ContextError> {
        if sha256_in_sandbox == self.sha256 {
            Ok(())
        } else {
            Err(ContextError::WriteMismatch)
        }
    }
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
        pack.encode()?;
        Ok(pack)
    }

    /// The bytes to write into the sandbox, refused when larger than the harness accepts.
    pub fn encode(&self) -> Result<EncodedPack, ContextError> {
        let bytes = serde_json::to_vec(self).map_err(|_| ContextError::Invalid("pack"))?;
        if bytes.len() > MAX_PACK_BYTES {
            return Err(ContextError::TooLarge("pack"));
        }
        let sha256 = Sha256::digest(&bytes).iter().fold(String::new(), |mut hex, b| {
            let _ = write!(hex, "{b:02x}");
            hex
        });
        Ok(EncodedPack { bytes, sha256 })
    }

    fn check(&self) -> Result<(), ContextError> {
        if self.task.is_empty() {
            return Err(ContextError::Invalid("task"));
        }
        let text = |name: &'static str, value: &str| {
            if value.len() > MAX_TEXT_BYTES {
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
                .is_some_and(|p| p.is_empty() || p.len() > MAX_PATTERN_BYTES)
            {
                return Err(ContextError::Invalid("approval pattern"));
            }
        }
        Ok(())
    }
}

/// 1..=128 ASCII letters and digits plus `extra`. These values reach the harness's command line and env.
fn safe_token(value: &str, extra: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_BYTES
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
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
        big.scope_of_work = "x".repeat(MAX_TEXT_BYTES + 1);
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
        // Every field within its own limit, the whole over the pack limit: the harness would refuse it.
        let mut many = context();
        many.conventions = vec!["x".repeat(MAX_TEXT_BYTES); MAX_PACK_BYTES / MAX_TEXT_BYTES + 1];
        for (context, error) in [
            (big, ContextError::TooLarge("scope of work")),
            (bad_model, ContextError::Invalid("model")),
            (bad_rule, ContextError::Invalid("approval pattern")),
            (no_turns, ContextError::Invalid("max turns")),
            (many, ContextError::TooLarge("pack")),
        ] {
            let mut source = InMemoryContext::default();
            source.insert(scope("org_1", "cmp_1"), context);
            assert_eq!(build(&source, scope("org_1", "cmp_1")).await, Err(error));
        }
        let mut source = InMemoryContext::default();
        source.insert(scope("org_1", "cmp_1"), context());
        let empty_task = ContextPack::build(
            &source,
            AgentRunId::new("run_1").unwrap(),
            scope("org_1", "cmp_1"),
            String::new(),
        );
        assert_eq!(empty_task.await, Err(ContextError::Invalid("task")));
    }

    #[tokio::test]
    async fn the_api_checks_the_pack_the_sandbox_holds() {
        let mut source = InMemoryContext::default();
        source.insert(scope("org_1", "cmp_1"), context());
        let encoded = build(&source, scope("org_1", "cmp_1")).await.unwrap().encode().unwrap();
        assert_eq!(encoded.sha256.len(), 64);
        assert_eq!(encoded.sha256, encoded.sha256.to_lowercase());
        assert_eq!(encoded.check_written(&encoded.sha256.clone()), Ok(()));
        for other in ["", "00", &"0".repeat(64), &encoded.sha256.to_uppercase()] {
            assert_eq!(
                encoded.check_written(other),
                Err(ContextError::WriteMismatch),
                "{other}"
            );
        }
    }
}

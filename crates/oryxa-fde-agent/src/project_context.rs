//! The context pack's project context from the FDE store: the agreed scope of work, its success criteria and the
//! project's decisions, read in one transaction scoped to the project. The agent config and conventions come from
//! service config until layered org, company and project config exists.

use oryxa_fde_core::ProjectScope;
use oryxa_fde_store::{Comparator, ScopeKind, Store};

use crate::context::{AgentConfig, ContextError, ContextSource, Criterion, Decision, ProjectContext};

pub struct StoreContext {
    store: Store,
    config: AgentConfig,
    conventions: Vec<String>,
}

impl StoreContext {
    pub fn new(store: Store, config: AgentConfig, conventions: Vec<String>) -> Self {
        Self {
            store,
            config,
            conventions,
        }
    }
}

// The store's error can describe the query; only its kind is passed on.
fn unavailable<E>(_: E) -> ContextError {
    ContextError::Source("store".into())
}

impl ContextSource for StoreContext {
    async fn project_context(&self, scope: &ProjectScope) -> Result<ProjectContext, ContextError> {
        let mut tx = self.store.project(scope).await.map_err(unavailable)?;
        let Some(sow) = tx.scope_of_work().await.map_err(unavailable)? else {
            return Err(ContextError::NotFound);
        };
        let decisions = tx.decisions().await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let scope_of_work = sow
            .items
            .iter()
            .map(|i| {
                let kind = match i.kind {
                    ScopeKind::In => "In scope",
                    ScopeKind::Out => "Out of scope",
                };
                format!("- {kind}: {}", i.description.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n");
        let success_criteria = sow
            .criteria
            .into_iter()
            .map(|c| {
                let comparator = match c.comparator {
                    Comparator::AtLeast => "at least",
                    Comparator::AtMost => "at most",
                };
                let unit = c.unit.as_ref().map(|u| format!(" {}", u.as_str())).unwrap_or_default();
                Criterion {
                    id: c.id,
                    text: format!(
                        "{} ({}: {comparator} {}{unit})",
                        c.description.as_str(),
                        c.metric.as_str(),
                        c.target
                    ),
                }
            })
            .collect();
        let decisions = decisions
            .into_iter()
            .map(|d| Decision {
                id: d.id,
                text: format!("{}: {}", d.title.as_str(), d.rationale.as_str()),
            })
            .collect();
        Ok(ProjectContext {
            scope_of_work,
            success_criteria,
            decisions,
            conventions: self.conventions.clone(),
            config: self.config.clone(),
        })
    }
}

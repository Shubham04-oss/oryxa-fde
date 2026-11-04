//! The run service: what a run needs (the store, the sandbox gateway, live output, the project's context and
//! access checks) and how it is configured. Each run is driven by its own task (`orchestrate`); runs in one company
//! take turns, since they share the company's sandbox and its `/workspace`. The turn is a lease in the store, so
//! runs driven by different API tasks take turns too.

use std::sync::Arc;
use std::time::Duration;

use oryxa_fde_core::{AgentRunId, ProjectScope};
use tokio::sync::watch;

use crate::access::Access;
use crate::context::ContextSource;
use crate::event::Usage;
use crate::gateway::Sandbox;
use crate::live::LiveOutput;
use crate::store::{Budget, RunStore, Spend, StoreError};

/// The parts a run service is built from; production and tests each pick theirs.
pub trait Deps: Send + Sync + 'static {
    type Store: RunStore;
    type Sandbox: Sandbox;
    type Live: LiveOutput;
    type Context: ContextSource + Send + Sync + 'static;
    type Access: Access;
}

/// Model prices, in millionths of a US dollar per million tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pricing {
    pub input_usd_micros_per_mtok: u64,
    pub output_usd_micros_per_mtok: u64,
}

impl Pricing {
    /// What `usage` cost, rounded up so a budget is never passed by rounding.
    pub fn cost(&self, usage: Usage) -> u64 {
        let micro_mtok = u128::from(usage.input_tokens) * u128::from(self.input_usd_micros_per_mtok)
            + u128::from(usage.output_tokens) * u128::from(self.output_usd_micros_per_mtok);
        u64::try_from(micro_mtok.div_ceil(1_000_000)).unwrap_or(u64::MAX)
    }
}

#[derive(Debug, Clone)]
pub struct RunsConfig {
    pub pricing: Pricing,
    /// For a project that has no budget of its own; there is always one.
    pub default_budget: Budget,
    /// The longest one run may take, whatever is left of the budget.
    pub max_run: Duration,
    /// The longest an FDE's approval keeps the action's hosts open; the run closes them as soon as the approved
    /// call returns.
    pub grant_ttl: Duration,
    /// How long a harness that was told to stop gets before its sandbox is destroyed.
    pub grace: Duration,
    /// How often a run looks for decisions and cancels made on another API task, and a queued run for its turn.
    pub poll: Duration,
    /// How long a run's hold on the company's sandbox, and on its budget reservation, lasts without renewal. The run
    /// renews it four times as often; a run whose API task is gone lets go within this time.
    pub lease: Duration,
}

/// What is left of a project's budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Remaining {
    pub seconds: u64,
    pub usd_micros: u64,
}

/// `None` when either part is used up.
pub fn remaining(budget: Budget, spent: Spend) -> Option<Remaining> {
    let seconds = (u64::from(budget.minutes) * 60).checked_sub(spent.seconds)?;
    let usd_micros = budget.spend_usd_micros.checked_sub(spent.usd_micros)?;
    (seconds > 0 && usd_micros > 0).then_some(Remaining { seconds, usd_micros })
}

pub struct Runs<D: Deps> {
    pub store: D::Store,
    pub sandbox: D::Sandbox,
    pub live: D::Live,
    pub context: D::Context,
    pub access: D::Access,
    pub config: RunsConfig,
    changes: watch::Sender<u64>,
}

impl<D: Deps> Runs<D> {
    pub fn new(
        store: D::Store,
        sandbox: D::Sandbox,
        live: D::Live,
        context: D::Context,
        access: D::Access,
        config: RunsConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            sandbox,
            live,
            context,
            access,
            config,
            changes: watch::channel(0).0,
        })
    }

    /// Drives a stored, queued run in the background until it ends.
    pub fn launch(self: &Arc<Self>, scope: ProjectScope, run: AgentRunId) -> tokio::task::JoinHandle<()> {
        tokio::spawn(crate::orchestrate::drive(self.clone(), scope, run))
    }

    /// The project's budget and what is left of it.
    pub async fn budget(&self, scope: &ProjectScope) -> Result<(Budget, Spend), StoreError> {
        let budget = self.store.budget(scope).await?.unwrap_or(self.config.default_budget);
        Ok((budget, self.store.spend(scope).await?))
    }

    /// Ends runs whose API task stopped (a deploy) before they did; see [`crate::orchestrate`]. Any task may run it,
    /// and it never touches a run that is still driven. Returns how many it ended.
    pub async fn sweep(&self) -> usize {
        crate::orchestrate::sweep(self).await
    }

    /// Wakes runs on this task after a decision, a cancel or a run's end was stored; runs on other tasks see it on
    /// their next poll.
    pub(crate) fn changed(&self) {
        self.changes.send_modify(|n| *n = n.wrapping_add(1));
    }

    pub(crate) fn watch(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_round_up_and_never_overflow() {
        let p = Pricing {
            input_usd_micros_per_mtok: 15_000_000,
            output_usd_micros_per_mtok: 75_000_000,
        };
        let usage = |i, o| Usage {
            input_tokens: i,
            output_tokens: o,
        };
        assert_eq!(p.cost(usage(1_000_000, 0)), 15_000_000);
        assert_eq!(p.cost(usage(0, 1)), 75);
        assert_eq!(p.cost(usage(1, 0)), 15);
        let tiny = Pricing {
            input_usd_micros_per_mtok: 1,
            output_usd_micros_per_mtok: 0,
        };
        assert_eq!(tiny.cost(usage(1, 0)), 1);
        assert_eq!(p.cost(usage(u64::MAX, u64::MAX)), u64::MAX);
    }

    #[test]
    fn a_budget_is_used_up_when_either_part_is() {
        let budget = Budget {
            minutes: 10,
            spend_usd_micros: 5_000_000,
        };
        let spent = |seconds, usd_micros| Spend { seconds, usd_micros };
        assert_eq!(
            remaining(budget, spent(60, 1_000_000)),
            Some(Remaining {
                seconds: 540,
                usd_micros: 4_000_000
            })
        );
        assert_eq!(remaining(budget, spent(600, 0)), None);
        assert_eq!(remaining(budget, spent(0, 5_000_000)), None);
        assert_eq!(remaining(budget, spent(10_000, 0)), None);
    }
}

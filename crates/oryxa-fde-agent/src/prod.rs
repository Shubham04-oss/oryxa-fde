//! Production wiring for `oryxa-fde-api`: the run router built from the environment. With no sandbox gateway
//! configured, agent runs are off and nothing is mounted, so the API still starts in an environment that has none.
//!
//! | Variable | Default |
//! | --- | --- |
//! | `SANDBOX_GATEWAY_URL`, `SANDBOX_GATEWAY_TOKEN` | none: agent runs off |
//! | `REALTIME_URL`, `REALTIME_TOKEN` | none: output is stored, not streamed |
//! | `AGENT_MODEL`, `AGENT_REGION` | required with the gateway: the Bedrock model or inference profile, and its region |
//! | `AGENT_MAX_TURNS` | 100 |
//! | `AGENT_APPROVALS` | deploy commands and customer sends (JSON list of `ApprovalRule`) |
//! | `AGENT_RUN_MAX_MINUTES` | 60 |
//! | `AGENT_BUDGET_MINUTES`, `AGENT_BUDGET_USD` | 600 minutes and 100 dollars per project without a budget of its own |
//! | `AGENT_PRICE_INPUT_USD_PER_MTOK`, `AGENT_PRICE_OUTPUT_USD_PER_MTOK` | 15 and 75 |
//! | `EVAL_JUDGE_MODEL` | `AGENT_MODEL`: the model the eval judge grader uses, in `AGENT_REGION` |

use std::marker::PhantomData;
use std::time::Duration;

use axum::Router;
use oryxa_authn::{AccessTokenVerifier, KeySource};
use oryxa_authz::SpiceDb;
use oryxa_fde_core::{AgentRunId, ProjectScope};
use oryxa_fde_store::Store;

use crate::access::PlatformAccess;
use crate::api;
use crate::context::{AgentConfig, ApprovalRule};
use crate::evals::{self, EvalDeps, Evals, JudgeConfig};
use crate::gateway::GatewayClient;
use crate::live::{LiveError, LiveOutput, Offline, RealtimeClient};
use crate::project_context::StoreContext;
use crate::service::{Deps, Pricing, Runs, RunsConfig};
use crate::store::Budget;

pub struct Production<K>(PhantomData<fn() -> K>);

impl<K: KeySource + 'static> Deps for Production<K> {
    type Store = Store;
    type Sandbox = GatewayClient;
    type Live = Live;
    type Context = StoreContext;
    type Access = PlatformAccess<K>;
}

impl<K: KeySource + 'static> EvalDeps for Production<K> {
    type Evals = Store;
}

pub enum Live {
    Offline(Offline),
    Realtime(RealtimeClient),
}

impl LiveOutput for Live {
    async fn publish(&self, scope: &ProjectScope, run: &AgentRunId, lines: Vec<String>) -> Result<(), LiveError> {
        match self {
            Live::Offline(o) => o.publish(scope, run, lines).await,
            Live::Realtime(r) => r.publish(scope, run, lines).await,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("agent runs: {0}")]
pub struct ConfigError(String);

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn required(name: &str) -> Result<String, ConfigError> {
    var(name).ok_or_else(|| ConfigError(format!("{name} is not set")))
}

fn number<T: std::str::FromStr>(name: &str, default: T) -> Result<T, ConfigError> {
    var(name).map_or(Ok(default), |v| {
        v.parse().map_err(|_| ConfigError(format!("{name} is not a number")))
    })
}

fn dollars(name: &str, default: u64) -> Result<u64, ConfigError> {
    var(name).map_or(Ok(default * 1_000_000), |v| {
        usd_micros(&v).ok_or_else(|| ConfigError(format!("{name} is not an amount in dollars")))
    })
}

/// `"12.5"` dollars as 12_500_000 millionths, without floating point.
fn usd_micros(value: &str) -> Option<u64> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty() || fraction.len() > 6 || !(whole.bytes().chain(fraction.bytes())).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let fraction = format!("{fraction:0<6}").parse::<u64>().ok()?;
    whole.parse::<u64>().ok()?.checked_mul(1_000_000)?.checked_add(fraction)
}

/// The approval list until layered config holds the company's own.
fn default_approvals() -> Vec<ApprovalRule> {
    vec![
        ApprovalRule {
            action: "deploy".into(),
            tool: "Bash".into(),
            pattern: Some(
                r"\b(wrangler|vercel|flyctl|kubectl|helm|tofu|terraform|cdk|serverless)\b.*\b(deploy|apply|publish|release)\b"
                    .into(),
            ),
        },
        ApprovalRule {
            action: "customer_send".into(),
            tool: "mcp__customer__send_message".into(),
            pattern: None,
        },
    ]
}

/// The agent run and eval routers, or an empty one when `SANDBOX_GATEWAY_URL` is unset. Secrets come from the task's environment
/// (Secrets Manager through ECS); none is logged.
pub fn router_from_env<K: KeySource + 'static>(
    store: Store,
    authz: SpiceDb,
    tokens: AccessTokenVerifier<K>,
) -> Result<Router, ConfigError> {
    let Some(gateway_url) = var("SANDBOX_GATEWAY_URL") else {
        tracing::info!("SANDBOX_GATEWAY_URL is not set: agent runs are off");
        return Ok(Router::new());
    };
    let sandbox = GatewayClient::new(&gateway_url, required("SANDBOX_GATEWAY_TOKEN")?)
        .map_err(|_| ConfigError("the sandbox gateway client could not be built".into()))?;
    let live = match (var("REALTIME_URL"), var("REALTIME_TOKEN")) {
        (Some(url), Some(token)) => Live::Realtime(
            RealtimeClient::new(&url, token)
                .map_err(|_| ConfigError("the realtime client could not be built".into()))?,
        ),
        (None, None) => Live::Offline(Offline),
        _ => {
            return Err(ConfigError(
                "set both REALTIME_URL and REALTIME_TOKEN, or neither".into(),
            ));
        }
    };
    let approvals = match var("AGENT_APPROVALS") {
        Some(json) => {
            serde_json::from_str(&json).map_err(|_| ConfigError("AGENT_APPROVALS is not a rule list".into()))?
        }
        None => default_approvals(),
    };
    let agent = AgentConfig {
        model: required("AGENT_MODEL")?,
        region: required("AGENT_REGION")?,
        max_turns: number("AGENT_MAX_TURNS", 100)?,
        approvals,
    };
    let judge = JudgeConfig {
        model: var("EVAL_JUDGE_MODEL").unwrap_or_else(|| agent.model.clone()),
        region: agent.region.clone(),
    };
    let config = RunsConfig {
        pricing: Pricing {
            input_usd_micros_per_mtok: dollars("AGENT_PRICE_INPUT_USD_PER_MTOK", 15)?,
            output_usd_micros_per_mtok: dollars("AGENT_PRICE_OUTPUT_USD_PER_MTOK", 75)?,
        },
        default_budget: Budget {
            minutes: number("AGENT_BUDGET_MINUTES", 600)?,
            spend_usd_micros: dollars("AGENT_BUDGET_USD", 100)?,
        },
        max_run: Duration::from_secs(60 * number::<u64>("AGENT_RUN_MAX_MINUTES", 60)?),
        // The backstop: a grant closes when its approved call returns.
        grant_ttl: Duration::from_secs(5 * 60),
        grace: Duration::from_secs(60),
        poll: Duration::from_secs(1),
        // A run whose API task is gone lets go of its company's sandbox within a minute.
        lease: Duration::from_secs(60),
    };
    let runs = Runs::<Production<K>>::new(
        store.clone(),
        sandbox,
        live,
        StoreContext::new(store.clone(), agent, Vec::new()),
        PlatformAccess::new(tokens, authz),
        config,
    );
    // Runs whose API task stopped (a deploy) are ended by whichever task finds them: at start, then every lease.
    let sweeper = runs.clone();
    tokio::spawn(async move {
        loop {
            sweeper.sweep().await;
            tokio::time::sleep(sweeper.config.lease).await;
        }
    });
    let evals = Evals::new(runs.clone(), store, judge);
    Ok(api::router(runs).merge(evals::router(evals)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dollars_parse_exactly() {
        assert_eq!(usd_micros("100"), Some(100_000_000));
        assert_eq!(usd_micros("12.5"), Some(12_500_000));
        assert_eq!(usd_micros("0.000001"), Some(1));
        for bad in ["", ".5", "1.0000001", "-1", "1e3", "1.2.3", "a"] {
            assert_eq!(usd_micros(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_default_approval_list_holds_deploys() {
        let rules = default_approvals();
        assert!(rules.iter().any(|r| r.action == "deploy"));
        assert!(rules.iter().any(|r| r.action == "customer_send"));
    }
}

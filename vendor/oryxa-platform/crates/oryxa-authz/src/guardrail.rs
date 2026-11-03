//! Cedar guardrails: attribute rules (external sends, amounts, time) evaluated after
//! SpiceDB has already allowed a call. A guardrail can only take an allow away.

use std::str::FromStr;

use cedar_policy::{Authorizer, Context, Decision, Entities, EntityUid, PolicySet, Request};

#[derive(Debug, thiserror::Error)]
pub enum GuardrailError {
    #[error("policies: {0}")]
    Policies(String),
    #[error("request: {0}")]
    Request(String),
}

pub struct Guardrails {
    policies: PolicySet,
    authorizer: Authorizer,
}

impl Guardrails {
    pub fn new(policy_src: &str) -> Result<Self, GuardrailError> {
        let policies = PolicySet::from_str(policy_src).map_err(|e| GuardrailError::Policies(e.to_string()))?;
        Ok(Self {
            policies,
            authorizer: Authorizer::new(),
        })
    }

    /// `principal`/`resource` are Cedar uids like `Agent::"a1"`; `context` must be a JSON object.
    /// Any evaluation error is a deny: Cedar skips a forbid that errors, which would otherwise allow.
    pub fn passes(
        &self,
        principal: &str,
        action: &str,
        resource: &str,
        context: serde_json::Value,
    ) -> Result<bool, GuardrailError> {
        let uid = |s: &str| EntityUid::from_str(s).map_err(|e| GuardrailError::Request(e.to_string()));
        let action = uid(&format!("Action::\"{action}\""))?;
        let context = Context::from_json_value(context, None).map_err(|e| GuardrailError::Request(e.to_string()))?;
        let request = Request::new(uid(principal)?, action, uid(resource)?, context, None)
            .map_err(|e| GuardrailError::Request(e.to_string()))?;
        let response = self
            .authorizer
            .is_authorized(&request, &self.policies, &Entities::empty());
        Ok(response.decision() == Decision::Allow && response.diagnostics().errors().next().is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const POLICIES: &str = include_str!("../../../policies/guardrails.cedar");

    fn invoke(g: &Guardrails, ctx: serde_json::Value) -> bool {
        g.passes(r#"Agent::"a1""#, "invoke", r#"Capability::"gmail.send""#, ctx)
            .unwrap()
    }

    #[test]
    fn shipped_guardrails() {
        let g = Guardrails::new(POLICIES).unwrap();
        let ctx = |effect: &str, approved: bool, amount: i64, max: i64| {
            json!({"effect": effect, "approved": approved, "amount_cents": amount, "max_amount_cents": max,
                   "sandbox_enabled": false, "network": false})
        };
        let base = ctx("write", false, 0, 0);
        assert!(invoke(&g, base.clone()));

        assert!(!invoke(&g, ctx("external", false, 0, 0)));
        assert!(invoke(&g, ctx("external", true, 0, 0)));

        let over = ctx("write", true, 50_001, 50_000);
        let negative = ctx("write", true, -1, 50_000);
        assert!(!invoke(&g, negative));
        assert!(!invoke(&g, over));
    }

    #[test]
    fn sandbox_needs_the_tenant_switch_even_when_approved() {
        let g = Guardrails::new(POLICIES).unwrap();
        let sandbox = |enabled: bool, approved: bool, network: bool| {
            json!({"effect": "sandbox", "approved": approved, "amount_cents": 0, "max_amount_cents": 0,
                   "sandbox_enabled": enabled, "network": network})
        };
        assert!(!invoke(&g, sandbox(false, false, false)));
        assert!(
            !invoke(&g, sandbox(false, true, false)),
            "approval does not turn sandboxes on"
        );
        assert!(invoke(&g, sandbox(true, false, false)));
        assert!(
            !invoke(&g, sandbox(true, false, true)),
            "network-enabled code needs approval"
        );
        assert!(invoke(&g, sandbox(true, true, true)));
        // A context without the switch is an evaluation error, which denies.
        assert!(!invoke(
            &g,
            json!({"effect": "sandbox", "approved": true, "amount_cents": 0, "max_amount_cents": 0})
        ));
    }

    #[test]
    fn missing_context_denies_instead_of_skipping_the_forbid() {
        let g = Guardrails::new(POLICIES).unwrap();
        assert!(!invoke(&g, json!({})));
    }
}

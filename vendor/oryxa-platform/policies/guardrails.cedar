// Guardrails run only after SpiceDB has allowed the call; they can only take it away.
// Every invoke must send: effect (read|write|external|delete|sandbox), approved, amount_cents,
// max_amount_cents, sandbox_enabled, network. A missing attribute is an evaluation error, which the gateway denies.

permit (principal, action, resource);

// Anything leaving the company needs an explicit human approval.
forbid (principal, action == Action::"invoke", resource)
when { context.effect == "external" && !context.approved };

// Deletes always need approval.
forbid (principal, action == Action::"invoke", resource)
when { context.effect == "delete" && !context.approved };

// Running code is off unless the tenant turned sandboxes on (#34); approval does not override it.
forbid (principal, action == Action::"invoke", resource)
when { context.effect == "sandbox" && !context.sandbox_enabled };

// Code that can reach the network can carry data out: it needs approval like any external effect.
forbid (principal, action == Action::"invoke", resource)
when { context.effect == "sandbox" && context.network && !context.approved };

// Negative amounts are never valid (the gateway rejects them too; defence in depth).
forbid (principal, action == Action::"invoke", resource)
when { context.amount_cents < 0 };

// Spend above the tenant's limit is never automatic, approved or not.
forbid (principal, action == Action::"invoke", resource)
when { context.amount_cents > context.max_amount_cents };

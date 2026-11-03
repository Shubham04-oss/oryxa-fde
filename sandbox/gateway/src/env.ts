import type { CompanySandbox } from "./sandbox.js";

export interface Env {
  SANDBOX: DurableObjectNamespace<CompanySandbox>;
  /** Bearer credential `oryxa-fde-api` presents. Unset or short: every API call is refused. */
  SERVICE_TOKEN?: string;
  /** Dev secret values per company (see `DevSecretResolver`). */
  DEV_SECRETS?: string;
  /** Default instance type for a sandbox. */
  SANDBOX_INSTANCE?: string;
  /** Idle time before Cloudflare stops a sandbox's container. */
  SANDBOX_IDLE_TIMEOUT_MS?: string;
}

type GatewayEnv = Env;

declare global {
  namespace Cloudflare {
    // Types `env` and `ctx.exports`, as `wrangler types` would.
    interface Env extends GatewayEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index.js");
      durableNamespaces: "CompanySandbox";
    }
  }
}

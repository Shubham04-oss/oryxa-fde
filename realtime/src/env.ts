import type { RunChannel } from "./channel.js";

export interface Env {
  RUNS: DurableObjectNamespace<RunChannel>;
  /** What `oryxa-fde-api` presents to publish run output (its `REALTIME_TOKEN`). Unset or short: refused. */
  PUBLISH_TOKEN?: string;
  /** What fde-web presents to subscribe a browser it has checked with the API. Unset or short: refused. */
  SUBSCRIBE_TOKEN?: string;
}

type RealtimeEnv = Env;

declare global {
  namespace Cloudflare {
    // Types `env` and `ctx.exports`, as `wrangler types` would.
    interface Env extends RealtimeEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index.js");
      durableNamespaces: "RunChannel";
    }
  }
}

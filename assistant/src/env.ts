import type { Conversation } from "./conversation.js";
import type { PersonTurns } from "./limits.js";

export interface Env {
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  PERSON_TURNS: DurableObjectNamespace<PersonTurns>;
  /**
   * The FDE API over the private link fde-web already uses (infra adds the `vpc_services` binding at deploy).
   * The only host this Worker reaches; without it every tool answers that it could not read.
   */
  API?: Fetcher;
  /** What fde-web presents on every call (its `ASSISTANT_SERVICE_TOKEN`). Unset or short: refused. */
  SERVICE_TOKEN?: string;
  /** The key fde-web signs each conversation binding with (its `ASSISTANT_BINDING_KEY`). Unset or short: refused. */
  BINDING_KEY?: string;
  /** Which model answers, by name (src/model/provider.ts). Only `fake` is enabled. */
  ASSISTANT_MODEL?: string;
}

type AssistantEnv = Env;

// Types `env` and `ctx.exports`, as `wrangler types` would: workers-types declares them in this namespace.
/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-empty-object-type */
declare global {
  namespace Cloudflare {
    interface Env extends AssistantEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index.js");
      durableNamespaces: "Conversation" | "PersonTurns";
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace, @typescript-eslint/no-empty-object-type */

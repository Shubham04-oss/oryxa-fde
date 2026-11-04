import { readFileSync } from "node:fs";

import type { Options, PermissionResult, query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ApprovalChannel, ApprovalOutcome } from "../src/approvals.js";
import type { HarnessEvent } from "../src/events.js";
import { parsePack } from "../src/pack.js";

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
export const jsonLines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
export const samplePack = () => parsePack(JSON.parse(fixture("context.json")));

/** Stands in for the SDK's `query`: replays messages, and asks permission where the script says. */
export class FakeQuery {
  options: Options | undefined;
  prompt: unknown;
  readonly permissions: PermissionResult[] = [];
  progressedAfterPermission = false;

  constructor(private readonly script: readonly (SDKMessage | { ask: string; input: Record<string, unknown> })[]) {}

  get query(): typeof query {
    const self = this;
    return (({ prompt, options }: { prompt: unknown; options?: Options }) => {
      self.prompt = prompt;
      self.options = options;
      return (async function* () {
        for (const step of self.script) {
          if ("ask" in step) {
            const signal = options?.abortController?.signal ?? new AbortController().signal;
            const result = await options?.canUseTool?.(step.ask, step.input, {
              signal,
              toolUseID: "toolu_bdrk_d1",
              requestId: "req_1",
            });
            if (result) self.permissions.push(result);
            self.progressedAfterPermission = true;
            // The SDK stops the turn when a denial asks it to interrupt.
            if (result?.behavior === "deny" && result.interrupt) return;
            continue;
          }
          yield step;
        }
      })();
    }) as unknown as typeof query;
  }
}

/** An approval channel the test decides by hand. */
export class ManualApprovals implements ApprovalChannel {
  readonly #pending = new Map<string, (o: ApprovalOutcome) => void>();

  request(id: string): Promise<ApprovalOutcome> {
    return new Promise((resolve) => this.#pending.set(id, resolve));
  }

  decide(id: string, outcome: ApprovalOutcome): void {
    this.#pending.get(id)?.(outcome);
  }
}

export function collect(): { events: HarnessEvent[]; emit: (e: HarnessEvent) => void } {
  const events: HarnessEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

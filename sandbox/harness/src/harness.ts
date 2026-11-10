import { randomUUID } from "node:crypto";

import type {
  CanUseTool,
  Options,
  PermissionResult,
  query as sdkQuery,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { Adapter, describeTool, RUN_ERROR } from "./adapter.js";
import { type ApprovalChannel, ApprovalGate } from "./approvals.js";
import { homeEnv } from "./clean.js";
import type { HarnessEvent, Outcome } from "./events.js";
import { type LoadedPack, systemPrompt } from "./pack.js";

export const WORKSPACE = "/workspace";

// Only these reach the agent's process; nothing else from the sandbox's environment is inherited.
export const INHERITED_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
];

// A coding agent's tools. The SDK's defaults also schedule, message and spawn agents, which a sandboxed run must not.
export const TOOLS = [
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
];

/** What `main.ts` gives every backend: the approval channel, the event sink, its environment and the cancel. */
export interface BackendDeps {
  approvals: ApprovalChannel;
  emit(event: HarnessEvent): void;
  env: Readonly<Record<string, string | undefined>>;
  newApprovalId?: () => string;
  /** Aborts when the API cancels the run. */
  cancel?: AbortSignal;
}

/** The Claude Agent SDK backend's own dependencies. */
export interface HarnessDeps extends BackendDeps {
  query: typeof sdkQuery;
  /** The run's fresh home (`freshHome`): the CLI's state and the shell startup files it reads stay with one run. */
  home: string;
  /** Starts the SDK's agent process; in the sandbox, as another user than the harness (`agentSpawner`). */
  spawn?: Options["spawnClaudeCodeProcess"];
}

/**
 * The environment for the SDK's process. Bedrock through AWS, never a claude.ai login, and no credential at all:
 * the gateway's outbound handler adds the Bedrock credential to the allowed request. Home, XDG and temp are the
 * run's own: `settingSources: []` keeps the CLI's settings out, but not `~/.bashrc`, which its shell tool sources.
 */
export function harnessEnv(base: HarnessDeps["env"], pack: LoadedPack["pack"], home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    ...homeEnv(home),
    // SDK settings, internal only; the product never shows these names.
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    AWS_REGION: pack.config.region,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "oryxa-fde-harness/0.1.0",
  };
}

/** Runs one agent run headless and reports it as events. Ends with exactly one `result` event. */
export async function runHarness({ pack, rules }: LoadedPack, deps: HarnessDeps): Promise<Outcome> {
  const abort = new AbortController();
  const adapter = new Adapter();
  const newApprovalId = deps.newApprovalId ?? (() => `apr_${randomUUID()}`);
  let rejected = false;
  let cancelled = false;
  let outcome: Outcome | undefined;
  const cancel = () => {
    cancelled = true;
    abort.abort();
  };
  if (deps.cancel?.aborted) cancel();
  else deps.cancel?.addEventListener("abort", cancel, { once: true });
  const gate = new ApprovalGate(rules, deps.approvals, deps.emit, newApprovalId, abort.signal);

  const canUseTool: CanUseTool = async (tool, input, { signal, toolUseID }): Promise<PermissionResult> => {
    const verdict = await gate.decide(tool, input, signal, () => ({
      toolCallId: adapter.toolCallId(toolUseID),
      title: describeTool(tool, input).title,
    }));
    if (verdict === "unlisted") return { behavior: "allow", updatedInput: input };
    if (verdict === "too_large")
      return { behavior: "deny", message: "This action is too large for an engineer to review. Split it up." };
    if (verdict === "approved" && !cancelled) return { behavior: "allow", updatedInput: input };
    if (!cancelled) rejected = true;
    abort.abort();
    const message = cancelled ? "The run was cancelled." : "An engineer rejected this action. The run has ended.";
    return { behavior: "deny", message, interrupt: true };
  };

  const options: Options = {
    cwd: WORKSPACE,
    model: pack.config.model,
    maxTurns: pack.config.max_turns,
    systemPrompt: systemPrompt(pack),
    tools: TOOLS,
    // No settings, hooks or CLAUDE.md from the repository: it is untrusted, and its allow rules would skip approvals.
    settingSources: [],
    permissionMode: "default",
    canUseTool,
    abortController: abort,
    persistSession: false,
    // Stream events carry each response's final usage, for the `usage` events the budget is enforced on.
    includePartialMessages: true,
    env: harnessEnv(deps.env, pack, deps.home),
    // Diagnostics stay on stderr; stdout carries only events.
    stderr: (data) => process.stderr.write(data),
    ...(deps.spawn === undefined ? {} : { spawnClaudeCodeProcess: deps.spawn }),
  };

  // A rejection or a cancel ends the run here, even if the SDK takes its time to stop.
  const stopped = new Promise<"stopped">((resolve) => {
    if (abort.signal.aborted) resolve("stopped");
    else abort.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  });
  try {
    const messages = deps.query({ prompt: pack.task, options })[Symbol.asyncIterator]();
    for (;;) {
      const next: Promise<IteratorResult<SDKMessage>> = messages.next();
      next.catch(() => {});
      const step = await Promise.race([next, stopped]);
      if (step === "stopped" || step.done === true) break;
      for (const event of adapter.events(step.value)) {
        deps.emit(event);
        if (event.type === "result") outcome = event.outcome;
      }
      if (outcome !== undefined) break;
    }
    void messages.return?.(undefined)?.catch(() => {});
  } catch (cause) {
    if (!rejected && !cancelled) {
      deps.emit(errorResult("sdk_error", cause));
      return "error";
    }
  }
  if (outcome === undefined && (rejected || cancelled)) {
    const ended = rejected ? "rejected" : "cancelled";
    deps.emit({ type: "result", outcome: ended, text: "", turns: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    return ended;
  }
  if (outcome === undefined) {
    deps.emit(errorResult("no_result", undefined));
    return "error";
  }
  return outcome;
}

function errorResult(reason: string, cause: unknown): HarnessEvent {
  // The SDK's messages name the SDK and its CLI; they belong in diagnostics, not in the product.
  if (cause instanceof Error) process.stderr.write(`harness: ${reason}: ${cause.message}\n`);
  return {
    type: "result",
    outcome: "error",
    reason,
    text: RUN_ERROR,
    turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

import { randomUUID } from "node:crypto";

import type {
  CanUseTool,
  Options,
  PermissionResult,
  query as sdkQuery,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { Adapter, describeTool, RUN_ERROR } from "./adapter.js";
import { type ApprovalChannel, ruleFor } from "./approvals.js";
import type { HarnessEvent, Outcome } from "./events.js";
import { type LoadedPack, systemPrompt } from "./pack.js";
import { AGENT } from "./users.js";

export const WORKSPACE = "/workspace";

// Only these reach the agent's process; nothing else from the sandbox's environment is inherited.
const INHERITED_ENV = [
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

export interface HarnessDeps {
  query: typeof sdkQuery;
  approvals: ApprovalChannel;
  emit(event: HarnessEvent): void;
  env: Readonly<Record<string, string | undefined>>;
  newApprovalId?: () => string;
  /** Aborts when the API cancels the run. */
  cancel?: AbortSignal;
  /** Starts the SDK's agent process; in the sandbox, as another user than the harness (`agentSpawner`). */
  spawn?: Options["spawnClaudeCodeProcess"];
}

/**
 * The environment for the SDK's process. Bedrock through AWS, never a claude.ai login, and no credential at all:
 * the gateway's outbound handler adds the Bedrock credential to the allowed request.
 */
export function harnessEnv(base: HarnessDeps["env"], pack: LoadedPack["pack"]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    // The agent's own home, whatever user started the harness.
    HOME: AGENT.home,
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
  // One approval at a time, so the run is never waiting on two.
  let queue: Promise<unknown> = Promise.resolve();

  const canUseTool: CanUseTool = async (tool, input, { signal, toolUseID }): Promise<PermissionResult> => {
    const rule = ruleFor(rules, tool, input);
    if (rule === undefined) return { behavior: "allow", updatedInput: input };
    // The engineer approves the exact input. One too large to show is refused, never cut short.
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_APPROVAL_INPUT_BYTES)
      return { behavior: "deny", message: "This action is too large for an engineer to review. Split it up." };
    const decision = queue.then(() => {
      if (abort.signal.aborted) return "rejected" as const;
      const id = newApprovalId();
      deps.emit({
        type: "approval_request",
        id,
        tool_call_id: adapter.toolCallId(toolUseID),
        action: rule.action,
        title: describeTool(tool, input).title,
        tool,
        input,
      });
      // A cancelled run rejects a pending approval as well.
      return deps.approvals.request(id, AbortSignal.any([signal, abort.signal]));
    });
    queue = decision.catch(() => {});
    if ((await decision.catch(() => "rejected" as const)) === "approved" && !cancelled)
      return { behavior: "allow", updatedInput: input };
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
    env: harnessEnv(deps.env, pack),
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

/** Largest tool input sent for approval; the event line itself is capped at 1 MiB. */
const MAX_APPROVAL_INPUT_BYTES = 256 * 1024;

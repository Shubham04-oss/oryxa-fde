import { randomUUID } from "node:crypto";

import type { CanUseTool, Options, PermissionResult, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import { Adapter, describeTool } from "./adapter.js";
import { type ApprovalChannel, ruleFor } from "./approvals.js";
import type { HarnessEvent, Outcome } from "./events.js";
import { type LoadedPack, systemPrompt } from "./pack.js";

export const WORKSPACE = "/workspace";

// Only these reach the agent's process; nothing else from the sandbox's environment is inherited.
const INHERITED_ENV = [
  "PATH",
  "HOME",
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
  let outcome: Outcome | undefined;
  // One approval at a time, so the run is never waiting on two.
  let queue: Promise<unknown> = Promise.resolve();

  const canUseTool: CanUseTool = async (tool, input, { signal, toolUseID }): Promise<PermissionResult> => {
    const rule = ruleFor(rules, tool, input);
    if (rule === undefined) return { behavior: "allow", updatedInput: input };
    const decision = queue.then(() => {
      if (rejected) return "rejected" as const;
      const id = newApprovalId();
      deps.emit({
        type: "approval_request",
        id,
        tool_call_id: toolUseID,
        action: rule.action,
        title: describeTool(tool, input).title,
      });
      return deps.approvals.request(id, signal);
    });
    queue = decision.catch(() => {});
    if ((await decision.catch(() => "rejected" as const)) === "approved")
      return { behavior: "allow", updatedInput: input };
    rejected = true;
    abort.abort();
    return { behavior: "deny", message: "An engineer rejected this action. The run has ended.", interrupt: true };
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
    env: harnessEnv(deps.env, pack),
    // Diagnostics stay on stderr; stdout carries only events.
    stderr: (data) => process.stderr.write(data),
  };

  try {
    for await (const message of deps.query({ prompt: pack.task, options })) {
      if (rejected) break;
      for (const event of adapter.events(message)) {
        deps.emit(event);
        if (event.type === "result") outcome = event.outcome;
      }
      if (outcome !== undefined) break;
    }
  } catch (cause) {
    if (!rejected) {
      deps.emit(errorResult("sdk_error", cause));
      return "error";
    }
  }
  if (rejected) {
    deps.emit({
      type: "result",
      outcome: "rejected",
      text: "",
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return "rejected";
  }
  if (outcome === undefined) {
    deps.emit(errorResult("no_result", undefined));
    return "error";
  }
  return outcome;
}

function errorResult(reason: string, cause: unknown): HarnessEvent {
  const text = cause instanceof Error ? cause.message : "";
  return { type: "result", outcome: "error", reason, text, turns: 0, usage: { input_tokens: 0, output_tokens: 0 } };
}

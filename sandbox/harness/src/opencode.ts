import { randomUUID } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type Stream,
} from "@agentclientprotocol/sdk";

import { RUN_ERROR } from "./adapter.js";
import { ApprovalGate } from "./approvals.js";
import type { HarnessEvent, Outcome } from "./events.js";
import { type BackendDeps, INHERITED_ENV, WORKSPACE } from "./harness.js";
import policy from "./opencode.json" with { type: "json" };
import { OpenCodeEvents, RULE_NAMES, turnUsage } from "./opencode-events.js";
import { type ContextPack, type LoadedPack, systemPrompt } from "./pack.js";
import { AGENT, type agentSpawner } from "./users.js";

/** The pinned binary, installed execute-only so the agent's processes cannot read its `/proc` entries (OPENCODE.md). */
export const OPENCODE_BIN = "/usr/local/bin/opencode";
/** The only model host in scope; the pack's model is a Bedrock model id. */
const PROVIDER = "amazon-bedrock";
/** OpenCode's tools a run may use. Anything else it offers (`skill`, `opencode_worktree_remove`, a new one) is rejected. */
const TOOLS = new Set([...Object.keys(RULE_NAMES), "todowrite"]);
// ponytail: a fixed limit until the pack carries one. OpenCode retries a failing model forever, so the adapter ends it.
export const RUN_DEADLINE_MS = 60 * 60 * 1000;
/** How long OpenCode gets to end the turn after `session/cancel` before it is stopped. */
const CANCEL_GRACE_MS = 5000;

/** A running `opencode acp`: the ACP stream over its stdio, and a way to stop it. */
export interface Peer {
  stream: Stream;
  stop(): void;
}

export interface OpenCodeDeps extends BackendDeps {
  /** Starts `opencode acp` for this pack; in the sandbox, `startOpenCode`. */
  start(pack: ContextPack): Promise<Peer>;
  deadlineMs?: number;
  graceMs?: number;
}

/** The run's OpenCode config: the static policy in `opencode.json`, with the model, region and turn limit filled in. */
export function openCodeConfig(pack: ContextPack): Record<string, unknown> {
  const model = `${PROVIDER}/${pack.config.model}`;
  return {
    ...policy,
    model,
    small_model: model,
    provider: { [PROVIDER]: { options: { region: pack.config.region } } },
    // The build agent's step limit is the pack's turn limit.
    agent: { build: { steps: pack.config.max_turns } },
  };
}

export interface RunDirs {
  /** Root-owned, holding `opencode.json`; the agent can read it but not change it. */
  config: string;
  /** Fresh for this run and owned by the agent: home, XDG config, data, state and cache, and temp. */
  home: string;
}

/**
 * OpenCode's environment, built from a list like the Claude backend's. A fresh home and XDG directories so nothing
 * carries from one run into the next, config only from the root-owned directory, the switches the spike verified, and
 * placeholder Bedrock credentials that are plainly not keys: OpenCode sends no request without some, and the
 * gateway's outbound handler drops its signature and signs again.
 */
export function openCodeEnv(base: BackendDeps["env"], pack: ContextPack, dirs: RunDirs): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = base[name];
    if (value !== undefined && name !== "TMPDIR") env[name] = value;
  }
  return {
    ...env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    XDG_DATA_HOME: join(dirs.home, ".local/share"),
    XDG_STATE_HOME: join(dirs.home, ".local/state"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"),
    TMPDIR: join(dirs.home, "tmp"),
    OPENCODE_CONFIG_DIR: dirs.config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    // The todo list is the run's plan.
    OPENCODE_FLAGS: "todo",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    AWS_REGION: pack.config.region,
    AWS_ACCESS_KEY_ID: "placeholder-access-key-id",
    AWS_SECRET_ACCESS_KEY: "placeholder-secret-access-key",
  };
}

/** Writes the run's config where only root can change it and makes the agent's fresh directories. Runs as root. */
export async function prepareRun(
  pack: ContextPack,
  roots = { config: "/etc/oryxa", run: "/tmp" },
  owner: (path: string) => Promise<void> = (path) => chown(path, AGENT.uid, AGENT.gid),
): Promise<RunDirs> {
  const config = await mkdtemp(join(roots.config, "opencode-"));
  await chmod(config, 0o755);
  await writeFile(join(config, "opencode.json"), `${JSON.stringify(openCodeConfig(pack), null, 2)}\n`, { mode: 0o644 });
  const home = await mkdtemp(join(roots.run, "oryxa-opencode-"));
  for (const dir of ["", ".config", ".local", ".local/share", ".local/state", ".cache", "tmp"]) {
    await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
    await owner(join(home, dir));
  }
  return { config, home };
}

/** Starts the pinned `opencode acp` as `agent` with a fresh run directory; the spawner then drops the harness's root. */
export function startOpenCode(spawn: ReturnType<typeof agentSpawner>, env: BackendDeps["env"]): OpenCodeDeps["start"] {
  return async (pack) => {
    const dirs = await prepareRun(pack);
    const kill = new AbortController();
    const child = spawn({
      command: OPENCODE_BIN,
      args: ["acp"],
      cwd: WORKSPACE,
      env: openCodeEnv(env, pack, dirs),
      signal: kill.signal,
    });
    // After the drop the harness may not be allowed to signal the agent's process; closing stdin ends it (OPENCODE.md).
    child.on("error", (cause: Error) => process.stderr.write(`harness: opencode: ${cause.message}\n`));
    return {
      stream: ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
      stop: () => {
        child.stdin.end();
        kill.abort();
      },
    };
  };
}

/** Runs one agent run on OpenCode over ACP and reports it as events. Ends with exactly one `result` event. */
export async function runOpenCode({ pack, rules }: LoadedPack, deps: OpenCodeDeps): Promise<Outcome> {
  const zero = { input_tokens: 0, output_tokens: 0 };
  if (deps.cancel?.aborted) {
    deps.emit({ type: "result", outcome: "cancelled", text: "", turns: 0, usage: zero });
    return "cancelled";
  }

  const map = new OpenCodeEvents();
  const emit = (events: HarnessEvent[]) => events.forEach((e) => deps.emit(e));
  const stop = new AbortController();
  let ended: { outcome: Outcome; reason?: string } | undefined;
  const gate = new ApprovalGate(rules, deps.approvals, deps.emit, deps.newApprovalId ?? newApprovalId, stop.signal);
  let peer: Peer;
  try {
    peer = await deps.start(pack);
  } catch (cause) {
    if (cause instanceof Error) process.stderr.write(`harness: opencode: ${cause.message}\n`);
    deps.emit({ type: "result", outcome: "error", reason: "agent_error", text: RUN_ERROR, turns: 0, usage: zero });
    return "error";
  }

  // Every tool call asks. Calls the company's list does not cover are approved at once; the answer is never `always`.
  const permission = async (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> => {
    const answer = (kind: "allow_once" | "reject_once"): RequestPermissionResponse => {
      const option = request.options.find((o) => o.kind === kind);
      return {
        outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId },
      };
    };
    const { id, call, title } = map.call(request.toolCall);
    if (stop.signal.aborted) return answer("reject_once");
    if (!TOOLS.has(call.name)) {
      end("rejected", "tool_not_allowed", false);
      return answer("reject_once");
    }
    const tool = RULE_NAMES[call.name] ?? call.name;
    const verdict = await gate.decide(tool, call.input, signal, () => ({ toolCallId: id, title }));
    if ((verdict === "unlisted" || verdict === "approved") && !stop.signal.aborted) return answer("allow_once");
    // A rejection ends OpenCode's turn by itself, so it ends the run, as it does on the Claude backend.
    end("rejected", verdict === "too_large" ? "approval_input_too_large" : undefined, false);
    return answer("reject_once");
  };

  const connection = client({ name: "oryxa-harness" })
    .onRequest("session/request_permission", ({ params, signal }) => permission(params, signal))
    .onNotification("session/update", ({ params }) => emit(map.update(params.update)))
    .connect(peer.stream);
  let sessionId: string | undefined;
  let killed: () => void = () => {};
  const gone = new Promise<"gone">((resolve) => (killed = () => resolve("gone")));
  // Cancel and the deadline end the turn with `session/cancel`, a rejection by answering `reject`. Either way, a peer
  // that has not ended the turn after the grace period is stopped.
  function end(outcome: Outcome, reason?: string, cancelTurn = true): void {
    if (ended !== undefined) return;
    ended = reason === undefined ? { outcome } : { outcome, reason };
    stop.abort();
    if (cancelTurn && sessionId !== undefined)
      void connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
    setTimeout(() => {
      peer.stop();
      killed();
    }, deps.graceMs ?? CANCEL_GRACE_MS).unref();
  }
  const onCancel = () => end("cancelled");
  deps.cancel?.addEventListener("abort", onCancel, { once: true });
  if (deps.cancel?.aborted) onCancel();
  const deadline = setTimeout(() => end("cancelled", "time_limit"), deps.deadlineMs ?? RUN_DEADLINE_MS);

  try {
    const until = <T>(request: Promise<T>) => Promise.race([request, gone]);
    await until(
      connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        // No file system or terminal: OpenCode's own tools do the work, and every call comes here to be approved.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "oryxa-harness", version: "0.1.0" },
      }),
    );
    const session = await until(connection.agent.request("session/new", { cwd: WORKSPACE, mcpServers: [] }));
    if (session === "gone") return finish(undefined);
    sessionId = session.sessionId;
    // A model id OpenCode does not know falls back to another model; run only the one asked for.
    const model = session.configOptions?.find((o) => o.id === "model");
    if (model?.type === "select" && model.currentValue !== `${PROVIDER}/${pack.config.model}`)
      return finish(undefined, "model_unavailable");
    if (ended !== undefined) return finish(undefined);
    const response = await until(
      connection.agent.request("session/prompt", {
        sessionId,
        // OpenCode keeps its own system prompt; the project context goes first, fenced as data, then the task.
        prompt: [
          { type: "text", text: systemPrompt(pack) },
          { type: "text", text: pack.task },
        ],
      }),
    );
    return finish(response === "gone" ? undefined : response);
  } catch (cause) {
    if (ended === undefined && cause instanceof Error) process.stderr.write(`harness: opencode: ${cause.message}\n`);
    return finish(undefined, ended === undefined ? "agent_error" : undefined);
  } finally {
    clearTimeout(deadline);
    deps.cancel?.removeEventListener("abort", onCancel);
    connection.close();
    peer.stop();
  }

  function finish(response: { stopReason: string } | undefined, error?: string): Outcome {
    emit(map.flush());
    // `usage` is not in ACP v1's stable schema; OpenCode sends it and the library keeps it.
    const usage = turnUsage((response as Record<string, unknown> | undefined)?.["usage"]);
    // Usage arrives once per turn; the API checks the budget on it, and the deadline bounds the turn itself.
    if (response !== undefined) deps.emit({ type: "usage", usage });
    if (error !== undefined || (ended === undefined && response?.stopReason !== "end_turn")) {
      const reason = error ?? response?.stopReason ?? "no_result";
      deps.emit({ type: "result", outcome: "error", reason, text: RUN_ERROR, turns: response ? 1 : 0, usage });
      return "error";
    }
    if (ended !== undefined) {
      const { outcome, reason } = ended;
      const turns = response === undefined ? 0 : 1;
      deps.emit({ type: "result", outcome, ...(reason === undefined ? {} : { reason }), text: "", turns, usage });
      return outcome;
    }
    // One prompt is one ACP turn; OpenCode does not report its model steps.
    deps.emit({ type: "result", outcome: "success", text: map.lastMessage, turns: 1, usage });
    return "success";
  }
}

function newApprovalId(): string {
  return `apr_${randomUUID()}`;
}

import type { SessionUpdate, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

import { count, describeTool, isRecord } from "./adapter.js";
import { type HarnessEvent, IdMap, type PlanStatus, type ToolKind, type ToolStatus, type Usage } from "./events.js";

/** OpenCode's tool names in the vocabulary of the company's approval rules (the Claude Agent SDK's), so one rule covers both. */
export const RULE_NAMES: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  shell: "Bash",
};
const KINDS = new Set<string>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
const PLAN_STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

export interface Call {
  /** OpenCode's tool name (a field ACP does not define). */
  name: string;
  kind: ToolKind;
  input: Record<string, unknown>;
  status?: ToolStatus;
}

/**
 * Turns OpenCode's ACP session updates into harness events. Our format is shaped on ACP, so most updates map directly;
 * the exceptions are the ones in OPENCODE.md: message chunks are joined, the todo list becomes the plan, a shell
 * command's exit code is read from its output, and usage comes once per turn. One per run: it remembers tool calls.
 */
export class OpenCodeEvents {
  readonly #calls = new Map<string, Call>();
  readonly #ids = new IdMap();
  #text = "";
  #messageId: unknown;
  /** The last message the agent finished, for the result. */
  lastMessage = "";

  update(update: SessionUpdate): HarnessEvent[] {
    if (update.sessionUpdate === "agent_message_chunk") {
      const events = update.messageId === this.#messageId ? [] : this.flush();
      this.#messageId = update.messageId;
      if (update.content.type === "text") this.#text += update.content.text;
      return events;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
      return [...this.flush(), ...this.#tool(update)];
    if (update.sessionUpdate === "plan") return [...this.flush(), plan(update.entries)];
    return [];
  }

  /** The message the agent was writing, once it is complete. */
  flush(): HarnessEvent[] {
    const text = this.#text;
    this.#text = "";
    this.#messageId = undefined;
    if (text.trim() === "") return [];
    this.lastMessage = text;
    return [{ type: "message", text }];
  }

  /** Records what a permission request says about its call, and returns it with its safe id. */
  call(toolCall: ToolCallUpdate): { id: string; call: Call; title: string } {
    const id = this.#ids.safe(toolCall.toolCallId);
    const call = this.#record(id, toolCall);
    return { id, call, title: title(call) };
  }

  #record(id: string, update: ToolCall | ToolCallUpdate): Call {
    const call = this.#calls.get(id) ?? { name: "", kind: "other", input: {} };
    const name = (update as Record<string, unknown>)["name"];
    if (typeof name === "string") call.name = name;
    if (typeof update.kind === "string") call.kind = KINDS.has(update.kind) ? (update.kind as ToolKind) : "other";
    // The first update carries an empty input; the one before the permission request has the real one.
    if (isRecord(update.rawInput) && Object.keys(update.rawInput).length > 0) call.input = update.rawInput;
    this.#calls.set(id, call);
    return call;
  }

  #tool(update: ToolCall | ToolCallUpdate): HarnessEvent[] {
    const id = this.#ids.safe(update.toolCallId);
    const call = this.#record(id, update);
    const status = update.status;
    // A pending call has no input yet; OpenCode repeats `in_progress` around the permission request.
    if ((status !== "in_progress" && status !== "completed" && status !== "failed") || status === call.status)
      return [];
    call.status = status;
    if (call.name === "todowrite") return status === "completed" ? todoPlan(call.input) : [];
    // A failing command is still `completed` in ACP; its exit code is in the output.
    const exit = call.name === "shell" ? exitCode(update) : undefined;
    const shown: ToolStatus = status === "completed" && exit !== undefined && exit !== 0 ? "failed" : status;
    const events: HarnessEvent[] = [{ type: "tool_call", id, title: title(call), kind: call.kind, status: shown }];
    if (status === "in_progress") return events;
    if (call.name === "shell" && typeof call.input["command"] === "string")
      events.push({ type: "command", tool_call_id: id, command: call.input["command"], status: shown });
    if (shown === "completed") events.push(...fileChanges(id, call, update));
    return events;
  }
}

/** Usage for a whole turn. Input counts cache reads and writes, and output counts reasoning: early, never late. */
export function turnUsage(usage: unknown): Usage {
  return {
    input_tokens: count(usage, "inputTokens") + count(usage, "cachedReadTokens") + count(usage, "cachedWriteTokens"),
    output_tokens: count(usage, "outputTokens") + count(usage, "thoughtTokens"),
  };
}

// The same titles as the Claude backend's, from the rule name and OpenCode's input (`path` where the SDK has `file_path`).
function title(call: Call): string {
  const path = call.input["path"] ?? call.input["filePath"];
  return describeTool(RULE_NAMES[call.name] ?? call.name, { ...call.input, file_path: path }).title;
}

function plan(entries: readonly { content: string; status: string }[]): HarnessEvent {
  const valid = entries.filter((e) => PLAN_STATUSES.has(e.status));
  return { type: "plan", entries: valid.map((e) => ({ content: e.content, status: e.status as PlanStatus })) };
}

// OpenCode has no ACP plan; its todo list (`todowrite`) is the plan, and a cancelled item drops out of it.
function todoPlan(input: Record<string, unknown>): HarnessEvent[] {
  const todos = input["todos"];
  if (!Array.isArray(todos)) return [];
  const entries = todos.filter(
    (t): t is { content: string; status: string } =>
      isRecord(t) && typeof t["content"] === "string" && typeof t["status"] === "string",
  );
  return [plan(entries)];
}

function exitCode(update: ToolCall | ToolCallUpdate): number | undefined {
  const metadata = isRecord(update.rawOutput) ? update.rawOutput["metadata"] : undefined;
  if (isRecord(metadata) && typeof metadata["exit"] === "number") return metadata["exit"];
  for (const text of texts(update)) {
    const found = /^Exit code: (\d+)$/m.exec(text);
    if (found?.[1] !== undefined) return Number(found[1]);
  }
  return undefined;
}

function fileChanges(id: string, call: Call, update: ToolCall | ToolCallUpdate): HarnessEvent[] {
  const diffs = (update.content ?? []).flatMap((c) => (c.type === "diff" ? [c] : []));
  if (diffs.length > 0)
    return diffs.map((d) => ({
      type: "file_change",
      tool_call_id: id,
      path: d.path,
      change: (d.oldText ?? "") === "" ? "created" : "modified",
    }));
  // `write` sends no diff; its output says whether the file was new ("Created file" or "Wrote file").
  const path = call.input["path"];
  if (call.name !== "write" || typeof path !== "string") return [];
  const created = texts(update).some((t) => t.startsWith("Created file"));
  return [{ type: "file_change", tool_call_id: id, path, change: created ? "created" : "modified" }];
}

function texts(update: ToolCall | ToolCallUpdate): string[] {
  return (update.content ?? []).flatMap((c) =>
    c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
  );
}

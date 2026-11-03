import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { type HarnessEvent, IdMap, type PlanStatus, type ToolKind, type ToolStatus } from "./events.js";

const MAX_TITLE = 200;
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// The SDK's task list is the agent's plan; these calls become plan events, not tool calls.
const PLAN_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
const PLAN_STATUSES: readonly unknown[] = ["pending", "in_progress", "completed"];

type AssistantBlock = SDKAssistantMessage["message"]["content"][number];

interface Call {
  name: string;
  input: Record<string, unknown>;
  title: string;
  kind: ToolKind;
}

/** Turns the SDK's message stream into harness events. One per run: it remembers tool calls by id. */
export class Adapter {
  readonly #calls = new Map<string, Call>();
  readonly #ids = new IdMap();
  readonly #plan = new Map<string, { content: string; status: PlanStatus }>();

  events(message: SDKMessage): HarnessEvent[] {
    switch (message.type) {
      case "assistant":
        return message.message.content.flatMap((block) => this.#assistantBlock(block));
      case "user":
        return this.#toolResults(message.message.content, message.tool_use_result);
      case "result":
        return [
          message.subtype === "success"
            ? {
                type: "result",
                outcome: "success",
                text: message.result,
                turns: message.num_turns,
                usage: usage(message.usage),
              }
            : {
                type: "result",
                outcome: "error",
                reason: message.subtype,
                text: message.errors.join("\n"),
                turns: message.num_turns,
                usage: usage(message.usage),
              },
        ];
      default:
        return [];
    }
  }

  #assistantBlock(block: AssistantBlock): HarnessEvent[] {
    if (block.type === "text") return block.text.trim() === "" ? [] : [{ type: "message", text: block.text }];
    if (block.type !== "tool_use") return [];
    const input = isRecord(block.input) ? block.input : {};
    const id = this.#ids.safe(block.id);
    const call = { name: block.name, input, ...describeTool(block.name, input) };
    this.#calls.set(id, call);
    if (PLAN_TOOLS.has(call.name)) return [];
    return [{ type: "tool_call", id, title: call.title, kind: call.kind, status: "in_progress" }];
  }

  #toolResults(content: unknown, toolUseResult: unknown): HarnessEvent[] {
    if (!Array.isArray(content)) return [];
    const results = content.filter(
      (b) => isRecord(b) && b["type"] === "tool_result" && typeof b["tool_use_id"] === "string",
    );
    return results.flatMap((block) => {
      const id = this.#ids.safe(block["tool_use_id"] as string);
      const call = this.#calls.get(id);
      if (call === undefined) return [];
      const status: ToolStatus = block["is_error"] === true ? "failed" : "completed";
      if (PLAN_TOOLS.has(call.name)) return status === "completed" ? this.#planChange(call, toolUseResult) : [];
      const events: HarnessEvent[] = [{ type: "tool_call", id, title: call.title, kind: call.kind, status }];
      if (call.name === "Bash" && typeof call.input["command"] === "string") {
        events.push({ type: "command", tool_call_id: id, command: call.input["command"], status });
      }
      const path = call.input["file_path"] ?? call.input["notebook_path"];
      if (EDIT_TOOLS.has(call.name) && status === "completed" && typeof path === "string") {
        // The SDK reports a single Write's result as {type: "create" | "update"}.
        const created = results.length === 1 && isRecord(toolUseResult) && toolUseResult["type"] === "create";
        events.push({ type: "file_change", tool_call_id: id, path, change: created ? "created" : "modified" });
      }
      return events;
    });
  }

  // Follows what the SDK confirmed: the id it assigned on create, then each update it accepted.
  #planChange(call: Call, toolUseResult: unknown): HarnessEvent[] {
    const { subject, taskId, status } = call.input;
    if (call.name === "TaskCreate") {
      const task = isRecord(toolUseResult) ? toolUseResult["task"] : undefined;
      if (!isRecord(task) || typeof task["id"] !== "string" || typeof subject !== "string") return [];
      this.#plan.set(task["id"], { content: subject, status: "pending" });
    } else if (call.name === "TaskUpdate" && typeof taskId === "string") {
      const entry = this.#plan.get(taskId);
      if (entry === undefined) return [];
      if (status === "deleted") this.#plan.delete(taskId);
      if (PLAN_STATUSES.includes(status)) entry.status = status as PlanStatus;
      if (typeof subject === "string") entry.content = subject;
    } else {
      return [];
    }
    return [{ type: "plan", entries: [...this.#plan.values()].map((entry) => ({ ...entry })) }];
  }
}

/** A short title and an ACP tool kind for a tool call, for the review screen and approval requests. */
export function describeTool(name: string, input: Record<string, unknown>): { title: string; kind: ToolKind } {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const titled = (title: string, kind: ToolKind) => ({ title: truncate(title), kind });
  switch (name) {
    case "Read":
      return titled(`Read ${str("file_path")}`, "read");
    case "Write":
      return titled(`Write ${str("file_path")}`, "edit");
    case "Edit":
    case "MultiEdit":
      return titled(`Edit ${str("file_path")}`, "edit");
    case "NotebookEdit":
      return titled(`Edit ${str("notebook_path")}`, "edit");
    case "Glob":
      return titled(`Find ${str("pattern")}`, "search");
    case "Grep":
      return titled(`Search for ${str("pattern")}`, "search");
    case "Bash":
      return titled(`Run: ${str("command")}`, "execute");
    case "WebFetch":
      return titled(`Fetch ${str("url")}`, "fetch");
    case "WebSearch":
      return titled(`Search the web for ${str("query")}`, "fetch");
    case "Task":
    case "Agent":
      return titled(`Delegate: ${str("description")}`, "think");
    default:
      return titled(name, "other");
  }
}

function usage(u: { input_tokens: number; output_tokens: number }) {
  return { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
}

function truncate(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

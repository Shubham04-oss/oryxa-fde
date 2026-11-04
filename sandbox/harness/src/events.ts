// The internal event format, one JSON object per line on stdout. It mirrors `oryxa_fde_agent::event` in Rust,
// and its vocabulary follows the Agent Client Protocol's session updates.

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
export type PlanStatus = "pending" | "in_progress" | "completed";
export type Outcome = "success" | "error" | "rejected";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type HarnessEvent =
  | { type: "plan"; entries: { content: string; status: PlanStatus }[] }
  | { type: "message"; text: string }
  | { type: "tool_call"; id: string; title: string; kind: ToolKind; status: ToolStatus }
  | { type: "file_change"; tool_call_id: string; path: string; change: "created" | "modified" | "deleted" }
  | { type: "command"; tool_call_id: string; command: string; status: ToolStatus }
  | {
      type: "approval_request";
      id: string;
      tool_call_id: string;
      action: string;
      title: string;
      // The exact tool and input that will run if approved, so the engineer never approves a summary.
      tool: string;
      input: Record<string, unknown>;
    }
  | { type: "result"; outcome: Outcome; reason?: string; text: string; turns: number; usage: Usage };

export const EVENT_VERSION = 1;

/** Numbers each event so the API can drop a replayed line, and writes it as one line. */
export class EventWriter {
  #seq = 0;

  constructor(private readonly write: (line: string) => void) {}

  emit(event: HarnessEvent): void {
    this.write(`${JSON.stringify({ v: EVENT_VERSION, seq: this.#seq++, ...event })}\n`);
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Ids follow the platform's id rules; anything else from the SDK is replaced by a stable safe one. */
export class IdMap {
  readonly #ids = new Map<string, string>();

  safe(id: string): string {
    if (SAFE_ID.test(id)) return id;
    let mapped = this.#ids.get(id);
    if (mapped === undefined) {
      mapped = `tool_${this.#ids.size + 1}`;
      this.#ids.set(id, mapped);
    }
    return mapped;
  }
}

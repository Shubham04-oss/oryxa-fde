import { createInterface } from "node:readline";
import { z } from "zod";

export type ApprovalOutcome = "approved" | "rejected";

/** Where approval requests go. The run waits on `request` until an FDE decides. */
export interface ApprovalChannel {
  request(id: string, signal: AbortSignal): Promise<ApprovalOutcome>;
}

export interface ApprovalRule {
  action: string;
  tool: string;
  pattern?: string | undefined;
}

export interface CompiledRule extends ApprovalRule {
  regex: RegExp | undefined;
}

/** Compiles the company's approval list; an invalid pattern throws, so the harness refuses to start. */
export function compileRules(rules: readonly ApprovalRule[]): CompiledRule[] {
  return rules.map((rule) => ({ ...rule, regex: rule.pattern === undefined ? undefined : new RegExp(rule.pattern) }));
}

/** The first rule that covers this tool call: its tool name, and its pattern over the command or JSON input. */
// ponytail: matches what the tool call says; an agent can obfuscate a shell command, so a host whose use needs
// approval should also be held at the outbound handler.
export function ruleFor(
  rules: readonly CompiledRule[],
  tool: string,
  input: Record<string, unknown>,
): CompiledRule | undefined {
  const subject = tool === "Bash" && typeof input["command"] === "string" ? input["command"] : JSON.stringify(input);
  return rules.find((rule) => (rule.tool === "*" || rule.tool === tool) && (rule.regex?.test(subject) ?? true));
}

const Decision = z.object({
  type: z.literal("approval_decision"),
  id: z.string(),
  outcome: z.enum(["approved", "rejected"]),
});

/**
 * Decisions arrive on stdin, one JSON line each, written by the API through the gateway. Only the API can write
 * there: the agent's own processes are children of the SDK, not of the harness, and never see this stream.
 * Fails closed: a closed stdin or an aborted request is a rejection, and lines that do not parse are ignored.
 */
export class StdioApprovals implements ApprovalChannel {
  readonly #pending = new Map<string, (outcome: ApprovalOutcome) => void>();
  #closed = false;

  constructor(input: NodeJS.ReadableStream) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receive(line));
    lines.on("close", () => {
      this.#closed = true;
      for (const resolve of this.#pending.values()) resolve("rejected");
      this.#pending.clear();
    });
  }

  request(id: string, signal: AbortSignal): Promise<ApprovalOutcome> {
    if (this.#closed || signal.aborted) return Promise.resolve("rejected");
    return new Promise((resolve) => {
      const settle = (outcome: ApprovalOutcome) => {
        this.#pending.delete(id);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => settle("rejected");
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, settle);
    });
  }

  #receive(line: string): void {
    let parsed: z.infer<typeof Decision>;
    try {
      parsed = Decision.parse(JSON.parse(line));
    } catch {
      return;
    }
    this.#pending.get(parsed.id)?.(parsed.outcome);
  }
}

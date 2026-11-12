import type {
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultPart,
} from "@ai-sdk/provider";

// The scripted model (issue #236): deterministic, offline, used in tests and in dev, and the only model this
// slice enables. It decides what to do from the person's own words alone. What a tool returned changes only
// the counts it reports, never what it shows or proposes, so text planted in the data cannot steer it
// (test/injection.test.ts holds the first case of that suite).

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

const NEW_COMPANY = /\b(new|add|onboard|set up|setup|start)\b.*\b(company|customer|client|engagement)\b/;
const TODAY = /\b(today|blocked|stuck|due|waiting|next|priorit\w*|plan my)\b/;
/** A turn whose model fails part way, so the failure path can be seen in dev and is tested. */
const FAIL = /^simulate a failed turn$/i;
/** "…called Kestrel Logistics" or "…named Kestrel Logistics": the name, as the person typed it. */
const CALLED = /\b(?:called|named)\s+(.+)$/is;

type Step = Array<{ text: string } | { tool: string; input: unknown } | { fail: string }>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The person's last message, and the tool results the model has had since. */
function read(prompt: LanguageModelV4Prompt): { said: string; results: Array<LanguageModelV4ToolResultPart> } {
  let last = -1;
  prompt.forEach((m, i) => {
    if (m.role === "user") last = i;
  });
  const user = prompt[last];
  const said =
    user?.role === "user"
      ? user.content
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("\n")
          .trim()
      : "";
  const results = prompt
    .slice(last + 1)
    .flatMap((m) => (m.role === "tool" ? m.content : []))
    .filter((p): p is LanguageModelV4ToolResultPart => p.type === "tool-result");
  return { said, results };
}

/** How many entries a tool found, read only as a count; null when it could not read. */
function count(result: LanguageModelV4ToolResultPart | undefined): number | null {
  if (result?.output.type !== "json") return null;
  const data = (result.output.value as { data?: { found?: unknown } } | null)?.data;
  return Array.isArray(data?.found) ? data.found.length : null;
}

function kinds(result: LanguageModelV4ToolResultPart | undefined) {
  if (result?.output.type !== "json") return null;
  const found = (result.output.value as { data?: { found?: unknown } } | null)?.data?.found;
  if (!Array.isArray(found)) return null;
  const status = (item: unknown) => (item as { status?: unknown }).status;
  return {
    blocked: found.filter((item) => status(item) === "blocked").length,
    waiting: found.filter((item) => status(item) === "waiting_on_customer" || status(item) === "pending").length,
    all: found.length,
  };
}

/** The next step of the script, from the person's words and how far the turn has got. */
export function script(prompt: LanguageModelV4Prompt): Step {
  const { said, results } = read(prompt);
  const words = said.toLowerCase();
  const result = (tool: string) => results.find((r) => r.toolName === tool);

  // The error carries the person's words, as a provider's might: none of it may reach a log or the browser.
  if (FAIL.test(said)) return [{ text: "Starting, " }, { fail: said }];

  if (NEW_COMPANY.test(words)) {
    const name = CALLED.exec(said)?.[1]
      ?.trim()
      .replace(/[.!?]+$/, "");
    if (!name) return [{ text: "What is the new company called? Say, for example, set up a company called Kestrel." }];
    if (!result("list_companies")) return [{ tool: "list_companies", input: {} }];
    const n = count(result("list_companies"));
    return [
      {
        text:
          n === null
            ? "I couldn't read your companies just now. Here is the new one, ready when you confirm."
            : `You work with ${plural(n, "company", "companies")} already. Here is the new one, ready when you confirm.`,
      },
      { tool: "show_block", input: { block: { type: "brief", items: [{ label: "Company", value: name }] } } },
      { tool: "propose_create_company", input: { name } },
    ];
  }

  if (TODAY.test(words)) {
    if (!result("read_today")) return [{ tool: "read_today", input: {} }];
    const k = kinds(result("read_today"));
    return [
      {
        text:
          k === null
            ? "I couldn't read your day just now. Today has it all."
            : k.all === 0
              ? "Nothing is open across your projects right now."
              : `${plural(k.all, "thing")} open: ${k.blocked} blocked, ${k.waiting} waiting on the customer.`,
      },
      { tool: "propose_open_route", input: { to: { screen: "today" } } },
    ];
  }

  return [{ text: "I can set up a company or show you what needs you today. I can't act on anything else yet." }];
}

function parts(step: Step): Array<LanguageModelV4StreamPart> {
  const out: Array<LanguageModelV4StreamPart> = [{ type: "stream-start", warnings: [] }];
  let calls = 0;
  step.forEach((piece, i) => {
    if ("text" in piece) {
      const id = `text-${i}`;
      out.push({ type: "text-start", id });
      // Word by word, so the screen streams it.
      for (const word of piece.text.split(/(?<= )/)) out.push({ type: "text-delta", id, delta: word });
      out.push({ type: "text-end", id });
      return;
    }
    if ("fail" in piece) {
      out.push({ type: "error", error: new Error(piece.fail) });
      return;
    }
    calls += 1;
    out.push({ type: "tool-call", toolCallId: `call-${i}`, toolName: piece.tool, input: JSON.stringify(piece.input) });
  });
  out.push({ type: "finish", usage, finishReason: { unified: calls > 0 ? "tool-calls" : "stop", raw: undefined } });
  return out;
}

/** A stream of `parts`, one at a time. */
export function streamOf(list: Array<LanguageModelV4StreamPart>): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of list) controller.enqueue(part);
      controller.close();
    },
  });
}

/** The scripted model, as the AI SDK's provider layer takes one. */
export function scriptedModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "oryxa.scripted",
    modelId: "scripted",
    supportedUrls: {},
    doGenerate() {
      return Promise.reject(new Error("the scripted model only streams"));
    },
    doStream({ prompt }) {
      return Promise.resolve({ stream: streamOf(parts(script(prompt))) });
    },
  };
}

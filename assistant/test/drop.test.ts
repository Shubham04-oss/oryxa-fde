import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { Binding } from "../src/auth.js";
import { MAX_REPLY } from "../src/catalogue/wire.js";
import type { WireEvent } from "../src/catalogue/wire.js";
import { MAX_TOOL_CALLS } from "../src/limits.js";
import { streamOf } from "../src/model/fake.js";
import { TurnFailed, runTurn } from "../src/turn.js";
import type { Folded } from "../src/turn.js";

// What the Worker sends is checked before it is stored: a block or a proposal outside the catalogue, or outside
// the conversation's company, never reaches the stream.

const HOME: Binding = { conversation: "c_drop", tenant: "org_sample", person: "user_riya", company: null };
const COMPANY: Binding = { ...HOME, company: "cmp_a" };
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

let call = 0;
const tool = (toolName: string, input: unknown): LanguageModelV4StreamPart => ({
  type: "tool-call",
  toolCallId: `call-${(call += 1)}`,
  toolName,
  input: JSON.stringify(input),
});
const text = (delta: string): Array<LanguageModelV4StreamPart> => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta },
  { type: "text-end", id: "t" },
];
const finish = (calls: boolean): LanguageModelV4StreamPart => ({
  type: "finish",
  usage,
  finishReason: { unified: calls ? "tool-calls" : "stop", raw: undefined },
});

/** A model that answers each step with the next of `steps`. */
function model(...steps: Array<Array<LanguageModelV4StreamPart>>) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: () => Promise.resolve({ stream: streamOf(steps[Math.min((step += 1) - 1, steps.length - 1)]!) }),
  });
}

async function turn(binding: Binding, m: MockLanguageModelV4, read = async (): Promise<unknown> => []) {
  const emitted: Array<WireEvent> = [];
  const out: Folded = { text: "", blocks: [], proposals: [], notice: null };
  await runTurn({ model: m, binding, said: "hello", history: [], read, emit: (e) => emitted.push(e), out });
  return { emitted, out };
}

const VALID_BLOCK = { type: "checklist", items: [{ label: "Sign the brief", done: false }] };

describe("the Worker drops what is outside the catalogue", () => {
  it("keeps text, a valid block and a valid proposal, and drops unknown and malformed ones", async () => {
    const { emitted, out } = await turn(
      HOME,
      model([
        ...text("Here is what I found."),
        tool("show_block", { block: { type: "html", html: "<img src=https://evil.example/x>" } }),
        tool("show_block", { block: { type: "suggestion", id: "s1", title: "No approve" } }),
        tool("show_block", {
          block: { type: "suggestion", id: "s2", title: "Go", approve: { label: "Go", to: "https://evil.example" } },
        }),
        tool("show_block", { block: VALID_BLOCK }),
        tool("delete_company", { company: "cmp_kestrel" }),
        tool("propose_delete_company", { company: "cmp_kestrel" }),
        tool("propose_create_company", { name: "Acme", industry: "extra argument" }),
        tool("propose_create_company", { name: "Line\nbreak" }),
        tool("propose_open_route", { to: { screen: "https://evil.example" } }),
        tool("fetch", { url: "https://evil.example" }),
        tool("propose_create_company", { name: "Acme" }),
        finish(true),
      ]),
    );
    expect(emitted.map((e) => e.type)).toEqual(["text", "block", "proposal"]);
    expect(emitted[1]).toEqual({ v: 1, type: "block", block: VALID_BLOCK });
    expect(emitted[2]).toMatchObject({
      type: "proposal",
      proposal: { action: "create_company", args: { name: "Acme" } },
    });
    // The proposal's id is ours, never the model's call id.
    expect((emitted[2] as { proposal: { id: string } }).proposal.id).toMatch(/^p_[0-9a-f]{32}$/);
    expect(out.blocks).toEqual([VALID_BLOCK]);
    expect(out.proposals).toHaveLength(1);
  });

  it("keeps a company's conversation to that company", async () => {
    const elsewhere = { screen: "company", company: "cmp_b" };
    const { emitted } = await turn(
      COMPANY,
      model([
        tool("show_block", {
          block: { type: "suggestion", id: "s", title: "Other", approve: { label: "Open", to: elsewhere } },
        }),
        tool("propose_create_company", { name: "Acme" }),
        tool("propose_open_route", { to: elsewhere }),
        tool("propose_open_route", { to: { screen: "project", company: "cmp_a", project: "prj_1" } }),
        tool("propose_open_route", { to: { screen: "today" } }),
        finish(true),
      ]),
    );
    expect(emitted.map((e) => (e.type === "proposal" ? e.proposal.args : e.type))).toEqual([
      { to: { screen: "project", company: "cmp_a", project: "prj_1" } },
      { to: { screen: "today" } },
    ]);
  });

  it("drops a delta with control characters, and stops a reply at its size limit, saying so", async () => {
    const { emitted, out } = await turn(
      HOME,
      model([...text("bell\u0007"), ...text("x".repeat(MAX_REPLY)), finish(false)]),
    );
    expect(emitted).toEqual([{ v: 1, type: "notice", notice: "reply_limit" }]);
    expect(out.notice).toBe("reply_limit");
  });

  it("stops after the tool calls one turn may make, without calling the API again, and says so", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [];
    };
    const { emitted } = await turn(
      HOME,
      model([
        tool("list_companies", {}),
        tool("list_companies", {}),
        tool("list_companies", {}),
        tool("read_today", {}),
        tool("list_companies", {}),
        finish(true),
      ]),
      read,
    );
    expect(reads).toBe(MAX_TOOL_CALLS);
    expect(emitted).toContainEqual({ v: 1, type: "notice", notice: "tool_limit" });
  });

  it("fails the turn plainly when the model's stream fails", async () => {
    const broken = model([{ type: "error", error: new Error("provider said something with a prompt in it") }]);
    await expect(turn(HOME, broken)).rejects.toBeInstanceOf(TurnFailed);
  });
});

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseView } from "../src/catalogue/wire.js";
import { OutboundRefused, runtime } from "../src/model/provider.js";
import { SESSION } from "./fake-api.js";
import { PERSON, TENANT, call, dump, freshConversation, logsOf, replyText, say } from "./helpers.js";

// The person's session is lent for one turn (ADR 0009): it reaches the API and nothing else. Not the object's
// storage, not a log, and no host but the API.

const SAID = "Set up a new company called Kestrel Logistics";
const SECRET = SESSION.split("=")[1]!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the person's session", () => {
  it("is never written to the conversation's storage, nor the rate's", async () => {
    const conversation = freshConversation();
    const { events } = await say(conversation, SAID);
    // The turn read the API with it, so it did pass through.
    expect(replyText(events)).toContain("You work with 2 companies");

    const held = await dump(env.CONVERSATIONS.getByName(conversation));
    expect(held).toContain("Kestrel Logistics");
    expect(held).not.toContain(SECRET);
    expect(held).not.toContain("fde_session");
    expect(await dump(env.PERSON_TURNS.getByName(`${TENANT}:${PERSON}`))).not.toContain(SECRET);
  });

  it("and the conversation never reach a log", async () => {
    const logged = await logsOf(() => say(freshConversation(), SAID));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("Kestrel");
    expect(logged).not.toContain("companies already");
  });
});

describe("outbound requests", () => {
  it("are watched by this test wherever they start, the conversation's object included", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const reached = vi.spyOn(runtime, "fetch");
    const refused = await runInDurableObject(env.CONVERSATIONS.getByName(freshConversation()), () =>
      fetch("https://outbound.example/").then(
        (r) => r.body?.cancel(),
        (error: unknown) => error,
      ),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    // The global guard refused it before it left, so the runtime's own fetch never saw it.
    expect(refused).toBeInstanceOf(OutboundRefused);
    expect(reached).not.toHaveBeenCalled();
  });

  it("go to no host but the API binding, for a whole turn with tool calls", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    // The runtime's own fetch is unguarded, so it is watched too: nothing in a turn may call it directly.
    const reached = vi.spyOn(runtime, "fetch");
    for (const said of [SAID, "What needs me today?"]) {
      const { events } = await say(freshConversation(), said);
      // The tools did read the API (through its binding), so a turn that reached out would have shown here.
      expect(replyText(events)).toMatch(/You work with 2 companies|2 things open/);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
  });
});

describe("a turn that fails", () => {
  it("ends plainly, keeps what it said, and logs ids only", async () => {
    const conversation = freshConversation();
    let all: Awaited<ReturnType<typeof say>>["all"] = [];
    const logged = await logsOf(async () => {
      ({ all } = await say(conversation, "simulate a failed turn"));
    });

    const data = all.filter((f) => f.event === null).map((f) => f.data as { type: string });
    expect(data.map((e) => e.type)).toEqual(["turn", "text", "notice"]);
    expect(data.at(-1)).toEqual({ v: 1, type: "notice", notice: "failed" });
    // The browser learns that it failed, in fixed words, and nothing of why.
    expect(all.at(-1)).toEqual({ id: null, event: "error", data: { reason: "failed" } });

    const view = parseView(await (await call(`/internal/v1/conversations/${conversation}`)).json());
    expect(view![0]).toMatchObject({ state: "failed", text: "Starting, ", notice: "failed" });

    expect(JSON.parse(logged)).toEqual([
      [
        JSON.stringify({
          event: "assistant_turn_failed",
          conversation,
          turn: (data[0] as unknown as { turn: string }).turn,
        }),
      ],
    ]);
    expect(logged).not.toContain("simulate");
    expect(logged).not.toContain(SECRET);
  });
});

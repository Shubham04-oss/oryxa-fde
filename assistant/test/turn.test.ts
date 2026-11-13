import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { parseView } from "../src/catalogue/wire.js";
import type { Conversation } from "../src/conversation.js";
import { MAX_REPLY, MAX_TURNS } from "../src/catalogue/wire.js";
import { PersonTurns, TURNS_PER_WINDOW, TURN_TIMEOUT_MS } from "../src/limits.js";
import { apiReader } from "../src/tools.js";
import { runTurn } from "../src/turn.js";
import type { Folded } from "../src/turn.js";
import type { WireEvent } from "../src/catalogue/wire.js";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { SESSION, SLOW_SESSION } from "./fake-api.js";
import { PERSON, TENANT, bindingFor, call, freshConversation, readAll, readSome, replyText, say } from "./helpers.js";

const NEW_COMPANY = "Set up a new company called Kestrel Logistics";

describe("a turn with the scripted model", () => {
  it("streams the person's words, text, a valid block and a proposal, in that order", async () => {
    const conversation = freshConversation();
    const { response, all, events: got } = await say(conversation, NEW_COMPANY);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const types = got.map((e) => (e as { type: string }).type);
    expect(types[0]).toBe("turn");
    expect(types.filter((t) => t === "text").length).toBeGreaterThan(1);
    expect(types.slice(-2)).toEqual(["block", "proposal"]);
    const text = replyText(got);
    // Two companies came back from the API, read with the person's session.
    expect(text).toBe("You work with 2 companies already. Here is the new one, ready when you confirm.");
    expect(got.at(-2)).toEqual({
      v: 1,
      type: "block",
      block: { type: "brief", items: [{ label: "Company", value: "Kestrel Logistics" }] },
    });
    expect(got.at(-1)).toMatchObject({
      v: 1,
      type: "proposal",
      proposal: { action: "create_company", args: { name: "Kestrel Logistics" } },
    });
    // Each frame has the stream's sequence number, and the stream ends plainly.
    expect(all.filter((f) => f.event === null).map((f) => f.id)).toEqual(got.map((_, i) => i));
    expect(all.at(-1)?.event).toBe("done");
  });

  it("answers what it cannot do in plain words, with nothing to confirm", async () => {
    const { events: got } = await say(freshConversation(), "Delete every company");
    expect(got.map((e) => (e as { type: string }).type)).not.toContain("proposal");
  });

  it("reads the day and proposes opening Today", async () => {
    const { events: got } = await say(freshConversation(), "What needs me today?");
    expect(got.at(-1)).toMatchObject({
      type: "proposal",
      proposal: { action: "open_route", args: { to: { screen: "today" } } },
    });
  });
});

describe("the live session", () => {
  it("resumes a dropped connection on the same stream, from the last event it had", async () => {
    const conversation = freshConversation();
    const first = await call(`/internal/v1/conversations/${conversation}/turns`, {
      method: "POST",
      session: SLOW_SESSION,
      body: { text: NEW_COMPANY },
    });
    // The connection drops after the first event, while the turn waits on the API.
    const seen = await readSome(first, 1);
    const turn = (seen[0]!.data as { turn: string }).turn;
    const resumed = await readAll(
      await call(`/internal/v1/conversations/${conversation}/turns/${turn}/events`, {
        headers: { "last-event-id": String(seen[0]!.id) },
      }),
    );
    const rest = resumed.filter((f) => f.event === null);
    expect(rest[0]!.id).toBe(1);
    expect(rest.at(-1)?.data).toMatchObject({ type: "proposal" });
    expect(resumed.at(-1)?.event).toBe("done");
  });

  it("shows a second tab the same conversation, and a waiting proposal survives the object sleeping", async () => {
    const conversation = freshConversation();
    const { events: got } = await say(conversation, NEW_COMPANY);
    const proposal = (got.at(-1) as { proposal: { id: string } }).proposal;

    // Every instance loses its memory, as an object that sleeps or restarts does; storage stays.
    await abortAllDurableObjects();
    const view = await call(`/internal/v1/conversations/${conversation}`);
    expect(view.status).toBe(200);
    const turns = parseView(await view.json());
    expect(turns).toHaveLength(1);
    expect(turns![0]).toMatchObject({
      said: NEW_COMPANY,
      state: "done",
      blocks: [{ type: "brief" }],
      proposals: [{ proposal, state: "waiting" }],
    });

    const settled = await call(`/internal/v1/conversations/${conversation}/proposals/${proposal.id}`, {
      method: "POST",
      body: { outcome: "dismissed" },
    });
    expect(settled.status).toBe(204);
    const again = parseView(await (await call(`/internal/v1/conversations/${conversation}`)).json());
    expect(again![0]!.proposals[0]!.state).toBe("dismissed");
    // It settles once.
    const twice = await call(`/internal/v1/conversations/${conversation}/proposals/${proposal.id}`, {
      method: "POST",
      body: { outcome: "confirmed" },
    });
    expect(twice.status).toBe(404);
  });

  it("answers that a conversation nobody has started does not exist, and binds nothing", async () => {
    const conversation = freshConversation();
    expect((await call(`/internal/v1/conversations/${conversation}`)).status).toBe(404);
    // A turn by someone else afterwards still binds it to them.
    const { response } = await say(
      conversation,
      "hello",
      SESSION,
      await bindingFor(conversation, { person: "user_b" }),
    );
    expect(response.status).toBe(200);
  });

  it("deletes its working copy when the idle alarm fires", async () => {
    const conversation = freshConversation();
    await say(conversation, NEW_COMPANY);
    const stub = env.CONVERSATIONS.getByName(conversation);
    // The job is due in 24 hours; bring it forward rather than wait.
    await runInDurableObject(stub, async (instance: Conversation) => {
      const job = instance.lifecycle.jobs.get("forget");
      expect(job!.time - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
      await instance.lifecycle.jobs.reschedule("forget", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The object reset itself, which breaks stubs to it: ask for a new one, as the Worker does per request.
    const left = await runInDurableObject(env.CONVERSATIONS.getByName(conversation), (_instance, state) =>
      state.storage.sql
        .exec<{
          name: string;
        }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )
        .toArray(),
    );
    expect(left).toEqual([]);
    expect((await call(`/internal/v1/conversations/${conversation}`)).status).toBe(404);
  });
});

describe("limits", () => {
  it("refuses a message that is too long, plainly", async () => {
    const { response } = await say(freshConversation(), "x".repeat(2001));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_long" });
    const huge = await say(freshConversation(), "x".repeat(20_000));
    expect(huge.response.status).toBe(413);
  });

  it("refuses a turn while another is running in the same conversation", async () => {
    const conversation = freshConversation();
    const first = await call(`/internal/v1/conversations/${conversation}/turns`, {
      method: "POST",
      session: SLOW_SESSION,
      body: { text: NEW_COMPANY },
    });
    const second = await say(conversation, "hello");
    expect(second.response.status).toBe(409);
    expect(await second.response.json()).toEqual({ error: "busy" });
    await readAll(first);
  });

  it("refuses past the turns one conversation may hold", async () => {
    const conversation = freshConversation();
    await say(conversation, "hello");
    await runInDurableObject(env.CONVERSATIONS.getByName(conversation), (_instance, state) => {
      for (let i = 1; i < MAX_TURNS; i++) {
        state.storage.sql.exec("INSERT INTO assistant_turns (id, said, state) VALUES (?, 'hi', 'done')", `t_seed${i}`);
      }
    });
    const { response } = await say(conversation, "hello");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "turn_limit" });
  });

  it("refuses past one person's turn rate, across their conversations", async () => {
    const person = `user_rate_${crypto.randomUUID().slice(0, 6)}`;
    const limiter = env.PERSON_TURNS.getByName(`${TENANT}:${person}`);
    for (let i = 0; i < TURNS_PER_WINDOW; i++) expect(await limiter.take()).toBe(true);
    const conversation = freshConversation();
    const { response } = await say(conversation, "hello", SESSION, await bindingFor(conversation, { person }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    // Another person is not held up by it.
    expect((await say(freshConversation(), "hello")).response.status).toBe(200);
    expect(PersonTurns).toBeDefined();
    expect(PERSON).not.toBe(person);
  });
});

/** A model that starts its answer and then never finishes it, as a stuck provider would. */
function stuckModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "oryxa.test",
    modelId: "stuck",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("streams only")),
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "Looking " });
          },
        }),
      }),
  };
}

/** A model that asks for the companies list once, says `then` if given, and waits on the list's answer. */
function readingModel(then = ""): LanguageModelV4 {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  };
  return {
    specificationVersion: "v4",
    provider: "oryxa.test",
    modelId: "reading",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("streams only")),
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "tool-call", toolCallId: "call-0", toolName: "list_companies", input: "{}" });
            if (then !== "") {
              controller.enqueue({ type: "text-start", id: "t" });
              controller.enqueue({ type: "text-delta", id: "t", delta: then });
              controller.enqueue({ type: "text-end", id: "t" });
            }
            controller.enqueue({ type: "finish", usage, finishReason: { unified: "tool-calls", raw: undefined } });
            controller.close();
          },
        }),
      }),
  };
}

describe("a turn's time limit", () => {
  it("ends a stuck turn with a plain notice, keeping what it had said", async () => {
    const emitted: Array<WireEvent> = [];
    const out: Folded = { text: "", blocks: [], proposals: [], notice: null };
    const started = Date.now();
    await runTurn({
      model: stuckModel(),
      binding: { conversation: "c_stuck", tenant: TENANT, person: PERSON, company: null },
      said: "hello",
      history: [],
      read: () => Promise.resolve(null),
      emit: (event) => emitted.push(event),
      out,
      timeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out).toMatchObject({ text: "Looking ", notice: "timed_out" });
    expect(emitted.map((e) => e.type)).toEqual(["text", "notice"]);
    expect(emitted.at(-1)).toEqual({ v: 1, type: "notice", notice: "timed_out" });
  });

  it("stops a read in flight with the turn, so the person's session is not held past it", async () => {
    // An API that never answers until its request is aborted, then says when that was.
    let aborted: number | null = null;
    const api = {
      fetch: (request: Request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted = Date.now();
            reject(request.signal.reason as Error);
          });
        }),
    } as unknown as Fetcher;
    const out: Folded = { text: "", blocks: [], proposals: [], notice: null };
    const started = Date.now();
    const reader = apiReader(api, SESSION);
    let settled = false;
    await runTurn({
      model: readingModel(),
      binding: { conversation: "c_reading", tenant: TENANT, person: PERSON, company: null },
      said: "hello",
      history: [],
      read: (path, signal) => reader(path, signal).finally(() => (settled = true)),
      emit: () => {},
      out,
      timeoutMs: 50,
    });
    expect(out.notice).toBe("timed_out");
    // Ended with the turn, not by the read's own ten second limit.
    expect(aborted).not.toBeNull();
    expect(aborted! - started).toBeLessThan(2_000);
    // The read itself is over, so nothing still holds the session.
    await new Promise((done) => setTimeout(done, 20));
    expect(settled).toBe(true);
  });

  it("stops a read in flight when the turn ends another way, here at the reply limit", async () => {
    let aborted = false;
    const api = {
      fetch: (request: Request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            reject(request.signal.reason as Error);
          });
        }),
    } as unknown as Fetcher;
    const out: Folded = { text: "", blocks: [], proposals: [], notice: null };
    const reader = apiReader(api, SESSION);
    let settled = false;
    await runTurn({
      model: readingModel("x".repeat(MAX_REPLY + 1)),
      binding: { conversation: "c_reading_long", tenant: TENANT, person: PERSON, company: null },
      said: "hello",
      history: [],
      read: (path, signal) => reader(path, signal).finally(() => (settled = true)),
      emit: () => {},
      out,
    });
    expect(out.notice).toBe("reply_limit");
    await new Promise((done) => setTimeout(done, 20));
    expect(aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it("is a few minutes at most, and longer than any one read", () => {
    expect(TURN_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(TURN_TIMEOUT_MS).toBeLessThanOrEqual(180_000);
  });
});

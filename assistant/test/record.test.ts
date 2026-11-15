import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseView } from "../src/catalogue/wire.js";
import { runtime } from "../src/model/provider.js";
import type { Conversation } from "../src/conversation.js";
import {
  DOWN_SESSION,
  FLAKY_SESSION,
  LOST_SESSION,
  REFUSED_TEXT,
  SESSION,
  SLOW_SESSION,
  UNHEARD_SESSION,
  WEB_ORIGIN,
} from "./fake-api.js";
import { bindingFor, call, dump, freshConversation, logsOf, readSome, replyText, say } from "./helpers.js";

// The record (issue #279, ADR 0009): each finished turn, and each answer to a proposal, is written to the API with
// the person's session lent for the call, without holding up the stream; and a new object is rebuilt from it. The
// sample API keeps records in memory and checks each write against openapi.json and the API's rules (fake-api.ts).

const NEW_COMPANY = "Set up a new company called Kestrel Logistics";
const SECRET = SESSION.split("=")[1]!;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type StoredTurn = {
  n: number;
  id: string;
  said: string;
  text: string;
  blocks: Array<unknown>;
  proposals: Array<{ proposal: { id: string; action: string }; state: string }>;
  notice: string | null;
  state: string;
};

/** The conversation's record, as the sample API holds it. */
async function recorded(conversation: string): Promise<Array<StoredTurn>> {
  const response = await env.API!.fetch(`http://api.internal/v1/assistant/conversations/${conversation}`, {
    headers: { cookie: SESSION },
  });
  return ((await response.json()) as { turns: Array<StoredTurn> }).turns;
}

/** Waits for the record to hold `count` turns, written in the background. */
const until = (conversation: string, check: (turns: Array<StoredTurn>) => void) =>
  vi.waitFor(async () => check(await recorded(conversation)), { timeout: 5_000, interval: 25 });

/** Every call the sample API saw for `conversation`'s record. */
async function callsFor(conversation: string) {
  const all = (await (await env.API!.fetch("http://api.internal/test/calls")).json()) as Array<{
    method: string;
    path: string;
    origin: string | null;
    csrf: string | null;
    status: number;
  }>;
  return all.filter((c) => c.path.includes(`/conversations/${conversation}`));
}

/** The record writes the Worker made for `conversation` (not a test's own seeding). */
const putsOf = async (conversation: string) =>
  (await callsFor(conversation)).filter((c) => c.method === "PUT" && c.path.startsWith("/v1/"));

/** Puts a finished turn the record does not have yet straight into the working copy, as an earlier turn left it. */
async function plant(
  conversation: string,
  turn: {
    id: string;
    text?: string;
    blocks?: Array<unknown>;
    proposals?: Array<{ id: string } & Record<string, unknown>>;
  },
) {
  await runInDurableObject(env.CONVERSATIONS.getByName(conversation), (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO assistant_turns (id, said, state, text, blocks, record) VALUES (?, 'planted', 'done', ?, ?, 'pending')",
      turn.id,
      turn.text ?? "",
      JSON.stringify(turn.blocks ?? []),
    );
    (turn.proposals ?? []).forEach((p, i) =>
      state.storage.sql.exec(
        "INSERT INTO assistant_proposals (id, turn, n, body, state) VALUES (?, ?, ?, ?, 'waiting')",
        p.id,
        turn.id,
        i,
        JSON.stringify(p),
      ),
    );
  });
}

/** The working copy's own marks: whether each turn is written to the record yet. */
const marks = (conversation: string) =>
  runInDurableObject(env.CONVERSATIONS.getByName(conversation), (_instance, state) =>
    state.storage.sql.exec<{ n: number; record: string }>("SELECT n, record FROM assistant_turns ORDER BY n").toArray(),
  );

/** A binding for a person of the test's own, so the turns of this file do not meet the per person rate. */
const as = (conversation: string) =>
  bindingFor(conversation, { person: `user_rec_${crypto.randomUUID().slice(0, 8)}` });

/** Says `text` as that person, with `session`. */
async function sayAs(conversation: string, binding: string, text: string, session = SESSION) {
  return say(conversation, text, session, binding);
}

const settle = (conversation: string, binding: string, proposal: string, outcome: string, session?: string) =>
  call(`/internal/v1/conversations/${conversation}/proposals/${proposal}`, {
    method: "POST",
    body: { outcome },
    binding,
    ...(session === undefined ? {} : { session }),
  });

describe("writing each finished turn", () => {
  it("writes it at its place as the person, from the web app's origin, once the stream is done", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    const first = await sayAs(conversation, binding, NEW_COMPANY);
    const second = await sayAs(conversation, binding, "What needs me today?");

    await until(conversation, (turns) => expect(turns).toHaveLength(2));
    const turns = await recorded(conversation);
    expect(turns.map((t) => [t.n, t.id, t.said, t.state, t.notice])).toEqual([
      [1, (first.events[0] as { turn: string }).turn, NEW_COMPANY, "done", null],
      [2, (second.events[0] as { turn: string }).turn, "What needs me today?", "done", null],
    ]);
    expect(turns[0]!.text).toBe(replyText(first.events));
    // The proposal as the person saw it, waiting; the home record leaves out the brief block it does not take.
    expect(turns[0]!.proposals).toEqual([
      { proposal: (first.events.at(-1) as { proposal: unknown }).proposal, state: "waiting" },
    ]);
    expect(turns[0]!.blocks).toEqual([]);
    expect(await marks(conversation)).toEqual([
      { n: 1, record: "written" },
      { n: 2, record: "written" },
    ]);
    const puts = (await callsFor(conversation)).filter((c) => c.method === "PUT");
    expect(puts.map((c) => [c.path.split("/").slice(-2).join("/"), c.origin, c.csrf])).toEqual([
      ["turns/1", WEB_ORIGIN, "1"],
      ["turns/2", WEB_ORIGIN, "1"],
    ]);
  });

  it("writes a company conversation's blocks as they were shown", async () => {
    const conversation = freshConversation();
    await env.API!.fetch(`http://api.internal/test/conversations/${conversation}`, {
      method: "PUT",
      body: JSON.stringify({ company: "cmp_kestrel" }),
    });
    const binding = await bindingFor(conversation, {
      person: `user_rec_${crypto.randomUUID().slice(0, 8)}`,
      company: "cmp_kestrel",
    });
    await sayAs(conversation, binding, NEW_COMPANY);
    await until(conversation, (turns) => expect(turns).toHaveLength(1));
    expect((await recorded(conversation))[0]!.blocks).toEqual([
      { type: "brief", items: [{ label: "Company", value: "Kestrel Logistics" }] },
    ]);
  });

  it("writes a failed turn as failed, with what it said and its notice", async () => {
    const conversation = freshConversation();
    await sayAs(conversation, await as(conversation), "simulate a failed turn");
    await until(conversation, (turns) =>
      expect(turns).toMatchObject([{ n: 1, state: "failed", text: "Starting, ", notice: "failed" }]),
    );
  });

  it("writes a stopped turn with the stopped notice", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    const started = await call(`/internal/v1/conversations/${conversation}/turns`, {
      method: "POST",
      session: SLOW_SESSION,
      body: { text: "What needs me today?" },
      binding,
    });
    const seen = await readSome(started, 2);
    const turn = (seen[0]!.data as { turn: string }).turn;
    await call(`/internal/v1/conversations/${conversation}/turns/${turn}/stop`, { method: "POST", binding });
    await until(conversation, (turns) => expect(turns).toMatchObject([{ id: turn, state: "done", notice: "stopped" }]));
  });

  it("tries a failed write again, and a retry of a stored turn stores it once", async () => {
    const flaky = freshConversation();
    await sayAs(flaky, await as(flaky), "hello", FLAKY_SESSION);
    await until(flaky, (turns) => expect(turns).toHaveLength(1));
    expect((await callsFor(flaky)).filter((c) => c.method === "PUT")).toHaveLength(3);

    const lost = freshConversation();
    await sayAs(lost, await as(lost), "hello", LOST_SESSION);
    await vi.waitFor(async () => expect(await marks(lost)).toEqual([{ n: 1, record: "written" }]), { timeout: 5_000 });
    expect(await recorded(lost)).toHaveLength(1);
    expect((await callsFor(lost)).filter((c) => c.method === "PUT")).toHaveLength(2);
  });
});

describe("a write that fails", () => {
  it("does not break the stream, and is kept and written at the start of the next turn", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    let first: Awaited<ReturnType<typeof say>> | null = null;
    const logged = await logsOf(async () => {
      first = await sayAs(conversation, binding, NEW_COMPANY, DOWN_SESSION);
      await vi.waitFor(
        async () => expect((await callsFor(conversation)).filter((c) => c.method === "PUT")).toHaveLength(3),
        { timeout: 5_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The person's turn streamed in full and ended plainly.
    expect(first!.all.at(-1)?.event).toBe("done");
    expect(replyText(first!.events)).toContain("You work with 2 companies");
    const view = parseView(await (await call(`/internal/v1/conversations/${conversation}`, { binding })).json());
    expect(view![0]).toMatchObject({ state: "done" });
    expect(await recorded(conversation)).toEqual([]);
    expect(await marks(conversation)).toEqual([{ n: 1, record: "pending" }]);
    // The log names ids and the outcome only.
    const turn = (first!.events[0] as { turn: string }).turn;
    expect(JSON.parse(logged)).toEqual([
      [JSON.stringify({ event: "assistant_record", conversation, turn, n: 1, outcome: "later", how: "whole" })],
    ]);
    // Nothing of the session is kept for the next turn.
    expect(await dump(env.CONVERSATIONS.getByName(conversation))).not.toContain("sample-down");

    await sayAs(conversation, binding, "What needs me today?");
    await until(conversation, (turns) =>
      expect(turns.map((t) => [t.n, t.said])).toEqual([
        [1, NEW_COMPANY],
        [2, "What needs me today?"],
      ]),
    );
  });

  it("ends the conversation with a plain line when the record holds all the turns it may", async () => {
    const conversation = `c_full_${crypto.randomUUID().slice(0, 8)}`;
    const binding = await as(conversation);
    const first = await sayAs(conversation, binding, "hello");
    expect(first.all.at(-1)?.event).toBe("done");
    await vi.waitFor(async () => expect(await marks(conversation)).toEqual([{ n: 1, record: "refused" }]), {
      timeout: 5_000,
    });
    const next = await sayAs(conversation, binding, "hello again");
    expect(next.response.status).toBe(409);
    expect(await next.response.json()).toEqual({ error: "turn_limit" });
  });
});

describe("a new object for a known conversation", () => {
  /** Writes `turns` to the sample record as the person would, before any object holds the conversation. */
  async function seed(conversation: string) {
    const put = (n: number, body: unknown) =>
      env.API!.fetch(`http://api.internal/v1/assistant/conversations/${conversation}/turns/${n}`, {
        method: "PUT",
        headers: { cookie: SESSION, origin: WEB_ORIGIN, "x-oryxa-request": "1" },
        body: JSON.stringify(body),
      });
    await put(1, {
      id: "t_seed1",
      said: "Set up a company called Acme",
      text: "Ready when you confirm.",
      proposals: [{ proposal: { id: "p_seed1", action: "create_company", args: { name: "Acme" } }, state: "waiting" }],
      state: "done",
    });
    await env.API!.fetch(`http://api.internal/v1/assistant/conversations/${conversation}/turns/1/proposals/p_seed1`, {
      method: "PUT",
      headers: { cookie: SESSION, origin: WEB_ORIGIN, "x-oryxa-request": "1" },
      body: JSON.stringify({ state: "confirmed" }),
    });
    await put(2, { id: "t_seed2", said: "And then?", text: "Stopped early.", notice: "stopped", state: "done" });
  }

  it("is rebuilt from the record when the screen opens it, and its next turn follows on", async () => {
    const conversation = freshConversation();
    await seed(conversation);
    const binding = await as(conversation);
    const view = await call(`/internal/v1/conversations/${conversation}`, { binding, session: SESSION });
    expect(view.status).toBe(200);
    expect(parseView(await view.json())).toMatchObject([
      {
        id: "t_seed1",
        state: "done",
        text: "Ready when you confirm.",
        proposals: [{ proposal: { id: "p_seed1" }, state: "confirmed" }],
      },
      { id: "t_seed2", notice: "stopped" },
    ]);
    // What was answered stays answered.
    expect((await settle(conversation, binding, "p_seed1", "dismissed", SESSION)).status).toBe(404);

    await sayAs(conversation, binding, "hello");
    await until(conversation, (turns) => expect(turns.map((t) => t.n)).toEqual([1, 2, 3]));
    expect(await marks(conversation)).toEqual([
      { n: 1, record: "written" },
      { n: 2, record: "written" },
      { n: 3, record: "written" },
    ]);
  });

  it("is rebuilt by a turn too, and writes nothing back of what it read", async () => {
    const conversation = freshConversation();
    await seed(conversation);
    await sayAs(conversation, await as(conversation), "hello");
    await until(conversation, (turns) => expect(turns.map((t) => t.id).slice(0, 2)).toEqual(["t_seed1", "t_seed2"]));
    const puts = (await callsFor(conversation)).filter((c) => c.method === "PUT" && !c.path.startsWith("/test"));
    // Two turns and an answer seeded here, and the new turn: nothing rewritten.
    expect(puts.map((c) => c.path.split("/").slice(-1)[0])).toEqual(["1", "p_seed1", "2", "3"]);
  });

  it("answers plainly when the record cannot be read, rather than starting empty", async () => {
    const gone = `c_gone_${crypto.randomUUID().slice(0, 8)}`;
    const turn = await sayAs(gone, await as(gone), "hello");
    expect(turn.response.status).toBe(404);
    expect(await turn.response.json()).toEqual({ error: "unknown_conversation" });

    const broken = `c_broken_${crypto.randomUUID().slice(0, 8)}`;
    const binding = await as(broken);
    const refused = await sayAs(broken, binding, "hello");
    expect(refused.response.status).toBe(503);
    expect(await refused.response.json()).toEqual({ error: "record_unavailable" });
    // And nothing was bound: without a session lent, the screen hears there is nothing yet.
    const view = await call(`/internal/v1/conversations/${broken}`, { binding });
    expect(view.status).toBe(404);
    expect(await view.json()).toEqual({ error: "no_conversation" });
  });
});

describe("the person's answer to a proposal", () => {
  it("is recorded with the session the answer lent, and performs nothing", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    const { events } = await sayAs(conversation, binding, NEW_COMPANY);
    const proposal = (events.at(-1) as { proposal: { id: string } }).proposal.id;
    await until(conversation, (turns) => expect(turns).toHaveLength(1));

    expect((await settle(conversation, binding, proposal, "confirmed", SESSION)).status).toBe(204);
    await until(conversation, (turns) => expect(turns[0]!.proposals[0]!.state).toBe("confirmed"));
    const puts = (await callsFor(conversation)).filter((c) => c.method === "PUT");
    expect(puts.at(-1)).toMatchObject({
      method: "PUT",
      path: `/v1/assistant/conversations/${conversation}/turns/1/proposals/${proposal}`,
      origin: WEB_ORIGIN,
    });
    // Recording is all: no company was created, nor anything else written outside the record.
    const all = (await (await env.API!.fetch("http://api.internal/test/calls")).json()) as Array<{
      method: string;
      path: string;
    }>;
    expect(
      all.filter((c) => c.method !== "GET" && !c.path.startsWith("/v1/assistant/") && !c.path.startsWith("/test/")),
    ).toEqual([]);
  });

  it("is recorded after its turn when both were left to the next turn", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    const { events } = await sayAs(conversation, binding, NEW_COMPANY, DOWN_SESSION);
    const proposal = (events.at(-1) as { proposal: { id: string } }).proposal.id;
    // Answered with no session lent: kept in the working copy until one is.
    expect((await settle(conversation, binding, proposal, "dismissed")).status).toBe(204);
    await vi.waitFor(
      async () => expect((await callsFor(conversation)).filter((c) => c.method === "PUT")).toHaveLength(3),
      {
        timeout: 5_000,
      },
    );

    await sayAs(conversation, binding, "hello");
    await until(conversation, (turns) => {
      expect(turns).toHaveLength(2);
      expect(turns[0]!.proposals[0]!.state).toBe("dismissed");
    });
    const paths = (await callsFor(conversation))
      .filter((c) => c.method === "PUT")
      .map((c) => c.path.split("/").slice(-1)[0]);
    // The turn first, its proposal waiting, then the answer; then the new turn.
    expect(paths.slice(3)).toEqual(["1", proposal, "2"]);
  });
});

describe("the session lent for the record", () => {
  it("is never kept, and the record's writes reach no host but the API binding", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const reached = vi.spyOn(runtime, "fetch");
    const conversation = freshConversation();
    const binding = await as(conversation);
    const { events } = await sayAs(conversation, binding, NEW_COMPANY);
    const proposal = (events.at(-1) as { proposal: { id: string } }).proposal.id;
    await settle(conversation, binding, proposal, "confirmed", SESSION);
    await until(conversation, (turns) => expect(turns[0]?.proposals[0]?.state).toBe("confirmed"));
    expect(spy).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
    const held = await dump(env.CONVERSATIONS.getByName(conversation));
    expect(held).not.toContain(SECRET);
    expect(held).not.toContain("fde_session");
    expect(held).not.toContain(WEB_ORIGIN);
  });

  it("must come with the web app's origin, well formed", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    // Well formed, and exactly the origin the deploy set (WEB_ORIGIN in vitest.config.ts).
    for (const origin of [
      null,
      "https://fde.example/path",
      "http://fde.example",
      "javascript:alert(1)",
      "https://other.example",
    ]) {
      const bad = await call(`/internal/v1/conversations/${conversation}/turns`, {
        method: "POST",
        session: SESSION,
        origin,
        body: { text: "hello" },
        binding,
      });
      expect(bad.status, String(origin)).toBe(400);
      expect(await bad.json()).toEqual({ error: "no_session" });
    }
  });
});

describe("a turn the record will not take", () => {
  it("is written as a plain failed turn in its place, and the turns after it follow on", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    await sayAs(conversation, binding, "hello");
    await until(conversation, (turns) => expect(turns).toHaveLength(1));
    // Refused by the API for a rule the Worker does not copy; then one the Worker itself cannot send.
    await plant(conversation, { id: "t_refused", text: `Here: ${REFUSED_TEXT}` });
    await plant(conversation, { id: "t_unsendable", text: "a\u001bb" });
    const last = await sayAs(conversation, binding, "and then?");
    await until(conversation, (turns) => expect(turns).toHaveLength(4));
    const turns = await recorded(conversation);
    expect(turns.map((t) => [t.n, t.id, t.state, t.notice])).toEqual([
      [1, turns[0]!.id, "done", null],
      [2, "t_refused", "failed", "failed"],
      [3, "t_unsendable", "failed", "failed"],
      [4, (last.events[0] as { turn: string }).turn, "done", null],
    ]);
    expect([turns[1]!.text, turns[2]!.text]).toEqual(["", ""]);
    expect(await marks(conversation)).toEqual([1, 2, 3, 4].map((n) => ({ n, record: "written" })));
  });

  it("is written without the parts naming a record the API refuses, in its place", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    await sayAs(conversation, binding, "hello");
    await until(conversation, (turns) => expect(turns).toHaveLength(1));
    const unseen = { screen: "company", company: "cmp_unseen" };
    await plant(conversation, {
      id: "t_unseen",
      text: "Open it below.",
      blocks: [{ type: "suggestion", id: "s1", title: "Open", approve: { label: "Open", to: unseen } }],
      proposals: [
        { id: "p_open", action: "open_route", args: { to: unseen } },
        { id: "p_make", action: "create_company", args: { name: "Acme" } },
      ],
    });
    await sayAs(conversation, binding, "and then?");
    await until(conversation, (turns) => expect(turns).toHaveLength(3));
    const second = (await recorded(conversation))[1]!;
    expect(second).toMatchObject({ n: 2, id: "t_unseen", text: "Open it below.", blocks: [], state: "done" });
    expect(second.proposals.map((p) => p.proposal.id)).toEqual(["p_make"]);
    const tries = (await putsOf(conversation)).filter((c) => c.path.endsWith("/turns/2"));
    expect(tries.map((c) => c.status)).toEqual([400, 201]);
  });
});

describe("another turn in the record's place", () => {
  it("stops the writes, leaves the turn waiting, and lines up with the record at the next session", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    await sayAs(conversation, binding, "hello");
    await until(conversation, (turns) => expect(turns).toHaveLength(1));
    // Another writer took place 2.
    await env.API!.fetch(`http://api.internal/v1/assistant/conversations/${conversation}/turns/2`, {
      method: "PUT",
      headers: { cookie: SESSION, origin: WEB_ORIGIN, "x-oryxa-request": "1" },
      body: JSON.stringify({ id: "t_elsewhere", said: "from elsewhere", state: "done" }),
    });
    const second = await sayAs(conversation, binding, "second");
    const secondId = (second.events[0] as { turn: string }).turn;
    await vi.waitFor(async () => expect((await putsOf(conversation)).filter((c) => c.status === 409)).toHaveLength(1), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await marks(conversation)).at(-1)).toEqual({ n: 2, record: "pending" });

    const third = await sayAs(conversation, binding, "third");
    const thirdId = (third.events[0] as { turn: string }).turn;
    await until(conversation, (turns) => expect(turns).toHaveLength(4));
    expect((await recorded(conversation)).map((t) => t.id).slice(1)).toEqual(["t_elsewhere", secondId, thirdId]);
    expect(await marks(conversation)).toEqual([
      { n: 1, record: "written" },
      { n: 2, record: "written" },
      { n: 3, record: "written" },
    ]);
  });
});

describe("an object gone mid-write", () => {
  it("restarts with the turn waiting, and its retry is answered 200", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    await sayAs(conversation, binding, "hello", UNHEARD_SESSION);
    await vi.waitFor(async () => expect(await putsOf(conversation)).toHaveLength(3), { timeout: 5_000 });
    // Stored, but the object never heard so: it keeps the turn waiting.
    expect(await recorded(conversation)).toHaveLength(1);
    expect(await marks(conversation)).toEqual([{ n: 1, record: "pending" }]);
    await abortAllDurableObjects();

    await sayAs(conversation, binding, "again");
    await until(conversation, (turns) => expect(turns).toHaveLength(2));
    const statuses = (await putsOf(conversation)).map((c) => [c.path.split("/").at(-1), c.status]);
    expect(statuses.slice(3)).toEqual([
      ["1", 200],
      ["2", 201],
    ]);
  });
});

describe("a rebuilt proposal still waiting", () => {
  it("records the person's answer once they give it", async () => {
    const conversation = freshConversation();
    await env.API!.fetch(`http://api.internal/v1/assistant/conversations/${conversation}/turns/1`, {
      method: "PUT",
      headers: { cookie: SESSION, origin: WEB_ORIGIN, "x-oryxa-request": "1" },
      body: JSON.stringify({
        id: "t_wait",
        said: "Set up Acme",
        proposals: [{ proposal: { id: "p_wait", action: "create_company", args: { name: "Acme" } }, state: "waiting" }],
        state: "done",
      }),
    });
    const binding = await as(conversation);
    expect((await call(`/internal/v1/conversations/${conversation}`, { binding, session: SESSION })).status).toBe(200);
    expect((await settle(conversation, binding, "p_wait", "confirmed", SESSION)).status).toBe(204);
    await until(conversation, (turns) => expect(turns[0]!.proposals[0]!.state).toBe("confirmed"));
  });
});

describe("a view that lends a session", () => {
  it("writes nothing, even with a turn waiting to be written", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    await sayAs(conversation, binding, "hello", DOWN_SESSION);
    await vi.waitFor(async () => expect(await putsOf(conversation)).toHaveLength(3), { timeout: 5_000 });
    expect((await call(`/internal/v1/conversations/${conversation}`, { binding, session: SESSION })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await putsOf(conversation)).toHaveLength(3);
    expect(await marks(conversation)).toEqual([{ n: 1, record: "pending" }]);
  });
});

describe("a lent session's deadline", () => {
  it("sends nothing after it, and the next session lent picks the writes up", async () => {
    const conversation = freshConversation();
    const person = `user_rec_${crypto.randomUUID().slice(0, 8)}`;
    const { events } = await sayAs(conversation, await bindingFor(conversation, { person }), NEW_COMPANY, DOWN_SESSION);
    const proposal = (events.at(-1) as { proposal: { id: string } }).proposal.id;
    // Ten minutes on, as after a sign-out: the turn's session is long past its deadline.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const before = (await putsOf(conversation)).length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(before).toBeLessThanOrEqual(1);
    expect(await putsOf(conversation)).toHaveLength(before);
    expect(await marks(conversation)).toEqual([{ n: 1, record: "pending" }]);

    // An answer lends a fresh session: the turn and the answer go with it. Its binding is signed now, as fde-web would.
    const binding = await bindingFor(conversation, { person });
    expect((await settle(conversation, binding, proposal, "confirmed", SESSION)).status).toBe(204);
    await until(conversation, (turns) => expect(turns[0]?.proposals[0]?.state).toBe("confirmed"));
  });
});

describe("the idle deletion", () => {
  it("says, by ids, which turns and answers it takes before the record has them", async () => {
    const conversation = freshConversation();
    const binding = await as(conversation);
    const { events } = await sayAs(conversation, binding, NEW_COMPANY, DOWN_SESSION);
    const turn = (events[0] as { turn: string }).turn;
    const proposal = (events.at(-1) as { proposal: { id: string } }).proposal.id;
    await settle(conversation, binding, proposal, "dismissed");
    await vi.waitFor(async () => expect(await putsOf(conversation)).toHaveLength(3), { timeout: 5_000 });
    const stub = env.CONVERSATIONS.getByName(conversation);
    await runInDurableObject(stub, async (instance: Conversation) => {
      await instance.lifecycle.jobs.reschedule("forget", Date.now() - 1);
    });
    const logged = await logsOf(async () => {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    });
    expect(JSON.parse(logged)).toContainEqual([
      JSON.stringify({ event: "assistant_record_dropped", conversation, turns: [turn], answers: [proposal] }),
    ]);
    expect(logged).not.toContain("Kestrel");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe("a working copy made before the record", () => {
  it("is brought up to date, and an answer given before is sent, never shown as waiting again", async () => {
    const conversation = freshConversation();
    const person = `user_rec_${crypto.randomUUID().slice(0, 8)}`;
    const body = { id: "p_old", action: "create_company", args: { name: "Acme" } };
    await runInDurableObject(env.CONVERSATIONS.getByName(conversation), (instance: Conversation, state) => {
      const sql = state.storage.sql;
      for (const t of ["assistant_binding", "assistant_turns", "assistant_proposals"])
        sql.exec(`DROP TABLE IF EXISTS ${t}`);
      // The tables as they were before this change.
      sql.exec(`CREATE TABLE assistant_binding (
        only INTEGER PRIMARY KEY CHECK (only = 1), tenant TEXT NOT NULL, person TEXT NOT NULL, company TEXT)`);
      sql.exec(`CREATE TABLE assistant_turns (
        n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, said TEXT NOT NULL, state TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '', blocks TEXT NOT NULL DEFAULT '[]', notice TEXT)`);
      sql.exec(`CREATE TABLE assistant_proposals (
        id TEXT PRIMARY KEY, turn TEXT NOT NULL, n INTEGER NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL)`);
      sql.exec("INSERT INTO assistant_binding VALUES (1, 'org_sample', ?, NULL)", person);
      sql.exec("INSERT INTO assistant_turns (id, said, state, text) VALUES ('t_old', 'Set up Acme', 'done', 'Ready.')");
      sql.exec("INSERT INTO assistant_proposals VALUES ('p_old', 't_old', 0, ?, 'confirmed')", JSON.stringify(body));
      instance.onStart();
      // Twice, as each start does: every step runs once.
      instance.onStart();
      expect(sql.exec("SELECT id, state, owed FROM assistant_proposals").toArray()).toEqual([
        { id: "p_old", state: "confirmed", owed: 1 },
      ]);
      expect(sql.exec("SELECT record, rn FROM assistant_turns").toArray()).toEqual([{ record: "pending", rn: null }]);
      expect(sql.exec("SELECT full, reconcile, floor FROM assistant_binding").toArray()).toEqual([
        { full: 0, reconcile: 0, floor: 0 },
      ]);
    });

    await sayAs(conversation, await bindingFor(conversation, { person }), "hello");
    await until(conversation, (turns) => {
      expect(turns.map((t) => t.id)[0]).toBe("t_old");
      expect(turns).toHaveLength(2);
      expect(turns[0]!.proposals).toEqual([{ proposal: body, state: "confirmed" }]);
    });
  });
});

describe("an object with no API binding", () => {
  it("refuses to rebuild rather than start empty", async () => {
    const conversation = freshConversation();
    const answer = await runInDurableObject(
      env.CONVERSATIONS.getByName(conversation),
      async (instance: Conversation) => {
        Object.defineProperty(instance, "env", { value: { ...env, API: undefined } });
        const binding = { conversation, tenant: "org_sample", person: "user_riya", company: null };
        const response = await instance.view(binding, { session: SESSION, origin: null });
        return { status: response.status, body: await response.json() };
      },
    );
    expect(answer).toEqual({ status: 503, body: { error: "record_unavailable" } });
  });
});

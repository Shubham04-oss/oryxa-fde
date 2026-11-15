import { describe, expect, it } from "vitest";

import { NOTICES, PROPOSAL_STATES } from "../src/catalogue/wire.js";
import type { Binding } from "../src/auth.js";
import {
  ANSWERS,
  FINISHED,
  RECORD_TRIES,
  TurnRecord,
  readRecord,
  recordOf,
  withoutDestinations,
  writeAnswer,
  writeTurn,
} from "../src/record.js";
import type { Folded } from "../src/record.js";
import { SESSION, WEB_ORIGIN } from "./fake-api.js";
import { problems, schemaOf } from "./openapi.js";

// What the Worker writes to the record, pinned to the API's own openapi.json (issue #279): the same fields, the same
// enums, and every ending's record fitting `TurnBody` exactly, so a change on either side fails here first.

const LENT = { session: SESSION, origin: WEB_ORIGIN };
const HOME: Binding = { conversation: "c_shape", tenant: "org_sample", person: "user_riya", company: null };

const folded = (over: Partial<Folded> = {}): Folded => ({
  id: "t_abc",
  said: "Set up a company called Kestrel",
  text: "Here it is.",
  blocks: [
    { type: "suggestion", id: "s1", title: "Open Kestrel", approve: { label: "Open", to: { screen: "today" } } },
  ],
  proposals: [{ id: "p_1", action: "create_company", args: { name: "Kestrel" } }],
  notice: null,
  state: "done",
  ...over,
});

const keys = (name: string) => Object.keys(schemaOf(name).properties ?? {}).sort();
const enumOf = (name: string) => schemaOf(name).enum;

describe("the record's shape", () => {
  it("has the API's fields and enums", () => {
    expect(Object.keys(TurnRecord.shape).sort()).toEqual(keys("TurnBody"));
    expect(schemaOf("TurnBody").required).toEqual(expect.arrayContaining(["id", "said", "state"]));
    expect(schemaOf("TurnBody").additionalProperties).toBe(false);
    expect(keys("ProposalEntry")).toEqual(["proposal", "state"]);
    expect(enumOf("TurnNotice")).toEqual([...NOTICES]);
    expect(enumOf("FinishedState")).toEqual([...FINISHED]);
    expect(enumOf("ProposalState")).toEqual([...PROPOSAL_STATES]);
    expect(enumOf("AnswerState")).toEqual([...ANSWERS]);
    expect(keys("AnswerBody")).toEqual(["state"]);
  });

  it("fits TurnBody for every way a turn ends, each proposal waiting", () => {
    const endings: Array<Partial<Folded>> = [
      {},
      ...(["tool_limit", "reply_limit", "timed_out", "stopped"] as const).map((notice) => ({ notice })),
      { notice: "failed", state: "failed", text: "", blocks: [], proposals: [] },
    ];
    for (const ending of endings) {
      const record = recordOf(folded(ending), true);
      expect(record, JSON.stringify(ending)).not.toBeNull();
      expect(problems(record, schemaOf("TurnBody"))).toEqual([]);
      expect(record!.proposals.every((p) => p.state === "waiting")).toBe(true);
    }
  });

  it("leaves out what the home conversation's record does not take, and keeps it for a company's", () => {
    const blocks = [
      { type: "brief", items: [{ label: "Company", value: "Kestrel" }] },
      {
        type: "suggestion",
        id: "s1",
        title: "Open",
        approve: { label: "Open", to: { screen: "project", company: "cmp_a", project: "prj_1" } },
      },
      { type: "people", people: [{ email: "a\u0000@b.co", role: "engineer" }] },
    ];
    const proposals = [
      { id: "p_1", action: "open_route", args: { to: { screen: "project", company: "cmp_a", project: "prj_1" } } },
    ];
    expect(recordOf(folded({ blocks, proposals }), true)).toMatchObject({ blocks: [], proposals: [] });
    const company = recordOf(folded({ blocks, proposals }), false)!;
    expect(company.blocks.map((b) => (b as { type: string }).type)).toEqual(["brief", "suggestion"]);
    expect(company.proposals).toHaveLength(1);
    expect(withoutDestinations(company)).toMatchObject({ blocks: [{ type: "brief" }], proposals: [] });
  });

  it("refuses what the API would refuse rather than send it", () => {
    for (const bad of [
      { text: "x".repeat(4000) + "😀".repeat(2001) },
      { text: "a\u001bb" },
      { text: "lone \ud800" },
      { said: " untrimmed" },
      { said: "" },
      { id: "turn-1" },
      { state: "live" },
      { notice: "other" },
      {
        proposals: [
          { id: "p_1", action: "create_company", args: { name: "A" } },
          { id: "p_1", action: "create_company", args: { name: "B" } },
        ],
      },
    ] as Array<Partial<Folded>>) {
      expect(recordOf(folded(bad), false), JSON.stringify(bad)).toBeNull();
    }
  });
});

/** An API that answers each call from `answers` in turn and remembers what it was asked. */
function api(answers: Array<Response | "hang" | "drop">) {
  const asked: Array<Request> = [];
  const fetcher = {
    fetch: (request: Request) => {
      asked.push(request);
      const next = answers.shift() ?? new Response(null, { status: 599 });
      if (next === "drop") return Promise.reject(new Error("dropped"));
      if (next === "hang") {
        return new Promise<Response>((_, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason as Error)),
        );
      }
      return Promise.resolve(next);
    },
  } as unknown as Fetcher;
  return { fetcher, asked };
}

const answer = (status: number, body: unknown = {}) => Response.json(body, { status });
const FAST = { timeoutMs: 50, backoffMs: 1 };

describe("writing a turn", () => {
  const record = recordOf(folded(), false)!;

  it("puts it at its place as the person, from the web app's origin, and nothing else", async () => {
    const { fetcher, asked } = api([answer(201)]);
    expect(await writeTurn(fetcher, LENT, "cnv_1", 3, record, FAST)).toBe("written");
    const [request] = asked;
    expect(request!.method).toBe("PUT");
    expect(request!.url).toBe("http://api.internal/v1/assistant/conversations/cnv_1/turns/3");
    expect(Object.fromEntries(request!.headers)).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      cookie: SESSION,
      origin: WEB_ORIGIN,
      "x-oryxa-request": "1",
    });
    expect(await request!.json()).toEqual(record);
  });

  it("tries again on a 5xx, a timeout or a dropped connection, a fixed number of times", async () => {
    const flaky = api([answer(503), "hang", answer(200)]);
    expect(await writeTurn(flaky.fetcher, LENT, "cnv_1", 1, record, FAST)).toBe("written");
    expect(flaky.asked).toHaveLength(3);
    // The same body each time, so the API answers a retry of a stored turn with 200.
    const bodies = await Promise.all(flaky.asked.map((r) => r.text()));
    expect(new Set(bodies).size).toBe(1);

    const down = api([answer(502), "drop", answer(503), answer(201)]);
    expect(await writeTurn(down.fetcher, LENT, "cnv_1", 1, record, FAST)).toBe("later");
    expect(down.asked).toHaveLength(RECORD_TRIES);
  });

  it("names each other answer without trying again", async () => {
    const cases: Array<[Response, string]> = [
      [answer(409, { error: "rejected_turn_limit" }), "full"],
      [answer(400, { error: "invalid_destination" }), "destination"],
      [answer(400, { error: "invalid_text" }), "refused"],
      [answer(409, { error: "rejected_turn_taken" }), "refused"],
      [answer(422), "refused"],
      [answer(401, { error: "unauthorized" }), "later"],
      [answer(403, { error: "forbidden" }), "later"],
      [answer(404, { error: "not_found" }), "later"],
    ];
    for (const [response, want] of cases) {
      const { fetcher, asked } = api([response]);
      expect(await writeTurn(fetcher, LENT, "cnv_1", 1, record, FAST)).toBe(want);
      expect(asked).toHaveLength(1);
    }
  });
});

describe("recording an answer", () => {
  it("puts only the answer, for the proposal of its turn", async () => {
    const { fetcher, asked } = api([answer(200)]);
    expect(await writeAnswer(fetcher, LENT, "cnv_1", 2, "p_1", "confirmed", FAST)).toBe("recorded");
    expect(asked[0]!.url).toBe("http://api.internal/v1/assistant/conversations/cnv_1/turns/2/proposals/p_1");
    expect(asked[0]!.method).toBe("PUT");
    expect(await asked[0]!.json()).toEqual({ state: "confirmed" });
    expect(problems({ state: "dismissed" }, schemaOf("AnswerBody"))).toEqual([]);
  });

  it("drops an answer the record will not take, and keeps one it could not send", async () => {
    for (const [response, want] of [
      [answer(409, { error: "rejected_answered" }), "dropped"],
      [answer(404), "dropped"],
      [answer(401), "later"],
    ] as const) {
      expect(await writeAnswer(api([response]).fetcher, LENT, "cnv_1", 1, "p_1", "dismissed", FAST)).toBe(want);
    }
    expect(await writeAnswer(api([]).fetcher, LENT, "cnv_1", 1, "p_1", "dismissed", FAST)).toBe("later");
  });
});

describe("reading the record", () => {
  const turn = (n: number, over: Record<string, unknown> = {}) => ({
    n,
    id: `t_${n}`,
    said: "hello",
    text: "Hi.",
    blocks: [{ type: "brief", items: [] }],
    proposals: [{ proposal: { id: `p_${n}`, action: "create_company", args: { name: "Acme" } }, state: "confirmed" }],
    notice: null,
    state: "done",
    created_at: "2026-11-15T09:00:00Z",
    ...over,
  });
  const detail = (turns: Array<unknown>, id = HOME.conversation) => ({
    conversation: { id, company: null, project: null, created_at: "x", last_active_at: "x" },
    turns,
  });

  it("answers its turns in order, each part checked as the conversation may show it", async () => {
    const { fetcher, asked } = api([answer(200, detail([turn(1), turn(2, { notice: "stopped" })]))]);
    const got = await readRecord(fetcher, SESSION, HOME, FAST);
    expect(asked[0]!.method).toBe("GET");
    expect(asked[0]!.headers.get("cookie")).toBe(SESSION);
    expect(asked[0]!.headers.has("origin")).toBe(false);
    expect(got).toMatchObject({
      turns: [
        { n: 1, id: "t_1", proposals: [{ proposal: { id: "p_1" }, state: "confirmed" }] },
        { n: 2, notice: "stopped" },
      ],
    });
  });

  it("says gone for a 404, and error for anything it cannot trust", async () => {
    expect(await readRecord(api([answer(404)]).fetcher, SESSION, HOME, FAST)).toBe("gone");
    for (const bad of [
      [answer(503), answer(503), answer(503)],
      [answer(401)],
      [answer(200, detail([turn(2)]))],
      [answer(200, detail([turn(1)], "c_other"))],
      [answer(200, detail([turn(1, { said: "a\u0007" })]))],
      [answer(200, { turns: "no" })],
    ]) {
      expect(await readRecord(api(bad).fetcher, SESSION, HOME, FAST)).toBe("error");
    }
  });
});

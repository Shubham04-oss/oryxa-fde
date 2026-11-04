import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { authorized } from "../src/auth.js";
import { parseLines } from "../src/index.js";
import { channelName, parseRunPath } from "../src/run.js";

// Sample values set in vitest.config.ts.
const PUBLISH = "sample-publish-token-for-tests-0123456789";
const SUBSCRIBE = "sample-subscribe-token-for-tests-012345";

const RUN = "/internal/v1/tenants/org_a/companies/cmp_1/projects/prj_1/agent-runs/run_1";
let next = 0;
/** A run path no other test uses, so each test has its own channel. */
const freshRun = () => `/internal/v1/tenants/org_a/companies/cmp_1/projects/prj_1/agent-runs/run_t${(next += 1)}`;

const line = (seq: number, type = "message") => JSON.stringify({ v: 1, seq, type, text: `line ${seq}` });

function publish(run: string, lines: Array<string>, token = PUBLISH, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`https://realtime.test${run}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson", ...headers },
      body: `${lines.join("\n")}\n`,
    }),
  );
}

async function subscribe(run: string, token = SUBSCRIBE): Promise<{ status: number; received: Array<string> }> {
  const response = await exports.default.fetch(
    new Request(`https://realtime.test${run}/live`, {
      headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
    }),
  );
  const received: Array<string> = [];
  const socket = response.webSocket;
  if (socket) {
    socket.accept();
    socket.addEventListener("message", (event) => {
      received.push(String(event.data));
    });
  }
  return { status: response.status, received };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const seqs = (received: Array<string>) => received.map((raw) => (JSON.parse(raw) as { seq: number }).seq);

describe("publishing", () => {
  it("needs the publish token, and the subscribe token will not do", async () => {
    expect((await publish(RUN, [line(0)], "")).status).toBe(401);
    expect((await publish(RUN, [line(0)], `${PUBLISH}x`)).status).toBe(401);
    expect((await publish(RUN, [line(0)], SUBSCRIBE)).status).toBe(401);
    expect((await publish(freshRun(), [line(0)])).status).toBe(202);
  });

  it("fails closed when a configured token is unset or short", async () => {
    const request = new Request("https://realtime.test/", { headers: { authorization: "Bearer short" } });
    expect(await authorized(request, undefined)).toBe(false);
    expect(await authorized(request, "short")).toBe(false);
  });

  it("takes only NDJSON harness lines, within the size limits", async () => {
    const run = freshRun();
    expect((await publish(run, [line(0)], PUBLISH, { "content-type": "application/json" })).status).toBe(415);
    expect((await publish(run, ["not json"])).status).toBe(400);
    expect((await publish(run, [JSON.stringify({ v: 2, seq: 0, type: "message" })])).status).toBe(400);
    expect((await publish(run, [JSON.stringify({ v: 1, seq: -1, type: "message" })])).status).toBe(400);
    expect((await publish(run, [JSON.stringify([1, 2])])).status).toBe(400);
    const huge = JSON.stringify({ v: 1, seq: 0, type: "message", text: "x".repeat(1024 * 1024) });
    expect((await publish(run, [huge])).status).toBe(400);
    expect(
      (
        await publish(
          run,
          Array.from({ length: 5 }, () => huge),
        )
      ).status,
    ).toBe(413);
  });

  it("refuses bad ids and unknown routes before reaching any channel", async () => {
    for (const path of [
      "/internal/v1/tenants/org:a/companies/cmp_1/projects/prj_1/agent-runs/run_1",
      "/internal/v1/tenants/org_a/companies/cmp%2F1/projects/prj_1/agent-runs/run_1",
      "/internal/v1/tenants/org_a/companies/cmp_1/projects/prj_1/agent-runs/run_1/x/y",
      "/internal/v2/tenants/org_a/companies/cmp_1/projects/prj_1/agent-runs/run_1",
    ]) {
      expect((await publish(path, [line(0)])).status, path).toBe(404);
    }
  });
});

describe("subscribing", () => {
  it("needs the subscribe token and a WebSocket, and the publish token will not do", async () => {
    expect((await subscribe(RUN, PUBLISH)).status).toBe(401);
    expect((await subscribe(RUN, "")).status).toBe(401);
    const plain = await exports.default.fetch(
      new Request(`https://realtime.test${RUN}/live`, { headers: { authorization: `Bearer ${SUBSCRIBE}` } }),
    );
    expect(plain.status).toBe(426);
  });

  it("streams each new line once, in order, and drops a replayed one", async () => {
    const run = freshRun();
    const browser = await subscribe(run);
    expect(browser.status).toBe(101);

    await publish(run, [line(0), line(1)]);
    await publish(run, [line(1), line(2)]);
    await settle();

    expect(seqs(browser.received)).toEqual([0, 1, 2]);
  });

  it("gives a browser that connects late what it kept, then the rest", async () => {
    const run = freshRun();
    await publish(run, [line(0), line(1)]);
    const late = await subscribe(run);
    await publish(run, [line(2, "result")]);
    await settle();

    expect(seqs(late.received)).toEqual([0, 1, 2]);
  });

  it("keeps each run's output to that run", async () => {
    const mine = freshRun();
    const other = freshRun();
    const browser = await subscribe(mine);
    await publish(other, [line(0)]);
    await publish(mine, [line(0, "plan")]);
    await settle();

    expect(browser.received.map((raw) => (JSON.parse(raw) as { type: string }).type)).toEqual(["plan"]);
  });
});

describe("paths and lines", () => {
  it("name one channel per run, never shared across tenants", () => {
    const a = parseRunPath(`${RUN}/events`);
    const b = parseRunPath(RUN.replace("org_a", "org_b") + "/events");
    expect(a?.action).toBe("events");
    expect(channelName(a!.address)).toBe("org_a:cmp_1:prj_1:run_1");
    expect(channelName(a!.address)).not.toBe(channelName(b!.address));
  });

  it("parses the API's batches: lines joined by newlines with a trailing one", () => {
    expect(parseLines(`${line(0)}\n${line(1)}\n`)?.map((l) => l.seq)).toEqual([0, 1]);
    expect(parseLines("")).toEqual([]);
  });
});

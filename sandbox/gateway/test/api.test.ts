import { Files } from "@cloudflare/sandbox";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authorized } from "../src/auth.js";
import type { CompanySandbox } from "../src/sandbox.js";
import { companyScope } from "../src/scope.js";
import { FakeContainer } from "./fakes.js";

// Sample values set in vitest.config.ts.
const TOKEN = "sample-service-token-for-tests-0123456789";
const SECRET_A = "sample-github-token-company-a";

const api = (path: string, init: RequestInit = {}, token = TOKEN) =>
  exports.default.fetch(
    new Request(`https://gateway.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    }),
  );
const json = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function attachFake(tenant: string, company: string): Promise<FakeContainer> {
  const fake = new FakeContainer();
  await runInDurableObject(env.SANDBOX.getByName(`${tenant}:${company}`), (sandbox: CompanySandbox) => {
    vi.spyOn(sandbox, "container").mockReturnValue(fake);
  });
  return fake;
}

const githubPolicy = {
  hosts: [{ host: "api.github.com", inject: [{ header: "authorization", secret: "github", prefix: "Bearer " }] }],
};

afterEach(() => vi.restoreAllMocks());

describe("service credential", () => {
  it("refuses a missing or wrong token before touching a sandbox", async () => {
    expect((await exports.default.fetch("https://gateway.test/v1/sandboxes/org_a/cmp_1")).status).toBe(401);
    expect((await api("/v1/sandboxes/org_a/cmp_1", {}, `${TOKEN}x`)).status).toBe(401);
  });

  it("fails closed when the configured token is unset or short", async () => {
    const request = new Request("https://gateway.test/", { headers: { authorization: "Bearer short" } });
    expect(await authorized(request, undefined)).toBe(false);
    expect(await authorized(request, "short")).toBe(false);
  });
});

describe("routing", () => {
  it("refuses malformed ids, including encoded separators", async () => {
    for (const path of [
      "/v1/sandboxes/org%7Ca/cmp_1",
      "/v1/sandboxes/org_a/cmp%2F1",
      "/v1/sandboxes/org_a/cmp%3A1",
      `/v1/sandboxes/${"o".repeat(65)}/cmp_1`,
    ]) {
      expect((await api(path)).status, path).toBe(400);
    }
    expect((await api("/v1/sandboxes/org_a/cmp_1/unknown")).status).toBe(404);
  });

  it("keeps each company's policy in its own sandbox, also across tenants", async () => {
    expect((await api("/v1/sandboxes/org_a/cmp_1/outbound-policy", json(githubPolicy))).status).toBe(200);
    const read = (path: string) => api(`/v1/sandboxes/${path}/outbound-policy`).then((r) => r.json());
    expect(await read("org_a/cmp_1")).toEqual({
      hosts: [{ host: "api.github.com", inject: [{ header: "authorization", secret: "github", prefix: "Bearer " }] }],
    });
    expect(await read("org_b/cmp_1")).toEqual({ hosts: [] });
    expect(await read("org_a/cmp_2")).toEqual({ hosts: [] });
  });

  it("stores secret references only", async () => {
    const raw = { hosts: [{ host: "api.github.com", inject: [{ header: "authorization", value: SECRET_A }] }] };
    expect((await api("/v1/sandboxes/org_a/cmp_1/outbound-policy", json(raw))).status).toBe(400);
  });
});

describe("sandbox lifecycle", () => {
  it("starts the container with no internet and every HTTP(S) request routed to the outbound handler", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    const response = await api("/v1/sandboxes/org_a/cmp_1/start", post());
    expect(await response.json()).toEqual({ running: true });
    expect(fake.started).toEqual([
      {
        image: "sandbox:test",
        instance: "standard-2",
        enableInternet: false,
        labels: { tenant: "org_a", company: "cmp_1" },
      },
    ]);
    expect(fake.intercepts.map(({ kind, addr }) => [kind, addr])).toEqual([
      ["http", "*"],
      ["https", "*"],
    ]);
    expect(fake.idleTimeoutMs).toBe(1_800_000);
    expect((await api("/v1/sandboxes/org_a/cmp_1/stop", post())).status).toBe(200);
    expect(fake.running).toBe(false);
  });

  it("refuses work before start, and a start for another company", async () => {
    await attachFake("org_a", "cmp_1");
    expect((await api("/v1/sandboxes/org_a/cmp_1/exec", post({ argv: ["true"] }))).status).toBe(409);
    expect((await api("/v1/sandboxes/org_a/cmp_1/start", post())).status).toBe(200);
    const misrouted = await env.SANDBOX.getByName("org_a:cmp_1")
      .start(companyScope("org_b", "cmp_1"), "standard-2")
      .then(
        () => undefined,
        (cause: Error) => cause.message,
      );
    expect(misrouted).toBe("this sandbox belongs to another company");
  });

  it("never passes a secret into the container", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/outbound-policy", json(githubPolicy));
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    expect(
      (await api("/v1/sandboxes/org_a/cmp_1/exec", post({ argv: ["env"], env: { GITHUB_TOKEN: SECRET_A } }))).status,
    ).toBe(400);
    await api("/v1/sandboxes/org_a/cmp_1/exec", post({ argv: ["env"], env: { RUN_ID: "run_1" } }));
    expect(fake.execs).toHaveLength(1);
    expect(JSON.stringify([fake.started, fake.execs])).not.toContain(SECRET_A);
  });

  it("refuses file paths outside the workspace", async () => {
    await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    expect((await api("/v1/sandboxes/org_a/cmp_1/files?path=/etc/passwd")).status).toBe(400);
    expect(
      (await api("/v1/sandboxes/org_a/cmp_1/files?path=/workspace/../etc/passwd", { method: "PUT", body: "x" })).status,
    ).toBe(400);
  });
});

describe("exec", () => {
  it("returns a buffered result", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    fake.run = () => ({ stdout: "ok\n", exitCode: 0 });
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const response = await api("/v1/sandboxes/org_a/cmp_1/exec", post({ argv: ["echo", "ok"] }));
    expect(await response.json()).toEqual({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  });

  it("streams output as JSON lines and takes stdin while it runs", async () => {
    await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const response = await api("/v1/sandboxes/org_a/cmp_1/exec/stream", post({ argv: ["cat"], stdin: true }));
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const next = lineReader(response);

    const started = await next();
    expect(started).toMatchObject({ type: "started" });
    const stdin = `/v1/sandboxes/org_a/cmp_1/exec/${started.exec}/stdin`;
    expect((await api(stdin, { method: "POST", body: "hi\n" })).status).toBe(204);
    expect(await next()).toEqual({ type: "stdout", data: "hi\n" });
    await api(stdin, { method: "POST", body: "bye\n" });
    expect(await next()).toEqual({ type: "stdout", data: "bye\n" });
    expect(await next()).toEqual({ type: "exit", code: 0, timedOut: false });
    expect((await api(stdin, { method: "POST", body: "late\n" })).status).toBe(404);
  });

  it("runs every command the API asks for as agent, never as the image's default user", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    await api("/v1/sandboxes/org_a/cmp_1/exec", post({ argv: ["id"] }));
    await api("/v1/sandboxes/org_a/cmp_1/exec/stream", post({ argv: ["id"] })).then((r) => r.text());
    expect(fake.execs.map((e) => e.options?.user)).toEqual(["1001:1001", "1001:1001"]);
    expect((await api("/v1/sandboxes/org_a/cmp_1/exec", post({ argv: ["id"], user: "0:0" }))).status).toBe(400);
  });
});

describe("runs", () => {
  const SHA = "a".repeat(64);
  const run = (path: string, init?: RequestInit) => api(`/v1/sandboxes/org_a/cmp_1/runs/run_1/${path}`, init);

  it("write the context pack as root where the agent cannot reach it, and report what is on disk", async () => {
    await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const pack = '{"v":1}';
    const write = vi.spyOn(Files.prototype, "writeFile").mockResolvedValue();
    // What the file holds when read back: here, something else than was sent.
    const read = vi.spyOn(Files.prototype, "readFile").mockImplementation(async () => new Response('{"v":2}'));
    const response = await run("context", { method: "PUT", body: pack });
    expect(response.status).toBe(200);
    const digest = async (text: string) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    expect(await response.json()).toEqual({ sha256: await digest('{"v":2}') });
    expect(write).toHaveBeenCalledWith("/etc/oryxa/runs/run_1.json", expect.anything(), { user: "0:0" });
    expect(read).toHaveBeenCalledWith("/etc/oryxa/runs/run_1.json", { user: "0:0" });
  });

  it("refuse a pack that is empty, too large, or for a malformed run id", async () => {
    await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const write = vi.spyOn(Files.prototype, "writeFile").mockResolvedValue();
    expect((await run("context", { method: "PUT", body: "" })).status).toBe(413);
    expect((await run("context", { method: "PUT", body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    for (const id of ["run%2F..%2Fx", "run.1", "x".repeat(129)]) {
      const response = await api(`/v1/sandboxes/org_a/cmp_1/runs/${id}/context`, { method: "PUT", body: "{}" });
      expect(response.status, id).toBe(400);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("start the harness as root, on the pack's path and digest, with stdin for decisions", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const response = await run("harness", post({ sha256: SHA, timeoutMs: 60_000 }));
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const started = await lineReader(response)();
    expect(started).toMatchObject({ type: "started" });
    expect(fake.execs).toHaveLength(1);
    const [exec] = fake.execs;
    expect(exec?.argv).toEqual([
      "/usr/local/bin/oryxa-harness",
      "--pack",
      "/etc/oryxa/runs/run_1.json",
      "--sha256",
      SHA,
    ]);
    expect(exec?.options).toMatchObject({
      user: "0:0",
      stdin: "pipe",
      cwd: "/workspace",
      env: { HOME: "/home/harness" },
    });
    const stdin = `/v1/sandboxes/org_a/cmp_1/exec/${started.exec}/stdin`;
    expect((await api(stdin, { method: "POST", body: "bye\n" })).status).toBe(204);
  });

  it("never start a harness while another may still run, even one nobody reads any more", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/stop", post());
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const harness = () => run("harness", post({ sha256: SHA, timeoutMs: 60_000 }));
    // The reader goes away, as an API task does in a deploy; the harness itself keeps running.
    const reader = (await harness()).body!.getReader();
    await reader.read();
    await reader.cancel();
    expect((await harness()).status).toBe(409);
    expect(fake.execs).toHaveLength(1);
    // A stopped sandbox has no harness left: the next one may start.
    await api("/v1/sandboxes/org_a/cmp_1/stop", post());
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const second = await harness();
    expect(second.status).toBe(200);
    const next = await lineReader(second)();
    const stdin = `/v1/sandboxes/org_a/cmp_1/exec/${next.exec}/stdin`;
    expect((await api(stdin, { method: "POST", body: "bye\n" })).status).toBe(204);
    // Its process exited: a third may start without a stop.
    await vi.waitFor(async () => {
      const third = await harness();
      expect(third.status).toBe(200);
      await third.body?.cancel();
    });
  });

  it("keep a harness marked running when its exit cannot be confirmed, until the sandbox stops", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    fake.exitLost = true;
    await api("/v1/sandboxes/org_a/cmp_1/stop", post());
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const harness = () => run("harness", post({ sha256: SHA, timeoutMs: 60_000 }));
    const reader = (await harness()).body!.getReader();
    await reader.read();
    await reader.cancel();
    // Waiting for its exit failed; it may still run, so no second harness joins it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await harness()).status).toBe(409);
    fake.exitLost = false;
    await api("/v1/sandboxes/org_a/cmp_1/stop", post());
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    const next = await harness();
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  it("refuse a harness start without a well-formed digest and time limit", async () => {
    const fake = await attachFake("org_a", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    for (const body of [
      { sha256: SHA },
      { sha256: SHA.toUpperCase(), timeoutMs: 60_000 },
      { sha256: "a".repeat(63), timeoutMs: 60_000 },
      { sha256: SHA, timeoutMs: 60_000, argv: ["sh"] },
    ]) {
      expect((await run("harness", post(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.execs).toEqual([]);
  });
});

describe("approval grants", () => {
  const deployPolicy = { hosts: [{ host: "api.cloudflare.com", approval: "deploy" }] };
  const grant = (tenant: string, init: RequestInit) => api(`/v1/sandboxes/${tenant}/cmp_1/grants/deploy`, init);

  /** Starts `run`'s harness once no other runs there, and returns what ends it. */
  const startHarness = async (tenant: string, run: string): Promise<() => Promise<void>> => {
    const harness = await vi.waitFor(async () => {
      const response = await api(
        `/v1/sandboxes/${tenant}/cmp_1/runs/${run}/harness`,
        post({ sha256: "a".repeat(64), timeoutMs: 60_000 }),
      );
      if (response.status !== 200) throw new Error(await response.text());
      return response;
    });
    const { exec } = await lineReader(harness)();
    return async () => {
      await api(`/v1/sandboxes/${tenant}/cmp_1/exec/${exec}/stdin`, { method: "POST", body: "bye\n" });
    };
  };

  async function setUp() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const fakeA = await attachFake("org_a", "cmp_1");
    const fakeB = await attachFake("org_b", "cmp_1");
    const ends: (() => Promise<void>)[] = [];
    for (const tenant of ["org_a", "org_b"]) {
      await api(`/v1/sandboxes/${tenant}/cmp_1/outbound-policy`, json(deployPolicy));
      // As a run does: a fresh container, whatever an earlier test left running in this one.
      await api(`/v1/sandboxes/${tenant}/cmp_1/stop`, post());
      await api(`/v1/sandboxes/${tenant}/cmp_1/start`, post());
      ends.push(await startHarness(tenant, "run_1"));
    }
    return {
      endA: ends[0]!,
      fromA: () => viaIntercept("org_a:cmp_1", fakeA, "https://api.cloudflare.com/client/v4/accounts"),
      fromB: () => viaIntercept("org_b:cmp_1", fakeB, "https://api.cloudflare.com/client/v4/accounts"),
    };
  }

  const close = (approval: string) =>
    api(`/v1/sandboxes/org_a/cmp_1/grants/deploy?approval=${approval}`, { method: "DELETE" });

  it("open an approved action's hosts for that company and run until that approval closes them", async () => {
    const { fromA, fromB } = await setUp();
    expect((await fromA()).status).toBe(403);
    const opened = await grant("org_a", json({ approval: "apr_1", run: "run_1" }));
    expect(await opened.json()).toMatchObject({ action: "deploy", approval: "apr_1", run: "run_1" });
    expect((await fromA()).status).toBe(200);
    // Another company's sandbox stays closed.
    expect((await fromB()).status).toBe(403);
    // Only the approval that opened it closes it.
    expect((await close("apr_0")).status).toBe(204);
    expect((await fromA()).status).toBe(200);
    expect((await close("apr_1")).status).toBe(204);
    expect((await fromA()).status).toBe(403);
    expect((await api("/v1/sandboxes/org_a/cmp_1/grants/deploy", { method: "DELETE" })).status).toBe(400);
  });

  it("close when the grant expires, a new harness starts or the sandbox stops", async () => {
    const { fromA, endA } = await setUp();
    await grant("org_a", json({ approval: "apr_1", run: "run_1", ttlMs: 1_000 }));
    expect((await fromA()).status).toBe(200);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1_001);
    expect((await fromA()).status).toBe(403);
    vi.spyOn(Date, "now").mockReturnValue(now);

    // The next run's harness inherits nothing from the last run.
    await grant("org_a", json({ approval: "apr_2", run: "run_1" }));
    await endA();
    await startHarness("org_a", "run_2");
    expect((await fromA()).status).toBe(403);

    await grant("org_a", json({ approval: "apr_3", run: "run_2" }));
    await api("/v1/sandboxes/org_a/cmp_1/stop", post());
    await runInDurableObject(env.SANDBOX.getByName("org_a:cmp_1"), (sandbox: CompanySandbox) => {
      expect(sandbox.grantOpen("deploy")).toBe(false);
    });
  });

  it("refuse a grant for any run but the one whose harness is running", async () => {
    const { fromA, endA } = await setUp();
    expect((await grant("org_a", json({ approval: "apr_1", run: "run_9" }))).status).toBe(409);
    await endA();
    await startHarness("org_a", "run_2");
    expect((await grant("org_a", json({ approval: "apr_1", run: "run_1" }))).status).toBe(409);
    expect((await grant("org_a", json({ approval: "apr_1", run: "run_2" }))).status).toBe(200);
    // A stopped sandbox runs no harness, so nothing can be granted until the next one starts.
    await api("/v1/sandboxes/org_a/cmp_1/stop", post());
    expect((await grant("org_a", json({ approval: "apr_2", run: "run_2" }))).status).toBe(409);
    expect((await fromA()).status).toBe(403);
  });

  it("last at most half an hour, five minutes unless asked", async () => {
    await setUp();
    const opened = await (
      await grant("org_a", json({ approval: "apr_1", run: "run_1" }))
    ).json<{ expiresAt: number }>();
    expect(opened.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1_000);
    expect(opened.expiresAt - Date.now()).toBeGreaterThan(4 * 60 * 1_000);
    const long = json({ approval: "apr_1", run: "run_1", ttlMs: 31 * 60 * 1_000 });
    expect((await grant("org_a", long)).status).toBe(400);
  });

  it("refuse an action no host is held for, and malformed grants", async () => {
    await setUp();
    const unheld = await api(
      "/v1/sandboxes/org_a/cmp_1/grants/customer_send",
      json({ approval: "apr_1", run: "run_1" }),
    );
    expect(unheld.status).toBe(409);
    for (const body of [
      {},
      { approval: "apr_1" },
      { approval: "a b", run: "run_1" },
      { approval: "apr_1", run: "r|1" },
    ]) {
      expect((await grant("org_a", json(body))).status, JSON.stringify(body)).toBe(400);
    }
    const encoded = api("/v1/sandboxes/org_a/cmp_1/grants/de%20ploy", json({ approval: "apr_1", run: "run_1" }));
    expect((await encoded).status).toBe(400);
  });
});

describe("outbound, end to end through each company's handler", () => {
  it("adds company A's secret for A, and refuses the same host for company B", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = new Request(input);
      return Response.json({ authorization: request.headers.get("authorization") });
    });
    const fakeA = await attachFake("org_a", "cmp_1");
    const fakeB = await attachFake("org_b", "cmp_1");
    await api("/v1/sandboxes/org_a/cmp_1/outbound-policy", json(githubPolicy));
    await api("/v1/sandboxes/org_b/cmp_1/outbound-policy", json({ hosts: [{ host: "registry.npmjs.org" }] }));
    await api("/v1/sandboxes/org_a/cmp_1/start", post());
    await api("/v1/sandboxes/org_b/cmp_1/start", post());
    // What each container's HTTPS request would reach: the handler its own Durable Object installed.
    const fromA = (url: string, init?: RequestInit) => viaIntercept("org_a:cmp_1", fakeA, url, init);
    const fromB = (url: string, init?: RequestInit) => viaIntercept("org_b:cmp_1", fakeB, url, init);

    expect(await fromA("https://api.github.com/user")).toEqual({
      status: 200,
      body: '{"authorization":"Bearer [redacted]"}',
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(new Request(upstream.mock.calls[0]?.[0] as Request).headers.get("authorization")).toBe(`Bearer ${SECRET_A}`);

    upstream.mockClear();
    expect((await fromB("https://api.github.com/user")).status).toBe(403);
    expect((await fromB("https://gateway.test/v1/sandboxes/org_a/cmp_1/exec", { method: "POST" })).status).toBe(403);
    expect((await fromA("https://exfil.example.net/")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

// The handler binding belongs to the Durable Object that created it, so call it from there.
function viaIntercept(name: string, fake: FakeContainer, url: string, init?: RequestInit) {
  const binding = fake.intercepts.find((i) => i.kind === "https")?.binding;
  if (binding === undefined) throw new Error("no HTTPS intercept installed");
  return runInDurableObject(env.SANDBOX.getByName(name), async () => {
    const response = await binding.fetch(url, init);
    return { status: response.status, body: await response.text() };
  });
}

function lineReader(response: Response): () => Promise<any> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  return async () => {
    while (!buffered.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended");
      buffered += value;
    }
    const at = buffered.indexOf("\n");
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return JSON.parse(line);
  };
}

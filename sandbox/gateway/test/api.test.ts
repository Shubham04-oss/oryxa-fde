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

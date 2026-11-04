import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "./env.js";
import { type OutboundPolicy, ruleFor } from "./policy.js";
import { redactResponse } from "./redact.js";
import { companyScope, type CompanyScope, sandboxName } from "./scope.js";
import { resolverFor, type SecretResolver } from "./secrets.js";

/** Set by the company's Durable Object when it starts the container; the container cannot change them. */
export interface OutboundProps {
  readonly tenant: string;
  readonly company: string;
}

export interface OutboundDeps {
  policy(): Promise<OutboundPolicy>;
  secrets: SecretResolver;
  upstream(request: Request): Promise<Response>;
  log(entry: Record<string, unknown>): void;
}

/**
 * Every HTTP (port 80) and HTTPS (port 443) request from a company's sandbox arrives here; the container has no
 * other way out. Deny by default, allow only the company's hosts, and add secrets only here.
 */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const scope = companyScope(this.ctx.props.tenant, this.ctx.props.company);
    const sandbox = this.env.SANDBOX.getByName(sandboxName(scope));
    return handleOutbound(request, scope, {
      policy: () => sandbox.outboundPolicy(),
      secrets: resolverFor(this.env),
      upstream: (r) => fetch(r),
      log: (entry) => console.log(entry),
    });
  }
}

export async function handleOutbound(request: Request, scope: CompanyScope, deps: OutboundDeps): Promise<Response> {
  const url = new URL(request.url);
  const deny = (status: number, reason: string, message: string) => {
    deps.log({ event: "outbound.denied", tenant: scope.tenant, company: scope.company, host: url.hostname, reason });
    return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });
  };

  if (url.protocol !== "http:" && url.protocol !== "https:")
    return deny(403, "scheme", "only http and https leave the sandbox");
  // The container network passes only 80 and 443; refuse anything else that reaches here.
  if (url.port !== "") return deny(403, "port", "only ports 80 and 443 leave the sandbox");

  let policy: OutboundPolicy;
  try {
    policy = await deps.policy();
  } catch {
    return deny(403, "policy_unavailable", "outbound policy unavailable");
  }
  const rule = ruleFor(policy, url.hostname);
  if (rule === undefined) return deny(403, "not_allowed", `${url.hostname} is not on this company's allowlist`);

  const headers = new Headers(request.headers);
  headers.delete("host");
  const secrets: string[] = [];
  if (rule.inject.length > 0) {
    // The Worker fetches with the sandbox's scheme; a secret added to plain HTTP would cross the internet in clear.
    if (url.protocol !== "https:") return deny(403, "secret_over_http", "secrets are only added over https");
    // Redaction reads the response bytes, so the upstream must answer in an encoding it can read: ask for none,
    // and refuse a partial response that could cut a secret short of the redactor.
    headers.set("accept-encoding", "identity");
    headers.delete("range");
    for (const injection of rule.inject) {
      try {
        const value = await deps.secrets.resolve(scope, injection.secret);
        headers.set(injection.header, `${injection.prefix}${value}`);
        secrets.push(value);
      } catch {
        return deny(502, "secret_unavailable", "a credential for this host is unavailable");
      }
    }
  }

  let response: Response;
  try {
    // Manual redirects: following one here would skip the allowlist and could carry the secret to another host.
    response = await deps.upstream(
      new Request(url, { method: request.method, headers, body: request.body, redirect: "manual" }),
    );
  } catch {
    return deny(502, "upstream_unreachable", `${url.hostname} is unreachable`);
  }
  deps.log({
    event: "outbound.allowed",
    tenant: scope.tenant,
    company: scope.company,
    host: url.hostname,
    status: response.status,
    injected: rule.inject.length,
  });
  if (secrets.length === 0) return response;
  // The runtime decodes gzip and br before the redactor sees the body; any other encoding (deflate, zstd) would
  // reach the sandbox with the secret still inside, so refuse it.
  const encoding = (response.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (!READABLE_ENCODINGS.has(encoding)) {
    await response.body?.cancel();
    return deny(502, "unreadable_encoding", `${url.hostname} answered in an encoding the gateway cannot check`);
  }
  return redactResponse(response, secrets);
}

/** Response encodings the redactor can scan: none, or ones the Workers runtime decodes before the body is read. */
const READABLE_ENCODINGS = new Set(["", "identity", "gzip", "br"]);

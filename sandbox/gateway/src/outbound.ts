import { WorkerEntrypoint } from "cloudflare:workers";

import { AssumeRoleSource, type CredentialSource } from "./aws.js";
import type { Env } from "./env.js";
import { type OutboundPolicy, ruleFor } from "./policy.js";
import { redactResponse } from "./redact.js";
import { companyScope, type CompanyScope, sandboxName } from "./scope.js";
import { resolverFor, type SecretResolver } from "./secrets.js";
import { sign } from "./sigv4.js";

/** Largest request body the handler buffers to sign. */
export const MAX_SIGNED_BODY = 20 * 1024 * 1024;

/** Set by the company's Durable Object when it starts the container; the container cannot change them. */
export interface OutboundProps {
  readonly tenant: string;
  readonly company: string;
}

export interface OutboundDeps {
  policy(): Promise<OutboundPolicy>;
  /** Whether an FDE's approval currently opens the hosts held for `action`. */
  approved(action: string): Promise<boolean>;
  secrets: SecretResolver;
  /** Short-lived AWS credentials for hosts the policy signs for. */
  credentials: CredentialSource;
  upstream(request: Request): Promise<Response>;
  log(entry: Record<string, unknown>): void;
  now(): number;
}

// One per isolate, so cached credentials outlive a request.
let credentialSource: CredentialSource | undefined;

/**
 * Every HTTP (port 80) and HTTPS (port 443) request from a company's sandbox arrives here; the container has no
 * other way out. Deny by default, allow only the company's hosts, and add secrets only here.
 */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const scope = companyScope(this.ctx.props.tenant, this.ctx.props.company);
    const sandbox = this.env.SANDBOX.getByName(sandboxName(scope));
    const secrets = resolverFor(this.env);
    credentialSource ??= new AssumeRoleSource({ secrets, fetch: (r) => fetch(r), now: () => Date.now() });
    return handleOutbound(request, scope, {
      policy: () => sandbox.outboundPolicy(),
      approved: (action) => sandbox.grantOpen(action),
      secrets,
      credentials: credentialSource,
      upstream: (r) => fetch(r),
      log: (entry) => console.log(entry),
      now: () => Date.now(),
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
  if (rule.approval !== undefined) {
    // Checked before any secret is resolved; an unreadable grant counts as no approval.
    let approved = false;
    try {
      approved = await deps.approved(rule.approval);
    } catch {
      approved = false;
    }
    if (!approved) return deny(403, "approval_required", `${url.hostname} needs an engineer's approval first`);
  }

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

  let body: ReadableStream<Uint8Array> | Uint8Array | null = request.body;
  if (rule.sign !== undefined) {
    if (url.protocol !== "https:") return deny(403, "signing_over_http", "requests are only signed over https");
    const bytes = await readBounded(request, MAX_SIGNED_BODY);
    if (bytes === undefined) return deny(413, "body_too_large", "the request is too large to sign");
    let credentials;
    try {
      credentials = await deps.credentials.credentials(scope, rule.sign.credentials, rule.sign.region);
    } catch {
      return deny(502, "credentials_unavailable", "credentials for this host are unavailable");
    }
    // Whatever the sandbox sent to authenticate itself is dropped; only the gateway's signature goes out.
    for (const name of [...headers.keys()])
      if (name === "authorization" || name.startsWith("x-amz-")) headers.delete(name);
    const signedHeaders: [string, string][] = [["host", url.host]];
    const contentType = headers.get("content-type");
    if (contentType !== null) signedHeaders.push(["content-type", contentType]);
    const signed = await sign(
      { method: request.method, path: url.pathname, query: url.search.slice(1), headers: signedHeaders, body: bytes },
      { service: rule.sign.service, region: rule.sign.region, credentials, date: new Date(deps.now()) },
    );
    for (const [name, value] of signed.headers) headers.set(name, value);
    headers.set("accept-encoding", "identity");
    headers.delete("range");
    secrets.push(
      credentials.accessKeyId,
      ...(credentials.sessionToken === undefined ? [] : [credentials.sessionToken]),
    );
    body = bytes;
  }

  let response: Response;
  try {
    // Manual redirects: following one here would skip the allowlist and could carry the secret to another host.
    response = await deps.upstream(new Request(url, { method: request.method, headers, body, redirect: "manual" }));
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
    signed: rule.sign !== undefined,
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

/** The whole body, or undefined when it is larger than `max`; read without holding more than `max` bytes. */
async function readBounded(request: Request, max: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return undefined;
  if (request.body === null) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body as ReadableStream<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) return undefined;
    parts.push(chunk);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return all;
}

/** Response encodings the redactor can scan: none, or ones the Workers runtime decodes before the body is read. */
const READABLE_ENCODINGS = new Set(["", "identity", "gzip", "br"]);

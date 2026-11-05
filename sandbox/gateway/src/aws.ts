import { z } from "zod";

import type { SecretRef } from "./policy.js";
import type { CompanyScope } from "./scope.js";
import type { SecretResolver } from "./secrets.js";
import { type AwsCredentials, sign } from "./sigv4.js";

/** Fetch new credentials when this little is left of the cached ones. */
export const REFRESH_BEFORE_MS = 5 * 60 * 1_000;
/** Never sign with credentials this close to expiry; a request can take this long to reach AWS. */
export const MIN_VALIDITY_MS = 60 * 1_000;
const SESSION_SECONDS = 3600;
const INVOKE_ONLY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: "*" },
  ],
});

export class CredentialsUnavailable extends Error {
  override readonly name = "CredentialsUnavailable";
}

/**
 * What a company's credential reference resolves to. Either a role to assume, with a key that may only call
 * `sts:AssumeRole` for it, or temporary credentials as they are (dev); never a long-lived key that signs requests.
 */
const CredentialSecret = z.union([
  z.strictObject({
    roleArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/),
    accessKeyId: z.string().min(16).max(128),
    secretAccessKey: z.string().min(16).max(128),
  }),
  z.strictObject({
    accessKeyId: z.string().min(16).max(128),
    secretAccessKey: z.string().min(16).max(128),
    sessionToken: z.string().min(1).max(8192),
    expiration: z.iso.datetime(),
  }),
]);

/** Short-lived AWS credentials for one company, from the reference its outbound policy names. */
export interface CredentialSource {
  credentials(scope: CompanyScope, ref: SecretRef, region: string): Promise<AwsCredentials>;
}

export interface AssumeRoleDeps {
  secrets: SecretResolver;
  fetch(request: Request): Promise<Response>;
  now(): number;
}

/**
 * Assumes the company's role with STS for an hour, limited to invoking models, and reuses the result until it is
 * close to expiry. The session is named after the company, so CloudTrail shows whose run called Bedrock. A failure
 * keeps no stale credentials: past `MIN_VALIDITY_MS` of their expiry they are refused.
 */
export class AssumeRoleSource implements CredentialSource {
  readonly #cache = new Map<string, AwsCredentials>();

  constructor(private readonly deps: AssumeRoleDeps) {}

  async credentials(scope: CompanyScope, ref: SecretRef, region: string): Promise<AwsCredentials> {
    const key = `${scope.tenant}/${scope.company}/${ref}/${region}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined && this.#left(cached) > REFRESH_BEFORE_MS) return cached;
    try {
      const fresh = await this.#fetch(scope, ref, region);
      if (this.#left(fresh) <= MIN_VALIDITY_MS) throw new CredentialsUnavailable("credentials are about to expire");
      this.#cache.set(key, fresh);
      return fresh;
    } catch (cause) {
      // Still-valid credentials outlast a failed refresh; expired ones never do.
      if (cached !== undefined && this.#left(cached) > MIN_VALIDITY_MS) return cached;
      this.#cache.delete(key);
      throw cause instanceof CredentialsUnavailable ? cause : new CredentialsUnavailable("no credentials");
    }
  }

  #left(c: AwsCredentials): number {
    return c.expiration === undefined ? 0 : c.expiration.getTime() - this.deps.now();
  }

  async #fetch(scope: CompanyScope, ref: SecretRef, region: string): Promise<AwsCredentials> {
    const parsed = CredentialSecret.safeParse(JSON.parse(await this.deps.secrets.resolve(scope, ref)));
    if (!parsed.success) throw new CredentialsUnavailable("the credential secret is malformed");
    const secret = parsed.data;
    if (!("roleArn" in secret)) {
      return { ...secret, expiration: new Date(secret.expiration) };
    }
    const body = new URLSearchParams({
      Action: "AssumeRole",
      Version: "2011-06-15",
      RoleArn: secret.roleArn,
      RoleSessionName: `fde-${scope.tenant}-${scope.company}`.slice(0, 64),
      DurationSeconds: String(SESSION_SECONDS),
      Policy: INVOKE_ONLY,
    }).toString();
    const host = `sts.${region}.amazonaws.com`;
    const headers: [string, string][] = [
      ["host", host],
      ["content-type", "application/x-www-form-urlencoded; charset=utf-8"],
    ];
    const signed = await sign(
      { method: "POST", path: "/", query: "", headers, body: new TextEncoder().encode(body) },
      { service: "sts", region, credentials: secret, date: new Date(this.deps.now()) },
    );
    const response = await this.deps.fetch(
      new Request(`https://${host}/`, { method: "POST", headers: [...headers, ...signed.headers], body }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new CredentialsUnavailable(`STS answered ${response.status}`);
    }
    return parseAssumeRole(await response.text());
  }
}

/** The credentials in an `AssumeRoleResponse`. Only these four values are read. */
export function parseAssumeRole(xml: string): AwsCredentials {
  const tag = (name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1];
  const accessKeyId = tag("AccessKeyId");
  const secretAccessKey = tag("SecretAccessKey");
  const sessionToken = tag("SessionToken");
  const expiration = new Date(tag("Expiration") ?? "");
  if (!accessKeyId || !secretAccessKey || !sessionToken || Number.isNaN(expiration.getTime()))
    throw new CredentialsUnavailable("STS gave no credentials");
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

import { z } from "zod";

import type { SecretRef } from "./policy.js";
import type { CompanyScope } from "./scope.js";

export class SecretUnavailable extends Error {
  override readonly name = "SecretUnavailable";
  constructor(readonly ref: SecretRef) {
    super(`secret ${ref} is unavailable`);
  }
}

/** Turns a company's secret reference into its value, inside the Worker only. */
export interface SecretResolver {
  /** Throws `SecretUnavailable` when this company has no such secret; never falls back to another value. */
  resolve(scope: CompanyScope, ref: SecretRef): Promise<string>;
}

const DevSecrets = z.record(z.string(), z.record(z.string(), z.string().min(1)));

/**
 * Dev only. The Worker secret `DEV_SECRETS` holds `{"<tenant>/<company>": {"<ref>": "<value>"}}`, so even in
 * dev a reference resolves only inside the company that owns it.
 */
// ponytail: dev resolver only; production swaps in one that reads the references from AWS Secrets Manager.
export class DevSecretResolver implements SecretResolver {
  // Maps, so a reference such as "__proto__" can never resolve to something that is not a secret.
  readonly #byCompany: Map<string, Map<string, string>>;

  constructor(json: string | undefined) {
    this.#byCompany = parseDevSecrets(json);
  }

  async resolve(scope: CompanyScope, ref: SecretRef): Promise<string> {
    const value = this.#byCompany.get(`${scope.tenant}/${scope.company}`)?.get(ref);
    if (value === undefined) throw new SecretUnavailable(ref);
    return value;
  }
}

export function resolverFor(env: { DEV_SECRETS?: string }): SecretResolver {
  return new DevSecretResolver(env.DEV_SECRETS);
}

// Malformed config resolves nothing (fail closed). The error never echoes the input: it holds secret values.
function parseDevSecrets(json: string | undefined): Map<string, Map<string, string>> {
  if (json === undefined || json === "") return new Map();
  try {
    const parsed = DevSecrets.parse(JSON.parse(json));
    return new Map(Object.entries(parsed).map(([company, refs]) => [company, new Map(Object.entries(refs))]));
  } catch {
    console.error({ event: "secrets.dev_config_invalid" });
    return new Map();
  }
}

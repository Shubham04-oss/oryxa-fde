// Who may call this Worker, and for which conversation (ADR 0009, "Only fde-web reaches the object").
// fde-web presents a service token on every call, and a binding it signed after asking the API who the
// person is and, for a company's conversation, that they may read the company. The binding is short-lived
// and names one conversation, person and company; the object refuses any other (conversation.ts).

// A shorter configured secret is treated as unset, so a placeholder never opens the Worker.
const MIN_SECRET_LENGTH = 32;
/** The longest a binding may live: fde-web signs one per request, valid for a minute. */
export const MAX_BINDING_SECONDS = 120;
const encoder = new TextEncoder();

/** The platform's id rule. Ids reach Durable Object names and SQL parameters, so each one is checked. */
const ID = /^[A-Za-z0-9_-]+$/;
export const validId = (value: unknown, max = 128): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && ID.test(value);

/** True only for `Authorization: Bearer <token>`; fails closed when the token is unset or weak. */
export async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (token === undefined || token.length < MIN_SECRET_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // Equal-length digests, so the comparison is constant-time whatever was presented.
  const [a, b] = await Promise.all([digest(presented), digest(token)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/** Whom a conversation belongs to: one person in one organisation, and one company or none (the home one). */
export interface Binding {
  readonly conversation: string;
  readonly tenant: string;
  readonly person: string;
  /** The company the conversation is bound to; null for the home conversation, which spans the list. */
  readonly company: string | null;
}

/**
 * The binding in `token` (`<payload>.<signature>`, base64url, HMAC-SHA256 over the payload's text) when it is
 * signed with `key`, has not expired, lives at most two minutes and names `conversation`; otherwise null.
 * The payload is `{"v":1,"conv":…,"tenant":…,"person":…,"company":…|null,"exp":<unix seconds>}`.
 */
export async function verifyBinding(
  token: string | null,
  key: string | undefined,
  conversation: string,
  now = Date.now(),
): Promise<Binding | null> {
  if (token === null || key === undefined || key.length < MIN_SECRET_LENGTH || token.length > 2048) return null;
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) return null;
  const sig = fromBase64Url(signature);
  if (sig === null) return null;
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  if (!(await crypto.subtle.verify("HMAC", hmac, sig, encoder.encode(payload)))) return null;
  const bytes = fromBase64Url(payload);
  if (bytes === null) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { v, conv, tenant, person, company, exp } = claims as Record<string, unknown>;
  const seconds = Math.floor(now / 1000);
  if (v !== 1 || !Number.isSafeInteger(exp)) return null;
  if ((exp as number) <= seconds || (exp as number) > seconds + MAX_BINDING_SECONDS) return null;
  if (!validId(conv) || conv !== conversation || !validId(tenant, 64) || !validId(person, 64)) return null;
  if (company !== null && !validId(company)) return null;
  return Object.freeze({ conversation, tenant, person, company });
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

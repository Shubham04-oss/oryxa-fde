// The API's sign-in routes (crates/oryxa-fde-api/src/signin.rs), answered on invented accounts with
// the API's rules and exact answers, so the screens' tests prove the contract: the same checks in the
// same order, one answer for a wrong password and an unknown address, limits counted on every
// attempt with `Retry-After`, a code asked for that answers alike for every address, and a pending
// step that the API would keep in its sealed cookie. The routes still to come (`LATER` in
// sign-in-api.ts) are answered on their assumed contract.
// Dev and test only, like the rest of the mock.

/** Every sample account's password. Invented, and only ever accepted by this mock. */
export const SAMPLE_PASSWORD = "sample-password"
/** The one code the mock accepts. */
export const SAMPLE_CODE = "123456"
/** Tokens in the sample invite and reset links; anything else has expired. */
export const SAMPLE_INVITE = "invite-sample"
export const SAMPLE_RESET = "reset-sample"

/**
 * The API's limits (signin.rs), in fixed windows: password attempts and code guesses per address and
 * per client, and codes emailed (a sign-in code, or a verification code sent again) per address and
 * per client.
 */
export const LIMITS = {
  address: 10,
  client: 30,
  windowSeconds: 300,
  sendAddress: 3,
  sendClient: 10,
  sendWindowSeconds: 900,
}
/** How long the API keeps a pending step. */
const PENDING_SECONDS = 600

type Outcome =
  "done" | "verify_email" | "choose_organisation" | "no_organisation" | "sign_in_unsupported"

/**
 * What each sample address leads to after a right password or code. Any other address is unknown.
 * The `unverified` ones go on to their own outcome once the email is confirmed (`AFTER_VERIFY`).
 */
export const SAMPLE_ACCOUNTS = {
  "riya@example.com": "done",
  "two-orgs@example.com": "choose_organisation",
  "unverified@example.com": "verify_email",
  "unverified-two-orgs@example.com": "verify_email",
  "unverified-mfa@example.com": "verify_email",
  "no-org@example.com": "no_organisation",
  "mfa@example.com": "sign_in_unsupported",
} as const satisfies Record<string, Outcome>
type Account = keyof typeof SAMPLE_ACCOUNTS

/** Where an account goes once its email is confirmed, when that is not `done`. */
const AFTER_VERIFY: Partial<Record<Account, Outcome>> = {
  "unverified-two-orgs@example.com": "choose_organisation",
  "unverified-mfa@example.com": "sign_in_unsupported",
}

/**
 * An address whose limit is already reached: every attempt at it answers 429 before anything else
 * is looked at, whatever the password or code, as the API counts before it asks WorkOS.
 */
export const LOCKED_ADDRESS = "locked@example.com"

export const SAMPLE_ORGANISATIONS = [
  { id: "org_sample_northwind", name: "Northwind Field Engineering" },
  { id: "org_sample_harbor", name: "Harbor Labs" },
]

/** The mock's view of the API's sealed pending cookie: never the password or the address. */
type Pending = {
  step: "verify_email" | "choose_organisation"
  /** The account the step continues, standing in for WorkOS's pending token. */
  account: Account
  organisations: string[]
  returnTo: string
  expires: number
}
let pending: Pending | null = null
/** Fixed windows by bucket, as the API's `sign_in_limits` table. */
let buckets = new Map<string, { start: number; count: number }>()

export function resetMockSignIn() {
  pending = null
  buckets = new Map()
}

/**
 * Dev and test only: a sign-in waiting to verify its email, as a password sign-in for
 * unverified@example.com leaves it, so the step can be opened straight from `/sign-in?step=…`.
 */
export function mockPendingStep(step: "verify_email") {
  pending = {
    step,
    account: "unverified@example.com",
    organisations: [],
    returnTo: "/",
    expires: Date.now() + PENDING_SECONDS * 1000,
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const refuse = (status: number, error: string, headers?: HeadersInit) =>
  Response.json({ error }, { status, headers })
/** A refusal that also ends the pending step, as the API clears its cookie. */
const ending = (status: number, error: string) => {
  pending = null
  return refuse(status, error)
}
const accepted = () => new Response(null, { status: 202 })
const limited = (seconds: number) =>
  refuse(429, "too_many_attempts", { "Retry-After": String(Math.max(1, Math.ceil(seconds))) })

/** `EmailAddress::new` in oryxa-fde-store. */
function emailOk(value: string): boolean {
  const v = value.trim()
  const at = v.indexOf("@")
  if (at < 0) return false
  const local = v.slice(0, at)
  const domain = v.slice(at + 1)
  return (
    v.length <= 254 &&
    /^[\x21-\x7e]+$/.test(v) &&
    !/[<>,;"()\\[\]]/.test(v) &&
    local.length >= 1 &&
    local.length <= 64 &&
    !domain.includes("@") &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".") &&
    !domain.includes("..")
  )
}

/** `safe_return_to` in the API's session.rs. */
function returnToOk(raw: string): boolean {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return false
  if (new TextEncoder().encode(raw).length > 2048 || /[\s\p{Cc}]/u.test(raw)) return false
  try {
    return new URL(raw, "https://fde.invalid/").origin === "https://fde.invalid"
  } catch {
    return false
  }
}

/**
 * The body, when it is a JSON object with exactly the string fields the route takes (serde's
 * `deny_unknown_fields`); `optional` fields may also be missing or null.
 */
async function bodyOf(
  request: Request,
  required: string[],
  optional: string[] = [],
): Promise<Record<string, string | undefined> | null> {
  const body: unknown = await request.json().catch(() => null)
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null
  const fields = body as Record<string, unknown>
  if (Object.keys(fields).some((k) => !required.includes(k) && !optional.includes(k))) return null
  if (required.some((k) => typeof fields[k] !== "string")) return null
  if (optional.some((k) => fields[k] != null && typeof fields[k] !== "string")) return null
  return Object.fromEntries(
    [...required, ...optional].map((k) => [k, (fields[k] as string | null) ?? undefined]),
  )
}

type Kind = "password" | "code" | "send" | "step"

/** Each kind's limits per address and per client, and its window in seconds. */
const KINDS: Record<Kind, { address: number; client: number; window: number }> = {
  password: { address: LIMITS.address, client: LIMITS.client, window: LIMITS.windowSeconds },
  code: { address: LIMITS.address, client: LIMITS.client, window: LIMITS.windowSeconds },
  send: {
    address: LIMITS.sendAddress,
    client: LIMITS.sendClient,
    window: LIMITS.sendWindowSeconds,
  },
  // Organisation choices are counted per client only.
  step: { address: Infinity, client: LIMITS.client, window: LIMITS.windowSeconds },
}

/**
 * Counts an attempt of `kind` from this client and, when there is one, at `address` (lowercased), as
 * the API does before WorkOS is asked, and the 429 when either is over its limit, with the seconds
 * left in its window. `LOCKED_ADDRESS` is over its limit already.
 */
function count(kind: Kind, address: string | null): Response | null {
  const { window, ...limit } = KINDS[kind]
  if (address === LOCKED_ADDRESS) return limited(window)
  const now = Date.now()
  let wait = 0
  const hits: Array<[bucket: string, max: number]> = [[`${kind}_client`, limit.client]]
  if (address !== null) hits.push([`${kind}_address:${address}`, limit.address])
  for (const [bucket, max] of hits) {
    let b = buckets.get(bucket)
    if (!b || now - b.start >= window * 1000) b = { start: now, count: 0 }
    b.count += 1
    buckets.set(bucket, b)
    if (b.count > max) wait = Math.max(wait, b.start + window * 1000 - now)
  }
  return wait === 0 ? null : limited(wait / 1000)
}

/** The API's `code_of`: 1 to 16 ASCII letters or digits, spaces around it aside, or null. */
function codeOf(raw: string): string | null {
  const code = raw.trim()
  return /^[A-Za-z0-9]{1,16}$/.test(code) ? code : null
}

/** An address as the API keys its limits: lowercased. */
const keyOf = (email: string) => email.trim().toLowerCase()

/** The account at `email`, or null for an unknown address. */
const accountOf = (email: string): Account | null => {
  const key = keyOf(email)
  return Object.hasOwn(SAMPLE_ACCOUNTS, key) ? (key as Account) : null
}

/** The API's `conclude`: where an account goes once its password or code was right. */
function conclude(
  account: Account,
  returnTo: string,
  setSession: (on: boolean) => void,
  outcome: Outcome = SAMPLE_ACCOUNTS[account],
): Response {
  const expires = Date.now() + PENDING_SECONDS * 1000
  switch (outcome) {
    case "done":
      pending = null
      setSession(true)
      return json({ next: "done", return_to: returnTo })
    case "verify_email":
      pending = { step: "verify_email", account, organisations: [], returnTo, expires }
      return json({ next: "verify_email" })
    case "choose_organisation":
      pending = {
        step: "choose_organisation",
        account,
        organisations: SAMPLE_ORGANISATIONS.map((o) => o.id),
        returnTo,
        expires,
      }
      return json({ next: "choose_organisation", organisations: SAMPLE_ORGANISATIONS })
    case "no_organisation":
    case "sign_in_unsupported":
      return ending(403, outcome)
  }
}

/** The pending step, when it is at `step` and has not lapsed. */
const pendingAt = (step: Pending["step"]) =>
  pending?.step === step && pending.expires > Date.now() ? pending : null

/** Answers `/auth/*` sign-in routes, or null for anything else. */
export async function signInRoutes(
  pathname: string,
  method: string,
  request: Request,
  setSession: (on: boolean) => void,
): Promise<Response | null> {
  if (!pathname.startsWith("/auth/") || method !== "POST") return null
  const route = pathname.slice("/auth/".length)
  // The API also checks `Origin`, which a request made in this page does not carry.
  const sameSite = request.headers.get("X-Oryxa-Request") === "1"

  switch (route) {
    case "sign-in/password": {
      if (!sameSite) return refuse(403, "csrf")
      const body = await bodyOf(request, ["email", "password"], ["return_to"])
      if (!body) return refuse(400, "invalid_body")
      const email = body.email!
      const password = body.password!
      if (!emailOk(email)) return refuse(400, "invalid_email")
      if (password === "" || new TextEncoder().encode(password).length > 1024)
        return refuse(400, "invalid_password")
      const returnTo = body.return_to ?? "/"
      if (!returnToOk(returnTo)) return refuse(400, "invalid_return_to")
      const over = count("password", keyOf(email))
      if (over) return over
      const account = accountOf(email)
      // An unknown address and a wrong password answer alike, and end any earlier pending step.
      if (!account || password !== SAMPLE_PASSWORD) return ending(401, "invalid_credentials")
      return conclude(account, returnTo, setSession)
    }
    case "sign-in/verify-email": {
      if (!sameSite) return refuse(403, "csrf")
      const body = await bodyOf(request, ["code"])
      if (!body) return refuse(400, "invalid_body")
      const code = codeOf(body.code!)
      if (!code) return refuse(400, "invalid_code")
      const at = pendingAt("verify_email")
      if (!at) return ending(400, "invalid_sign_in")
      const over = count("code", at.account)
      if (over) return over
      // A wrong or expired code keeps the step open.
      if (code !== SAMPLE_CODE) return refuse(401, "invalid_code")
      return conclude(at.account, at.returnTo, setSession, AFTER_VERIFY[at.account] ?? "done")
    }
    case "sign-in/organisation": {
      if (!sameSite) return refuse(403, "csrf")
      const body = await bodyOf(request, ["organisation"])
      if (!body) return refuse(400, "invalid_body")
      const at = pendingAt("choose_organisation")
      if (!at) return ending(400, "invalid_sign_in")
      if (!at.organisations.includes(body.organisation!)) return refuse(400, "invalid_organisation")
      const over = count("step", null)
      if (over) return over
      return conclude(at.account, at.returnTo, setSession, "done")
    }
    case "sign-in/code": {
      if (!sameSite) return refuse(403, "csrf")
      const body = await bodyOf(request, ["email"])
      if (!body) return refuse(400, "invalid_body")
      const email = body.email!
      if (!emailOk(email)) return refuse(400, "invalid_email")
      const over = count("send", keyOf(email))
      if (over) return over
      // Sent or not, whether the address has an account: the answer is the same.
      return json({ next: "enter_code" })
    }
    case "sign-in/code/verify": {
      if (!sameSite) return refuse(403, "csrf")
      const body = await bodyOf(request, ["email", "code"], ["return_to"])
      if (!body) return refuse(400, "invalid_body")
      const email = body.email!
      if (!emailOk(email)) return refuse(400, "invalid_email")
      const code = codeOf(body.code!)
      if (!code) return refuse(400, "invalid_code")
      const returnTo = body.return_to ?? "/"
      if (!returnToOk(returnTo)) return refuse(400, "invalid_return_to")
      const over = count("code", keyOf(email))
      if (over) return over
      const account = accountOf(email)
      // A wrong code and an address with no account answer alike, and end any earlier pending step.
      if (!account || code !== SAMPLE_CODE) return ending(401, "invalid_code")
      return conclude(account, returnTo, setSession)
    }
    case "sign-in/verify-email/resend": {
      // The route reads no body.
      if (!sameSite) return refuse(403, "csrf")
      const at = pendingAt("verify_email")
      if (!at) return ending(400, "invalid_sign_in")
      const over = count("send", at.account)
      if (over) return over
      // The step stays as it is.
      return json({ next: "verify_email" })
    }
  }

  // The routes still to come, on their assumed contract (sign-in-api.ts).
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const text = (name: string) => {
    const value = body[name]
    return typeof value === "string" ? value : ""
  }
  switch (route) {
    case "password/forgot": {
      const email = text("email")
      if (!emailOk(email)) return refuse(400, "invalid_email")
      if (keyOf(email) === LOCKED_ADDRESS) return limited(LIMITS.windowSeconds)
      // Sent, or not: the answer is the same.
      return accepted()
    }
    case "invite/lookup":
      return text("token") === SAMPLE_INVITE
        ? json({ email: "new-colleague@example.com" })
        : refuse(410, "link_expired")
    case "invite": {
      if (text("token") !== SAMPLE_INVITE) return refuse(410, "link_expired")
      const name = text("name").trim()
      if (name.length === 0 || name.length > 200 || /[\n\r]/.test(name))
        return refuse(400, "invalid_name")
      if (text("password").length < 10) return refuse(422, "password_rejected")
      setSession(true)
      return json({ next: "done", return_to: text("return_to") || "/" })
    }
    case "password/reset":
      if (text("token") !== SAMPLE_RESET) return refuse(410, "link_expired")
      if (text("password").length < 10) return refuse(422, "password_rejected")
      return new Response(null, { status: 204 })
  }
  return null
}

// Dev only: `globalThis.__fdeMockPendingStep`, set before the app loads (`pnpm shots` does), starts
// the mock with a sign-in waiting at that step.
const preset = (globalThis as Record<string, unknown>).__fdeMockPendingStep
if (preset === "verify_email") mockPendingStep(preset)

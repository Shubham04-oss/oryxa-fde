// The sign-in routes the web assumes of the API (src/lib/api/sign-in-api.ts, issue #204), answered
// on invented accounts with the API's rules: one answer for a wrong password and an unknown address,
// the same "sent" whatever the address, a limit on attempts. Dev and test only, like the rest of the mock.

/** Every sample account's password. Invented, and only ever accepted by this mock. */
export const SAMPLE_PASSWORD = "sample-password"
/** The one code the mock accepts; `EXPIRED_CODE` answers as an expired one. */
export const SAMPLE_CODE = "123456"
export const EXPIRED_CODE = "000000"
/** Tokens in the sample invite and reset links; anything else has expired. */
export const SAMPLE_INVITE = "invite-sample"
export const SAMPLE_RESET = "reset-sample"
/** Wrong guesses for one address before the mock answers `too_many_attempts`. */
export const MAX_ATTEMPTS = 5

/** What each sample address leads to after a right password or code. Any other address is unknown. */
export const SAMPLE_ACCOUNTS = {
  "riya@example.com": "signed_in",
  "two-orgs@example.com": "choose_organisation",
  "unverified@example.com": "verify_email",
  "no-org@example.com": "no_organisation",
  "locked@example.com": "too_many_attempts",
  "mfa@example.com": "mfa_required",
  "sso@example.com": "sso_required",
} as const
type Account = keyof typeof SAMPLE_ACCOUNTS

const ORGANISATIONS = [
  { id: "org_sample_northwind", name: "Northwind Field Engineering" },
  { id: "org_sample_harbor", name: "Harbor Labs" },
]

/** The mock's view of the API's sealed pending-step cookie and its counters. */
type Pending = { step: "verify_email" | "choose_organisation"; after: Account } | null
let pending: Pending = null
let failures = new Map<string, number>()

export function resetMockSignIn() {
  pending = null
  failures = new Map()
}

/**
 * Dev and test only: a sign-in waiting at `step`, as Google's callback leaves it, so the step can be
 * opened straight from `/sign-in?step=…`.
 */
export function mockPendingStep(step: "verify_email" | "choose_organisation") {
  pending = {
    step,
    after: step === "verify_email" ? "unverified@example.com" : "two-orgs@example.com",
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const refuse = (status: number, error: string, headers?: HeadersInit) =>
  Response.json({ error }, { status, headers })
const accepted = () => new Response(null, { status: 202 })

const isEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
/** The sample account at `email`, or null for an unknown address. */
const accountOf = (email: string): Account | null => {
  const key = email.toLowerCase()
  return key in SAMPLE_ACCOUNTS ? (key as Account) : null
}

/** Where an account goes once its password or code was right. */
function after(email: Account, setSession: (on: boolean) => void): Response {
  const outcome = SAMPLE_ACCOUNTS[email]
  if (outcome === "signed_in") {
    pending = null
    setSession(true)
    return json({ next: "signed_in" })
  }
  if (outcome === "no_organisation") {
    pending = null
    return json({ next: "no_organisation" })
  }
  if (outcome === "verify_email") {
    pending = { step: "verify_email", after: email }
    return json({ next: "verify_email" })
  }
  if (outcome === "choose_organisation") {
    pending = { step: "choose_organisation", after: email }
    return json({ next: "choose_organisation" })
  }
  if (outcome === "mfa_required" || outcome === "sso_required") {
    pending = null
    return json({ next: "cannot_finish", reason: outcome })
  }
  return refuse(429, "too_many_attempts", { "Retry-After": "300" })
}

/** A wrong guess for `email`, counted whether or not the address has an account. */
function wrong(email: string, code: string) {
  const key = email.toLowerCase()
  const count = (failures.get(key) ?? 0) + 1
  failures.set(key, count)
  return count > MAX_ATTEMPTS
    ? refuse(429, "too_many_attempts", { "Retry-After": "300" })
    : refuse(401, code)
}
const limited = (email: string) =>
  email.toLowerCase() === "locked@example.com" ||
  (failures.get(email.toLowerCase()) ?? 0) >= MAX_ATTEMPTS

/** Answers `/auth/*` sign-in routes, or null for anything else. */
export async function signInRoutes(
  pathname: string,
  method: string,
  request: Request,
  setSession: (on: boolean) => void,
): Promise<Response | null> {
  if (!pathname.startsWith("/auth/")) return null
  if (method === "GET" && pathname === "/auth/pending") {
    if (pending?.step === "verify_email") return json({ step: "verify_email" })
    if (pending?.step === "choose_organisation")
      return json({ step: "choose_organisation", organisations: ORGANISATIONS })
    return refuse(410, "step_expired")
  }
  if (method !== "POST") return null
  const route = pathname.slice("/auth/".length)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const text = (name: string) => {
    const value = body[name]
    return typeof value === "string" ? value : ""
  }

  switch (route) {
    case "password": {
      const email = text("email")
      if (!isEmail(email)) return refuse(400, "invalid_email")
      if (limited(email)) return refuse(429, "too_many_attempts", { "Retry-After": "300" })
      const account = accountOf(email)
      if (!account || text("password") !== SAMPLE_PASSWORD)
        return wrong(email, "invalid_credentials")
      return after(account, setSession)
    }
    case "code":
    case "password/forgot": {
      const email = text("email")
      if (!isEmail(email)) return refuse(400, "invalid_email")
      if (email.toLowerCase() === "locked@example.com")
        return refuse(429, "too_many_attempts", { "Retry-After": "300" })
      // Sent, or not: the answer is the same.
      return accepted()
    }
    case "code/verify": {
      const email = text("email")
      if (!isEmail(email)) return refuse(400, "invalid_email")
      if (limited(email)) return refuse(429, "too_many_attempts", { "Retry-After": "300" })
      if (text("code") === EXPIRED_CODE) return refuse(410, "code_expired")
      const account = accountOf(email)
      if (!account || text("code") !== SAMPLE_CODE) return wrong(email, "invalid_code")
      return after(account, setSession)
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
      return json({ next: "signed_in" })
    }
    case "verify-email": {
      if (pending?.step !== "verify_email") return refuse(410, "step_expired")
      if (text("code") === EXPIRED_CODE) return refuse(410, "code_expired")
      if (text("code") !== SAMPLE_CODE) return wrong(pending.after, "invalid_code")
      pending = null
      setSession(true)
      return json({ next: "signed_in" })
    }
    case "verify-email/resend":
      return pending?.step === "verify_email" ? accepted() : refuse(410, "step_expired")
    case "organisation": {
      if (pending?.step !== "choose_organisation") return refuse(410, "step_expired")
      if (!ORGANISATIONS.some((o) => o.id === text("organisation")))
        return refuse(410, "step_expired")
      pending = null
      setSession(true)
      return json({ next: "signed_in" })
    }
    case "password/reset":
      if (text("token") !== SAMPLE_RESET) return refuse(410, "link_expired")
      if (text("password").length < 10) return refuse(422, "password_rejected")
      return new Response(null, { status: 204 })
  }
  return null
}

// Dev only: `globalThis.__fdeMockPendingStep`, set before the app loads (`pnpm shots` does), starts
// the mock with a sign-in waiting at that step, as if Google's callback had just sent the browser there.
const preset = (globalThis as Record<string, unknown>).__fdeMockPendingStep
if (preset === "verify_email" || preset === "choose_organisation") mockPendingStep(preset)

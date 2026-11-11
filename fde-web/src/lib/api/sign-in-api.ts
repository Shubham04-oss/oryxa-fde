// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ASSUMED CONTRACT, HAND-WRITTEN. The API's sign-in routes (issue #204) do not exist yet, so the
// calls below are what this app expects of them, built against the dev mock (src/dev/mock-sign-in.ts).
// When the API's openapi.json has them, `pnpm api:generate` and replace this module's `fetch` calls
// with the generated client in client.ts; the screens use only `signInApi` and `SignInError`.
// The full contract is in the PR for issue #205 and summed up here.
//
//   POST /auth/password            { email, password }        → 200 Next
//   POST /auth/code                { email }                  → 202, the same whatever the address
//   POST /auth/code/verify         { email, code }            → 200 Next
//   POST /auth/invite/lookup       { token }                  → 200 { email } (the invited address)
//   POST /auth/invite              { token, name, password }  → 200 Next (address from the invite)
//   GET  /auth/pending                                        → 200 Pending, or 410 step_expired
//   POST /auth/verify-email        { code }                   → 200 Next (pending step in a cookie)
//   POST /auth/verify-email/resend {}                         → 202
//   POST /auth/organisation        { organisation }           → 200 Next (one of those offered)
//   POST /auth/password/forgot     { email }                  → 202, the same whatever the address
//   POST /auth/password/reset      { token, password }        → 204
//   GET  /auth/google?return_to=   → 302 straight to Google, back through /auth/callback, which
//        redirects to return_to when signed in, or to /sign-in with `return_to` and one of
//        `step=verify-email`, `step=organisation` (pending cookie set), `error=no_organisation`,
//        `error=mfa_required`, `error=sso_required` (no session)
//
//   Next = { next: "signed_in" }                     session cookie set, pending cookie cleared
//        | { next: "verify_email" }                  a code was sent; pending cookie set
//        | { next: "choose_organisation" }           pending cookie set; GET /auth/pending lists them
//        | { next: "no_organisation" }               no session; the person needs an invite
//        | { next: "cannot_finish", reason: "mfa_required" | "sso_required" | "other" }  no session
//   Pending = { step: "verify_email" } | { step: "choose_organisation", organisations: [{ id, name }] }
//   A refusal is { error: code } with one of SIGN_IN_TEXT's codes, and `Retry-After` (seconds) on 429.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { z } from "zod"
import { HEADERS, safeReturnTo, selected } from "./client"
import type { Transport } from "./client"

/**
 * Whether this build shows our own sign-in screens (ADR 0007) instead of today's redirect to
 * `/auth/login`. Off unless the build sets `VITE_FDE_OWN_SIGN_IN=1`; it stays off until the API's
 * sign-in routes are deployed.
 */
export function ownSignInOn(env: { VITE_FDE_OWN_SIGN_IN?: string }) {
  return env.VITE_FDE_OWN_SIGN_IN === "1"
}

// Read by name, so Vite writes the build's value in its place.
export const ownSignIn = ownSignInOn({
  VITE_FDE_OWN_SIGN_IN: import.meta.env.VITE_FDE_OWN_SIGN_IN as string | undefined,
})

/** An organisation to choose. Ids are opaque to this app; a name is shown as text. */
export const Organisation = z.object({
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(200),
})
export type Organisation = z.infer<typeof Organisation>

/** Why a sign-in our screens cannot finish yet ended, with no session. Anything new reads as `other`. */
export const CannotFinish = z.enum(["mfa_required", "sso_required", "other"]).catch("other")
export type CannotFinish = z.infer<typeof CannotFinish>

/** What a sign-in step leads to. */
export const Next = z.discriminatedUnion("next", [
  z.object({ next: z.literal("signed_in") }),
  z.object({ next: z.literal("verify_email") }),
  z.object({ next: z.literal("choose_organisation") }),
  z.object({ next: z.literal("no_organisation") }),
  z.object({ next: z.literal("cannot_finish"), reason: CannotFinish }),
])
export type Next = z.infer<typeof Next>

/** The step a sign-in waits at, from its pending cookie: how Google's callback lands on a step too. */
export const Pending = z.discriminatedUnion("step", [
  z.object({ step: z.literal("verify_email") }),
  z.object({ step: z.literal("choose_organisation"), organisations: z.array(Organisation).min(1) }),
])
export type Pending = z.infer<typeof Pending>

const InviteOut = z.object({ email: z.string().min(3).max(320) })

/**
 * Words for each refusal, chosen here and never taken from the answer, so no answer can say
 * whether an address has an account. A wrong password and an unknown address are one code.
 */
export const SIGN_IN_TEXT = {
  invalid_credentials:
    "That email and password do not match an account. Check both and try again, or reset your password.",
  invalid_email: "Enter an email address like name@example.com.",
  invalid_code: "That code is not right. Check the newest email and try again.",
  code_expired: "That code has expired. Send a new one and use it within a few minutes.",
  step_expired: "This sign-in took too long and has expired. Start again.",
  link_expired: "This link has expired or has already been used.",
  password_rejected:
    "That password was refused. Choose a longer one that is not used on other sites.",
  invalid_name: "Your name is one line, 1 to 200 characters.",
  too_many_attempts: "Too many attempts. Wait a few minutes, then try again.",
  unavailable: "Sign-in is briefly unavailable. Try again in a minute.",
  offline: "Could not reach the workspace. Check your connection and try again.",
  failed: "Could not sign you in. Try again.",
} as const
export type SignInCode = keyof typeof SIGN_IN_TEXT

/** A refused sign-in step. `retryAfter` is in seconds, when the API said. */
export class SignInError extends Error {
  constructor(
    readonly code: SignInCode,
    readonly retryAfter?: number,
  ) {
    super(SIGN_IN_TEXT[code])
    this.name = "SignInError"
  }
}

const KNOWN = new Set(Object.keys(SIGN_IN_TEXT))
const ErrorBody = z.object({ error: z.string() })

/** The refusal in `response`, as one of our codes; anything unknown is `failed`. */
async function refusal(response: Response): Promise<SignInError> {
  const parsed = ErrorBody.safeParse(await response.json().catch(() => null))
  const said = parsed.success && KNOWN.has(parsed.data.error) ? parsed.data.error : null
  const code = (said ?? (response.status >= 500 ? "unavailable" : "failed")) as SignInCode
  const wait = Number(response.headers.get("retry-after"))
  return new SignInError(code, Number.isFinite(wait) && wait > 0 ? wait : undefined)
}

/** The sign-in calls over `transport`. Tests pass their own. */
export function signInOver(transport: () => Promise<Transport>) {
  /** POSTs `body` as JSON. The body is never logged or kept; a failure throws a `SignInError`. */
  async function post(path: string, body: Record<string, string>): Promise<Response> {
    const t = await transport()
    let response: Response
    try {
      response = await t.fetch(
        new Request(`${globalThis.location.origin}${path}`, {
          method: "POST",
          headers: { ...HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "same-origin",
        }),
      )
    } catch {
      // The browser's own error may name the request; it is not passed on.
      throw new SignInError("offline")
    }
    if (!response.ok) throw await refusal(response)
    return response
  }

  async function next(path: string, body: Record<string, string>): Promise<Next> {
    const parsed = Next.safeParse(await (await post(path, body)).json().catch(() => null))
    if (!parsed.success) throw new SignInError("failed")
    return parsed.data
  }

  return {
    withPassword: (email: string, password: string) => next("/auth/password", { email, password }),
    requestCode: async (email: string) => void (await post("/auth/code", { email })),
    withCode: (email: string, code: string) => next("/auth/code/verify", { email, code }),
    async invite(token: string): Promise<{ email: string }> {
      const parsed = InviteOut.safeParse(
        await (await post("/auth/invite/lookup", { token })).json().catch(() => null),
      )
      if (!parsed.success) throw new SignInError("failed")
      return parsed.data
    },
    acceptInvite: (token: string, name: string, password: string) =>
      next("/auth/invite", { token, name, password }),
    async pending(): Promise<Pending> {
      const t = await transport()
      let response: Response
      try {
        response = await t.fetch(
          new Request(`${globalThis.location.origin}/auth/pending`, {
            headers: HEADERS,
            credentials: "same-origin",
          }),
        )
      } catch {
        throw new SignInError("offline")
      }
      if (!response.ok) throw await refusal(response)
      const parsed = Pending.safeParse(await response.json().catch(() => null))
      if (!parsed.success) throw new SignInError("failed")
      return parsed.data
    },
    verifyEmail: (code: string) => next("/auth/verify-email", { code }),
    resendVerification: async () => void (await post("/auth/verify-email/resend", {})),
    chooseOrganisation: (organisation: string) => next("/auth/organisation", { organisation }),
    forgotPassword: async (email: string) => void (await post("/auth/password/forgot", { email })),
    resetPassword: async (token: string, password: string) =>
      void (await post("/auth/password/reset", { token, password })),
    /** Leaves for Google through the API, to come back to `returnTo`. Settles only on the mock. */
    withGoogle: async (returnTo: string) =>
      (await transport()).leave(
        `/auth/google?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`,
      ),
  }
}

export type SignInApi = ReturnType<typeof signInOver>

export const signInApi = signInOver(selected)

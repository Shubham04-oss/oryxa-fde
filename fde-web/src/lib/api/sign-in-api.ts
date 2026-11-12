// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The calls behind our own sign-in screens (ADR 0007). Two kinds, both posted from this origin with
// `X-Oryxa-Request: 1` and a JSON body, never with sign-in data in the address.
//
// SERVED: the API's contract (crates/oryxa-fde-api/src/signin.rs, typed in fde-api.gen.ts):
//   POST /auth/sign-in/password      { email, password, return_to? } → 200 SignInStep
//   POST /auth/sign-in/verify-email  { code }                        → 200 SignInStep (pending cookie)
//   POST /auth/sign-in/organisation  { organisation }                → 200 SignInStep (one offered)
//   POST /auth/sign-in/code          { email }                       → 200 CodeRequested, the same
//                                                                       whatever the address
//   POST /auth/sign-in/code/verify   { email, code, return_to? }     → 200 SignInStep
//   POST /auth/sign-in/verify-email/resend   (no body)               → 200 { next: "verify_email" }
//   SignInStep = { next: "done", return_to }        session cookie set, pending cookie cleared
//              | { next: "verify_email" }           a code was emailed; pending cookie set
//              | { next: "choose_organisation", organisations: [{ id, name }] }   pending cookie set
//   CodeRequested = { next: "enter_code" }   a code is on its way if the address has an account
//   A refusal is { error: code }: 400 invalid_body | invalid_email | invalid_password |
//   invalid_return_to | invalid_code | invalid_organisation | invalid_sign_in (start again),
//   401 invalid_credentials | invalid_code (the step stays open), 403 csrf | no_organisation |
//   sign_in_unsupported, 429 too_many_attempts with `Retry-After` in seconds, 503 unavailable.
//
// ASSUMED, HAND-WRITTEN: routes the API does not serve yet (#204's later PRs). Their screens and
// buttons stay hidden while `LATER` has them off, so the flag never shows a dead button. When a
// route lands, match its call here to the API and turn it on.
//   POST /auth/invite/lookup       { token }                  → 200 { email } (the invited address)
//   POST /auth/invite   { token, name, password, return_to }  → 200 SignInStep
//   POST /auth/password/forgot     { email }                  → 202, the same whatever the address
//   POST /auth/password/reset      { token, password }        → 204
//   GET  /auth/google?return_to=   → 302 straight to Google, back through /auth/callback
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { z } from "zod"
import { HEADERS, safeReturnTo, selected } from "./client"
import type { Transport } from "./client"
import type { components } from "./fde-api.gen"

type Spec = components["schemas"]

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

/**
 * Each way in beyond the password, on once its API route is served. Screens and buttons of one that
 * is off are hidden; turn one on in the PR that matches its call to the API.
 */
export const LATER = {
  /** An emailed one-time code: `/sign-in?step=code` and "Email me a code". */
  code: true,
  /** "Send a new code" on the verify-email step. */
  resend: true,
  /** "Forgotten password?" and `/sign-in?step=forgot`. */
  forgot: false,
  /** The emailed reset link, `/sign-in?step=reset`. */
  reset: false,
  /** The emailed invite link, `/sign-in?step=invite`. */
  invite: false,
  /** "Continue with Google". */
  google: false,
}
export type Later = keyof typeof LATER

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

/** Where a sign-in stands after a step that worked: the API's `SignInStep`. */
export const Next = z.discriminatedUnion("next", [
  z.object({ next: z.literal("done"), return_to: z.string() }),
  z.object({ next: z.literal("verify_email") }),
  z.object({ next: z.literal("choose_organisation"), organisations: z.array(Organisation).min(1) }),
])
export type Next = z.infer<typeof Next>

/** The one answer to asking for a code: the API's `CodeRequested`, whatever the address. */
export const CodeRequested = z.object({ next: z.literal("enter_code") })

/** The answer to sending the verification code again: the step stays as it is. */
export const Resent = z.object({ next: z.literal("verify_email") })

const InviteOut = z.object({ email: z.string().min(3).max(320) })

/**
 * Words for each refusal, chosen here and never taken from the answer, so no answer can say
 * whether an address has an account. A wrong password and an unknown address are one code.
 */
export const SIGN_IN_TEXT = {
  invalid_credentials: "That email and password do not match an account. Check both and try again.",
  invalid_email: "Enter an email address like name@example.com.",
  invalid_password: "Enter your password. It can be up to 1,024 characters long.",
  invalid_code: "That code is not right, or it has expired. Check the newest email and try again.",
  invalid_organisation: "That organisation is not one you can choose here. Pick one from the list.",
  invalid_sign_in: "Your sign-in took too long or was interrupted. Sign in again.",
  invalid_return_to: "The page to go back to after signing in is not one of ours. Try again.",
  invalid_body: "Your sign-in could not be sent as it was. Reload the page and try again.",
  csrf: "This page could not prove it is ours. Reload the page and try again.",
  no_organisation: "Your account is not part of an organisation yet.",
  sign_in_unsupported:
    "Your account needs a sign-in step the FDE workspace does not support yet. Ask your organisation's admin for help.",
  too_many_attempts: "Too many attempts. Wait a few minutes, then try again.",
  unavailable: "Sign-in is briefly unavailable. Try again in a minute.",
  offline: "Could not reach the workspace. Check your connection and try again.",
  failed: "Could not sign you in. Try again.",
  // Codes of the routes still to come (`LATER`), as assumed.
  link_expired: "This link has expired or has already been used.",
  password_rejected:
    "That password was refused. Choose a longer one that is not used on other sites.",
  invalid_name: "Your name is one line, 1 to 200 characters.",
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

const ErrorBody = z.object({ error: z.string() })

/** The refusal in `response`, as one of our codes; anything unknown is `failed`. */
async function refusal(response: Response): Promise<SignInError> {
  const parsed = ErrorBody.safeParse(await response.json().catch(() => null))
  const said =
    parsed.success && Object.hasOwn(SIGN_IN_TEXT, parsed.data.error)
      ? (parsed.data.error as SignInCode)
      : null
  const code = said ?? (response.status >= 500 ? "unavailable" : "failed")
  // `Retry-After` is whole seconds here; an HTTP date or anything else is not read.
  const header = response.headers.get("retry-after") ?? ""
  const wait = /^\d{1,6}$/.test(header) ? Number(header) : 0
  return new SignInError(code, wait > 0 ? wait : undefined)
}

/** `returnTo` as the API takes it: a local path of at most 2,048 bytes, or home. */
function returnToSent(returnTo: string): string {
  const path = safeReturnTo(returnTo)
  return new TextEncoder().encode(path).length <= 2048 ? path : "/"
}

/** The sign-in calls over `transport`. Tests pass their own. */
export function signInOver(transport: () => Promise<Transport>) {
  /**
   * POSTs `body` as JSON, or nothing for a route that takes no body. The body is never logged or
   * kept; a failure throws a `SignInError`.
   */
  async function post(path: string, body?: object): Promise<Response> {
    const t = await transport()
    let response: Response
    try {
      response = await t.fetch(
        new Request(`${globalThis.location.origin}${path}`, {
          method: "POST",
          headers: body ? { ...HEADERS, "Content-Type": "application/json" } : HEADERS,
          body: body ? JSON.stringify(body) : undefined,
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

  /** The answer to `path`, read as `schema`; any other answer is `failed`. */
  async function answer<T>(schema: z.ZodType<T>, path: string, body?: object): Promise<T> {
    const parsed = schema.safeParse(await (await post(path, body)).json().catch(() => null))
    if (!parsed.success) throw new SignInError("failed")
    return parsed.data
  }

  const next = (path: string, body: object): Promise<Next> => answer(Next, path, body)

  return {
    /** `returnTo` is where the API sends the person once signed in, by this step or a later one. */
    withPassword: (email: string, password: string, returnTo: string) =>
      next("/auth/sign-in/password", {
        email,
        password,
        return_to: returnToSent(returnTo),
      } satisfies Spec["PasswordSignInIn"]),
    verifyEmail: (code: string) =>
      next("/auth/sign-in/verify-email", { code } satisfies Spec["VerifyEmailIn"]),
    chooseOrganisation: (organisation: string) =>
      next("/auth/sign-in/organisation", { organisation } satisfies Spec["ChooseOrganisationIn"]),
    /** Answers the same whether or not the address has an account. */
    requestCode: async (email: string) =>
      void (await answer(CodeRequested, "/auth/sign-in/code", {
        email,
      } satisfies Spec["CodeRequestIn"])),
    withCode: (email: string, code: string, returnTo: string) =>
      next("/auth/sign-in/code/verify", {
        email,
        code,
        return_to: returnToSent(returnTo),
      } satisfies Spec["CodeSignInIn"]),
    resendVerification: async () =>
      void (await answer(Resent, "/auth/sign-in/verify-email/resend")),

    // The routes still to come (`LATER`), on the assumed contract.
    async invite(token: string): Promise<{ email: string }> {
      const parsed = InviteOut.safeParse(
        await (await post("/auth/invite/lookup", { token })).json().catch(() => null),
      )
      if (!parsed.success) throw new SignInError("failed")
      return parsed.data
    },
    acceptInvite: (token: string, name: string, password: string, returnTo: string) =>
      next("/auth/invite", { token, name, password, return_to: returnToSent(returnTo) }),
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

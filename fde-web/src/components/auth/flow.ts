import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { safeReturnTo } from "@/lib/api/client"
import { LATER, SignInError } from "@/lib/api/sign-in-api"
import type { Later, Next, Organisation, SignInCode } from "@/lib/api/sign-in-api"
import type { Outcome } from "@/lib/sign-in-outcome"

/** The sign-in steps, each at `/sign-in?step=…`. No step is the email and password screen. */
export const STEPS = [
  "password",
  "code",
  "verify-email",
  "organisation",
  "forgot",
  "reset",
  "invite",
] as const
export type Step = (typeof STEPS)[number]

/** The step in the address, or the first one for anything unknown or not served yet (`LATER`). */
export function stepOf(value: unknown): Step {
  if (!STEPS.includes(value as Step)) return "password"
  const step = value as Step
  return Object.hasOwn(LATER, step) && !LATER[step as Later] ? "password" : step
}

/**
 * What one step hands the next, in memory only: the address typed, the address a code was just
 * asked for, the organisations offered, a note for the first screen, and an emailed link's token once
 * it is out of the address bar. A reload forgets them. Never the password.
 */
export const carried: {
  email: string
  codeSentTo: string | null
  organisations: Organisation[]
  note: SignInCode | null
  token: string
  tokenFor: Step | null
} = {
  email: "",
  codeSentTo: null,
  organisations: [],
  note: null,
  token: "",
  tokenFor: null,
}

/** Forgets everything a sign-in carried between its steps. */
function forget() {
  carried.email = ""
  carried.codeSentTo = null
  carried.organisations = []
  carried.note = null
  carried.token = ""
  carried.tokenFor = null
}

/** Moves between steps and finishes sign-in, keeping where the person was going. */
export function useFlow(returnTo: string) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const go = useCallback(
    (step: Step) =>
      void router.navigate({
        to: "/sign-in",
        search: { return_to: returnTo, ...(step === "password" ? {} : { step }) },
      }),
    [router, returnTo],
  )

  /** An end with no session: the same page `/auth/callback` sends the browser to. */
  const end = useCallback(
    (error: Outcome) => {
      forget()
      void router.navigate({ to: "/sign-in", search: { return_to: returnTo, error } })
    },
    [router, returnTo],
  )

  const follow = useCallback(
    (next: Next) => {
      if (next.next === "done") {
        // Reads cached while signed out must not survive into the session.
        queryClient.clear()
        forget()
        router.history.push(safeReturnTo(next.return_to))
      } else if (next.next === "verify_email") go("verify-email")
      else {
        carried.organisations = next.organisations
        go("organisation")
      }
    },
    [go, queryClient, router],
  )

  /**
   * A refusal that ends this step, acted on: a lapsed or missing step starts again with a note, and
   * no organisation is the page for it. True when it was handled, so the screen shows nothing.
   */
  const ended = useCallback(
    (error: SignInError) => {
      if (error.code === "no_organisation") {
        end("no_organisation")
        return true
      }
      if (error.code === "invalid_sign_in") {
        carried.organisations = []
        carried.note = "invalid_sign_in"
        go("password")
        return true
      }
      return false
    },
    [end, go],
  )

  return { go, follow, ended }
}

/**
 * One step's call: whether it is working and how it was refused. `ended` acts on a refusal that
 * ends the step (`useFlow`); any other refusal is shown.
 */
export function useCall(ended?: (error: SignInError) => boolean) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<SignInError | null>(null)
  const run = useCallback(
    async <T>(call: () => Promise<T>): Promise<T | null> => {
      setWorking(true)
      setError(null)
      try {
        return await call()
      } catch (failure) {
        // Our own words only: nothing the browser or the answer said is shown or kept.
        const refused = failure instanceof SignInError ? failure : new SignInError("failed")
        if (!ended?.(refused)) setError(refused)
        return null
      } finally {
        setWorking(false)
      }
    },
    [ended],
  )
  return { working, error, setError, run }
}

/** The note `useFlow` left for the first screen, read once. */
export function useNote(): SignInCode | null {
  const [note] = useState(() => carried.note)
  useEffect(() => {
    carried.note = null
  }, [])
  return note
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Why an address cannot be sent, or null. The API checks again. */
export function emailProblem(email: string): string | null {
  if (email.trim() === "") return "Enter your email address."
  return EMAIL.test(email.trim()) ? null : "Enter an email address like name@example.com."
}

/** The digits of a code as typed with spaces or dashes, or null when it is not six digits. */
export function codeOf(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, "")
  return /^\d{6}$/.test(digits) ? digits : null
}

/** "Wait 5 minutes" or "Wait 30 seconds" for a `Retry-After`, or the general advice. */
export function waitText(error: SignInError): string {
  if (error.code !== "too_many_attempts" || !error.retryAfter) return error.message
  const wait =
    error.retryAfter < 60
      ? `${error.retryAfter} ${error.retryAfter === 1 ? "second" : "seconds"}`
      : `${Math.ceil(error.retryAfter / 60)} ${error.retryAfter <= 60 ? "minute" : "minutes"}`
  return `Too many attempts. Wait ${wait}, then try again.`
}

/**
 * An emailed link's token (reset, invite): read once from the address, kept in memory and taken out
 * of the address bar, so it is not left in history or on screen. It reaches the API only in a body.
 * Returns the token to use: the one read for this step, or "".
 */
export function useLinkToken(
  token: string | undefined,
  step: Step | undefined,
  returnTo: string,
  enabled = true,
): string {
  const router = useRouter()
  useEffect(() => {
    if (!token || !enabled) return
    carried.token = token
    carried.tokenFor = step ?? null
    void router.navigate({
      to: "/sign-in",
      search: { return_to: returnTo, ...(step ? { step } : {}) },
      replace: true,
    })
  }, [token, step, returnTo, router, enabled])
  // A token read for one step is never offered to another (a reset link's token to an invite).
  return token ?? (carried.tokenFor === step ? carried.token : "")
}

import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { safeReturnTo } from "@/lib/api/client"
import { SignInError } from "@/lib/api/sign-in-api"
import type { Next } from "@/lib/api/sign-in-api"
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

export function stepOf(value: unknown): Step {
  return STEPS.includes(value as Step) ? (value as Step) : "password"
}

/**
 * What one step hands the next, in memory only: the address typed, and an emailed link's token once
 * it is out of the address bar. A reload forgets them. Never the password.
 */
export const carried: { email: string; token: string; tokenFor: Step | null } = {
  email: "",
  token: "",
  tokenFor: null,
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
    (error: Outcome) =>
      void router.navigate({ to: "/sign-in", search: { return_to: returnTo, error } }),
    [router, returnTo],
  )

  const follow = useCallback(
    (next: Next) => {
      if (next.next === "signed_in") {
        // Reads cached while signed out must not survive into the session.
        queryClient.clear()
        carried.email = ""
        carried.token = ""
        carried.tokenFor = null
        router.history.push(safeReturnTo(returnTo))
      } else if (next.next === "verify_email") go("verify-email")
      else if (next.next === "choose_organisation") go("organisation")
      else if (next.next === "no_organisation") end("no_organisation")
      else end(next.reason === "other" ? "cannot_finish" : next.reason)
    },
    [go, end, queryClient, router, returnTo],
  )

  return { go, follow }
}

/** One step's call: whether it is working and how it was refused. */
export function useCall() {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<SignInError | null>(null)
  const run = useCallback(async <T>(call: () => Promise<T>): Promise<T | null> => {
    setWorking(true)
    setError(null)
    try {
      return await call()
    } catch (failure) {
      // Our own words only: nothing the browser or the answer said is shown or kept.
      setError(failure instanceof SignInError ? failure : new SignInError("failed"))
      return null
    } finally {
      setWorking(false)
    }
  }, [])
  return { working, error, setError, run }
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

/** "Wait 5 minutes" for a `Retry-After`, or the general advice. */
export function waitText(error: SignInError): string {
  if (error.code !== "too_many_attempts" || !error.retryAfter) return error.message
  const minutes = Math.max(1, Math.ceil(error.retryAfter / 60))
  return `Too many attempts. Wait ${minutes} ${minutes === 1 ? "minute" : "minutes"}, then try again.`
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

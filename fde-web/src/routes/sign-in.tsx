import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { OwnSignIn } from "@/components/auth/own-sign-in"
import { stepOf, useLinkToken } from "@/components/auth/flow"
import type { Step } from "@/components/auth/flow"
import { SignIn } from "@/components/sign-in"
import { safeReturnTo } from "@/lib/api/client"
import { ownSignIn } from "@/lib/api/sign-in-api"
import { outcomeOf } from "@/lib/sign-in-outcome"
import type { Outcome } from "@/lib/sign-in-outcome"

/** An emailed link's token: opaque, one line of URL-safe characters, or nothing. */
export function tokenOf(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{1,512}$/.test(value) ? value : ""
}

type Search = { return_to: string; step?: Step; token?: string; error?: Outcome }

/** What this page reads from its address; anything else is dropped. */
function searchOf(search: Record<string, unknown>): Search {
  const step = stepOf(search.step)
  // A token belongs only to the emailed link's own step.
  const token = step === "reset" || step === "invite" ? tokenOf(search.token) : ""
  const error = outcomeOf(search.error)
  return {
    return_to: safeReturnTo(search.return_to),
    ...(step === "password" ? {} : { step }),
    ...(token ? { token } : {}),
    ...(error ? { error } : {}),
  }
}

export const Route = createFileRoute("/sign-in")({
  // The Worker sends `Referrer-Policy: no-referrer` for this page (security-headers.ts); this keeps it
  // so after the app has moved here from another page.
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  validateSearch: searchOf,
  component: SignInRoute,
})

function SignInRoute() {
  // Read through `searchOf` again: the root route passes the raw search on, so a step or token
  // `validateSearch` dropped can still be in `useSearch()`.
  const raw: Record<string, unknown> = Route.useSearch()
  const { return_to, step, token, error } = searchOf(raw)
  const linkToken = useLinkToken(token, step, return_to, ownSignIn)
  const navigate = Route.useNavigate()
  const stray = raw.token !== undefined && !token
  useEffect(() => {
    // A token this page will not use, as for a step still to come, is not left in the address.
    if (ownSignIn && stray)
      void navigate({ search: { return_to, ...(step ? { step } : {}) }, replace: true })
  }, [stray, step, return_to, navigate])

  // Today's redirect to `/auth/login` until the API's sign-in routes are deployed (ADR 0007).
  if (!ownSignIn) return <SignIn returnTo={return_to} outcome={error} />
  return (
    <OwnSignIn
      key={error ?? step ?? "password"}
      step={step ?? "password"}
      outcome={error}
      returnTo={return_to}
      token={linkToken}
    />
  )
}

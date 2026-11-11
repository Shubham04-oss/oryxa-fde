import { createFileRoute } from "@tanstack/react-router"
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

export const Route = createFileRoute("/sign-in")({
  // The Worker sends `Referrer-Policy: no-referrer` for this page (security-headers.ts); this keeps it
  // so after the app has moved here from another page.
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  validateSearch: (search: Record<string, unknown>): Search => {
    const step = stepOf(search.step)
    const token = tokenOf(search.token)
    const error = outcomeOf(search.error)
    return {
      return_to: safeReturnTo(search.return_to),
      ...(step === "password" ? {} : { step }),
      ...(token ? { token } : {}),
      ...(error ? { error } : {}),
    }
  },
  component: SignInRoute,
})

function SignInRoute() {
  const { return_to, step, token, error } = Route.useSearch()
  const linkToken = useLinkToken(token, step, return_to, ownSignIn)

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

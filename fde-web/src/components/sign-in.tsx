import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { AuthPage, AuthTitle } from "./auth/frame"
import { Button } from "./ui/button"
import { ApiError, api, onMock, safeReturnTo } from "@/lib/api/client"
import { OUTCOMES } from "@/lib/sign-in-outcome"
import type { Outcome } from "@/lib/sign-in-outcome"

/**
 * Sign-in (DESIGN.md §3): the signed-out page and its one card, as every sign-in step has it. The
 * account check itself belongs to the API (WorkOS AuthKit).
 * `outcome` is how the last sign-in ended with no session (`/sign-in?error=…` from `/auth/callback`).
 */
export function SignIn({ returnTo, outcome }: { returnTo: string; outcome?: Outcome }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setWorking(true)
    setError(null)
    try {
      // AuthKit's hosted page, through the API, which brings the FDE back to `returnTo`. On the
      // mock it settles at once, and the app moves on by itself.
      await api.signIn(returnTo)
      // Reads cached while signed out must not survive into the session.
      queryClient.clear()
      router.history.push(safeReturnTo(returnTo))
    } catch (failure) {
      const said = failure instanceof ApiError && failure.message !== failure.code
      setError(said ? failure.message : "Couldn't sign you in. Try again.")
      setWorking(false)
    }
  }

  return (
    <AuthPage label="Account access">
      <AuthTitle lead="Use your work account. Your companies and projects open next.">
        Sign in to your FDE workspace
      </AuthTitle>
      <div className="mt-8 grid gap-4">
        {outcome && (
          <div role="alert" className="rounded-field border bg-card p-4 text-meta">
            <p className="font-medium">{OUTCOMES[outcome].title}</p>
            <p className="mt-1 text-muted-foreground">{OUTCOMES[outcome].text}</p>
          </div>
        )}
        <Button
          className="h-11 w-full text-[13px]"
          disabled={working}
          onClick={() => void signIn()}
        >
          {working ? "Signing in…" : "Continue"}
        </Button>
        {error && (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        )}
      </div>
      {onMock && (
        <p className="mt-7 border-t pt-4 text-micro text-muted-foreground">
          Running on the mock API with sample data. No account is checked.
        </p>
      )}
    </AuthPage>
  )
}

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { Button } from "./ui/button"
import { ApiError, api, onMock, safeReturnTo } from "@/lib/api/client"
import { STAGES } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"
import { OUTCOMES } from "@/lib/sign-in-outcome"
import type { Outcome } from "@/lib/sign-in-outcome"
import { cn } from "@/lib/utils"

// Each stage a little stronger than the last, drawn in --text: the screen's one expressive touch.
const FADE = [
  "opacity-20",
  "opacity-30",
  "opacity-40",
  "opacity-50",
  "opacity-60",
  "opacity-70",
  "opacity-80",
  "opacity-90",
]

/**
 * Sign-in (DESIGN.md §3): the one expressive screen. The full canvas, a compact card inset right,
 * and the eight stages behind it. The account check itself belongs to the API (WorkOS AuthKit).
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
    <main className="grid min-h-dvh place-items-center bg-canvas px-[clamp(24px,5vw,80px)] py-6 text-foreground">
      <div className="grid w-[min(100%,1100px)] grid-cols-[minmax(0,1fr)_minmax(320px,420px)] items-center gap-[clamp(36px,7vw,112px)] max-[800px]:grid-cols-1">
        <ol aria-hidden="true" className="grid gap-2.5 max-[800px]:hidden">
          {STAGES.map((stage, i) => (
            <li key={stage} className={cn("flex items-center gap-3", FADE[i])}>
              <span className="size-2.5 rounded-full bg-foreground" />
              <span className="text-[clamp(20px,2.6vw,28px)] font-semibold tracking-[-0.03em]">
                {STAGE_LABEL[stage]}
              </span>
            </li>
          ))}
        </ol>
        <section
          aria-label="Account access"
          className="rounded-[20px] border bg-card p-[34px] max-[800px]:p-6"
        >
          <h1 className="text-[clamp(27px,6vw,33px)] leading-[1.12] font-[650] tracking-[-0.055em]">
            Sign in to your FDE workspace
          </h1>
          <p className="mt-2.5 mb-7 text-[13px] leading-normal text-muted-foreground">
            Use your work account. Your companies and projects open next.
          </p>
          {outcome && (
            <div role="alert" className="mb-5 rounded-lg border p-3 text-[12px] leading-normal">
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
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}
          {onMock && (
            <p className="mt-4 text-[11px] leading-normal text-muted-foreground">
              Running on the mock API with sample data. No account is checked.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}

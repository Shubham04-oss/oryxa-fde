import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { useLocation, useNavigate } from "@tanstack/react-router"
import { AppShell } from "./app-shell"
import { Failed } from "./page"
import { ApiError, queries } from "@/lib/api/client"

/**
 * Every screen but sign-in: the shell, once the API says who is signed in. Without a session it
 * goes to sign-in, which brings the FDE back here afterwards.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const me = useQuery(queries.me())
  const navigate = useNavigate()
  const here = useLocation({ select: (location) => location.href })
  const signedOut = me.error instanceof ApiError && me.error.status === 401
  // The address to come back to, as it was when the session was found missing.
  const returnTo = useRef(here)

  useEffect(() => {
    // Once: <Navigate> would navigate again on every render while sign-in loads, without end.
    if (signedOut)
      void navigate({ to: "/sign-in", search: { return_to: returnTo.current }, replace: true })
  }, [signedOut, navigate])

  if (me.isPending || signedOut)
    return (
      <div
        role="status"
        className="grid min-h-dvh place-items-center text-xs text-muted-foreground"
      >
        Opening your workspace…
      </div>
    )
  if (me.isError)
    return (
      <main className="mx-auto grid min-h-dvh w-[min(520px,calc(100%-32px))] content-center">
        <Failed
          title="We couldn't reach your workspace."
          error={me.error}
          onRetry={() => void me.refetch()}
        />
      </main>
    )
  return <AppShell me={me.data}>{children}</AppShell>
}

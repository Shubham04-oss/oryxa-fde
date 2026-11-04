import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { AppShell } from "./app-shell"
import { Failed } from "./page"
import { ApiError, queries } from "@/lib/api/client"

/**
 * Every screen but sign-in: the shell, once the API says who is signed in. Without a session the
 * query client (src/lib/session.ts) sends the FDE to sign-in, which brings them back here.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const me = useQuery(queries.me())
  const signedOut = me.error instanceof ApiError && me.error.status === 401

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

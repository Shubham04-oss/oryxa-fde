import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "./ui/button"
import { api, queries } from "@/lib/api/client"

/** The one signed-in page: who is signed in, in which organisation, and a way to sign out. */
export function SignedIn() {
  const me = useQuery(queries.me())
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  const [failed, setFailed] = useState(false)

  async function signOut() {
    setLeaving(true)
    setFailed(false)
    try {
      await api.signOut()
      // Every cached read belonged to the session just ended.
      queryClient.clear()
      await navigate({ to: "/sign-in", search: { return_to: "/" } })
    } catch {
      setFailed(true)
      setLeaving(false)
    }
  }

  if (!me.data) return null
  const { user, organisation, role } = me.data
  return (
    <main className="mx-auto grid min-h-dvh w-[min(520px,calc(100%-32px))] content-center gap-4 text-[13px]">
      <h1 className="text-base font-semibold">You are signed in</h1>
      <p>
        Signed in as <strong>{user.name}</strong> in <strong>{organisation.name}</strong>
        {role === "admin" ? ", as an organisation admin." : "."}
      </p>
      <div>
        <Button variant="outline" disabled={leaving} onClick={() => void signOut()}>
          {leaving ? "Signing out…" : "Sign out"}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-destructive">
          Couldn&apos;t sign out. Try again.
        </p>
      )}
    </main>
  )
}

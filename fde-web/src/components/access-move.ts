import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ApiError, StaleSaveError, api, queries } from "@/lib/api/client"
import { accessRefusalNote, commitAccess } from "@/lib/access"
import type { AccessRefusal } from "@/lib/access"
import type { AccessRequestOut, AccessState, ProjectScope } from "@/lib/api/schemas"
import { reason } from "@/lib/task-move"
import { ACCESS_LABEL } from "@/lib/today"

export type { AccessRefusal }

/**
 * Changes an access request's status, on Today or on the project page, with the same honesty as a task move: the row
 * shows "moving" until the API answers, and a refusal leaves it where it was. The move is made on the copy of the
 * request the page had at the click, and sends that copy's version: if the request has changed since, nothing is
 * saved, the current request goes into the page, and the move is offered again.
 */
export function useAccessMover({ onSaved }: { onSaved?: (access: AccessRequestOut) => void } = {}) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState<Record<string, AccessState>>({})
  const [refusal, setRefusal] = useState<AccessRefusal | null>(null)
  const [announcement, say] = useState("")

  async function move(scope: ProjectScope, access: AccessRequestOut, to: AccessState) {
    if (to === access.status || saving[access.id]) return
    setRefusal(null)
    setSaving((s) => ({ ...s, [access.id]: to }))
    try {
      // The route replaces the whole request, so everything but the status is sent as it is.
      const saved = await api.updateAccess(
        scope,
        access.id,
        {
          description: access.description,
          owner: access.owner ?? null,
          system: access.system ?? null,
          status: to,
        },
        access.version,
      )
      await commitAccess(queryClient, scope, saved, access.status)
      say(`Marked “${access.description}” ${ACCESS_LABEL[to].toLowerCase()}.`)
      onSaved?.(saved)
    } catch (e) {
      say("")
      if (e instanceof StaleSaveError) {
        const now = e.current as AccessRequestOut
        // The request as it stands, so the page is true; its own status is not a change to wait for.
        await commitAccess(queryClient, scope, now, now.status)
        setRefusal({
          scope,
          access: now,
          to,
          why: e.message,
          kind: now.status === to ? "already" : "stale",
        })
      } else {
        setRefusal({ scope, access, to, why: reason(e, "request"), kind: "refused" })
        // The request may have gone: read Today again.
        if (e instanceof ApiError && e.status === 404)
          void queryClient.invalidateQueries({ queryKey: queries.today().queryKey })
      }
    } finally {
      setSaving(({ [access.id]: _, ...rest }) => rest)
    }
  }

  /** The move a stale refusal offers again, on the request as it now stands. */
  function again() {
    if (!refusal || refusal.kind !== "stale") return
    setRefusal(null)
    void move(refusal.scope, refusal.access, refusal.to)
  }

  return {
    saving,
    refusal,
    announcement,
    move,
    dismiss: () => setRefusal(null),
    again,
    /** What the refusal says where it is shown; `name` says which request, for a place that is not its row. */
    note: (name: string | null) => refusal && accessRefusalNote(refusal, name, again),
  }
}

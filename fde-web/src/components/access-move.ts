import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ApiError, api, queries } from "@/lib/api/client"
import { commitAccess } from "@/lib/access"
import type { AccessRequestOut, AccessState, ProjectScope } from "@/lib/api/schemas"
import { reason } from "@/lib/task-move"
import { ACCESS_LABEL } from "@/lib/today"

/** An access request status change the API refused, and why. */
export type AccessRefusal = { access: AccessRequestOut; to: AccessState; why: string }

/**
 * Changes an access request's status, on Today or on the project page, with the same honesty as a task move: the row
 * shows "moving" until the API answers, and a refusal leaves it where it was.
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
      const saved = await api.updateAccess(scope, access.id, {
        description: access.description,
        owner: access.owner ?? null,
        system: access.system ?? null,
        status: to,
      })
      await commitAccess(queryClient, scope, saved, access.status)
      say(`Marked “${access.description}” ${ACCESS_LABEL[to].toLowerCase()}.`)
      onSaved?.(saved)
    } catch (e) {
      say("")
      setRefusal({ access, to, why: reason(e, "request") })
      // The request may have gone: read Today again.
      if (e instanceof ApiError && e.status === 404)
        void queryClient.invalidateQueries({ queryKey: queries.today().queryKey })
    } finally {
      setSaving(({ [access.id]: _, ...rest }) => rest)
    }
  }

  return { saving, refusal, announcement, move, dismiss: () => setRefusal(null) }
}

import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { onMock, queries } from "./api/client"
import type { ProjectScope } from "./api/schemas"
import { RunEvent, mergeEvents } from "./api/runs"
import type { AgentRunId } from "./api/runs"

/** Where the browser follows a run's output: this app's own origin, which hands it to realtime/. */
export function liveUrl(
  scope: ProjectScope,
  run: AgentRunId,
  location: Location = window.location,
) {
  const scheme = location.protocol === "https:" ? "wss" : "ws"
  return `${scheme}://${location.host}/live/companies/${scope.company}/projects/${scope.project}/agent-runs/${run}`
}

/**
 * A run's new output while `follow` is set, and whether it is arriving live. Without live output (the mock,
 * no realtime Worker, a dropped socket) the run query's polling carries on alone, so nothing is lost: the
 * stored transcript is the record and this only brings lines sooner.
 */
export function useLiveEvents(scope: ProjectScope, run: AgentRunId, follow: boolean) {
  const queryClient = useQueryClient()
  const [events, setEvents] = useState<Array<RunEvent>>([])
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!follow || onMock || typeof WebSocket === "undefined") return
    const socket = new WebSocket(liveUrl(scope, run))
    socket.addEventListener("open", () => setLive(true))
    socket.addEventListener("close", () => setLive(false))
    socket.addEventListener("message", (message) => {
      let value: unknown
      try {
        value = JSON.parse(String(message.data))
      } catch {
        return
      }
      const parsed = RunEvent.safeParse(value)
      if (!parsed.success) return
      setEvents((current) => mergeEvents(current, [parsed.data]))
      // The run's state and its approvals change with these; read them now rather than at the next poll.
      if (parsed.data.type === "approval_request" || parsed.data.type === "result")
        void queryClient.invalidateQueries({ queryKey: queries.run(scope, run).queryKey })
    })
    return () => socket.close()
  }, [follow, scope.company, scope.project, run, queryClient])

  return { events, live }
}

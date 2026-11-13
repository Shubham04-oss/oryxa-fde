import { Navigate, createFileRoute } from "@tanstack/react-router"
import { ConversationView } from "@/components/workspace/chat/conversation-view"
import { onMock } from "@/lib/api/client"
import { ConversationId, scopeFromParam } from "@/lib/workspace/chat"
import { newWorkspace } from "@/lib/workspace/flag"

// The conversation prototype (issue #263): only with the new workspace on, and only on the dev mock,
// whose scripted assistant is the only one that answers its proposed routes. Anywhere else it is `/`.

type Search = { c?: string; new?: string }

export const Route = createFileRoute("/_app/conversations")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    c: ConversationId.safeParse(search.c).success ? (search.c as string) : undefined,
    new: scopeFromParam(search.new) ? (search.new as string) : undefined,
  }),
  component: Conversations,
})

function Conversations() {
  const search = Route.useSearch()
  if (!newWorkspace() || !onMock) return <Navigate to="/" replace />
  return <ConversationView conversation={search.c ?? null} draft={scopeFromParam(search.new)} />
}

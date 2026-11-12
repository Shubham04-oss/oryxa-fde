import { Navigate, createFileRoute } from "@tanstack/react-router"
import { NewCompanyConversation } from "@/components/workspace/new-company"
import { newWorkspace } from "@/lib/workspace/flag"

export const Route = createFileRoute("/_app/new-company")({ component: NewCompany })

/** A new company as a conversation (issue #209); without the new workspace, the form on `/`. */
function NewCompany() {
  return newWorkspace() ? <NewCompanyConversation /> : <Navigate to="/" replace />
}

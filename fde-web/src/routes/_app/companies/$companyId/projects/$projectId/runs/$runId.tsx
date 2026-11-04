import { createFileRoute } from "@tanstack/react-router"
import { NotFound } from "@/components/page"
import { RunPage } from "@/components/run-page"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { AgentRunId } from "@/lib/api/runs"

export const Route = createFileRoute("/_app/companies/$companyId/projects/$projectId/runs/$runId")({
  component: RunRoute,
})

function RunRoute() {
  // The address is untrusted: ids that break the id rule never reach a call.
  const params = Route.useParams()
  const company = CompanyId.safeParse(params.companyId)
  const project = ProjectId.safeParse(params.projectId)
  const run = AgentRunId.safeParse(params.runId)
  if (!company.success || !project.success || !run.success) return <NotFound what="run" />
  return (
    <RunPage
      key={`${company.data}/${project.data}/${run.data}`}
      scope={{ company: company.data, project: project.data }}
      runId={run.data}
    />
  )
}

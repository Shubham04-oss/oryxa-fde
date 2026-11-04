import { createFileRoute } from "@tanstack/react-router"
import { NotFound } from "@/components/page"
import { ProjectPage } from "@/components/project-page"
import { CompanyId, ProjectId } from "@/lib/api/schemas"

export const Route = createFileRoute("/_app/companies/$companyId/projects/$projectId")({
  component: ProjectRoute,
})

function ProjectRoute() {
  // The address is untrusted: ids that break the id rule never reach a call.
  const params = Route.useParams()
  const company = CompanyId.safeParse(params.companyId)
  const project = ProjectId.safeParse(params.projectId)
  if (!company.success || !project.success) return <NotFound what="project" />
  return (
    <ProjectPage
      key={`${company.data}/${project.data}`}
      scope={{ company: company.data, project: project.data }}
    />
  )
}

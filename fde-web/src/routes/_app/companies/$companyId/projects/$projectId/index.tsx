import { useEffect, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { NotFound } from "@/components/page"
import { ProjectPage } from "@/components/project-page"
import { CompanyId, ProjectId } from "@/lib/api/schemas"

export const Route = createFileRoute("/_app/companies/$companyId/projects/$projectId/")({
  // `?add=task` opens New task: where Today sends the FDE to give a project its next step.
  validateSearch: (search: Record<string, unknown>): { add?: "task" } =>
    search.add === "task" ? { add: "task" } : {},
  component: ProjectRoute,
})

function ProjectRoute() {
  const { add } = Route.useSearch()
  const navigate = useNavigate()
  // Kept from the first render: the address is cleared below, long before the project has loaded.
  const [addTask] = useState(add === "task")
  // The form opens once; the address goes back to the project's own, so a reload does not reopen it.
  useEffect(() => {
    if (add) void navigate({ to: ".", search: {}, replace: true })
  }, [add, navigate])
  // The address is untrusted: ids that break the id rule never reach a call.
  const params = Route.useParams()
  const company = CompanyId.safeParse(params.companyId)
  const project = ProjectId.safeParse(params.projectId)
  if (!company.success || !project.success) return <NotFound what="project" />
  return (
    <ProjectPage
      key={`${company.data}/${project.data}`}
      scope={{ company: company.data, project: project.data }}
      addTask={addTask}
    />
  )
}

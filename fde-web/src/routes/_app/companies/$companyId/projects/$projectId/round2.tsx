import { Suspense, lazy } from "react"
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { NotFound } from "@/components/page"
import { onMock } from "@/lib/api/client"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { lookOf, tabOf } from "@/lib/round2"
import type { Look, Tab } from "@/lib/round2"
import { newWorkspace } from "@/lib/workspace/flag"

// The round 2 project page prototype (issue #262), for the founder to look at before anything is rolled out.
// Dev mock with the workspace on only: `import.meta.env.DEV` is `false` in a production build, so the
// prototype's code is dropped from it, and nothing links here.
const Round2Project = import.meta.env.DEV
  ? lazy(() => import("@/components/round2/project").then((m) => ({ default: m.Round2Project })))
  : null

export const Route = createFileRoute("/_app/companies/$companyId/projects/$projectId/round2")({
  // `?tab=` is the tab, `?look=a|b` the look; anything else falls back to Overview and look a.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab; look?: Look } => ({
    ...(search.tab !== undefined && tabOf(search.tab) !== "overview"
      ? { tab: tabOf(search.tab) }
      : {}),
    ...(search.look === "b" ? { look: lookOf(search.look) } : {}),
  }),
  component: Round2Route,
})

function Round2Route() {
  const params = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  // The address is untrusted: ids that break the id rule never reach a call.
  const company = CompanyId.safeParse(params.companyId)
  const project = ProjectId.safeParse(params.projectId)
  if (!company.success || !project.success) return <NotFound what="project" />
  if (!Round2Project || !onMock || !newWorkspace())
    return (
      <Navigate
        to="/companies/$companyId/projects/$projectId"
        params={{ companyId: company.data, projectId: project.data }}
        search={{}}
        replace
      />
    )
  return (
    <Suspense fallback={null}>
      <Round2Project
        key={`${company.data}/${project.data}`}
        scope={{ company: company.data, project: project.data }}
        tab={tabOf(search.tab)}
        look={lookOf(search.look)}
        onTab={(tab) =>
          void navigate({
            search: (s) => ({ ...s, tab: tab === "overview" ? undefined : tab }),
          })
        }
      />
    </Suspense>
  )
}

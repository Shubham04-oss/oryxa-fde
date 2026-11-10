import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CompanyDialog, ProjectDialog } from "./company-forms"
import { ROLE_LABEL } from "./companies-home"
import { Card, Failed, Loading, NotFound, Page, Quiet, Row, Rows, isNotFound } from "./page"
import { NotesCard } from "./notes-card"
import { StakeholdersCard, SystemsCard } from "./records-cards"
import { MembersCard } from "./team"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { queries } from "@/lib/api/client"
import type { CompanyId } from "@/lib/api/schemas"
import { canManage } from "@/lib/records"
import { STAGE_LABEL } from "@/lib/stage"

/** A company (DESIGN.md §3): its profile, stakeholders, systems, projects and team. */
export function CompanyPage({
  companyId,
  addStakeholder = false,
}: {
  companyId: CompanyId
  /** Opens Add stakeholder as the page loads: a project's checklist sent the FDE here to name someone. */
  addStakeholder?: boolean
}) {
  const company = useQuery(queries.company(companyId))
  const me = useQuery(queries.me())
  const [dialog, setDialog] = useState<"edit" | "project" | null>(null)

  if (company.isPending)
    return (
      <Page>
        <Loading>Loading the company…</Loading>
      </Page>
    )
  if (isNotFound(company.error)) return <NotFound what="company" />
  if (company.isError)
    return (
      <Page>
        <Failed
          title="We couldn't load this company."
          error={company.error}
          onRetry={() => void company.refetch()}
        />
      </Page>
    )

  const c = company.data
  // Editing the profile and starting projects need `manage`; the API still decides.
  const manage = canManage(me.data, c.role)
  return (
    <Page wide>
      <Card
        title="Profile"
        aside={
          manage && (
            <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
              Edit company
            </Button>
          )
        }
      >
        {c.summary && <p className="mb-3 text-xs leading-relaxed">{c.summary}</p>}
        <dl className="grid grid-cols-3 gap-3 text-xs max-[560px]:grid-cols-1">
          {[
            ["Industry", c.industry || "Not set"],
            ["Region", c.region || "Not set"],
            ["Your part", c.role ? ROLE_LABEL[c.role] : "Not a member"],
          ].map(([term, value]) => (
            <div key={term}>
              <dt className="text-[11px] text-muted-foreground">{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {!manage && (
          <Quiet className="mt-3">
            Only a lead or an organisation admin changes the profile or starts a project.
          </Quiet>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
        <StakeholdersCard company={c.id} people={c.stakeholders} startOpen={addStakeholder} />
        <SystemsCard company={c.id} systems={c.systems} />
      </div>

      <Card
        title="Projects"
        aside={
          manage && (
            <Button variant="outline" size="sm" onClick={() => setDialog("project")}>
              New project
            </Button>
          )
        }
      >
        {c.projects.length === 0 ? (
          <Quiet>
            No projects yet.
            {manage
              ? " Start one for the first piece of work. It begins at Discover."
              : " A lead starts one when the work is known."}
          </Quiet>
        ) : (
          <Rows>
            {c.projects.map((project) => (
              <Row key={project.id}>
                <Link
                  to="/companies/$companyId/projects/$projectId"
                  params={{ companyId: c.id, projectId: project.id }}
                  className="group flex items-baseline justify-between gap-3"
                >
                  <span className="truncate text-xs group-hover:underline group-hover:underline-offset-2">
                    {project.name}
                  </span>
                  <span className="flex-none text-[11px] text-soft">
                    {STAGE_LABEL[project.stage]}
                  </span>
                </Link>
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <NotesCard place={{ company: c.id }} people={c.stakeholders} />

      <MembersCard company={c.id} me={me.data?.user.id} manage={manage} />

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === "edit" && <CompanyDialog company={c} onClose={() => setDialog(null)} />}
        {dialog === "project" && <ProjectDialog company={c.id} onClose={() => setDialog(null)} />}
      </Dialog>
    </Page>
  )
}

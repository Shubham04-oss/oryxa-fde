import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Avatar } from "./app-shell"
import { ROLE_LABEL } from "./companies-home"
import { Card, Failed, Loading, NotFound, Page, Quiet, Row, Rows, isNotFound } from "./page"
import { queries } from "@/lib/api/client"
import type { CompanyId, Stakeholder } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"

const PART_LABEL: Record<Stakeholder["part"], string> = {
  sponsor: "Sponsor",
  champion: "Champion",
  decision_maker: "Decision maker",
  security: "Security",
  it_owner: "IT owner",
  end_user: "End user",
}

/** A company (DESIGN.md §3): its profile, stakeholders, systems and projects. */
export function CompanyPage({ companyId }: { companyId: CompanyId }) {
  const company = useQuery(queries.company(companyId))

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
  return (
    <Page wide>
      <Card title="Profile">
        <p className="text-xs leading-relaxed">{c.summary}</p>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-xs max-[560px]:grid-cols-1">
          {[
            ["Industry", c.industry],
            ["Region", c.region],
            ["Your part", ROLE_LABEL[c.role]],
          ].map(([term, value]) => (
            <div key={term}>
              <dt className="text-[11px] text-muted-foreground">{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
        <Card title="Stakeholders">
          {c.stakeholders.length === 0 ? (
            <Quiet>No stakeholders yet.</Quiet>
          ) : (
            <Rows>
              {c.stakeholders.map((person) => (
                <Row key={person.id}>
                  <div className="flex items-center gap-3">
                    <Avatar name={person.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs">{person.name}</p>
                      <Quiet className="truncate">{person.title}</Quiet>
                    </div>
                    <span className="flex-none text-[11px] text-soft">
                      {PART_LABEL[person.part]}
                    </span>
                  </div>
                </Row>
              ))}
            </Rows>
          )}
        </Card>

        <Card title="Systems">
          {c.systems.length === 0 ? (
            <Quiet>No systems yet.</Quiet>
          ) : (
            <Rows>
              {c.systems.map((system) => (
                <Row key={system.id}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-xs">{system.name}</p>
                    <span className="flex-none text-[11px] text-soft">{system.kind}</span>
                  </div>
                  <Quiet>{system.notes}</Quiet>
                </Row>
              ))}
            </Rows>
          )}
        </Card>
      </div>

      <Card title="Projects">
        {c.projects.length === 0 ? (
          <Quiet>No projects yet.</Quiet>
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
    </Page>
  )
}

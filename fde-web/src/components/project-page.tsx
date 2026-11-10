import { useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronLeft } from "lucide-react"
import { Card, Failed, Loading, NotFound, Page, Quiet, Row, Rows, Status, isNotFound } from "./page"
import type { Tone } from "./page"
import { Board } from "./board"
import { ProjectDialog } from "./company-forms"
import { AssigneesCard } from "./team"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { StageBar } from "./stage-bar"
import { RunsCard } from "./runs"
import { ApiError, api, queries } from "@/lib/api/client"
import type {
  AccessState,
  CriterionOut,
  Project,
  ProjectOut,
  ProjectScope,
  Stage,
} from "@/lib/api/schemas"
import { canManage } from "@/lib/records"
import { dayOf, shortDate } from "@/lib/time"

const ACCESS: Record<AccessState, { label: string; tone: Tone }> = {
  requested: { label: "Requested", tone: "neutral" },
  in_progress: { label: "In progress", tone: "neutral" },
  granted: { label: "Granted", tone: "success" },
  denied: { label: "Denied", tone: "attention" },
  revoked: { label: "Revoked", tone: "attention" },
}

const COMPARATOR: Record<CriterionOut["comparator"], string> = {
  at_least: "at least",
  at_most: "at most",
}

/** "plans accepted unchanged, at least 70%". */
function target({ metric, comparator, target: value, unit }: CriterionOut) {
  const units = unit ? (unit === "%" ? "%" : ` ${unit}`) : ""
  return `${metric}, ${COMPARATOR[comparator]} ${value}${units}`
}

/** The page column (1040px) the cards sit in; the board alone breaks out to the canvas. */
function Column({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid w-[min(1040px,100%)] gap-4 max-[800px]:gap-3.5">{children}</div>
  )
}

/** How scope sign-off stands: signed for this version, signed before a change, or never. */
function signOffStatus(p: Project, person: (id: string) => string) {
  const signed = p.scope.sign_off
  if (!signed) return <Status tone="neutral">Not signed off</Status>
  const by = person(signed.stakeholder)
  if (!p.scope.signed_off) return <Status tone="neutral">Changed since {by} signed off</Status>
  return (
    <Status tone="success">
      Signed off by {by}, {shortDate(dayOf(signed.signed_at))}
    </Status>
  )
}

/**
 * A project (DESIGN.md §3): the stage bar, scope and success criteria, the access tracker, tasks
 * and decisions.
 */
export function ProjectPage({ scope }: { scope: ProjectScope }) {
  const queryClient = useQueryClient()
  const project = useQuery(queries.project(scope))
  const me = useQuery(queries.me())
  // The FDE's part at the company comes with their list of companies, already read for the sidebar.
  const companies = useQuery(queries.companies())
  const [editing, setEditing] = useState(false)
  const move = useMutation({
    mutationFn: (to: Stage) => api.moveStage(scope, to),
    onSuccess: (moved: ProjectOut) => {
      queryClient.setQueryData(
        queries.project(scope).queryKey,
        (old) => old && { ...old, stage: moved.stage, updated_at: moved.updated_at },
      )
      // Stages show on the company, Home and Jump to.
      void queryClient.invalidateQueries({ queryKey: ["companies"], exact: false })
    },
  })

  if (project.isPending)
    return (
      <Page>
        <Loading>Loading the project…</Loading>
      </Page>
    )
  if (isNotFound(project.error)) return <NotFound what="project" />
  if (project.isError)
    return (
      <Page>
        <Failed
          title="We couldn't load this project."
          error={project.error}
          onRetry={() => void project.refetch()}
        />
      </Page>
    )

  const p = project.data
  const role = companies.data?.companies.find((c) => c.id === p.company.id)?.role
  // Its team needs `manage` on the company; its name and summary need only `work`, which anyone who
  // can read the project has. The API still decides.
  const manage = canManage(me.data, role)
  // A project nobody has written anything in yet: say what to do first.
  const fresh =
    p.scope.items.length === 0 &&
    p.scope.criteria.length === 0 &&
    p.tasks.length === 0 &&
    p.access.length === 0 &&
    p.decisions.length === 0
  const moveError = move.isError
    ? move.error instanceof ApiError && move.error.status === 409
      ? move.error.message
      : "Couldn't move the project. Try again."
    : null
  const people = new Map(p.stakeholders.map((s) => [s.id as string, s.name]))
  const systems = new Map(p.systems.map((s) => [s.id as string, s.name]))
  const person = (id: string) => people.get(id) ?? "a stakeholder no longer listed"
  const inScope = p.scope.items.filter((item) => item.kind === "in")
  const outOfScope = p.scope.items.filter((item) => item.kind === "out")

  return (
    <Page full>
      <Column>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Link
              to="/companies/$companyId"
              params={{ companyId: p.company.id }}
              className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft size={14} strokeWidth={1.7} aria-hidden="true" />
              {p.company.name}
            </Link>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit project
            </Button>
          </div>
          {p.summary && <p className="text-xs leading-relaxed text-soft">{p.summary}</p>}
          {fresh && (
            <div className="rounded-[14px] border border-dashed border-strong px-5 py-3.5 max-[800px]:p-4">
              <strong className="text-[13px] font-semibold">A new project. Start here.</strong>
              <Quiet className="mt-1">
                Name who you work with at {p.company.name} on the company page, then agree the scope
                with them. Add tasks to the board as the work takes shape.
              </Quiet>
            </div>
          )}
        </div>

        <StageBar
          stage={p.stage}
          moving={move.isPending}
          error={moveError}
          onMove={(to) => move.mutate(to)}
        />
      </Column>

      <Board scope={scope} project={p} />

      <Column>
        <div className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
          <Card title="Scope" aside={signOffStatus(p, person)}>
            {p.scope.items.length === 0 ? (
              <Quiet>No scope written yet.</Quiet>
            ) : (
              <div className="grid gap-3 text-xs">
                {(
                  [
                    ["In scope", inScope],
                    ["Out of scope", outOfScope],
                  ] as const
                ).map(([heading, items]) => (
                  <div key={heading}>
                    <h3 className="text-[11px] text-muted-foreground">{heading}</h3>
                    {items.length === 0 ? (
                      <Quiet>None listed.</Quiet>
                    ) : (
                      <ul className="mt-1 grid list-disc gap-1 pl-4 marker:text-muted-foreground">
                        {items.map((item) => (
                          <li key={item.id}>{item.description}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Success criteria">
            {p.scope.criteria.length === 0 ? (
              <Quiet>No success criteria yet.</Quiet>
            ) : (
              <Rows>
                {p.scope.criteria.map((criterion) => (
                  <Row key={criterion.id}>
                    <p className="min-w-0 text-xs">{criterion.description}</p>
                    <Quiet>Target: {target(criterion)}</Quiet>
                  </Row>
                ))}
              </Rows>
            )}
          </Card>
        </div>

        <Card title="Access">
          {p.access.length === 0 ? (
            <Quiet>No access requested yet.</Quiet>
          ) : (
            <Rows>
              {p.access.map((request) => {
                const open = request.status === "requested" || request.status === "in_progress"
                const days = request.days_waiting
                const detail = [
                  request.system && systems.get(request.system),
                  request.owner && `Owner: ${person(request.owner)}`,
                  `Requested ${shortDate(dayOf(request.requested_at))}`,
                  open && `${days} ${days === 1 ? "day" : "days"} waiting`,
                ]
                return (
                  <Row key={request.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="min-w-0 text-xs">{request.description}</p>
                      <Status tone={ACCESS[request.status].tone}>
                        {ACCESS[request.status].label}
                      </Status>
                    </div>
                    <Quiet>{detail.filter(Boolean).join(" · ")}</Quiet>
                  </Row>
                )
              })}
            </Rows>
          )}
        </Card>

        <RunsCard scope={scope} />

        <Card title="Decisions">
          {p.decisions.length === 0 ? (
            <Quiet>No decisions logged yet.</Quiet>
          ) : (
            <Rows>
              {p.decisions.map((decision) => (
                <Row key={decision.id}>
                  <p className="text-xs">{decision.title}</p>
                  <p className="mt-0.5 text-xs text-soft">{decision.rationale}</p>
                  <Quiet>
                    {decision.decided_by}, {shortDate(dayOf(decision.decided_at))}
                  </Quiet>
                </Row>
              ))}
            </Rows>
          )}
        </Card>

        <AssigneesCard scope={scope} me={me.data?.user.id} manage={manage} />
      </Column>

      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && (
          <ProjectDialog company={p.company.id} project={p} onClose={() => setEditing(false)} />
        )}
      </Dialog>
    </Page>
  )
}

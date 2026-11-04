import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronLeft } from "lucide-react"
import { Card, Failed, Loading, NotFound, Page, Quiet, Row, Rows, Status, isNotFound } from "./page"
import type { Tone } from "./page"
import { StageBar } from "./stage-bar"
import { ApiError, api, queries } from "@/lib/api/client"
import type { AccessRequest, Criterion, ProjectScope, Stage, Task } from "@/lib/api/schemas"
import { daysBetween, dueLabel, localDay, shortDate, waitingLabel } from "@/lib/time"

const CRITERION: Record<Criterion["status"], { label: string; tone: Tone }> = {
  not_measured: { label: "Not measured", tone: "neutral" },
  passing: { label: "Passing", tone: "success" },
  failing: { label: "Failing", tone: "attention" },
}

const ACCESS: Record<AccessRequest["status"], { label: string; tone: Tone }> = {
  requested: { label: "Requested", tone: "neutral" },
  in_review: { label: "In review", tone: "neutral" },
  granted: { label: "Granted", tone: "success" },
  denied: { label: "Denied", tone: "attention" },
}

const TASK: Record<Task["status"], { label: string; tone: Tone }> = {
  todo: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "neutral" },
  blocked: { label: "Blocked", tone: "attention" },
  waiting_on_customer: { label: "Waiting on the customer", tone: "neutral" },
  done: { label: "Done", tone: "success" },
}

/** What a task's second line says: why it is stuck, or when it is due. */
function taskDetail(task: Task, today: string) {
  if (task.status === "blocked" && task.blocker) return task.blocker
  if (task.status === "waiting_on_customer" && task.waiting_on)
    return waitingLabel(task.waiting_since ?? today, task.waiting_on, today)
  if (task.status !== "done" && task.due) return dueLabel(task.due, today)
  return null
}

/**
 * A project (DESIGN.md §3): the stage bar, scope and success criteria, the access tracker, tasks
 * and decisions.
 */
export function ProjectPage({ scope }: { scope: ProjectScope }) {
  const queryClient = useQueryClient()
  const project = useQuery(queries.project(scope))
  const move = useMutation({
    mutationFn: (to: Stage) => api.moveStage(scope, to),
    onSuccess: (moved) => {
      queryClient.setQueryData(queries.project(scope).queryKey, moved)
      // Stages show on the company, Home and Jump to.
      void queryClient.invalidateQueries({ queryKey: ["companies"], exact: false })
    },
  })
  const today = localDay()

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
  const moveError = move.isError
    ? move.error instanceof ApiError && move.error.status === 409
      ? move.error.message
      : "Couldn't move the project. Try again."
    : null

  return (
    <Page wide>
      <div className="grid gap-2">
        <Link
          to="/companies/$companyId"
          params={{ companyId: p.company.id }}
          className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={14} strokeWidth={1.7} aria-hidden="true" />
          {p.company.name}
        </Link>
        <p className="text-xs leading-relaxed text-soft">{p.summary}</p>
      </div>

      <StageBar
        stage={p.stage}
        moving={move.isPending}
        error={moveError}
        onMove={(to) => move.mutate(to)}
      />

      <div className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
        <Card
          title="Scope"
          aside={
            p.scope.signed_off ? (
              <Status tone="success">
                Signed off by {p.scope.signed_off.by}, {shortDate(p.scope.signed_off.on)}
              </Status>
            ) : (
              <Status tone="neutral">Not signed off</Status>
            )
          }
        >
          {p.scope.in_scope.length === 0 && p.scope.out_of_scope.length === 0 ? (
            <Quiet>No scope written yet.</Quiet>
          ) : (
            <div className="grid gap-3 text-xs">
              {(
                [
                  ["In scope", p.scope.in_scope],
                  ["Out of scope", p.scope.out_of_scope],
                ] as const
              ).map(([heading, items]) => (
                <div key={heading}>
                  <h3 className="text-[11px] text-muted-foreground">{heading}</h3>
                  {items.length === 0 ? (
                    <Quiet>None listed.</Quiet>
                  ) : (
                    <ul className="mt-1 grid list-disc gap-1 pl-4 marker:text-muted-foreground">
                      {items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Success criteria">
          {p.criteria.length === 0 ? (
            <Quiet>No success criteria yet.</Quiet>
          ) : (
            <Rows>
              {p.criteria.map((criterion) => (
                <Row key={criterion.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-xs">{criterion.statement}</p>
                    <Status tone={CRITERION[criterion.status].tone}>
                      {CRITERION[criterion.status].label}
                    </Status>
                  </div>
                  <Quiet>Target: {criterion.target}</Quiet>
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
              const open = request.status === "requested" || request.status === "in_review"
              const days = daysBetween(request.requested_on, today)
              return (
                <Row key={request.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-xs">{request.system}</p>
                    <Status tone={ACCESS[request.status].tone}>
                      {ACCESS[request.status].label}
                    </Status>
                  </div>
                  <Quiet>
                    Owner: {request.owner} · Requested {shortDate(request.requested_on)}
                    {open && ` · ${days} ${days === 1 ? "day" : "days"} waiting`}
                  </Quiet>
                </Row>
              )
            })}
          </Rows>
        )}
      </Card>

      <Card title="Tasks">
        {p.tasks.length === 0 ? (
          <Quiet>No tasks yet.</Quiet>
        ) : (
          <Rows>
            {p.tasks.map((task) => {
              const detail = taskDetail(task, today)
              const late = task.status !== "done" && task.due !== null && task.due < today
              return (
                <Row key={task.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-xs">{task.title}</p>
                    <Status tone={late ? "attention" : TASK[task.status].tone}>
                      {TASK[task.status].label}
                    </Status>
                  </div>
                  <Quiet>
                    {[task.assignee ?? "Unassigned", detail].filter(Boolean).join(" · ")}
                  </Quiet>
                </Row>
              )
            })}
          </Rows>
        )}
      </Card>

      <Card title="Decisions">
        {p.decisions.length === 0 ? (
          <Quiet>No decisions logged yet.</Quiet>
        ) : (
          <Rows>
            {p.decisions.map((decision) => (
              <Row key={decision.id}>
                <p className="text-xs">{decision.title}</p>
                <p className="mt-0.5 text-xs text-soft">{decision.why}</p>
                <Quiet>
                  {decision.decided_by}, {shortDate(decision.decided_on)}
                </Quiet>
              </Row>
            ))}
          </Rows>
        )}
      </Card>
    </Page>
  )
}

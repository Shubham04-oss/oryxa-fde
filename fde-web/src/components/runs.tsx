import { useState } from "react"
import type { FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Card, Quiet, Row, Rows, Status } from "./page"
import type { Tone } from "./page"
import { Button } from "./ui/button"
import { ApiError, api, queries } from "@/lib/api/client"
import type { ProjectScope } from "@/lib/api/schemas"
import { repositoryProblem, taskOk } from "@/lib/api/runs"
import type { Repository, RunOut, RunState } from "@/lib/api/runs"
import { dayOf, shortDate } from "@/lib/time"

export const RUN_STATE: Record<RunState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "neutral" },
  waiting_for_approval: { label: "Waiting for approval", tone: "attention" },
  finished: { label: "Finished", tone: "success" },
  failed: { label: "Failed", tone: "attention" },
}

const FAILURE: Record<string, string> = {
  approval_rejected: "An action was rejected",
  cancelled: "Cancelled",
  timed_out: "Ran out of time",
  over_budget: "Stopped at the project's budget",
  interrupted: "Interrupted",
}

/** Why a failed run failed, in words. */
export const failureText = (failure: string | null | undefined) =>
  (failure && FAILURE[failure]) || "Failed"

/** A task's first line: what a list shows of it. */
export const taskTitle = (task: string) => task.trim().split("\n")[0] ?? ""

export const repoName = (r: Repository) => `${r.owner}/${r.name}`

/** One run in a list, linked to its review screen; `where` names the company and project. */
function RunRow({ scope, run, where }: { scope: ProjectScope; run: RunOut; where?: string }) {
  const state = RUN_STATE[run.state]
  return (
    <Row>
      <Link
        to="/companies/$companyId/projects/$projectId/runs/$runId"
        params={{ companyId: scope.company, projectId: scope.project, runId: run.id }}
        className="group flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
      >
        <span className="min-w-0">
          <span className="block truncate text-xs group-hover:underline group-hover:underline-offset-2">
            {taskTitle(run.task)}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {[where, repoName(run.repository), shortDate(dayOf(run.created_at))]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <Status tone={state.tone}>{state.label}</Status>
      </Link>
    </Row>
  )
}

/** The project's agent runs (DESIGN.md §3), newest first, and starting a new one. */
export function RunsCard({ scope }: { scope: ProjectScope }) {
  const runs = useQuery(queries.runs(scope))
  const [starting, setStarting] = useState(false)

  return (
    <Card
      title="Agent runs"
      aside={
        !starting && (
          <Button variant="outline" onClick={() => setStarting(true)}>
            Start a task
          </Button>
        )
      }
    >
      {starting && (
        <StartRun
          scope={scope}
          from={runs.data?.[0]?.repository}
          onCancel={() => setStarting(false)}
        />
      )}
      {runs.isPending ? (
        <Quiet>Loading runs…</Quiet>
      ) : runs.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn't load the runs.{" "}
          <button type="button" className="underline" onClick={() => void runs.refetch()}>
            Try again
          </button>
        </p>
      ) : runs.data.length === 0 ? (
        !starting && <Quiet>No runs yet.</Quiet>
      ) : (
        <Rows label="Agent runs">
          {runs.data.map((run) => (
            <RunRow key={run.id} scope={scope} run={run} />
          ))}
        </Rows>
      )}
    </Card>
  )
}

const FIELD =
  "w-full rounded-lg border bg-raised px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:border-strong"

const PROBLEM = {
  owner: "The owner is a GitHub user or organisation: letters, digits and single hyphens.",
  name: "The repository name is letters, digits, dots, underscores and hyphens.",
  base: "The branch name has a character or shape git does not allow.",
}

/** Asks for the task and where it starts, then queues the run and opens it. */
function StartRun({
  scope,
  from,
  onCancel,
}: {
  scope: ProjectScope
  from: Repository | undefined
  onCancel: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [task, setTask] = useState("")
  const [repo, setRepo] = useState<Repository>(from ?? { owner: "", name: "", base: "main" })
  const [problem, setProblem] = useState<string | null>(null)
  const start = useMutation({
    mutationFn: () => api.startRun(scope, { task, repository: repo }),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({ queryKey: queries.runs(scope).queryKey })
      void navigate({
        to: "/companies/$companyId/projects/$projectId/runs/$runId",
        params: { companyId: scope.company, projectId: scope.project, runId: run.id },
      })
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.message !== error.code
          ? error.message
          : "Couldn't start the run. Try again.",
      ),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    const bad = repositoryProblem(repo)
    if (!taskOk(task)) return setProblem("Describe the task in plain text, up to 64 KiB.")
    if (bad) return setProblem(PROBLEM[bad])
    setProblem(null)
    start.mutate()
  }

  const field = (key: keyof Repository, label: string) => (
    <label className="grid gap-1 text-[11px] text-muted-foreground">
      {label}
      <input
        className={FIELD}
        value={repo[key]}
        onChange={(e) => setRepo({ ...repo, [key]: e.target.value.trim() })}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  )

  return (
    <form
      aria-label="Start a task"
      onSubmit={submit}
      className="mb-3 grid gap-3 rounded-xl border bg-raised p-3.5"
    >
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        What should the agent do?
        <textarea
          className={`${FIELD} min-h-24`}
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
      </label>
      <div className="grid grid-cols-3 gap-2 max-[560px]:grid-cols-1">
        {field("owner", "GitHub owner")}
        {field("name", "Repository")}
        {field("base", "From branch")}
      </div>
      <Quiet>
        It runs in this company's sandbox on sample data. Actions on the approval list wait for you.
      </Quiet>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={start.isPending}>
          {start.isPending ? "Starting…" : "Start"}
        </Button>
      </div>
    </form>
  )
}

/** Today's runs (DESIGN.md §3): the ones that may still need the FDE, waiting for approval first. */
export function ActiveRunsCard() {
  const runs = useQuery(queries.activeRuns())
  const order = (state: RunState) => (state === "waiting_for_approval" ? 0 : 1)
  const sorted = [...(runs.data ?? [])].sort((a, b) => order(a.run.state) - order(b.run.state))

  return (
    <Card
      title="Agent runs"
      aside={
        runs.isSuccess && <span className="text-[11px] text-muted-foreground">{sorted.length}</span>
      }
    >
      {runs.isPending ? (
        <Quiet>Loading runs…</Quiet>
      ) : runs.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn't load the runs.{" "}
          <button type="button" className="underline" onClick={() => void runs.refetch()}>
            Try again
          </button>
        </p>
      ) : sorted.length === 0 ? (
        <Quiet>No runs are going.</Quiet>
      ) : (
        <Rows label="Agent runs">
          {sorted.map(({ run, company, project }) => (
            <RunRow
              key={run.id}
              scope={{ company: company.id, project: project.id }}
              run={run}
              where={`${company.name} · ${project.name}`}
            />
          ))}
        </Rows>
      )}
    </Card>
  )
}

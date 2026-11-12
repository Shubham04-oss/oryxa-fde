import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Card, Failed, Loading, NotFound, Page, Quiet, Row, Rows, Status, isNotFound } from "./page"
import type { Tone } from "./page"
import { RUN_STATE, failureText, repoName } from "./runs"
import { Button } from "./ui/button"
import { ApiError, api, queries } from "@/lib/api/client"
import type { ProjectScope } from "@/lib/api/schemas"
import { isActive, mergeEvents, pullRequestUrl, summarize } from "@/lib/api/runs"
import type {
  AgentRunId,
  ApprovalId,
  ApprovalOut,
  RunOut,
  RunSummary,
  ToolStatus,
} from "@/lib/api/runs"
import { useLiveEvents } from "@/lib/live"
import { dayOf, shortDate } from "@/lib/time"
import { Icon } from "@/components/ui/icon"

const STEP: Record<RunSummary["plan"][number]["status"], { label: string; tone: Tone }> = {
  pending: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "neutral" },
  completed: { label: "Done", tone: "success" },
}

const COMMAND: Record<ToolStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "neutral" },
  in_progress: { label: "Running", tone: "neutral" },
  completed: { label: "Passed", tone: "success" },
  failed: { label: "Failed", tone: "attention" },
}

const CHANGE = { created: "Created", modified: "Modified", deleted: "Deleted" } as const

const mono = "font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"

/** What came of the run's work: its pull request, or why there is none. */
function Delivered({ run }: { run: RunOut }) {
  const url = pullRequestUrl(run.delivery)
  if (url && run.delivery.status === "pull_request")
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        Pull request #{run.delivery.number}
      </a>
    )
  if (run.delivery.status === "no_changes") return <>No changes to deliver</>
  if (run.delivery.status === "failed") return <>The branch or pull request could not be made</>
  return null
}

/** One approval request: exactly what would run, and the FDE's decision or the buttons to make it. */
function Approval({
  approval,
  waiting,
  deciding,
  onDecide,
}: {
  approval: ApprovalOut
  waiting: boolean
  deciding: boolean
  onDecide: (outcome: "approve" | "reject") => void
}) {
  // Both decisions ask first: approving runs the action, and one stray tap on a phone must not.
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null)
  const decided = approval.decision
  return (
    <Row>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-xs">{approval.title}</p>
        {decided ? (
          <Status tone={decided.outcome === "approved" ? "success" : "attention"}>
            {decided.outcome === "approved" ? "Approved" : "Rejected"},{" "}
            {shortDate(dayOf(decided.at))}
          </Status>
        ) : (
          <Status tone={waiting ? "attention" : "neutral"}>
            {waiting ? "Waiting for you" : "Not decided"}
          </Status>
        )}
      </div>
      <Quiet>
        {approval.action} · {approval.tool} · asked {shortDate(dayOf(approval.requested_at))}
      </Quiet>
      {/* The full input, as it will run: the title is only a summary. */}
      <pre className={`mt-2 max-h-56 overflow-auto rounded-lg border bg-raised p-2.5 ${mono}`}>
        {JSON.stringify(approval.input, null, 2)}
      </pre>
      {waiting && !decided && (
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2 max-[560px]:grid max-[560px]:grid-cols-1">
          {confirming ? (
            <>
              <p className="mr-auto text-xs">
                {confirming === "approve"
                  ? "Approve this action? It runs exactly as shown."
                  : "Reject this action? The run stops."}
              </p>
              <Button variant="ghost" onClick={() => setConfirming(null)} disabled={deciding}>
                Keep waiting
              </Button>
              <Button onClick={() => onDecide(confirming)} disabled={deciding}>
                {deciding ? "Sending…" : confirming === "approve" ? "Approve" : "Reject"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setConfirming("reject")} disabled={deciding}>
                Reject…
              </Button>
              <Button onClick={() => setConfirming("approve")} disabled={deciding}>
                Approve…
              </Button>
            </>
          )}
        </div>
      )}
    </Row>
  )
}

/**
 * An agent run (DESIGN.md §3): what it was asked, its approvals, plan, file changes, commands and result. While
 * it may change, it follows the run live and reads it again every few seconds.
 */
export function RunPage({ scope, runId }: { scope: ProjectScope; runId: AgentRunId }) {
  const queryClient = useQueryClient()
  const detail = useQuery(queries.run(scope, runId))
  const companies = useQuery(queries.companies())
  const following = detail.data ? isActive(detail.data.run.state) : false
  const live = useLiveEvents(scope, runId, following)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queries.run(scope, runId).queryKey }),
      queryClient.invalidateQueries({ queryKey: queries.runs(scope).queryKey }),
      queryClient.invalidateQueries({ queryKey: queries.activeRuns().queryKey }),
    ])
  const decide = useMutation({
    mutationFn: (v: { approval: ApprovalId; outcome: "approve" | "reject" }) =>
      api.decide(scope, runId, v.approval, v.outcome),
    onSettled: refresh,
  })
  const cancel = useMutation({ mutationFn: () => api.cancelRun(scope, runId), onSettled: refresh })

  if (detail.isPending)
    return (
      <Page>
        <Loading>Loading the run…</Loading>
      </Page>
    )
  if (isNotFound(detail.error)) return <NotFound what="run" />
  if (detail.isError)
    return (
      <Page>
        <Failed
          title="We couldn't load this run."
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </Page>
    )

  const { run, approvals, skipped } = detail.data
  const summary = summarize(mergeEvents(detail.data.events, live.events))
  const company = companies.data?.companies.find((c) => c.id === scope.company)
  const projectName = company?.projects.find((p) => p.id === scope.project)?.name ?? "Project"
  const state = RUN_STATE[run.state]
  const pending = approvals.filter((a) => !a.decision)
  const decided = approvals.filter((a) => a.decision)
  const failed = (mutation: { isError: boolean; error: unknown }, fallback: string) =>
    mutation.isError
      ? mutation.error instanceof ApiError && mutation.error.message !== mutation.error.code
        ? mutation.error.message
        : fallback
      : null
  const decideError = failed(decide, "Couldn't send your decision. Try again.")
  const cancelError = failed(cancel, "Couldn't cancel the run. Try again.")

  const approvalList = (list: Array<ApprovalOut>) => (
    <Rows label="Approval requests">
      {list.map((approval) => (
        <Approval
          key={approval.id}
          approval={approval}
          waiting={run.state === "waiting_for_approval" && run.pending_approval === approval.id}
          deciding={decide.isPending}
          onDecide={(outcome) => decide.mutate({ approval: approval.id, outcome })}
        />
      ))}
    </Rows>
  )

  return (
    <Page wide>
      <Link
        to="/companies/$companyId/projects/$projectId"
        params={{ companyId: scope.company, projectId: scope.project }}
        className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Icon name="chevron-left" size={14} strokeWidth={1.7} aria-hidden="true" />
        {projectName}
      </Link>

      <Card title="Task" aside={<Status tone={state.tone}>{state.label}</Status>}>
        <p className="text-xs leading-relaxed whitespace-pre-wrap">{run.task}</p>
        <Quiet className="mt-2">
          {[
            `${repoName(run.repository)} from ${run.repository.base}`,
            `Started ${shortDate(dayOf(run.started_at ?? run.created_at))}`,
            run.ended_at && `Ended ${shortDate(dayOf(run.ended_at))}`,
            `${(run.usage.input_tokens + run.usage.output_tokens).toLocaleString("en-GB")} tokens`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Quiet>
        {run.state === "failed" && <p className="mt-2 text-xs">{failureText(run.failure)}.</p>}
        {run.state === "finished" && (
          <p className="mt-2 text-xs">
            <Delivered run={run} />
          </p>
        )}
        {following && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Quiet>
              {live.live ? "Following live." : "Checking for new output every few seconds."}
            </Quiet>
            {confirmCancel ? (
              <span className="flex items-center gap-2">
                <span className="text-xs">Cancel this run?</span>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmCancel(false)}
                  disabled={cancel.isPending}
                >
                  Keep it
                </Button>
                <Button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                  Cancel run
                </Button>
              </span>
            ) : (
              <Button variant="outline" onClick={() => setConfirmCancel(true)}>
                Cancel…
              </Button>
            )}
          </div>
        )}
        {cancelError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {cancelError}
          </p>
        )}
      </Card>

      {pending.length > 0 && (
        <Card title="Waiting for approval">
          {approvalList(pending)}
          {decideError && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {decideError}
            </p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
        <Card title="Plan">
          {summary.plan.length === 0 ? (
            <Quiet>No plan yet.</Quiet>
          ) : (
            <Rows label="Plan">
              {summary.plan.map((entry, i) => (
                <Row key={i}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-xs">{entry.content}</p>
                    <Status tone={STEP[entry.status].tone}>{STEP[entry.status].label}</Status>
                  </div>
                </Row>
              ))}
            </Rows>
          )}
        </Card>

        <Card title="Files changed">
          {summary.changes.length === 0 ? (
            <Quiet>No files changed yet.</Quiet>
          ) : (
            <Rows label="Files changed">
              {summary.changes.map((file) => (
                <Row key={file.path}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className={`min-w-0 ${mono}`}>{file.path}</p>
                    <span className="flex-none text-[11px] text-soft">{CHANGE[file.change]}</span>
                  </div>
                </Row>
              ))}
            </Rows>
          )}
        </Card>
      </div>

      <Card title="Tests and commands">
        {summary.commands.length === 0 ? (
          <Quiet>No commands run yet.</Quiet>
        ) : (
          <Rows label="Tests and commands">
            {summary.commands.map((command) => (
              <Row key={command.seq}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className={`min-w-0 ${mono}`}>$ {command.command}</p>
                  <Status tone={COMMAND[command.status].tone}>
                    {COMMAND[command.status].label}
                  </Status>
                </div>
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <Card title="What the agent said">
        {summary.messages.length === 0 && !summary.result ? (
          <Quiet>Nothing yet.</Quiet>
        ) : (
          <Rows label="What the agent said">
            {summary.messages.map((message) => (
              <Row key={message.seq}>
                <p className="text-xs leading-relaxed whitespace-pre-wrap">{message.text}</p>
              </Row>
            ))}
            {summary.result && (
              <Row>
                <p className="text-xs font-semibold">Result</p>
                <p className="text-xs leading-relaxed whitespace-pre-wrap">{summary.result.text}</p>
                <Quiet>{summary.result.turns} turns</Quiet>
              </Row>
            )}
          </Rows>
        )}
        {skipped > 0 && (
          <Quiet className="mt-2">
            {skipped} {skipped === 1 ? "line" : "lines"} of this run's output could not be shown.
          </Quiet>
        )}
      </Card>

      {decided.length > 0 && <Card title="Decided approvals">{approvalList(decided)}</Card>}
    </Page>
  )
}

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import type { Ref } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ImportDialog, NewSuiteDialog } from "./eval-dialogs"
import { SuiteItem } from "./eval-suites"
import { Card, Failed, Loading, Quiet, Row, Rows, Status, reveal } from "./page"
import { Button } from "./ui/button"
import { api, evalsOff, queries } from "@/lib/api/client"
import type { EvalRunOut, SuiteOut } from "@/lib/api/evals"
import type { CriterionOut, ProjectScope, TaskOut } from "@/lib/api/schemas"
import { STATUS_LABEL } from "@/lib/board"
import { pollDelay } from "@/lib/documents"
import { commitRun, commitRunFinished } from "@/lib/proof-cache"
import {
  STATUS,
  counts,
  freshness,
  isRunning,
  proofs,
  targetText,
  trendText,
  valueText,
} from "@/lib/proof"
import type { Proof, TrendPoint } from "@/lib/proof"
import { reason } from "@/lib/task-move"
import { dayOf, shortDate } from "@/lib/time"

// Proof (DESIGN.md §3): for each success criterion, is it met and how do we know. A glance per criterion (met or
// not, the number against the target, how fresh, where it came from) and, behind it, the suites that measure it,
// their runs and the cases that failed. "Met" is the API's verdict, never worked out here (lib/proof.ts).

export type ProofHandle = {
  /** Scrolls the Proof card into view and focuses it. */
  show: () => void
}

/** What the Proof cards are doing in a dialog: a new suite, or a CSV for one. */
type Dialog =
  { kind: "suite"; chosen: Array<string> } | { kind: "cases" | "results"; suite: SuiteOut } | null

/**
 * The two cards, **Proof** (a row per criterion) and **Eval suites** (their depth), with the reads, the polling of
 * a run in flight and the dialogs they share. Where the API serves no evals, the cards say so and show only what the
 * API already holds.
 */
export function ProofSection({
  scope,
  criteria,
  tasks,
  handle,
}: {
  scope: ProjectScope
  criteria: ReadonlyArray<CriterionOut>
  /** The project's tasks, in its order: a row names those that work towards its criterion. */
  tasks: ReadonlyArray<TaskOut>
  handle?: Ref<ProofHandle>
}) {
  const client = useQueryClient()
  const suites = useQuery(queries.evalSuites(scope))
  const runs = useQuery(queries.evalRuns(scope))
  const room = useQuery(queries.room(scope))
  const card = useRef<HTMLElement>(null)
  useImperativeHandle(handle, () => ({ show: () => reveal(card.current) }))
  const [dialog, setDialog] = useState<Dialog>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [said, setSaid] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  const off = evalsOff(suites.error) || evalsOff(runs.error)
  const list = useMemo(() => suites.data ?? [], [suites.data])
  const history = useMemo(() => runs.data ?? [], [runs.data])
  const rows = useMemo(
    () => proofs(criteria, room.data?.criteria, list, history),
    [criteria, room.data, list, history],
  )

  // Said when a run that was going has ended, since nothing else on the page moves.
  const before = useRef<Map<string, EvalRunOut["state"]> | null>(null)
  useEffect(() => {
    if (!runs.data) return
    const was = before.current
    before.current = new Map(runs.data.map((r) => [r.id, r.state]))
    if (!was) return
    const done = runs.data.filter((r) => was.get(r.id) === "running" && r.state === "finished")
    const last = done[0]
    if (!last) return
    const name = list.find((s) => s.id === last.suite)?.name ?? "The suite"
    const c = counts(last)
    setSaid(
      done.length > 1
        ? `${done.length} runs have finished.`
        : `“${name}” has finished${c ? `: ${c.passed} of ${c.cases} cases passed` : ""}.`,
    )
  }, [runs.data, list])

  const start = useMutation({
    mutationFn: (suite: SuiteOut) => api.startEvalRun(scope, suite.id),
    onSuccess: (run) => commitRun(client, scope, run),
    onError: (error) => setRefused(reason(error, "suite")),
  })

  function open(
    kind: NonNullable<Dialog>["kind"],
    rest: { suite?: SuiteOut; chosen?: Array<string> },
  ) {
    setSaid(null)
    setRefused(null)
    opener.current = document.activeElement as HTMLElement | null
    setDialog(kind === "suite" ? { kind, chosen: rest.chosen ?? [] } : { kind, suite: rest.suite! })
  }
  function close() {
    setDialog(null)
    // Focus goes back to what opened the dialog, if it is still there.
    setTimeout(() => opener.current?.isConnected && opener.current.focus(), 0)
  }
  function showSuite(id: string) {
    setOpened((now) => new Set(now).add(id))
    // After it has opened, so the focus lands on its heading.
    setTimeout(() => {
      const el = document.getElementById(`suite-${id}`)
      el?.scrollIntoView({ block: "center", behavior: "auto" })
      el?.focus({ preventScroll: true })
    }, 0)
  }

  const running = history.filter(isRunning)
  const met = room.data ? room.data.criteria_passing : null

  return (
    <>
      <Card
        ref={card}
        title="Proof"
        aside={
          <span className="flex items-center gap-3">
            {met !== null && criteria.length > 0 && (
              <Status tone="neutral">{`${met} of ${criteria.length} met`}</Status>
            )}
            {!off && criteria.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => open("suite", { chosen: [] })}>
                New eval suite
              </Button>
            )}
          </span>
        }
      >
        {said && (
          <p role="status" className="mb-2 text-xs [overflow-wrap:anywhere] text-soft">
            {said}
          </p>
        )}
        {refused && (
          <p
            role="alert"
            className="mb-2 flex flex-wrap items-center gap-2 text-xs text-destructive"
          >
            {refused}
            <button type="button" className="underline" onClick={() => setRefused(null)}>
              Dismiss
            </button>
          </p>
        )}
        {running.map((run) => (
          <RunWatch key={run.id} scope={scope} run={run} />
        ))}
        {criteria.length === 0 ? (
          <Quiet>
            Proof is read against success criteria. Add one first, with a target the customer can
            check; an eval suite then grades cases against it.
          </Quiet>
        ) : (
          <>
            <Quiet className="mb-2.5">
              {off
                ? "Evals are not available in this environment, so a suite cannot be created, run or given results here. What the API already holds is shown."
                : "A run grades each case and gives each criterion the share that passed. Runs happen in the company's sandbox, on sample data only for now; results run elsewhere can be imported as a CSV."}
            </Quiet>
            {room.isError && (
              <p
                role="alert"
                className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              >
                We couldn't read whether the criteria are met.
                <Button variant="ghost" size="sm" onClick={() => void room.refetch()}>
                  Try again
                </Button>
              </p>
            )}
            {!off && (suites.isPending || runs.isPending) ? (
              <Loading>Reading the proof…</Loading>
            ) : (suites.isError && !off) || (runs.isError && !off) ? (
              <Failed
                title="We couldn't read the eval suites."
                error={suites.error ?? runs.error}
                onRetry={() => {
                  void suites.refetch()
                  void runs.refetch()
                }}
              />
            ) : (
              <Rows label="Success criteria and their proof">
                {rows.map((p) => (
                  <ProofRow
                    key={p.criterion.id}
                    proof={p}
                    tasks={tasks.filter((t) => t.criterion === p.criterion.id)}
                    suites={list}
                    off={off}
                    starting={start.isPending}
                    onNewSuite={() => open("suite", { chosen: [p.criterion.id] })}
                    onRun={(suite) => {
                      setSaid(null)
                      setRefused(null)
                      start.mutate(suite)
                    }}
                    onShowSuite={showSuite}
                  />
                ))}
              </Rows>
            )}
          </>
        )}
      </Card>

      {!off && criteria.length > 0 && !suites.isError && (
        <Card
          title="Eval suites"
          aside={
            <Button variant="outline" size="sm" onClick={() => open("suite", { chosen: [] })}>
              New eval suite
            </Button>
          }
        >
          {suites.isPending ? (
            <Loading>Reading the eval suites…</Loading>
          ) : list.length === 0 ? (
            <Quiet>
              No eval suite yet. A suite is a set of cases, the graders each case goes through and
              the criteria its pass rate is the result of.
            </Quiet>
          ) : (
            <Rows label="Eval suites">
              {list.map((suite) => (
                <SuiteItem
                  key={suite.id}
                  suite={suite}
                  runs={history.filter((r) => r.suite === suite.id)}
                  criteria={criteria}
                  open={opened.has(suite.id)}
                  onToggle={() =>
                    setOpened((now) => {
                      const next = new Set(now)
                      if (!next.delete(suite.id)) next.add(suite.id)
                      return next
                    })
                  }
                  actions={{
                    starting: start.isPending ? start.variables.id : null,
                    run: (s) => {
                      setSaid(null)
                      setRefused(null)
                      start.mutate(s)
                    },
                    importResults: (s) => open("results", { suite: s }),
                    addCases: (s) => open("cases", { suite: s }),
                  }}
                />
              ))}
            </Rows>
          )}
        </Card>
      )}

      {dialog?.kind === "suite" && (
        <NewSuiteDialog
          scope={scope}
          criteria={criteria}
          chosen={dialog.chosen}
          onCreated={(suite) => {
            setOpened((now) => new Set(now).add(suite.id))
            setSaid(
              `Created “${suite.name}”. Add its cases from a CSV, then run it or import results.`,
            )
          }}
          onClose={close}
        />
      )}
      {(dialog?.kind === "cases" || dialog?.kind === "results") && (
        <ImportDialog
          scope={scope}
          suite={dialog.suite}
          kind={dialog.kind}
          onDone={setSaid}
          onClose={close}
        />
      )}
    </>
  )
}

/**
 * Follows one run that has not finished: the run is read again after 2 seconds, then every 5, 15 and 30 as it goes
 * on, and it stops at fifteen minutes (a run that long is slow or stuck), when the run ends, when the page is left
 * and while the tab is hidden. A run is shown as finished only when this read says so.
 */
function RunWatch({ scope, run }: { scope: ProjectScope; run: EvalRunOut }) {
  const client = useQueryClient()
  const since = useRef(Date.now())
  const read = useQuery({
    ...queries.evalRun(scope, run.id),
    refetchInterval: (query) =>
      query.state.data?.state === "finished" ? false : pollDelay(Date.now() - since.current),
  })
  const finished = read.data?.state === "finished" ? read.data : null
  useEffect(() => {
    if (finished) void commitRunFinished(client, scope, finished)
  }, [finished, client, scope])
  const stalled =
    !finished && read.data !== undefined && pollDelay(read.dataUpdatedAt - since.current) === false
  if (!stalled) return null
  return (
    <p role="status" className="mb-2 flex flex-wrap items-center gap-2 text-xs text-soft">
      A run is taking longer than usual to finish.
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          since.current = Date.now()
          void read.refetch()
        }}
      >
        Check again
      </Button>
    </p>
  )
}

// ── One criterion ──────────────────────────────────────────────────────────

/** The trend: a few small bars, each a recent result's rate (0 to 1), oldest first. The values are in the text. */
function Trend({ trend }: { trend: ReadonlyArray<TrendPoint> }) {
  if (trend.length < 2) return null
  const text = trendText(trend)
  return (
    <span className="flex flex-none items-end gap-[3px]" title={text}>
      <span aria-hidden="true" className="flex h-5 items-end gap-[3px]">
        {trend.map((t, i) => (
          <span
            key={t.run}
            className={i === trend.length - 1 ? "w-2 bg-soft" : "w-2 bg-strong"}
            style={{
              height: `${Math.max(2, Math.round(Math.min(1, Math.max(0, t.rate)) * 20))}px`,
            }}
          />
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  )
}

/** How many linked tasks a row names before "and N more". */
const TASKS_SHOWN = 3

/** The tasks that work towards a criterion, in one line: each title with its status. */
function Linked({ tasks }: { tasks: ReadonlyArray<TaskOut> }) {
  if (tasks.length === 0) return null
  const named = tasks
    .slice(0, TASKS_SHOWN)
    .map((t) => `“${t.title}” (${STATUS_LABEL[t.status].toLowerCase()})`)
  const more = tasks.length - TASKS_SHOWN
  return (
    <Quiet className="[overflow-wrap:anywhere]">
      {tasks.length === 1 ? "Task towards it" : "Tasks towards it"}: {named.join(", ")}
      {more > 0 ? `, and ${more} more` : ""}.
    </Quiet>
  )
}

function ProofRow({
  proof: p,
  tasks,
  suites,
  off,
  starting,
  onNewSuite,
  onRun,
  onShowSuite,
}: {
  proof: Proof
  /** The project's tasks linked to this criterion. */
  tasks: ReadonlyArray<TaskOut>
  suites: ReadonlyArray<SuiteOut>
  off: boolean
  starting: boolean
  onNewSuite: () => void
  onRun: (suite: SuiteOut) => void
  onShowSuite: (id: string) => void
}) {
  // Where the API serves no evals, "no suite" would mislead: nothing can be measured here.
  const state =
    off && p.status === "no_suite"
      ? { tone: "neutral" as const, label: "Not measured" }
      : STATUS[p.status]
  const source = p.source ? suites.find((s) => s.id === p.source?.suite) : undefined
  // The next step for a criterion with no value: run the one suite that can be run, or go to the suites.
  const first = p.suites[0]
  const runnableSuite =
    p.suites.length === 1 && first?.target && first.cases.length > 0 ? first : undefined
  return (
    <Row>
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 flex-1 basis-56 text-xs [overflow-wrap:anywhere] whitespace-pre-line">
            {p.criterion.description}
          </p>
          <Status tone={state.tone}>{state.label}</Status>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <p className="text-xs">
            {p.value !== null ? (
              <>
                <strong className="text-[13px] font-semibold tabular-nums">
                  {valueText(p.value)}
                </strong>{" "}
                <span className="text-muted-foreground">against {targetText(p.criterion)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Target: {targetText(p.criterion)}</span>
            )}
          </p>
          <Trend trend={p.trend} />
        </div>
        {p.value !== null && p.measuredAt && (
          <Quiet className="[overflow-wrap:anywhere]">
            {[
              freshness(p.measuredAt),
              p.source && `${p.source.passed} of ${p.source.total} cases passed`,
              source
                ? `from “${source.name}”, ${p.source?.imported ? "results imported" : "run in the sandbox"}`
                : p.source
                  ? "from an eval run"
                  : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Quiet>
        )}
        {p.stale && (
          <p className="flex items-start gap-1.5 text-[11px] text-soft">
            <span
              aria-hidden="true"
              className="mt-1 size-1.5 flex-none rounded-full bg-attention"
            />
            Out of date. {p.stale}
          </p>
        )}
        {p.running && (
          <Quiet>
            A run started {shortDate(dayOf(p.running.created_at))} is being graded.{" "}
            {p.value !== null ? "The number above is the last finished result." : ""}
          </Quiet>
        )}
        {p.scale && <Quiet className="[overflow-wrap:anywhere]">{p.scale}</Quiet>}
        <Linked tasks={tasks} />
        {p.status === "no_suite" && !off && (
          <>
            <Quiet>
              Nothing measures this yet. An eval suite grades cases against it, and its pass rate
              becomes the result.
            </Quiet>
            <div>
              <Button variant="outline" size="sm" onClick={onNewSuite}>
                New eval suite for this
              </Button>
            </div>
          </>
        )}
        {p.status === "no_result" && !off && (
          <>
            <Quiet className="[overflow-wrap:anywhere]">
              {first && p.suites.length === 1
                ? `“${first.name}” has ${first.cases.length === 0 ? "no cases" : `${first.cases.length} ${first.cases.length === 1 ? "case" : "cases"}`} and has not been run.`
                : `${p.suites.length} suites measure it and none has a result.`}{" "}
              {runnableSuite
                ? "Run it, or import results from elsewhere."
                : first && first.cases.length === 0
                  ? "Add cases to it first."
                  : "Import results from elsewhere to grade."}
            </Quiet>
            <div className="flex flex-wrap items-center gap-2">
              {runnableSuite && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={starting || p.running !== null}
                  onClick={() => onRun(runnableSuite)}
                  aria-label={`Run ${runnableSuite.name}`}
                >
                  Run in the sandbox
                </Button>
              )}
              {first && (
                <Button variant="ghost" size="sm" onClick={() => onShowSuite(first.id)}>
                  Open the suite
                </Button>
              )}
            </div>
          </>
        )}
        {p.value !== null && p.suites.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[11px] text-muted-foreground">
              {p.suites.length === 1 ? "Suite" : "Suites"}
            </span>
            {p.suites.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onShowSuite(s.id)}
                aria-label={`Open the suite ${s.name}`}
                className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </Row>
  )
}

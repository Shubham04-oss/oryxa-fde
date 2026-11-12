import { useState } from "react"
import { LongText } from "./long-text"
import { Quiet, Row, Rows, Status } from "./page"
import { Button } from "./ui/button"
import type { Case, CaseResult, EvalRunOut, SuiteOut } from "@/lib/api/evals"
import type { CriterionOut } from "@/lib/api/schemas"
import { uploader } from "@/lib/documents"
import {
  OUTCOME,
  counts,
  countsText,
  graderDetail,
  graderName,
  isRunning,
  runSource,
  runnable,
  splitCases,
  valueText,
  verdictText,
} from "@/lib/proof"
import { dayOf, shortDate } from "@/lib/time"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

// An eval suite and what hangs off it (DESIGN.md §3, Proof): its graders and where outputs come from, its runs, and
// for a run its cases, the ones that did not pass first with each grader's reason. Everything from a case, a model
// or an imported file is untrusted: it is shown as text only, long ones folded.

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`

/** "5 Nov 2026" for a timestamp. */
const dayText = (instant: string) => shortDate(dayOf(instant))

/** A button that opens and closes what is under it, its state said for a screen reader. */
export function Disclosure({
  open,
  onToggle,
  controls,
  children,
  className,
}: {
  open: boolean
  onToggle: () => void
  controls: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "group flex w-full items-start gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <Icon
        name={open ? "chevron-down" : "chevron-right"}
        size={14}
        strokeWidth={1.7}
        aria-hidden="true"
        className="mt-0.5 flex-none text-muted-foreground"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

export type SuiteActions = {
  /** Starts a run in the sandbox; the API answers once it is queued. */
  run: (suite: SuiteOut) => void
  importResults: (suite: SuiteOut) => void
  addCases: (suite: SuiteOut) => void
  /** The suite a run was just started for, while the API has not answered. */
  starting: string | null
}

export function SuiteItem({
  suite,
  runs,
  criteria,
  me,
  open,
  onToggle,
  actions,
}: {
  suite: SuiteOut
  /** This suite's runs, newest first. */
  runs: ReadonlyArray<EvalRunOut>
  criteria: ReadonlyArray<CriterionOut>
  me: string | undefined
  open: boolean
  onToggle: () => void
  actions: SuiteActions
}) {
  const body = `suite-${suite.id}-body`
  const latest = runs[0]
  const measures = suite.criteria
    .map((id) => criteria.find((c) => c.id === id)?.description)
    .filter((d): d is string => d !== undefined)
  const busy = runs.some(isRunning) || actions.starting === suite.id
  const cannot = runnable(suite)
  return (
    <Row>
      <div id={`suite-${suite.id}`} tabIndex={-1} className="grid gap-2 outline-none">
        <Disclosure open={open} onToggle={onToggle} controls={body}>
          <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="text-xs [overflow-wrap:anywhere] group-hover:underline group-hover:underline-offset-2">
              {suite.name}
            </span>
            {latest && <RunStatus run={latest} />}
          </span>
          <Quiet className="[overflow-wrap:anywhere]">
            {[
              plural(suite.cases.length, "case"),
              suite.target ? "run in the company's sandbox" : "results imported",
              measures.length > 0 && `measures ${measures.join("; ")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Quiet>
        </Disclosure>
        {open && (
          <div id={body} className="grid gap-3 pl-[22px]">
            <Setup suite={suite} />
            <div className="flex flex-wrap items-center gap-2">
              {suite.target && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || cannot !== null}
                  onClick={() => actions.run(suite)}
                  aria-label={`Run ${suite.name}`}
                >
                  {actions.starting === suite.id ? "Starting…" : "Run in the sandbox"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={suite.cases.length === 0}
                onClick={() => actions.importResults(suite)}
                aria-label={`Import results for ${suite.name}`}
              >
                Import results
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => actions.addCases(suite)}
                aria-label={`Add cases to ${suite.name}`}
              >
                Add cases
              </Button>
            </div>
            {cannot && suite.target && <Quiet>Cannot run yet. {cannot}</Quiet>}
            {suite.cases.length === 0 && (
              <Quiet>
                No cases yet. Add them from a CSV: columns input, expected, id and criteria.
              </Quiet>
            )}
            <Runs suite={suite} runs={runs} criteria={criteria} me={me} />
            {suite.cases.length > 0 && <CaseList cases={suite.cases} />}
          </div>
        )}
      </div>
    </Row>
  )
}

/** A run's state, a dot and words: finished only when the API says so. */
function RunStatus({ run }: { run: EvalRunOut }) {
  if (isRunning(run)) return <Status tone="neutral">Running</Status>
  const c = counts(run)
  return (
    <Status tone="neutral">
      {`Last run ${dayText(run.ended_at ?? run.created_at)}`}
      {c ? `: ${c.passed} of ${c.cases} passed` : ""}
    </Status>
  )
}

/** Where outputs come from, and the graders: what the suite is, as text. */
function Setup({ suite }: { suite: SuiteOut }) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <p className="text-[11px] text-muted-foreground">Outputs</p>
        {suite.target ? (
          <p className="text-xs [overflow-wrap:anywhere]">
            <code className="font-mono text-[11px]">{suite.target.argv.join(" ")}</code> in the
            company's sandbox, on sample data only for now (stops after {suite.target.timeout_secs}
            s).
          </p>
        ) : (
          <p className="text-xs">
            Imported: run your system anywhere and import a CSV of its outputs.
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <p className="text-[11px] text-muted-foreground">
          {suite.graders.length === 1 ? "Grader" : "Graders"}
          {suite.graders.length > 1 && ", all must pass"}
        </p>
        <ul className="grid gap-1.5">
          {suite.graders.map((g, i) => {
            const detail = graderDetail(g)
            return (
              <li key={i} className="grid gap-1">
                <p className="text-xs">{graderName(g)}</p>
                {detail && g.kind !== "exact_match" && <LongText text={detail} label="text" />}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** The runs of a suite, newest first, and the one selected in full. */
function Runs({
  suite,
  runs,
  criteria,
  me,
}: {
  suite: SuiteOut
  runs: ReadonlyArray<EvalRunOut>
  criteria: ReadonlyArray<CriterionOut>
  me: string | undefined
}) {
  const [chosen, setChosen] = useState<string | null>(null)
  if (runs.length === 0)
    return <Quiet>No runs yet. A run grades every case and gives each criterion its result.</Quiet>
  const run = runs.find((r) => r.id === chosen) ?? runs[0]!
  return (
    <div className="grid gap-2">
      <p className="text-[11px] text-muted-foreground">Runs, newest first</p>
      <Rows label={`Runs of ${suite.name}`}>
        {runs.map((r) => {
          const c = counts(r)
          const on = r.id === run.id
          return (
            <li key={r.id} className="py-1 first:pt-0 last:pb-0">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => setChosen(r.id)}
                className={cn(
                  "flex w-full flex-wrap items-baseline justify-between gap-x-3 rounded-md px-1.5 py-1 text-left text-[11px] outline-none hover:bg-selected focus-visible:ring-1 focus-visible:ring-ring",
                  on && "bg-selected",
                )}
              >
                <span>
                  {dayText(r.created_at)} · {r.imported ? "imported" : "sandbox"}
                </span>
                <span className="text-muted-foreground">
                  {isRunning(r) ? "Running" : c ? countsText(c) : "Finished"}
                </span>
              </button>
            </li>
          )
        })}
      </Rows>
      <RunPanel suite={suite} run={run} criteria={criteria} me={me} />
    </div>
  )
}

/** One run in full: its state, where its outputs came from, each criterion's result, and its cases. */
export function RunPanel({
  suite,
  run,
  criteria,
  me,
}: {
  suite: SuiteOut
  run: EvalRunOut
  criteria: ReadonlyArray<CriterionOut>
  me: string | undefined
}) {
  const report = run.report
  const c = counts(run)
  return (
    <section
      aria-label={`Run of ${dayText(run.created_at)}`}
      className="grid gap-2 rounded-xl border bg-raised px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Status tone="neutral">{isRunning(run) ? "Running" : "Finished"}</Status>
        <Quiet>
          Started {dayText(run.created_at)} by {uploader(run.created_by, me)} · {runSource(run)}
        </Quiet>
      </div>
      {isRunning(run) ? (
        <Quiet>
          Being graded. A run ends when the API records its report; this page asks again every few
          seconds and stops when it has ended.
        </Quiet>
      ) : (
        <>
          {run.ended_at && <Quiet>Finished {dayText(run.ended_at)}.</Quiet>}
          {c && <p className="text-xs">{countsText(c)}.</p>}
          {report && report.criteria.length > 0 && (
            <ul className="grid gap-0.5 text-xs">
              {report.criteria.map((rate) => (
                <li key={rate.criterion} className="[overflow-wrap:anywhere]">
                  {criteria.find((k) => k.id === rate.criterion)?.description ?? "A criterion"}:{" "}
                  {rate.total === 0
                    ? "no case measured it"
                    : `${rate.passed} of ${rate.total} cases passed (${valueText(rate.rate)})`}
                </li>
              ))}
            </ul>
          )}
          {report && <Results report={report} suite={suite} />}
        </>
      )}
    </section>
  )
}

/** The cases of a finished run: those that did not pass first, the rest under one button. */
function Results({
  report,
  suite,
}: {
  report: NonNullable<EvalRunOut["report"]>
  suite: SuiteOut
}) {
  const { notPassed, passed } = splitCases(report)
  const [all, setAll] = useState(false)
  return (
    <div className="grid gap-1.5">
      {notPassed.length === 0 ? (
        <Quiet>Every case passed.</Quiet>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            {plural(notPassed.length, "case")} did not pass
          </p>
          <CaseResults results={notPassed} suite={suite} />
        </>
      )}
      {passed.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className="w-fit text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {all
              ? "Hide the cases that passed"
              : `Show the ${plural(passed.length, "case")} that passed`}
          </button>
          {all && <CaseResults results={passed} suite={suite} />}
        </>
      )}
    </div>
  )
}

const PAGE = 20

/** Cases a page at a time: a suite can hold thousands. */
function CaseResults({ results, suite }: { results: ReadonlyArray<CaseResult>; suite: SuiteOut }) {
  const [shown, setShown] = useState(PAGE)
  return (
    <div className="grid gap-1">
      <ul className="grid gap-1">
        {results.slice(0, shown).map((r) => (
          <ResultRow key={r.case} result={r} suite={suite} />
        ))}
      </ul>
      {results.length > shown && (
        <button
          type="button"
          onClick={() => setShown(shown + PAGE)}
          className="w-fit text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Show {Math.min(PAGE, results.length - shown)} more of {results.length - shown}
        </button>
      )}
    </div>
  )
}

/** One case's result, folded: the case, its outcome, and on open the input, output and each grader's say. */
function ResultRow({ result, suite }: { result: CaseResult; suite: SuiteOut }) {
  const [open, setOpen] = useState(false)
  const body = `result-${suite.id}-${result.case}`
  const given = suite.cases.find((c) => c.id === result.case)
  const outcome = OUTCOME[result.outcome]
  return (
    <li className="rounded-lg border bg-card px-3 py-2">
      <Disclosure open={open} onToggle={() => setOpen(!open)} controls={body}>
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <span className="font-mono text-[11px] [overflow-wrap:anywhere]">{result.case}</span>
          <Status tone={outcome.tone}>{outcome.label}</Status>
        </span>
      </Disclosure>
      {open && (
        <div id={body} className="mt-2 grid gap-2 pl-[22px]">
          {given && <Given given={given} />}
          {result.error && (
            <div className="grid gap-0.5">
              <p className="text-[11px] text-muted-foreground">Why there is no output</p>
              <p className="text-xs [overflow-wrap:anywhere]">{result.error}</p>
            </div>
          )}
          {result.output != null && (
            <div className="grid gap-0.5">
              <p className="text-[11px] text-muted-foreground">Output</p>
              <LongText text={result.output} label="output" />
            </div>
          )}
          {result.verdicts.length > 0 && (
            <div className="grid gap-1">
              <p className="text-[11px] text-muted-foreground">Graders</p>
              <ul className="grid gap-1">
                {result.verdicts.map((v, i) => {
                  const grader = suite.graders[i]
                  return (
                    <li key={i} className="grid gap-0.5">
                      <span className="flex items-center gap-1.5 text-xs">
                        <Status tone={v.verdict === "passed" ? "success" : "attention"}>
                          {grader ? graderName(grader) : `Grader ${i + 1}`}
                        </Status>
                      </span>
                      <LongText text={verdictText(v)} label="reason" />
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function Given({ given }: { given: Case }) {
  return (
    <>
      <div className="grid gap-0.5">
        <p className="text-[11px] text-muted-foreground">Input</p>
        <LongText text={given.input} label="input" />
      </div>
      {given.expected != null && (
        <div className="grid gap-0.5">
          <p className="text-[11px] text-muted-foreground">Expected</p>
          <LongText text={given.expected} label="expected output" />
        </div>
      )}
    </>
  )
}

/** The suite's cases, a page at a time, folded under one button. */
function CaseList({ cases }: { cases: ReadonlyArray<Case> }) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(PAGE)
  return (
    <div className="grid gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-fit text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {open ? "Hide the cases" : `Show the ${plural(cases.length, "case")}`}
      </button>
      {open && (
        <ul className="grid gap-1.5">
          {cases.slice(0, shown).map((c) => (
            <li key={c.id} className="grid gap-1 rounded-lg border bg-card px-3 py-2">
              <p className="font-mono text-[11px] [overflow-wrap:anywhere]">{c.id}</p>
              <LongText text={c.input} label="input" />
              {c.expected != null && <LongText text={c.expected} label="expected output" />}
              {c.criteria && c.criteria.length > 0 && (
                <Quiet className="[overflow-wrap:anywhere]">Measures {c.criteria.join(", ")}</Quiet>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && cases.length > shown && (
        <button
          type="button"
          onClick={() => setShown(shown + PAGE)}
          className="w-fit text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Show {Math.min(PAGE, cases.length - shown)} more of {cases.length - shown}
        </button>
      )}
    </div>
  )
}

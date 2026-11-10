import type { Tone } from "@/components/page"
import type { CriterionOut } from "./api/schemas"
import type {
  CaseResult,
  EvalRunId,
  EvalRunOut,
  Grader,
  RoomCriterion,
  SuiteOut,
  Verdict,
} from "./api/evals"
import { COMPARATOR_LABEL } from "./scope"
import { dayOf, daysBetween, localDay, shortDate } from "./time"

// What the Proof card says about a criterion (DESIGN.md §3, Proof): whether it is met, by what, how fresh the
// result is and where it came from. "Met" is never worked out here. The API judges it (`passing`, on the room's
// criteria: the same rule that drives the stage checklist's "Every criterion meets its target" and the "ready to
// deploy" suggestion, `ProjectTx::criteria_met` in oryxa-fde-store). The page only reads it, and finds which run
// the number came from.

/** How many recent results the trend shows. */
export const TREND_POINTS = 8
/** A result this many days old is called out of date. */
export const STALE_DAYS = 14

export type ProofStatus =
  /** The API says the latest value meets the target. */
  | "met"
  /** There is a value and the API says it does not meet the target. */
  | "not_met"
  /** A suite measures it, but no finished run has produced a value. */
  | "no_result"
  /** No suite measures it. */
  | "no_suite"
  /** The page could not read the API's verdict. */
  | "unknown"

export const STATUS: Record<ProofStatus, { tone: Tone; label: string }> = {
  met: { tone: "success", label: "Met" },
  // Failing is amber, as everywhere (red is for errors).
  not_met: { tone: "attention", label: "Not met" },
  no_result: { tone: "neutral", label: "No result yet" },
  no_suite: { tone: "neutral", label: "No eval suite" },
  unknown: { tone: "neutral", label: "Not read yet" },
}

/** One finished run's value for a criterion: the API's own `passed`, `total` and `rate`. */
export type TrendPoint = {
  run: EvalRunId
  suite: string
  at: string
  passed: number
  total: number
  rate: number
  imported: boolean
}

export type Proof = {
  criterion: CriterionOut
  status: ProofStatus
  /** The API's latest value for it, null until one exists. */
  value: number | null
  measuredAt: string | null
  /** The suites that measure it, newest first. */
  suites: ReadonlyArray<SuiteOut>
  /** The run the value came from, when the page can tell: the newest finished run, if its rate is the API's value. */
  source: TrendPoint | null
  /** Recent finished results, oldest first. */
  trend: ReadonlyArray<TrendPoint>
  /** A run of a suite that measures it that has not finished. */
  running: EvalRunOut | null
  /** Why the result may be out of date, in words, or null. */
  stale: string | null
  /** Why the target cannot be reached by a pass rate, or null. */
  scale: string | null
}

const when = (run: EvalRunOut) => run.ended_at ?? run.created_at

/** The value as a person reads it: two places, no trailing zeros ("0.74", "1"). */
export const valueText = (n: number) => String(Number(n.toFixed(2)))

/** "at least 0.7 pass rate": the target as the API holds it, with its unit. */
export function targetText(c: Pick<CriterionOut, "comparator" | "target" | "unit">) {
  const unit = c.unit ? (c.unit === "%" ? "%" : ` ${c.unit}`) : ""
  return `${COMPARATOR_LABEL[c.comparator].toLowerCase()} ${c.target}${unit}`
}

/**
 * The API compares a criterion's value, a pass rate from 0 to 1, with the target as written. A target a rate can
 * never reach (at least 70, written as a percentage) is never met, so the page says so rather than leave the
 * criterion failing without a reason.
 */
export function scaleNote(c: Pick<CriterionOut, "comparator" | "target">): string | null {
  if (c.comparator === "at_least" && c.target > 1)
    return `A pass rate runs from 0 to 1, so at least ${c.target} can never be met. Write the target as ${valueText(c.target / 100)} instead.`
  if (c.comparator === "at_most" && c.target < 0)
    return `A pass rate runs from 0 to 1, so at most ${c.target} can never be met.`
  return null
}

/** How old a result is, from the API's timestamp: "Measured 3 Nov 2026, 6 days ago". */
export function freshness(measuredAt: string, now = new Date()) {
  const days = Math.max(0, daysBetween(dayOf(measuredAt), localDay(now)))
  const age = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
  return days === 0 ? "Measured today" : `Measured ${shortDate(dayOf(measuredAt))}, ${age}`
}

/** The proof for every criterion, from what the API sent. `room` is the API's verdict; the rest says where it came from. */
export function proofs(
  criteria: ReadonlyArray<CriterionOut>,
  room: ReadonlyArray<RoomCriterion> | undefined,
  suites: ReadonlyArray<SuiteOut>,
  runs: ReadonlyArray<EvalRunOut>,
  now = new Date(),
): Array<Proof> {
  return criteria.map((criterion) => {
    const mine = suites.filter((s) => s.criteria.includes(criterion.id))
    const ids = new Set(mine.map((s) => s.id as string))
    const ofMine = runs.filter((r) => ids.has(r.suite))
    const trend = ofMine
      .flatMap((run) => {
        const rate = run.report?.criteria.find((c) => c.criterion === criterion.id)
        // A run in which no case measured the criterion has no value for it: the API keeps the last measured one.
        return rate && rate.total > 0
          ? [
              {
                run: run.id,
                suite: run.suite,
                at: when(run),
                passed: rate.passed,
                total: rate.total,
                rate: rate.rate,
                imported: run.imported,
              },
            ]
          : []
      })
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const got = room?.find((r) => r.criterion.id === criterion.id)
    const value = got?.latest ?? null
    const measuredAt = got?.measured_at ?? null
    const status: ProofStatus = !room
      ? "unknown"
      : value !== null
        ? got?.passing === true
          ? "met"
          : "not_met"
        : mine.length > 0
          ? "no_result"
          : "no_suite"
    const last = trend.at(-1) ?? null
    const days = measuredAt ? daysBetween(dayOf(measuredAt), localDay(now)) : 0
    return {
      criterion,
      status,
      value,
      measuredAt,
      suites: mine,
      source: last && value !== null && Math.abs(last.rate - value) < 1e-9 ? last : null,
      trend: trend.slice(-TREND_POINTS),
      running: ofMine.find((r) => r.state === "running") ?? null,
      stale:
        value === null || !measuredAt
          ? null
          : Date.parse(criterion.updated_at) > Date.parse(measuredAt)
            ? "The criterion was changed after this was measured."
            : days >= STALE_DAYS
              ? `This result is ${days} days old.`
              : null,
      scale: value !== null || mine.length > 0 ? scaleNote(criterion) : null,
    }
  })
}

/** A short text a screen reader gets for the trend marks: every value, oldest first. */
export const trendText = (trend: ReadonlyArray<TrendPoint>) =>
  trend.length === 0
    ? "No earlier results."
    : `Recent results, oldest first: ${trend.map((t) => `${valueText(t.rate)} (${t.passed} of ${t.total})`).join(", ")}.`

// ── Suites and runs ────────────────────────────────────────────────────────

/** A grader, in a few words: what it is. */
export function graderName(g: Grader): string {
  switch (g.kind) {
    case "exact_match":
      return g.ignore_case ? "Exact match, ignoring case" : "Exact match"
    case "regex":
      return "Regular expression"
    case "json_schema":
      return "JSON schema"
    case "script":
      return "Script in the sandbox"
    case "judge":
      return "Model judge"
  }
}

/** What a grader checks, as text: the pattern, the command, the rubric. Never markup. */
export function graderDetail(g: Grader): string | null {
  switch (g.kind) {
    case "exact_match":
      return "The output equals the case's expected output, ignoring whitespace at the ends."
    case "regex":
      return g.pattern
    case "json_schema":
      return JSON.stringify(g.schema)
    case "script":
      return `${g.argv.join(" ")} (stops after ${g.timeout_secs}s; exit code 0 passes)`
    case "judge":
      return g.rubric
  }
}

export const OUTCOME: Record<CaseResult["outcome"], { tone: Tone; label: string }> = {
  passed: { tone: "success", label: "Passed" },
  failed: { tone: "attention", label: "Failed" },
  // The grader or the target could not decide; counted as not passed.
  errored: { tone: "attention", label: "Could not be graded" },
}

/** What a verdict says, in words: a failing or errored one carries the grader's reason. */
export function verdictText(v: Verdict): string {
  if (v.verdict === "passed")
    return v.score == null ? "Passed" : `Passed, score ${valueText(v.score)}`
  return `${v.verdict === "failed" ? "Failed" : "Could not decide"}: ${v.reason}`
}

export const isRunning = (run: Pick<EvalRunOut, "state">) => run.state === "running"

/** A run's counts, from its report: the API's `passed`, `failed` and `errored`. Null while it has none. */
export function counts(run: Pick<EvalRunOut, "report">) {
  const r = run.report
  if (!r) return null
  return { passed: r.passed, failed: r.failed, errored: r.errored, cases: r.cases.length }
}

/** "31 passed, 8 failed, 3 could not be graded". */
export function countsText(c: NonNullable<ReturnType<typeof counts>>) {
  return [
    `${c.passed} passed`,
    c.failed > 0 && `${c.failed} failed`,
    c.errored > 0 && `${c.errored} could not be graded`,
  ]
    .filter(Boolean)
    .join(", ")
}

/** The cases that did not pass, then those that did, each in the run's order. */
export function splitCases(report: NonNullable<EvalRunOut["report"]>) {
  return {
    notPassed: report.cases.filter((c) => c.outcome !== "passed"),
    passed: report.cases.filter((c) => c.outcome === "passed"),
  }
}

/** Where a run's outputs came from. */
export const runSource = (run: Pick<EvalRunOut, "imported">) =>
  run.imported ? "Results imported from elsewhere" : "Run in the company's sandbox"

/** What a suite does when asked to run: needs a target command and at least one case. */
export function runnable(s: Pick<SuiteOut, "target" | "cases">): string | null {
  if (!s.target) return "It has no target command. Import results to grade."
  if (s.cases.length === 0) return "It has no cases yet. Add them from a CSV."
  return null
}

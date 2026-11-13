import { STAGES } from "./api/schemas"
import type { CriterionOut, Stage, TaskOut } from "./api/schemas"
import { daysBetween, dayOf } from "./time"

// The round 2 project page prototype (DESIGN.md "Round 2", issue #262): what it reads from the address,
// what it puts first, and the geometry of its pictures. Dev mock only; nothing here decides a verdict.

export const TABS = ["overview", "plan", "proof", "access", "notes", "agent"] as const
export type Tab = (typeof TABS)[number]

export const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  plan: "Plan",
  proof: "Proof",
  access: "Access",
  notes: "Notes and decisions",
  agent: "Agent",
}

/** The tab named in the address, or Overview for anything else. */
export const tabOf = (value: unknown): Tab =>
  TABS.includes(value as Tab) ? (value as Tab) : "overview"

export const LOOKS = ["a", "b"] as const
export type Look = (typeof LOOKS)[number]

/** The look named in the address (`?look=b`), or "a" for anything else. */
export const lookOf = (value: unknown): Look => (value === "b" ? "b" : "a")

// ── Proof as a picture ─────────────────────────────────────────────────────

/** Where the marks sit on a criterion's track, in percent from the left; the right is always better. */
export type Track = {
  baseline: number | null
  current: number | null
  target: number
}

const pct = (n: number) => Math.round(n * 1000) / 10

/**
 * A criterion's baseline, current value and target on one line, oriented so that better is to the right
 * ("at most" targets are flipped), with room past the target for the zone where it is met.
 */
export function trackOf(
  c: Pick<CriterionOut, "comparator" | "target" | "baseline">,
  current: number | null,
): Track {
  const sign = c.comparator === "at_least" ? 1 : -1
  const t = c.target * sign
  const b = c.baseline == null ? null : c.baseline * sign
  const v = current == null ? null : current * sign
  const values = [t, ...(b === null ? [] : [b]), ...(v === null ? [] : [v])]
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi === lo) {
    // Only the target is known: put it most of the way along.
    const k = Math.abs(t) || 1
    lo = t - k
    hi = t + k / 4
  } else {
    const pad = (hi - lo) * 0.12
    lo -= pad
    hi += pad
  }
  const at = (x: number) => pct((x - lo) / (hi - lo))
  return { baseline: b === null ? null : at(b), current: v === null ? null : at(v), target: at(t) }
}

/** Points of a small trend line for pass rates (0 to 1), oldest first, in a `width` by `height` box. */
export function sparkPoints(
  rates: ReadonlyArray<number>,
  width: number,
  height: number,
  inset = 3,
) {
  if (rates.length === 0) return []
  const step = rates.length === 1 ? 0 : (width - inset * 2) / (rates.length - 1)
  return rates.map((r, i) => ({
    x: Math.round((rates.length === 1 ? width / 2 : inset + i * step) * 10) / 10,
    y: Math.round((inset + (1 - Math.min(1, Math.max(0, r))) * (height - inset * 2)) * 10) / 10,
  }))
}

// ── What needs attention ───────────────────────────────────────────────────

export type Attention = {
  task: TaskOut
  kind: "blocked" | "overdue" | "waiting"
  /** Days overdue, or days waiting; 0 for blocked. */
  days: number
}

/** Blocked tasks, then overdue (the latest first), then waiting on the customer (the longest first). */
export function attention(tasks: ReadonlyArray<TaskOut>, today: string): Array<Attention> {
  const rank = { blocked: 0, overdue: 1, waiting: 2 } as const
  return tasks
    .flatMap((task): Array<Attention> => {
      if (task.status === "done") return []
      if (task.status === "blocked") return [{ task, kind: "blocked", days: 0 }]
      if (task.due_on && task.due_on < today)
        return [{ task, kind: "overdue", days: daysBetween(task.due_on, today) }]
      if (task.status === "waiting_on_customer")
        return [
          {
            task,
            kind: "waiting",
            days: task.waiting_since
              ? Math.max(0, daysBetween(dayOf(task.waiting_since), today))
              : 0,
          },
        ]
      return []
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.days - a.days)
}

/**
 * The plan's next open tasks, in the project's order, leaving out the next step (the header has it) and
 * what already needs attention.
 */
export function comingUp(
  tasks: ReadonlyArray<TaskOut>,
  skip: ReadonlySet<string>,
  most = 4,
): Array<TaskOut> {
  return tasks
    .filter((t) => (t.status === "todo" || t.status === "in_progress") && !skip.has(t.id))
    .slice(0, most)
}

/** A due day for a column: "Today", "Tomorrow", "In 4 days", "Overdue 2 days". */
export function dueShort(due: string, today: string) {
  const days = daysBetween(today, due)
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  if (days < 0) return `Overdue ${-days} ${days === -1 ? "day" : "days"}`
  return `In ${days} days`
}

/** A value with its criterion's unit: "45 min", "0.42", "80%". */
export function withUnit(text: string, unit: string | null | undefined) {
  return unit ? (unit === "%" ? `${text}%` : `${text} ${unit}`) : text
}

// ── Set up next ────────────────────────────────────────────────────────────

export type Gap =
  | "name-people"
  | "write-note"
  | "assign"
  | "add-scope"
  | "add-criterion"
  | "add-baseline"
  | "request-access"
  | "add-suite"

/** What the page knows about a project; null where it has not been read (then nothing is claimed missing). */
export type Facts = {
  stakeholders: number
  inScope: number
  criteria: number
  /** Criteria with no baseline measured. */
  withoutBaseline: number
  access: number
  notes: number | null
  suites: number | null
  assignees: number | null
}

const GAPS: ReadonlyArray<{
  gap: Gap
  stage: Stage
  missing: (f: Facts) => boolean
  /** The stage checklist item that already asks for it, if any. */
  checklist?: string
}> = [
  {
    gap: "name-people",
    stage: "discover",
    missing: (f) => f.stakeholders === 0,
    checklist: "stakeholders_named",
  },
  { gap: "assign", stage: "discover", missing: (f) => f.assignees === 0 },
  {
    gap: "write-note",
    stage: "discover",
    missing: (f) => f.notes === 0,
    checklist: "discovery_notes",
  },
  { gap: "add-scope", stage: "scope", missing: (f) => f.inScope === 0 },
  {
    gap: "add-criterion",
    stage: "scope",
    missing: (f) => f.criteria === 0,
    checklist: "criteria_have_targets",
  },
  { gap: "add-baseline", stage: "scope", missing: (f) => f.withoutBaseline > 0 },
  { gap: "request-access", stage: "access", missing: (f) => f.access === 0 },
  {
    gap: "add-suite",
    stage: "build",
    missing: (f) => f.criteria > 0 && f.suites === 0,
    checklist: "criteria_have_evals",
  },
]

/**
 * The few most useful missing things, ordered by the current stage: this stage's first, then what an
 * earlier stage left (the nearest first), then what the next stages will need. A gap the stage checklist
 * already asks for is left to the checklist.
 */
export function setUpNext(
  facts: Facts,
  stage: Stage,
  openChecklist: ReadonlySet<string>,
  most = 3,
): Array<Gap> {
  const here = STAGES.indexOf(stage)
  const order = (s: Stage) => {
    const d = STAGES.indexOf(s) - here
    return d === 0 ? 0 : d < 0 ? 10 - d : 100 + d
  }
  return GAPS.filter((g) => g.missing(facts) && !(g.checklist && openChecklist.has(g.checklist)))
    .map((g, i) => ({ g, i }))
    .sort((a, b) => order(a.g.stage) - order(b.g.stage) || a.i - b.i)
    .slice(0, most)
    .map(({ g }) => g.gap)
}

/** The stage a gap belongs to, shown beside it. */
export const gapStage = (gap: Gap): Stage => GAPS.find((g) => g.gap === gap)?.stage ?? "discover"

export const GAP_TEXT: Record<Gap, { title: string; action: string }> = {
  "name-people": { title: "Name who you work with", action: "Add people" },
  assign: { title: "Assign an engineer", action: "Assign" },
  "write-note": { title: "Write up the first call", action: "Write a note" },
  "add-scope": { title: "Write down what is in scope", action: "Add to scope" },
  "add-criterion": { title: "Say what success looks like", action: "Add criterion" },
  "add-baseline": { title: "Measure a baseline", action: "Open criteria" },
  "request-access": { title: "Ask for the access the work needs", action: "Request access" },
  "add-suite": { title: "Set up an eval for each criterion", action: "Open proof" },
}

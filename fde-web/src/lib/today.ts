import type { components } from "./api/fde-api.gen"
import type { AccessState, TaskState, TodayItem } from "./api/schemas"

export type AccessBody = components["schemas"]["AccessRequestBody"]

export type TodayGroup = "blocked" | "due" | "waiting"

export const TODAY_GROUPS: Array<{ key: TodayGroup; title: string; empty: string }> = [
  { key: "blocked", title: "Blocked", empty: "Nothing is blocked." },
  { key: "due", title: "Due", empty: "Nothing is due today." },
  {
    key: "waiting",
    title: "Waiting on the customer",
    empty: "Nothing is waiting on the customer.",
  },
]

const isOpen = (status: string) => status === "requested" || status === "in_progress"

/**
 * Where an open item belongs on Today, or null when it does not need the FDE today. Each item
 * lands in one group: blocked first, then waiting on the customer, then due (today or overdue).
 */
export function groupOf(item: TodayItem, today: string): TodayGroup | null {
  if (item.kind === "access_request") {
    const { status } = item.access
    if (status === "denied" || status === "revoked") return "blocked"
    return isOpen(status) ? "waiting" : null
  }
  const { status, due_on } = item.task
  if (status === "done") return null
  if (status === "blocked") return "blocked"
  if (status === "waiting_on_customer") return "waiting"
  return due_on && due_on <= today ? "due" : null
}

/** When an item started needing the FDE: a wait's start, a refusal, a due date or a last change. */
function since(item: TodayItem): number {
  if (item.kind === "access_request") {
    const { access } = item
    return Date.parse(isOpen(access.status) ? access.requested_at : access.status_changed_at)
  }
  const { status, due_on, waiting_since, updated_at } = item.task
  if (status === "waiting_on_customer") return Date.parse(waiting_since ?? updated_at)
  if (status === "blocked") return Date.parse(updated_at)
  return Date.parse(due_on ?? updated_at)
}

/** The Today view: open items grouped, oldest first in each group, so the longest wait leads. */
export function groupToday(
  items: Array<TodayItem>,
  today: string,
): Record<TodayGroup, Array<TodayItem>> {
  const groups: Record<TodayGroup, Array<TodayItem>> = { blocked: [], due: [], waiting: [] }
  for (const item of items) {
    const group = groupOf(item, today)
    if (group) groups[group].push(item)
  }
  for (const list of Object.values(groups)) list.sort((a, b) => since(a) - since(b))
  return groups
}

/** Where a row sits in the list: unique across kinds, so a row keeps its place as data is read again. */
export const itemKey = (item: TodayItem) =>
  item.kind === "task" ? `task:${item.task.id}` : `access:${item.access.id}`

/** The companies the groups' rows belong to. */
export const companiesIn = (groups: Record<TodayGroup, Array<TodayItem>>) =>
  new Set(TODAY_GROUPS.flatMap(({ key }) => groups[key].map((item) => item.company.id))).size

/** What is left, for the line above the groups: the total first, then each group that has rows. */
export function summaryLine(groups: Record<TodayGroup, Array<TodayItem>>): string {
  const counts = Object.fromEntries(TODAY_GROUPS.map(({ key }) => [key, groups[key].length]))
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  if (total === 0) return "Nothing needs you today."
  const companies = companiesIn(groups)
  const parts = [
    [counts.blocked, "blocked"],
    [counts.due, "due"],
    [counts.waiting, "waiting on the customer"],
  ]
    .filter(([n]) => n)
    .map(([n, words]) => `${n} ${words}`)
    .join(", ")
  return `${total} ${total === 1 ? "needs" : "need"} you across ${companies} ${companies === 1 ? "company" : "companies"}: ${parts}.`
}

// What a row can do (DESIGN.md §3, Today). A task row has the board's moves; an access request
// row has the statuses its API route takes. The first action is the one most likely wanted, and
// has a key; the rest sit in the row's menu.

export type RowAction = { label: string } & (
  { kind: "task"; to: TaskState } | { kind: "access"; to: AccessState }
)
export type RowActions = { primary: RowAction; rest: Array<RowAction> }

/** How an access request's status reads in a sentence. */
export const ACCESS_LABEL: Record<AccessState, string> = {
  requested: "Requested",
  in_progress: "In progress",
  granted: "Granted",
  denied: "Denied",
  revoked: "Revoked",
}

// The board's five moves, worded as what the FDE does. The two that ask a question end in an ellipsis.
const TASK_MOVES: ReadonlyArray<{ to: TaskState; label: string }> = [
  { to: "in_progress", label: "Start" },
  { to: "done", label: "Mark done" },
  { to: "blocked", label: "Mark blocked…" },
  { to: "waiting_on_customer", label: "Waiting on the customer…" },
  { to: "todo", label: "Back to to do" },
]

function taskActions(task: { status: TaskState }, group: TodayGroup): RowActions {
  // Due: finish it. Blocked: the blocker is gone, so work resumes. Waiting: the customer
  // answered, so work resumes. Both of the last two read better than a bare "Start".
  const primary: RowAction =
    group === "due"
      ? { kind: "task", to: "done", label: "Done" }
      : { kind: "task", to: "in_progress", label: group === "blocked" ? "Unblock" : "Received" }
  const rest = TASK_MOVES.filter((m) => m.to !== task.status && m.to !== primary.to).map(
    (m): RowAction => ({ kind: "task", ...m }),
  )
  return { primary, rest }
}

function accessActions(status: AccessState): RowActions {
  const asked = status === "requested" || status === "in_progress"
  // Open: the customer has granted it. Refused or revoked: ask again, which puts it back under waiting.
  const primary: RowAction = asked
    ? { kind: "access", to: "granted", label: "Mark granted" }
    : { kind: "access", to: "requested", label: "Ask again" }
  const all: Array<RowAction> = [
    { kind: "access", to: "in_progress", label: "Mark in progress" },
    { kind: "access", to: "granted", label: "Mark granted" },
    { kind: "access", to: "denied", label: "Mark denied" },
    { kind: "access", to: "requested", label: "Back to requested" },
  ]
  const rest = all.filter(
    (a) =>
      a.to !== status &&
      a.to !== primary.to &&
      // A request that was already refused or revoked is not marked denied again.
      (asked || a.to !== "denied"),
  )
  return { primary, rest }
}

export function actionsOf(item: TodayItem, group: TodayGroup): RowActions {
  return item.kind === "task" ? taskActions(item.task, group) : accessActions(item.access.status)
}

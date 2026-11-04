import type { TodayItem } from "./api/schemas"

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

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

/**
 * Where an open item belongs on Today, or null when it does not need the FDE today. Each item
 * lands in one group: blocked first, then waiting on the customer, then due (today or overdue).
 */
export function groupOf(item: TodayItem, today: string): TodayGroup | null {
  if (item.kind === "access_request") {
    const { status } = item.access
    if (status === "denied") return "blocked"
    return status === "requested" || status === "in_review" ? "waiting" : null
  }
  const { status, due } = item.task
  if (status === "done") return null
  if (status === "blocked") return "blocked"
  if (status === "waiting_on_customer") return "waiting"
  return due !== null && due <= today ? "due" : null
}

/** The day an item became urgent: the day a wait began, or the due date. Earliest sorts first. */
function since(item: TodayItem): string {
  if (item.kind === "access_request") return item.access.requested_on
  const { status, due, waiting_since } = item.task
  const day = status === "waiting_on_customer" ? (waiting_since ?? due) : due
  return day ?? "9999-12-31"
}

/** The Today view: open items grouped, oldest first in each group, so overdue work leads. */
export function groupToday(
  items: Array<TodayItem>,
  today: string,
): Record<TodayGroup, Array<TodayItem>> {
  const groups: Record<TodayGroup, Array<TodayItem>> = { blocked: [], due: [], waiting: [] }
  for (const item of items) {
    const group = groupOf(item, today)
    if (group) groups[group].push(item)
  }
  for (const list of Object.values(groups)) list.sort((a, b) => since(a).localeCompare(since(b)))
  return groups
}

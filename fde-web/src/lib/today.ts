import type { TodayItem } from "./api/schemas"

export type TodayGroup = "blocked" | "waiting"

export const TODAY_GROUPS: Array<{ key: TodayGroup; title: string; empty: string }> = [
  { key: "blocked", title: "Blocked", empty: "Nothing is blocked." },
  {
    key: "waiting",
    title: "Waiting on the customer",
    empty: "Nothing is waiting on the customer.",
  },
]

/**
 * Where an open item belongs on Today, or null when it does not need the FDE today. Each item
 * lands in one group: refused or stuck work is blocked, the customer's move is waiting.
 */
export function groupOf(item: TodayItem): TodayGroup | null {
  if (item.kind === "access_request") {
    const { status } = item.access
    if (status === "denied" || status === "revoked") return "blocked"
    return status === "requested" || status === "in_progress" ? "waiting" : null
  }
  const { status } = item.task
  if (status === "blocked") return "blocked"
  return status === "waiting_on_customer" ? "waiting" : null
}

/** When an item started needing the FDE: an open request's ask, else its last change. */
function since(item: TodayItem): number {
  if (item.kind === "task") return Date.parse(item.task.updated_at)
  const { access } = item
  const open = access.status === "requested" || access.status === "in_progress"
  return Date.parse(open ? access.requested_at : access.status_changed_at)
}

/** The Today view: open items grouped, oldest first in each group, so the longest wait leads. */
export function groupToday(items: Array<TodayItem>): Record<TodayGroup, Array<TodayItem>> {
  const groups: Record<TodayGroup, Array<TodayItem>> = { blocked: [], waiting: [] }
  for (const item of items) {
    const group = groupOf(item)
    if (group) groups[group].push(item)
  }
  for (const list of Object.values(groups)) list.sort((a, b) => since(a) - since(b))
  return groups
}

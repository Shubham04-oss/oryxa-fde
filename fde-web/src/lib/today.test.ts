import { describe, expect, it } from "vitest"
import type { AccessState, TaskOut, TodayItem } from "./api/schemas"
import { AccessRequestOut, CompanyId, ProjectId, TaskOut as Task } from "./api/schemas"
import { groupOf, groupToday } from "./today"

const TODAY = "2026-11-03"
const where = {
  company: { id: CompanyId.parse("cmp_1"), name: "Kestrel Freight" },
  project: { id: ProjectId.parse("prj_1"), name: "Dispatch copilot" },
}
const at = (day: string) => `${day}T09:00:00Z`

function task(id: string, fields: Partial<Record<keyof TaskOut, string | null>> = {}): TodayItem {
  const t = Task.parse({
    id,
    title: id,
    status: "todo",
    created_at: at("2026-10-01"),
    updated_at: at("2026-11-01"),
    ...fields,
  })
  return { kind: "task", task: t, ...where }
}

function access(id: string, status: AccessState, asked: string, changed = asked): TodayItem {
  const a = AccessRequestOut.parse({
    id,
    description: id,
    status,
    requested_at: at(asked),
    status_changed_at: at(changed),
    days_waiting: 0,
  })
  return { kind: "access_request", access: a, owner: "Tomas Becker", ...where }
}

describe("groupOf", () => {
  it("puts blocked tasks and refused access under Blocked", () => {
    expect(groupOf(task("t", { status: "blocked" }), TODAY)).toBe("blocked")
    expect(groupOf(access("a", "denied", "2026-10-01"), TODAY)).toBe("blocked")
    expect(groupOf(access("a", "revoked", "2026-10-01"), TODAY)).toBe("blocked")
  })

  it("puts tasks waiting on the customer and open access requests under Waiting", () => {
    expect(groupOf(task("t", { status: "waiting_on_customer" }), TODAY)).toBe("waiting")
    expect(groupOf(access("a", "requested", "2026-10-01"), TODAY)).toBe("waiting")
    expect(groupOf(access("a", "in_progress", "2026-10-01"), TODAY)).toBe("waiting")
  })

  it("puts open tasks due today or earlier under Due", () => {
    expect(groupOf(task("t", { due_on: TODAY }), TODAY)).toBe("due")
    expect(groupOf(task("t", { status: "in_progress", due_on: "2026-10-30" }), TODAY)).toBe("due")
  })

  it("leaves out what does not need the FDE today", () => {
    expect(groupOf(task("t", { due_on: "2026-11-04" }), TODAY)).toBeNull()
    expect(groupOf(task("t"), TODAY)).toBeNull()
    expect(groupOf(task("t", { status: "done", due_on: "2026-10-01" }), TODAY)).toBeNull()
    expect(groupOf(access("a", "granted", "2026-10-01"), TODAY)).toBeNull()
  })

  it("files a late task once: blocked or waiting wins over due", () => {
    expect(groupOf(task("t", { status: "blocked", due_on: "2026-10-01" }), TODAY)).toBe("blocked")
    expect(groupOf(task("t", { status: "waiting_on_customer", due_on: "2026-10-01" }), TODAY)).toBe(
      "waiting",
    )
  })
})

describe("groupToday", () => {
  it("sorts each group oldest first, so the longest wait and the latest work lead", () => {
    const groups = groupToday(
      [
        task("due_today", { due_on: TODAY }),
        task("overdue_3", { due_on: "2026-10-31" }),
        task("overdue_1", { due_on: "2026-11-02" }),
        task("waited_2", { status: "waiting_on_customer", waiting_since: at("2026-11-01") }),
        access("asked_9", "requested", "2026-10-25", "2026-11-02"),
        access("refused_on_2", "denied", "2026-10-01", "2026-11-01"),
        task("blocked_on_3", { status: "blocked", updated_at: at("2026-10-31") }),
      ],
      TODAY,
    )
    const ids = (items: Array<TodayItem>) =>
      items.map((item) => (item.kind === "task" ? item.task.id : item.access.id))

    expect(ids(groups.due)).toEqual(["overdue_3", "overdue_1", "due_today"])
    // An open request counts from when it was asked; a refusal from when it was refused.
    expect(ids(groups.waiting)).toEqual(["asked_9", "waited_2"])
    expect(ids(groups.blocked)).toEqual(["blocked_on_3", "refused_on_2"])
  })

  it("is empty when nothing is open", () => {
    expect(groupToday([], TODAY)).toEqual({ blocked: [], due: [], waiting: [] })
  })
})

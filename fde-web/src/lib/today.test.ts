import { describe, expect, it } from "vitest"
import type { AccessRequestOut, AccessState, TaskOut, TaskState, TodayItem } from "./api/schemas"
import { AccessRequestOut as Access, CompanyId, ProjectId, TaskOut as Task } from "./api/schemas"
import { groupOf, groupToday } from "./today"

const where = {
  company: { id: CompanyId.parse("cmp_1"), name: "Kestrel Freight" },
  project: { id: ProjectId.parse("prj_1"), name: "Dispatch copilot" },
}
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}T09:00:00Z`

function task(id: string, status: TaskState, updated = 1): TodayItem {
  const t: TaskOut = Task.parse({
    id,
    title: id,
    status,
    created_at: day(1),
    updated_at: day(updated),
  })
  return { kind: "task", task: t, ...where }
}

function access(id: string, status: AccessState, asked: number, changed = asked): TodayItem {
  const a: AccessRequestOut = Access.parse({
    id,
    description: id,
    status,
    requested_at: day(asked),
    status_changed_at: day(changed),
    days_waiting: 0,
  })
  return { kind: "access_request", access: a, owner: null, ...where }
}

describe("groupOf", () => {
  it("puts blocked tasks and refused access under Blocked", () => {
    expect(groupOf(task("t", "blocked"))).toBe("blocked")
    expect(groupOf(access("a", "denied", 1))).toBe("blocked")
    expect(groupOf(access("a", "revoked", 1))).toBe("blocked")
  })

  it("puts tasks waiting on the customer and open access requests under Waiting", () => {
    expect(groupOf(task("t", "waiting_on_customer"))).toBe("waiting")
    expect(groupOf(access("a", "requested", 1))).toBe("waiting")
    expect(groupOf(access("a", "in_progress", 1))).toBe("waiting")
  })

  it("leaves out what does not need the FDE today", () => {
    for (const status of ["todo", "in_progress", "done"] as const)
      expect(groupOf(task("t", status)), status).toBeNull()
    expect(groupOf(access("a", "granted", 1))).toBeNull()
  })
})

describe("groupToday", () => {
  it("sorts each group oldest first, so the longest wait leads", () => {
    const groups = groupToday([
      task("blocked_3", "blocked", 3),
      access("denied_on_2", "denied", 1, 2),
      task("waited_since_4", "waiting_on_customer", 4),
      access("asked_on_1", "requested", 1, 5),
    ])
    const ids = (items: Array<TodayItem>) =>
      items.map((item) => (item.kind === "task" ? item.task.id : item.access.id))

    // A refusal counts from when it was refused; an open request from when it was asked.
    expect(ids(groups.blocked)).toEqual(["denied_on_2", "blocked_3"])
    expect(ids(groups.waiting)).toEqual(["asked_on_1", "waited_since_4"])
  })

  it("is empty when nothing is open", () => {
    expect(groupToday([])).toEqual({ blocked: [], waiting: [] })
  })
})

import { describe, expect, it } from "vitest"
import type { Task } from "./api/schemas"
import { CompanyId, ProjectId, TaskId, TodayItem } from "./api/schemas"
import { groupOf, groupToday } from "./today"

const TODAY = "2026-11-03"
const where = {
  company: { id: CompanyId.parse("cmp_1"), name: "Kestrel Freight" },
  project: { id: ProjectId.parse("prj_1"), name: "Dispatch copilot" },
}

function task(id: string, fields: Partial<Task>): TodayItem {
  return {
    kind: "task",
    ...where,
    task: {
      id: TaskId.parse(id),
      title: id,
      status: "todo",
      due: null,
      assignee: null,
      blocker: null,
      waiting_on: null,
      waiting_since: null,
      ...fields,
    },
  }
}

function access(id: string, status: "requested" | "in_review" | "granted" | "denied", on: string) {
  return TodayItem.parse({
    kind: "access_request",
    ...where,
    access: { id, system: id, owner: "Tomas Becker", status, requested_on: on },
  })
}

describe("groupOf", () => {
  it("puts blocked tasks and denied access under Blocked", () => {
    expect(groupOf(task("t", { status: "blocked" }), TODAY)).toBe("blocked")
    expect(groupOf(access("a", "denied", "2026-10-01"), TODAY)).toBe("blocked")
  })

  it("puts tasks waiting on the customer and open access requests under Waiting", () => {
    expect(groupOf(task("t", { status: "waiting_on_customer" }), TODAY)).toBe("waiting")
    expect(groupOf(access("a", "requested", "2026-10-01"), TODAY)).toBe("waiting")
    expect(groupOf(access("a", "in_review", "2026-10-01"), TODAY)).toBe("waiting")
  })

  it("puts open tasks due today or earlier under Due", () => {
    expect(groupOf(task("t", { due: TODAY }), TODAY)).toBe("due")
    expect(groupOf(task("t", { status: "in_progress", due: "2026-10-30" }), TODAY)).toBe("due")
  })

  it("leaves out what does not need the FDE today", () => {
    expect(groupOf(task("t", { due: "2026-11-04" }), TODAY)).toBeNull()
    expect(groupOf(task("t", { due: null }), TODAY)).toBeNull()
    expect(groupOf(task("t", { status: "done", due: "2026-10-01" }), TODAY)).toBeNull()
    expect(groupOf(access("a", "granted", "2026-10-01"), TODAY)).toBeNull()
  })

  it("files a late task once: blocked or waiting wins over due", () => {
    expect(groupOf(task("t", { status: "blocked", due: "2026-10-01" }), TODAY)).toBe("blocked")
    expect(groupOf(task("t", { status: "waiting_on_customer", due: "2026-10-01" }), TODAY)).toBe(
      "waiting",
    )
  })
})

describe("groupToday", () => {
  it("sorts each group oldest first, so the latest work leads", () => {
    const groups = groupToday(
      [
        task("due_today", { due: TODAY }),
        task("overdue_3", { due: "2026-10-31" }),
        task("overdue_1", { due: "2026-11-02" }),
        task("waited_2", { status: "waiting_on_customer", waiting_since: "2026-11-01" }),
        access("waited_9", "requested", "2026-10-25"),
      ],
      TODAY,
    )
    const ids = (items: Array<TodayItem>) =>
      items.map((item) => (item.kind === "task" ? item.task.id : item.access.id))

    expect(ids(groups.due)).toEqual(["overdue_3", "overdue_1", "due_today"])
    expect(ids(groups.waiting)).toEqual(["waited_9", "waited_2"])
    expect(groups.blocked).toEqual([])
  })

  it("is empty when nothing is open", () => {
    expect(groupToday([], TODAY)).toEqual({ blocked: [], due: [], waiting: [] })
  })
})

import { describe, expect, it } from "vitest"
import type { AccessState, TaskOut, TodayItem } from "./api/schemas"
import { AccessRequestOut, CompanyId, ProjectId, TaskOut as Task } from "./api/schemas"
import { actionsOf, groupOf, groupToday, itemKey, summaryLine } from "./today"

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
    version: 1,
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
    version: 1,
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

describe("summaryLine", () => {
  it("counts what is left, across how many companies, leaving out empty groups", () => {
    const groups = groupToday(
      [
        task("a", { status: "blocked" }),
        task("b", { due_on: TODAY }),
        task("c", { due_on: TODAY }),
        {
          ...task("d", { status: "waiting_on_customer" }),
          company: { id: CompanyId.parse("cmp_2"), name: "Other" },
        },
      ],
      TODAY,
    )
    expect(summaryLine(groups)).toBe(
      "4 need you across 2 companies: 1 blocked, 2 due, 1 waiting on the customer.",
    )
  })

  it("says one thing needs you in the singular, and nothing only when every group is empty", () => {
    expect(summaryLine(groupToday([task("a", { due_on: TODAY })], TODAY))).toBe(
      "1 needs you across 1 company: 1 due.",
    )
    expect(summaryLine(groupToday([], TODAY))).toBe("Nothing needs you today.")
  })

  it("counts the projects with no next step, and is all clear only without any", () => {
    const one = groupToday([task("a", { due_on: TODAY })], TODAY)
    expect(summaryLine(one, 2)).toBe(
      "1 needs you across 1 company: 1 due. 2 projects have no next step.",
    )
    expect(summaryLine(groupToday([], TODAY), 1)).toBe("1 project has no next step.")
    expect(summaryLine(groupToday([], TODAY), 0)).toBe("Nothing needs you today.")
  })
})

describe("itemKey", () => {
  it("tells a task from an access request with the same id", () => {
    expect(itemKey(task("x"))).not.toBe(itemKey(access("x", "requested", "2026-10-01")))
  })
})

describe("actionsOf", () => {
  const labels = (item: TodayItem, group: "blocked" | "due" | "waiting") => {
    const { primary, rest } = actionsOf(item, group)
    return [primary.label, ...rest.map((a) => a.label)]
  }

  it("finishes a due task, with the board's other moves in the menu", () => {
    expect(labels(task("t", { due_on: TODAY }), "due")).toEqual([
      "Done",
      "Start",
      "Mark blocked…",
      "Waiting on the customer…",
    ])
    // Already started: there is nothing to start.
    expect(labels(task("t", { status: "in_progress", due_on: TODAY }), "due")).toEqual([
      "Done",
      "Mark blocked…",
      "Waiting on the customer…",
      "Back to to do",
    ])
  })

  it("resumes a blocked or waiting task, into In progress", () => {
    const blocked = actionsOf(task("t", { status: "blocked" }), "blocked")
    expect(blocked.primary).toMatchObject({ label: "Unblock", kind: "task", to: "in_progress" })
    expect(blocked.rest.map((a) => a.to)).toEqual(["done", "waiting_on_customer", "todo"])
    const waiting = actionsOf(task("t", { status: "waiting_on_customer" }), "waiting")
    expect(waiting.primary).toMatchObject({ label: "Received", to: "in_progress" })
    expect(waiting.rest.map((a) => a.to)).toEqual(["done", "blocked", "todo"])
  })

  it("never offers the status a task is in, or the main action twice", () => {
    for (const status of ["todo", "in_progress", "waiting_on_customer", "blocked"] as const) {
      const group =
        status === "blocked" ? "blocked" : status === "waiting_on_customer" ? "waiting" : "due"
      const { primary, rest } = actionsOf(task("t", { status, due_on: TODAY }), group)
      const targets = [primary, ...rest].map((a) => a.to)
      expect(targets).not.toContain(status)
      expect(new Set(targets).size).toBe(targets.length)
    }
  })

  it("lets an open access request be granted, and asks again for a refused one", () => {
    expect(labels(access("a", "requested", "2026-10-01"), "waiting")).toEqual([
      "Mark granted",
      "Mark in progress",
      "Mark denied",
    ])
    expect(labels(access("a", "in_progress", "2026-10-01"), "waiting")).toEqual([
      "Mark granted",
      "Mark denied",
      "Back to requested",
    ])
    expect(labels(access("a", "denied", "2026-10-01"), "blocked")).toEqual([
      "Ask again",
      "Mark in progress",
      "Mark granted",
    ])
    // A revoked request cannot become denied.
    expect(labels(access("a", "revoked", "2026-10-01"), "blocked")).toEqual([
      "Ask again",
      "Mark in progress",
      "Mark granted",
    ])
  })
})

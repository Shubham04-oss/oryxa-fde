import { describe, expect, it } from "vitest"
import {
  attention,
  comingUp,
  dueShort,
  lookOf,
  setUpNext,
  sparkPoints,
  tabOf,
  trackOf,
  withUnit,
} from "./round2"
import type { Facts } from "./round2"
import type { TaskOut } from "./api/schemas"

describe("tabOf and lookOf", () => {
  it("reads a known tab and look from the address", () => {
    expect(tabOf("proof")).toBe("proof")
    expect(lookOf("b")).toBe("b")
  })
  it("falls back to Overview and look a for anything else", () => {
    expect(tabOf("settings")).toBe("overview")
    expect(tabOf(undefined)).toBe("overview")
    expect(tabOf(["proof"])).toBe("overview")
    expect(lookOf("c")).toBe("a")
    expect(lookOf(undefined)).toBe("a")
  })
})

describe("trackOf", () => {
  it("puts baseline left of target for an at-least criterion, current between", () => {
    const t = trackOf({ comparator: "at_least", target: 0.7, baseline: 0.42 }, 0.75)
    expect(t.baseline).toBeLessThan(t.target)
    expect(t.current).toBeGreaterThan(t.target)
    expect(t.baseline).toBeGreaterThan(0)
    expect(t.current).toBeLessThan(100)
  })
  it("flips an at-most criterion so better is still to the right", () => {
    const t = trackOf({ comparator: "at_most", target: 2, baseline: 9.5 }, 5)
    expect(t.baseline!).toBeLessThan(t.current!)
    expect(t.current!).toBeLessThan(t.target)
  })
  it("places a lone target most of the way along", () => {
    const t = trackOf({ comparator: "at_least", target: 0.9, baseline: null }, null)
    expect(t).toEqual({ baseline: null, current: null, target: 80 })
  })
  it("handles a zero target with nothing else known", () => {
    const t = trackOf({ comparator: "at_most", target: 0, baseline: null }, null)
    expect(t.target).toBe(80)
  })
})

describe("sparkPoints", () => {
  it("draws nothing for no results", () => {
    expect(sparkPoints([], 100, 24)).toEqual([])
  })
  it("centres a single result", () => {
    expect(sparkPoints([0.5], 100, 24)).toEqual([{ x: 50, y: 12 }])
  })
  it("spreads results across the width, higher rates higher up, and clamps", () => {
    const p = sparkPoints([0, 1, 2], 100, 24)
    expect(p.map((q) => q.x)).toEqual([3, 50, 97])
    expect(p[0]!.y).toBe(21)
    expect(p[1]!.y).toBe(3)
    expect(p[2]!.y).toBe(3)
  })
})

const task = (over: Partial<TaskOut>): TaskOut =>
  ({
    id: `tsk_${Math.random().toString(36).slice(2)}`,
    title: "A task",
    status: "todo",
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    version: 1,
    ...over,
  }) as TaskOut

describe("attention", () => {
  it("lists blocked, then overdue latest first, then waiting longest first, and skips the rest", () => {
    const today = "2026-11-12"
    const list = attention(
      [
        task({ title: "fine", due_on: "2026-11-20" }),
        task({
          title: "waiting 2",
          status: "waiting_on_customer",
          waiting_since: "2026-11-10T09:00:00Z",
        }),
        task({ title: "late 1", due_on: "2026-11-11" }),
        task({ title: "blocked", status: "blocked" }),
        task({
          title: "waiting 5",
          status: "waiting_on_customer",
          waiting_since: "2026-11-07T09:00:00Z",
        }),
        task({ title: "late 3", status: "in_progress", due_on: "2026-11-09" }),
        task({ title: "done late", status: "done", due_on: "2026-11-01" }),
      ],
      today,
    )
    expect(list.map((a) => [a.task.title, a.kind, a.days])).toEqual([
      ["blocked", "blocked", 0],
      ["late 3", "overdue", 3],
      ["late 1", "overdue", 1],
      ["waiting 5", "waiting", 5],
      ["waiting 2", "waiting", 2],
    ])
  })
})

const facts = (over: Partial<Facts> = {}): Facts => ({
  stakeholders: 1,
  inScope: 1,
  criteria: 1,
  withoutBaseline: 0,
  access: 1,
  notes: 1,
  suites: 1,
  assignees: 1,
  ...over,
})

describe("setUpNext", () => {
  it("is empty when nothing is missing", () => {
    expect(setUpNext(facts(), "build", new Set())).toEqual([])
  })
  it("puts the current stage first, then earlier stages, then later ones", () => {
    const f = facts({ assignees: 0, inScope: 0, access: 0 })
    expect(setUpNext(f, "scope", new Set())).toEqual(["add-scope", "assign", "request-access"])
    expect(setUpNext(f, "discover", new Set())).toEqual(["assign", "add-scope", "request-access"])
  })
  it("leaves to the checklist what it already asks for", () => {
    const f = facts({ notes: 0, assignees: 0 })
    expect(setUpNext(f, "discover", new Set(["discovery_notes"]))).toEqual(["assign"])
    expect(setUpNext(f, "discover", new Set())).toEqual(["assign", "write-note"])
  })
  it("claims nothing missing that has not been read", () => {
    const f = facts({ notes: null, suites: null, assignees: null })
    expect(setUpNext(f, "discover", new Set())).toEqual([])
  })
  it("asks for an eval suite only once there is a criterion to measure", () => {
    expect(setUpNext(facts({ criteria: 0, suites: 0 }), "build", new Set())).toEqual([
      "add-criterion",
    ])
    expect(setUpNext(facts({ suites: 0 }), "build", new Set())).toEqual(["add-suite"])
  })
  it("keeps at most three", () => {
    const f = facts({ stakeholders: 0, assignees: 0, notes: 0, inScope: 0, access: 0 })
    expect(setUpNext(f, "discover", new Set())).toHaveLength(3)
  })
})

describe("comingUp", () => {
  it("keeps open tasks in order, skipping the given ones, at most four", () => {
    const tasks = [
      task({ id: "a" as TaskOut["id"], title: "next step" }),
      task({ id: "b" as TaskOut["id"], title: "blocked", status: "blocked" }),
      task({ id: "c" as TaskOut["id"], title: "late" }),
      task({ id: "d" as TaskOut["id"], title: "doing", status: "in_progress" }),
      task({ id: "e" as TaskOut["id"], title: "done", status: "done" }),
      task({ id: "f" as TaskOut["id"], title: "waiting", status: "waiting_on_customer" }),
      task({ id: "g" as TaskOut["id"], title: "g" }),
      task({ id: "h" as TaskOut["id"], title: "h" }),
      task({ id: "i" as TaskOut["id"], title: "i" }),
    ]
    expect(comingUp(tasks, new Set(["a", "c"])).map((t) => t.title)).toEqual([
      "doing",
      "g",
      "h",
      "i",
    ])
  })
})

describe("withUnit", () => {
  it("adds a unit with a space, a percent without, and nothing without a unit", () => {
    expect(withUnit("45", "min")).toBe("45 min")
    expect(withUnit("80", "%")).toBe("80%")
    expect(withUnit("0.42", null)).toBe("0.42")
  })
})

describe("dueShort", () => {
  it("says a due day the way a column reads it", () => {
    const today = "2026-11-12"
    expect(dueShort("2026-11-12", today)).toBe("Today")
    expect(dueShort("2026-11-13", today)).toBe("Tomorrow")
    expect(dueShort("2026-11-16", today)).toBe("In 4 days")
    expect(dueShort("2026-11-11", today)).toBe("Overdue 1 day")
    expect(dueShort("2026-11-09", today)).toBe("Overdue 3 days")
  })
})

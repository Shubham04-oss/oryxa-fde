import { describe, expect, expectTypeOf, it } from "vitest"
import type { components } from "./api/fde-api.gen"
import { TaskId } from "./api/schemas"
import type { TaskOut } from "./api/schemas"
import {
  asksFirst,
  fieldsOf,
  inColumn,
  isOverdue,
  nextStepOf,
  placeAt,
  placed,
  problem,
  recentDone,
  stays,
  summarise,
  toBody,
} from "./board"
import type { Fields, TaskBody, TaskSave } from "./board"

type Spec = components["schemas"]

const task = (over: Partial<TaskOut> = {}): TaskOut => ({
  id: TaskId.parse("tsk_1"),
  title: "Write the runbook",
  status: "todo",
  created_at: "2026-11-01T09:00:00Z",
  updated_at: "2026-11-01T09:00:00Z",
  version: 1,
  ...over,
})

describe("toBody", () => {
  it("sends every field, so a PUT never drops one", () => {
    const body = toBody({
      ...fieldsOf(task({ due_on: "2026-11-20", assignee: "usr_riya" as TaskOut["assignee"] })),
      title: "  Write the runbook  ",
    })
    expect(body).toEqual({
      title: "Write the runbook",
      status: "todo",
      assignee: "usr_riya",
      due_on: "2026-11-20",
      blocker: null,
      blocked_by: null,
      waiting_on: null,
      criterion: null,
      stage: null,
    })
  })

  it("sends the stage back on every save, so a save never clears it", () => {
    const staged = fieldsOf(task({ stage: "build" }))
    expect(staged.stage).toBe("build")
    expect(toBody(staged).stage).toBe("build")
    // A move, a blocker or a wait keeps it.
    expect(toBody({ ...staged, status: "done" }).stage).toBe("build")
    expect(toBody({ ...staged, status: "blocked", blocker: "No VPN" }).stage).toBe("build")
    expect(toBody({ ...staged, status: "waiting_on_customer" }).stage).toBe("build")
    expect(
      toBody(staged, { side: "after", anchor: task({ id: TaskId.parse("tsk_9") }) }).stage,
    ).toBe("build")
    // None is said as null, never a missing key: the API clears a stage left out.
    expect(toBody(fieldsOf(task()))).toHaveProperty("stage", null)
  })

  it("sends the criterion back on every save, so a save never unlinks it", () => {
    const linked = fieldsOf(task({ criterion: "crt_1" as TaskOut["criterion"] }))
    expect(toBody(linked).criterion).toBe("crt_1")
    // A move or any other change keeps it.
    expect(toBody({ ...linked, status: "done" }).criterion).toBe("crt_1")
    expect(toBody({ ...linked, status: "blocked", blocker: "No VPN" }).criterion).toBe("crt_1")
    // Left unlinked, it says so: null, never a missing key.
    expect(toBody(fieldsOf(task()))).toHaveProperty("criterion", null)
  })

  it("names the place as one anchor, before or after", () => {
    const anchor = task({ id: TaskId.parse("tsk_9") })
    const fields = fieldsOf(task())
    expect(toBody(fields, { side: "after", anchor })).toMatchObject({ after: "tsk_9" })
    expect(toBody(fields, { side: "after", anchor })).not.toHaveProperty("before")
    expect(toBody(fields, { side: "before", anchor })).toMatchObject({ before: "tsk_9" })
    expect(toBody(fields)).not.toHaveProperty("after")
    expect(toBody(fields)).not.toHaveProperty("before")
  })

  it("is the API's task body, with every replaced field required", () => {
    expectTypeOf<keyof TaskBody>().toEqualTypeOf<Exclude<keyof Spec["TaskBody"], "version">>()
    expectTypeOf<TaskSave>().toExtend<Spec["TaskBody"]>()
    expectTypeOf<Pick<TaskSave, "criterion" | "assignee" | "stage">>().toEqualTypeOf<{
      criterion: string | null
      assignee: string | null
      stage: Spec["ProjectStage"] | null
    }>()
    expectTypeOf(toBody).returns.toEqualTypeOf<TaskSave>()
  })

  it("keeps the blocker and its access request only while blocked", () => {
    const fields: Fields = {
      ...fieldsOf(task({ status: "blocked", blocker: "No VPN", blocked_by: "acc_1" as never })),
    }
    expect(toBody(fields)).toMatchObject({ blocker: "No VPN", blocked_by: "acc_1" })
    expect(toBody({ ...fields, status: "in_progress" })).toMatchObject({
      blocker: null,
      blocked_by: null,
    })
  })

  it("keeps who it waits on only while it waits on the customer", () => {
    const fields: Fields = {
      ...fieldsOf(task()),
      status: "waiting_on_customer",
      waitingOn: "stk_1",
    }
    expect(toBody(fields).waiting_on).toBe("stk_1")
    expect(toBody({ ...fields, status: "done" }).waiting_on).toBeNull()
  })
})

describe("problem", () => {
  const ok = fieldsOf(task())

  it("wants a title of one line, up to 200 characters", () => {
    expect(problem(ok)).toBeNull()
    expect(problem({ ...ok, title: "   " })).toBe("Give the task a title.")
    expect(problem({ ...ok, title: "a\nb" })).toMatch(/one line/)
    expect(problem({ ...ok, title: "a".repeat(201) })).toMatch(/one line/)
    expect(problem({ ...ok, title: "a".repeat(200) })).toBeNull()
  })

  it("wants a blocker for a blocked task, and nothing for the others", () => {
    expect(problem({ ...ok, status: "blocked" })).toBe("Say what is blocking it.")
    expect(problem({ ...ok, status: "blocked", blocker: "  " })).toBe("Say what is blocking it.")
    expect(problem({ ...ok, status: "blocked", blocker: "No VPN\nuntil Friday" })).toBeNull()
    expect(problem({ ...ok, status: "blocked", blocker: "a".repeat(4001) })).toMatch(/4000/)
    expect(problem({ ...ok, status: "in_progress", blocker: "" })).toBeNull()
  })

  it("wants a date as YYYY-MM-DD", () => {
    expect(problem({ ...ok, due: "2026-11-20" })).toBeNull()
    expect(problem({ ...ok, due: "20/11/2026" })).toMatch(/date/)
  })
})

describe("columns", () => {
  it("ask first only for blocked and waiting on the customer", () => {
    expect(["todo", "in_progress", "done"].some((s) => asksFirst(s as never))).toBe(false)
    expect(asksFirst("blocked")).toBe(true)
    expect(asksFirst("waiting_on_customer")).toBe(true)
  })

  it("list tasks in the order the API gives them, not by when they were made", () => {
    const later = task({ id: TaskId.parse("tsk_2"), created_at: "2026-11-03T09:00:00Z" })
    const earlier = task({ id: TaskId.parse("tsk_3"), created_at: "2026-11-02T09:00:00Z" })
    const other = task({ id: TaskId.parse("tsk_4"), status: "done" })
    expect(inColumn([later, other, earlier], "todo").map((t) => t.id)).toEqual(["tsk_2", "tsk_3"])
  })
})

describe("places", () => {
  const t = (id: string, status: TaskOut["status"] = "todo") =>
    task({ id: TaskId.parse(id), status })
  const [a, b, c] = [t("tsk_a"), t("tsk_b"), t("tsk_c")]
  const ids = (list: ReadonlyArray<TaskOut>) => list.map((x) => x.id)

  it("puts a task first before the top card, anywhere else after the card above", () => {
    expect(placeAt([a, b], 0)).toEqual({ side: "before", anchor: a })
    expect(placeAt([a, b], 1)).toEqual({ side: "after", anchor: a })
    expect(placeAt([a, b], 2)).toEqual({ side: "after", anchor: b })
    // An empty column names no anchor: the API puts it at the end.
    expect(placeAt([], 0)).toBeUndefined()
  })

  it("knows a place that leaves the task where it is", () => {
    expect(stays([a, b, c], b, { side: "after", anchor: a })).toBe(true)
    expect(stays([a, b, c], b, { side: "before", anchor: c })).toBe(true)
    expect(stays([a, b, c], b, { side: "before", anchor: a })).toBe(false)
    expect(stays([a, b, c], b, undefined)).toBe(true)
    // Not in this column: a move, whatever the place.
    expect(stays([a, c], b, undefined)).toBe(false)
  })

  it("orders the saved task as the API does", () => {
    const d = t("tsk_d", "done")
    // Beside its anchor.
    expect(ids(placed([a, b, c, d], c, { side: "before", anchor: a }))).toEqual([
      "tsk_c",
      "tsk_a",
      "tsk_b",
      "tsk_d",
    ])
    expect(ids(placed([a, b, c, d], a, { side: "after", anchor: b }))).toEqual([
      "tsk_b",
      "tsk_a",
      "tsk_c",
      "tsk_d",
    ])
    // A change of status with no place: the end. Any other save keeps its place, with what was saved.
    const moved = { ...a, status: "in_progress" as const }
    expect(ids(placed([a, b, d], moved, undefined))).toEqual(["tsk_b", "tsk_d", "tsk_a"])
    const renamed = { ...a, title: "Renamed" }
    expect(placed([a, b], renamed, undefined)).toEqual([renamed, b])
    // A new task: the end.
    expect(ids(placed([a, b], c, undefined))).toEqual(["tsk_a", "tsk_b", "tsk_c"])
  })
})

describe("recentDone", () => {
  it("lists the most recently finished first and only done tasks", () => {
    const done = (id: string, updated_at: string) =>
      task({ id: TaskId.parse(id), status: "done", updated_at })
    const tasks = [
      done("tsk_a", "2026-11-01T09:00:00Z"),
      task({ id: TaskId.parse("tsk_open") }),
      done("tsk_c", "2026-11-05T09:00:00Z"),
      done("tsk_b", "2026-11-03T09:00:00Z"),
    ]
    expect(recentDone(tasks).map((t) => t.id)).toEqual(["tsk_c", "tsk_b", "tsk_a"])
  })
})

describe("summarise", () => {
  it("counts blocked, waiting and overdue open tasks, and never a done one as overdue", () => {
    const tasks = [
      task({ status: "blocked", due_on: "2026-11-01" }),
      task({ status: "waiting_on_customer" }),
      task({ status: "todo", due_on: "2026-11-09" }),
      task({ status: "todo", due_on: "2026-11-10" }),
      task({ status: "done", due_on: "2026-10-01" }),
    ]
    expect(summarise(tasks, "2026-11-10")).toEqual({ blocked: 1, waiting: 1, overdue: 2 })
    expect(isOverdue(tasks[4]!, "2026-11-10")).toBe(false)
  })
})

describe("nextStepOf", () => {
  const t = (id: string, over: Partial<TaskOut> = {}) =>
    task({ id: TaskId.parse(id), title: `Task ${id}`, ...over })

  it("is the first task in the project's order that is not done, as the API reads it", () => {
    const tasks = [
      t("tsk_a", { status: "done" }),
      t("tsk_b", { status: "blocked", assignee: "usr_riya" as never, due_on: "2026-11-20" }),
      t("tsk_c"),
    ]
    expect(nextStepOf(tasks)).toEqual({
      task: "tsk_b",
      title: "Task tsk_b",
      assignee: "usr_riya",
      due_on: "2026-11-20",
    })
    // Reordered, the next step follows the order, not the status.
    expect(nextStepOf([tasks[2]!, tasks[1]!])?.task).toBe("tsk_c")
  })

  it("is none when every task is done, or there are none", () => {
    expect(nextStepOf([])).toBeNull()
    expect(nextStepOf([t("tsk_a", { status: "done" }), t("tsk_b", { status: "done" })])).toBeNull()
  })

  it("says no owner and no date as null", () => {
    expect(nextStepOf([t("tsk_a")])).toMatchObject({ assignee: null, due_on: null })
  })
})

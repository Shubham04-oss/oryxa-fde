import { describe, expect, it } from "vitest"
import { TaskId } from "./api/schemas"
import type { TaskOut } from "./api/schemas"
import { asksFirst, fieldsOf, inColumn, problem, toBody } from "./board"
import type { Fields } from "./board"

const task = (over: Partial<TaskOut> = {}): TaskOut => ({
  id: TaskId.parse("tsk_1"),
  title: "Write the runbook",
  status: "todo",
  created_at: "2026-11-01T09:00:00Z",
  updated_at: "2026-11-01T09:00:00Z",
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
    })
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

  it("list tasks in creation order, whatever order they arrive in", () => {
    const later = task({ id: TaskId.parse("tsk_2"), created_at: "2026-11-03T09:00:00Z" })
    const earlier = task({ id: TaskId.parse("tsk_3"), created_at: "2026-11-02T09:00:00Z" })
    const other = task({ id: TaskId.parse("tsk_4"), status: "done" })
    expect(inColumn([later, other, earlier], "todo").map((t) => t.id)).toEqual(["tsk_3", "tsk_2"])
  })
})

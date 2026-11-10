import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  UNBLOCK_REREAD_MS,
  accessBody,
  accessChanged,
  accessEditBody,
  accessFields,
  accessProblem,
  blockedBy,
  blockers,
  blankDecision,
  chaseOrder,
  commitAccess,
  decisionBody,
  decisionProblem,
  glance,
  heldUpBy,
  newestFirst,
  subjectOf,
  waitOf,
} from "./access"
import { queries } from "./api/client"
import type { AccessRequestOut, AccessState, DecisionOut, Project, TaskOut } from "./api/schemas"

const at = "2026-11-04T10:00:00Z"
function request(id: string, status: AccessState, days: number, over: object = {}) {
  return {
    id,
    description: `Request ${id}`,
    status,
    requested_at: new Date(Date.now() - days * 86_400_000).toISOString(),
    status_changed_at: at,
    days_waiting: days,
    ...over,
  } as AccessRequestOut
}
const name = (id: string) => ({ a: "Ana", b: "Bo", c: "Cy", d: "Di" })[id] ?? id

describe("the access form", () => {
  const was = request("acc_1", "in_progress", 3, { system: "sys_1", owner: "stk_1" })

  it("needs words, up to the API's limit, and says which field", () => {
    expect(accessProblem(accessFields())).toEqual({
      field: "description",
      message: "Say what access is needed.",
    })
    expect(accessProblem({ ...accessFields(), description: "  \n " })).toMatchObject({
      field: "description",
    })
    expect(accessProblem({ ...accessFields(), description: "x".repeat(4001) })).toMatchObject({
      field: "description",
    })
    expect(accessProblem({ ...accessFields(), description: "Read replica" })).toBeNull()
  })

  it("starts a new request as requested, a blank pick left out as null", () => {
    expect(
      accessBody({
        ...accessFields(),
        description: " Read replica ",
        system: null,
        owner: "stk_1",
      }),
    ).toEqual({
      description: "Read replica",
      system: null,
      owner: "stk_1",
      status: "requested",
    })
  })

  it("compares with the request it opened on", () => {
    expect(accessChanged(was, accessFields(was))).toBe(false)
    expect(accessChanged(was, { ...accessFields(was), description: " Request acc_1 " })).toBe(false)
    expect(accessChanged(was, { ...accessFields(was), owner: null })).toBe(true)
  })

  it("sends every field on an edit, all from the form: the copy it opened on with the person's changes", () => {
    // The status is not in the form: it is the copy's, and goes with that copy's version.
    expect(accessEditBody({ ...accessFields(was), description: " New words " })).toEqual({
      description: "New words",
      system: "sys_1",
      owner: "stk_1",
      status: "in_progress",
    })
    expect(accessEditBody({ ...accessFields(was), owner: null })).toEqual({
      description: "Request acc_1",
      system: "sys_1",
      owner: null,
      status: "in_progress",
    })
  })
})

describe("what the card answers", () => {
  const list = [
    request("g", "granted", 10, { owner: "a" }),
    request("o1", "requested", 2, { owner: "a" }),
    request("o2", "in_progress", 9, { owner: "b" }),
    request("o3", "requested", 5),
    request("d", "denied", 20, { owner: "a" }),
    request("r", "revoked", 1, { owner: "c" }),
  ]

  it("puts refusals first, then open ones, then granted, the oldest request first in each", () => {
    expect(chaseOrder(list).map((r) => r.id)).toEqual(["d", "r", "o2", "o3", "o1", "g"])
  })

  it("counts what is not granted, who holds it, and the longest open wait", () => {
    expect(glance(list, name)).toEqual({
      notGranted: 5,
      total: 6,
      heldUp: [
        { who: "Ana", count: 2 },
        { who: "Bo", count: 1 },
        { who: "Cy", count: 1 },
        { who: null, count: 1 },
      ],
      longest: 9,
    })
    expect(glance([request("g", "granted", 4)], name)).toMatchObject({
      notGranted: 0,
      heldUp: [],
      longest: null,
    })
    // Denied ones are not waiting: no open request, no wait.
    expect(glance([request("d", "denied", 4)], name).longest).toBeNull()
  })

  it("names who holds it up in a sentence, and no more than three people", () => {
    const held = glance(list, name).heldUp
    expect(heldUpBy(held)).toBe("Ana (2), Bo, Cy and 1 more")
    expect(heldUpBy([{ who: null, count: 2 }])).toBe("No one named (2)")
    expect(heldUpBy([])).toBe("")
  })

  it("reads how long it waited, amber from a week, or when it was settled and how long that took", () => {
    expect(waitOf(request("a", "requested", 0))).toEqual({
      text: "Requested, waiting less than a day",
      tone: "neutral",
    })
    expect(waitOf(request("a", "in_progress", 6)).tone).toBe("neutral")
    expect(waitOf(request("a", "in_progress", 7))).toEqual({
      text: "In progress, waiting 7 days",
      tone: "attention",
    })
    expect(waitOf(request("a", "denied", 4))).toEqual({
      text: expect.stringMatching(/^Denied .*, after 4 days$/),
      tone: "attention",
    })
    expect(waitOf(request("a", "revoked", 1)).tone).toBe("attention")
    // Revoked after a grant: the days are the ones the grant took, so the line says so and gives the day.
    expect(waitOf(request("a", "revoked", 3, { granted_at: "2026-11-02T10:00:00Z" })).text).toMatch(
      /^Revoked \d+ \w+ \d{4}\. It had been granted 2 Nov 2026, after 3 days\.$/,
    )
    expect(waitOf(request("a", "revoked", 0, { granted_at: "2026-11-02T10:00:00Z" })).text).toMatch(
      /granted 2 Nov 2026, the same day\.$/,
    )
    expect(waitOf(request("a", "granted", 0))).toEqual({
      text: expect.stringMatching(/^Granted .*, the same day$/),
      tone: "success",
    })
  })

  it("finds the tasks a request blocks, and what a task can be blocked on", () => {
    const task = (id: string, status: string, by: string | null) =>
      ({ id, title: id, status, blocked_by: by }) as TaskOut
    const tasks = [task("t1", "blocked", "d"), task("t2", "todo", "d"), task("t3", "blocked", "o1")]
    expect(blockedBy("d", tasks).map((t) => t.id)).toEqual(["t1"])
    // Granted is not offered, unless the task already names it.
    expect(blockers(list, null).map((r) => r.id)).toEqual(["d", "r", "o2", "o3", "o1"])
    expect(blockers(list, "g").map((r) => r.id)).toEqual(["d", "r", "o2", "o3", "o1", "g"])
  })
})

describe("the decision form", () => {
  const today = "2026-11-10"
  const filled = { title: "Pilot", rationale: "Cleanest data", decidedBy: "Mara", decidedOn: today }

  it("checks what the API checks, in the order the form reads", () => {
    expect(decisionProblem(blankDecision(today), today)).toMatchObject({ field: "title" })
    expect(decisionProblem({ ...filled, title: "a\nb" }, today)).toMatchObject({ field: "title" })
    expect(decisionProblem({ ...filled, rationale: " " }, today)).toMatchObject({
      field: "rationale",
    })
    expect(decisionProblem({ ...filled, rationale: "x".repeat(4001) }, today)).toMatchObject({
      field: "rationale",
    })
    expect(decisionProblem({ ...filled, decidedBy: "" }, today)).toMatchObject({
      field: "decidedBy",
    })
    expect(decisionProblem({ ...filled, decidedOn: "" }, today)).toMatchObject({
      field: "decidedOn",
    })
    expect(decisionProblem({ ...filled, decidedOn: "2026-11-11" }, today)).toMatchObject({
      field: "decidedOn",
    })
    expect(decisionProblem(filled, today)).toBeNull()
    expect(
      decisionProblem({ ...filled, rationale: "one\ntwo", decidedOn: "2026-10-01" }, today),
    ).toBeNull()
  })

  it("leaves today's time to the API, and sends an earlier day as noon where the FDE is", () => {
    expect(decisionBody({ ...filled, title: " Pilot " }, today)).toEqual({
      title: "Pilot",
      rationale: "Cleanest data",
      decided_by: "Mara",
      decided_at: null,
    })
    const sent = decisionBody({ ...filled, decidedOn: "2026-10-01" }, today).decided_at!
    expect(new Date(sent).getFullYear()).toBe(2026)
    expect([
      new Date(sent).getMonth(),
      new Date(sent).getDate(),
      new Date(sent).getHours(),
    ]).toEqual([9, 1, 12])
  })

  it("lists the newest decision first", () => {
    const d = (id: string, decided_at: string) => ({ id, decided_at }) as DecisionOut
    expect(
      newestFirst([
        d("b", "2026-11-01T00:00:00Z"),
        d("c", "2026-11-03T00:00:00Z"),
        d("a", "2026-11-01T00:00:00Z"),
      ]).map((x) => x.id),
    ).toEqual(["c", "a", "b"])
  })

  it("says what a discussion was about, from the records the page has", () => {
    const p = {
      access: [{ id: "acc_1", description: "Telematics export" }],
      tasks: [{ id: "tsk_1", title: "Replay orders" }],
      stakeholders: [{ id: "stk_1", name: "Mara Lindqvist" }],
      systems: [],
      scope: { items: [{ id: "itm_1", description: "Draft plans" }], criteria: [] },
    } as unknown as Project
    const about = (kind: string, id: string) =>
      subjectOf({ kind, id } as Parameters<typeof subjectOf>[0], p)
    expect(about("access_request", "acc_1")).toBe("the access request “Telematics export”")
    expect(about("task", "tsk_1")).toBe("the task “Replay orders”")
    expect(about("stakeholder", "stk_1")).toBe("Mara Lindqvist")
    expect(about("scope_item", "itm_1")).toBe("the scope item “Draft plans”")
    // A record the page does not hold is named by what it is, never by an id.
    expect(about("system", "sys_9")).toBe("a system")
    expect(about("access_request", "acc_9")).toBe("an access request")
    expect(about("shape", "x")).toBe("a shape on the canvas")
  })
})

describe("commitAccess", () => {
  const scope = { company: "cmp_1", project: "prj_1" } as never
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("puts the request in the project, drops what a read sent before it would bring back, and reads the checklist", async () => {
    const client = new QueryClient()
    const key = queries.project(scope).queryKey
    client.setQueryData(key, {
      access: [request("acc_1", "requested", 3)],
      tasks: [],
    } as unknown as Project)
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const cancel = vi.spyOn(client, "cancelQueries")
    await commitAccess(client, scope, request("acc_1", "in_progress", 3), "requested")
    expect(cancel).toHaveBeenCalledWith({ queryKey: key })
    expect(client.getQueryData<{ access: Array<AccessRequestOut> }>(key)?.access[0]?.status).toBe(
      "in_progress",
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queries.stageChecklist(scope).queryKey })
    // Not granted: no later read for unblocked tasks.
    invalidate.mockClear()
    await vi.advanceTimersByTimeAsync(UNBLOCK_REREAD_MS + 1)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("adds a new request after the others", async () => {
    const client = new QueryClient()
    const key = queries.project(scope).queryKey
    client.setQueryData(key, {
      access: [request("acc_1", "requested", 3)],
      tasks: [],
    } as unknown as Project)
    await commitAccess(client, scope, request("acc_2", "requested", 0))
    expect(
      client.getQueryData<{ access: Array<AccessRequestOut> }>(key)?.access.map((a) => a.id),
    ).toEqual(["acc_1", "acc_2"])
  })

  it("reads the project again a few seconds after a grant: the API puts blocked tasks back to do by an event", async () => {
    const client = new QueryClient()
    const key = queries.project(scope).queryKey
    client.setQueryData(key, {
      access: [request("acc_1", "requested", 3)],
      tasks: [],
    } as unknown as Project)
    const invalidate = vi.spyOn(client, "invalidateQueries")
    await commitAccess(client, scope, request("acc_1", "granted", 3), "requested")
    invalidate.mockClear()
    await vi.advanceTimersByTimeAsync(UNBLOCK_REREAD_MS - 1)
    expect(invalidate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key })
  })

  it("does not read again for a request that was granted already", async () => {
    const client = new QueryClient()
    client.setQueryData(queries.project(scope).queryKey, {
      access: [],
      tasks: [],
    } as unknown as Project)
    const invalidate = vi.spyOn(client, "invalidateQueries")
    await commitAccess(client, scope, request("acc_1", "granted", 3), "granted")
    invalidate.mockClear()
    await vi.advanceTimersByTimeAsync(UNBLOCK_REREAD_MS + 1)
    expect(invalidate).not.toHaveBeenCalled()
  })
})

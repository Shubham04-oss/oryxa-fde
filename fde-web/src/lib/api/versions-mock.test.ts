import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiError, StaleSaveError, api } from "./client"
import { AccessRequestId, CompanyId, ProjectId, StakeholderId, TaskId } from "./schemas"
import type { TaskOut } from "./schemas"
import { resetMockApi } from "@/dev/mock-api"
import { fieldsOf, toBody } from "@/lib/board"

// The dev mock versions its records the way the API does (#172): every change moves a record's
// version on, whoever makes it; a stale version is a 409 with the record as it stands; an identical
// save changes nothing; a create names no version. The screens are tried against it.

const company = CompanyId.parse("cmp_kestrel")
const place = { company, project: ProjectId.parse("prj_kestrel_dispatch") }
const claims = { company, project: ProjectId.parse("prj_kestrel_claims") }

beforeEach(() => resetMockApi())
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__fdeMockSomeoneElse
})

const failure = async (work: Promise<unknown>) => {
  const e = await work.then(
    () => null,
    (error: unknown) => error,
  )
  expect(e).toBeInstanceOf(ApiError)
  return e as ApiError
}
const task = async (title: string): Promise<TaskOut> =>
  (await api.project(place)).tasks.find((t) => t.title === title)!
const REPLAY = "Replay last month's orders through the planner"

describe("the mock's versions", () => {
  it("starts every record at version 1 and moves it on by one with each change", async () => {
    const t = await task(REPLAY)
    expect(t.version).toBe(1)
    const saved = await api.updateTask(place, t.id, { ...toBody(fieldsOf(t)), title: "New" }, 1)
    expect(saved.version).toBe(2)
    const again = await api.updateTask(
      place,
      t.id,
      { ...toBody(fieldsOf(saved)), title: "Newer" },
      2,
    )
    expect(again.version).toBe(3)
    expect((await task("Newer")).version).toBe(3)
  })

  it("answers an identical save with the record unchanged, version and time included", async () => {
    const t = await task(REPLAY)
    const same = await api.updateTask(place, t.id, toBody(fieldsOf(t)), 1)
    expect(same).toEqual(t)
  })

  it("refuses a stale version with the record as it stands, and changes nothing", async () => {
    const t = await task(REPLAY)
    await api.updateTask(place, t.id, { ...toBody(fieldsOf(t)), title: "Moved on" }, 1)
    const e = await failure(
      api.updateTask(place, t.id, { ...toBody(fieldsOf(t)), title: "Mine" }, 1),
    )
    expect(e).toBeInstanceOf(StaleSaveError)
    expect(e).toMatchObject({ status: 409, code: "stale_version" })
    expect((e as StaleSaveError<TaskOut>).current).toMatchObject({ title: "Moved on", version: 2 })
    expect((await task("Moved on")).version).toBe(2)
  })

  it("tells a task's other 409 from a stale one by its code", async () => {
    const t = await task(REPLAY)
    const e = await failure(
      api.updateTask(place, t.id, { title: "x", status: "blocked" }, t.version),
    )
    expect(e).not.toBeInstanceOf(StaleSaveError)
    expect(e).toMatchObject({ status: 409, code: "rejected_blocker_required" })
  })

  it("refuses a version on a create, and a version that is not a whole number", async () => {
    // The typed client cannot send one: a body has no `version`. The route still refuses it.
    const { mockApi } = await import("@/dev/mock-api")
    const call = (method: string, path: string, body: unknown) =>
      mockApi.fetch(
        new Request(`${location.origin}/api/v1${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    const tasks = "/companies/cmp_kestrel/projects/prj_kestrel_dispatch/tasks"
    for (const [path, body] of [
      [tasks, { title: "x", status: "todo" }],
      ["/companies/cmp_kestrel/stakeholders", { name: "x" }],
      ["/companies/cmp_kestrel/systems", { name: "x" }],
      [`${tasks.replace("tasks", "scope/items")}`, { kind: "in", description: "x" }],
      [
        `${tasks.replace("tasks", "scope/criteria")}`,
        { description: "x", metric: "m", comparator: "at_least", target: 1 },
      ],
      [`${tasks.replace("tasks", "access-requests")}`, { description: "x", status: "requested" }],
    ] as const) {
      const refused = await call("POST", path, { ...body, version: 1 })
      expect(refused.status, path).toBe(400)
      expect(await refused.json(), path).toEqual({ error: "invalid_version" })
      // Without one it is made.
      expect((await call("POST", path, body)).status, path).toBe(201)
    }
    for (const bad of [-1, 1.5, "1", true]) {
      const refused = await call("PUT", `${tasks}/tsk_k2`, {
        title: "x",
        status: "todo",
        version: bad,
      })
      expect(refused.status, String(bad)).toBe(400)
    }
  })

  it("moves a task's version when the engine unblocks it, and a stakeholder removal's changes", async () => {
    // Granting the request a blocked task names puts the task back to do: a change by the API.
    const blocked = await task("Agree the telematics alternative")
    expect(blocked).toMatchObject({ status: "blocked", version: 1 })
    const access = (await api.project(place)).access.find((a) => a.id === blocked.blocked_by)!
    await api.updateAccess(
      place,
      AccessRequestId.parse(access.id),
      {
        description: access.description,
        system: access.system,
        owner: access.owner,
        status: "granted",
      },
      access.version,
    )
    expect(await task("Agree the telematics alternative")).toMatchObject({
      status: "todo",
      version: 2,
    })
    // A save made on the version before the unblocking is stale.
    const e = await failure(api.updateTask(place, blocked.id, toBody(fieldsOf(blocked)), 1))
    expect(e).toBeInstanceOf(StaleSaveError)

    // Removing a stakeholder leaves a task that waited on them naming no one: a change too.
    const person = await api.addStakeholder(company, { name: "Ines Moreau" })
    const waiting = await api.addTask(place, {
      title: "Wait for Ines",
      status: "waiting_on_customer",
      waiting_on: person.id,
    })
    expect(waiting.version).toBe(1)
    await api.removeStakeholder(company, person.id)
    expect(await task("Wait for Ines")).toMatchObject({ waiting_on: null, version: 2 })
  })

  it("has a dev switch that makes someone else change the record once, before the next save", async () => {
    const t = await task(REPLAY)
    ;(globalThis as Record<string, unknown>).__fdeMockSomeoneElse = true
    const e = await failure(api.updateTask(place, t.id, toBody(fieldsOf(t)), 1))
    expect(e).toBeInstanceOf(StaleSaveError)
    expect((e as StaleSaveError<TaskOut>).current).toMatchObject({
      status: "in_progress",
      version: 2,
    })
    // It is one-shot: the next save, on the version it was given, goes through.
    expect((globalThis as Record<string, unknown>).__fdeMockSomeoneElse).toBeUndefined()
    const current = (e as StaleSaveError<TaskOut>).current
    const saved = await api.updateTask(
      place,
      t.id,
      { ...toBody(fieldsOf(current)), title: "Mine" },
      2,
    )
    expect(saved).toMatchObject({ title: "Mine", version: 3 })
  })

  it("refuses a stale sign-off with the whole scope, and signs nothing", async () => {
    const scope = await api.scope(claims)
    await api.addScopeItem(claims, { kind: "in", description: "Sort claims" })
    const e = await failure(api.signOffScope(claims, StakeholderId.parse("stk_k1"), scope.version))
    expect(e).toBeInstanceOf(StaleSaveError)
    const current = (e as StaleSaveError<{ version: number; items: Array<unknown> }>).current
    expect(current).toMatchObject({ version: scope.version + 1 })
    expect(current.items).toHaveLength(1)
    expect((await api.scope(claims)).sign_off).toBeFalsy()
    // On the version it was shown, it is signed.
    const signed = await api.signOffScope(claims, StakeholderId.parse("stk_k1"), current.version)
    expect(signed.version).toBe(current.version)
  })

  it("moves the scope's version with an item's, and leaves both alone for an identical save", async () => {
    await api.addScopeItem(claims, { kind: "in", description: "Sort claims" })
    const scope = await api.scope(claims)
    const item = scope.items[0]!
    expect(item.version).toBe(1)
    const same = await api.updateScopeItem(
      claims,
      item.id,
      { kind: "in", description: "Sort claims" },
      1,
    )
    expect(same).toEqual(item)
    expect((await api.scope(claims)).version).toBe(scope.version)
    const changed = await api.updateScopeItem(
      claims,
      item.id,
      { kind: "out", description: "Sort claims" },
      1,
    )
    expect(changed.version).toBe(2)
    expect((await api.scope(claims)).version).toBe(scope.version + 1)
    // The task id parse keeps the import used.
    expect(TaskId.parse("tsk_k2")).toBe("tsk_k2")
  })
})

import { beforeEach, describe, expect, it } from "vitest"
import { ApiError, api } from "./client"
import { CompanyId, ProjectId, StakeholderId } from "./schemas"
import { mockApi, resetMockApi } from "@/dev/mock-api"
import { fieldsOf, toBody } from "@/lib/board"
import { criterionBody, criterionFields } from "@/lib/scope"

// The dev mock answers #238's fields as the API does (crates/oryxa-fde-api/src/lifecycle.rs,
// projects.rs, records.rs, today.rs): a task's stage and a criterion's baseline and proof are cleared
// when a `PUT` leaves them out, a stage that is not one of the eight does not deserialize (422), a
// project's next step is worked out on every read, and a main contact is one stakeholder of the company.

const company = CompanyId.parse("cmp_kestrel")
const dispatch = { company, project: ProjectId.parse("prj_kestrel_dispatch") }
const base = "/companies/cmp_kestrel/projects/prj_kestrel_dispatch"

const call = (method: string, path: string, body: unknown) =>
  mockApi.fetch(
    new Request(`${location.origin}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

async function failure(work: Promise<unknown>) {
  const e = await work.then(
    () => null,
    (error: unknown) => error,
  )
  expect(e).toBeInstanceOf(ApiError)
  return e as ApiError
}

const taskOf = async (id: string) => (await api.project(dispatch)).tasks.find((t) => t.id === id)!

beforeEach(() => resetMockApi())

describe("a task's stage, in the mock", () => {
  it("is kept by a save that sends it, and cleared by one that leaves it out", async () => {
    const t = await taskOf("tsk_k2")
    expect(t.stage).toBe("build")
    const kept = await api.updateTask(
      dispatch,
      t.id,
      { ...toBody(fieldsOf(t)), title: "New" },
      t.version,
    )
    expect(kept.stage).toBe("build")
    // The typed client cannot leave it out; a raw PUT shows what that would do.
    const { stage: _, ...without } = toBody(fieldsOf(kept))
    const cleared = await call("PUT", `${base}/tasks/tsk_k2`, without)
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toHaveProperty("stage", null)
  })

  it("takes one of the eight stages, or none; anything else is a 422 that changes nothing", async () => {
    const t = await taskOf("tsk_k2")
    const body = toBody(fieldsOf(t))
    for (const bad of ["Build", "nope", 3, ""]) {
      const refused = await call("PUT", `${base}/tasks/tsk_k2`, { ...body, stage: bad })
      expect(refused.status, String(bad)).toBe(422)
      expect(refused.headers.get("content-type"), String(bad)).toMatch(/^text\/plain/)
    }
    expect((await call("POST", `${base}/tasks`, { ...body, stage: "launch" })).status).toBe(422)
    expect(await taskOf("tsk_k2")).toEqual(t)
    // The client reads a 422 with no error code as one it can still say something about.
    const e = await failure(
      api.updateTask(dispatch, t.id, { ...body, stage: "nope" as never }, t.version),
    )
    expect(e).toMatchObject({ status: 422, code: "http_422" })
    const added = await api.addTask(dispatch, {
      ...body,
      title: "Plan the pilot review",
      stage: "evaluate",
    })
    expect(added.stage).toBe("evaluate")
  })

  it("counts as a change: an identical save is answered as it is, a new stage moves the version on", async () => {
    const t = await taskOf("tsk_k2")
    expect((await api.updateTask(dispatch, t.id, toBody(fieldsOf(t)), t.version)).version).toBe(
      t.version,
    )
    const moved = await api.updateTask(
      dispatch,
      t.id,
      { ...toBody(fieldsOf(t)), stage: "evaluate" },
      t.version,
    )
    expect(moved).toMatchObject({ stage: "evaluate", version: t.version + 1 })
  })
})

describe("a project's next step, in the mock", () => {
  it("is its first task in order that is not done, worked out on every read", async () => {
    const p = await api.project(dispatch)
    expect(p.next_step).toEqual({
      task: "tsk_k1",
      title: "Load depot rules into the context pack",
      assignee: "usr_riya",
      due_on: p.tasks[0]!.due_on,
    })
    const first = p.tasks[0]!
    await api.updateTask(
      dispatch,
      first.id,
      { ...toBody(fieldsOf(first)), status: "done" },
      first.version,
    )
    expect((await api.project(dispatch)).next_step?.task).toBe("tsk_k2")
  })

  it("is none, and the project is on Today, once every task is done", async () => {
    const p = await api.project(dispatch)
    expect((await api.today()).projects_without_next_step ?? []).not.toContainEqual(
      expect.objectContaining({ project: { id: dispatch.project, name: p.name } }),
    )
    for (const t of p.tasks.filter((x) => x.status !== "done"))
      await api.updateTask(
        dispatch,
        t.id,
        { ...toBody(fieldsOf(t)), status: "done", blocker: null, blocked_by: null },
        t.version,
      )
    expect((await api.project(dispatch)).next_step).toBeNull()
    expect((await api.today()).projects_without_next_step).toContainEqual({
      company: { id: company, name: "Kestrel Freight" },
      project: { id: dispatch.project, name: p.name },
    })
  })

  it("comes with every read of a project: the company's list, a new project and an edit", async () => {
    const listed = await api.company(company)
    for (const p of listed.projects) expect(p).toHaveProperty("next_step")
    const made = await api.createProject(company, { name: "Returns triage" })
    expect(made.next_step).toBeNull()
  })
})

describe("a criterion's baseline and proof, in the mock", () => {
  const crt = async () =>
    (await api.project(dispatch)).scope.criteria.find((c) => c.id === "crt_k1")!

  it("are saved, and cleared by a PUT that leaves them out", async () => {
    const c = await crt()
    expect(c).toMatchObject({ baseline: 0.42, proof: expect.any(String) })
    const saved = await api.updateCriterion(
      dispatch,
      c.id,
      { ...criterionBody(criterionFields(c)), baseline: 0.5, proof: "  Fifty sampled plans  " },
      c.version,
    )
    expect(saved).toMatchObject({ baseline: 0.5, proof: "Fifty sampled plans" })
    const { baseline: _b, proof: _p, ...without } = criterionBody(criterionFields(saved))
    const cleared = await call("PUT", `${base}/scope/criteria/crt_k1`, without)
    expect(await cleared.json()).toMatchObject({ baseline: null, proof: null })
  })

  it("refuse a proof that is blank, too long or has a control character, and a baseline that is not a number", async () => {
    const body = criterionBody(criterionFields(await crt()))
    for (const proof of [" ", "x".repeat(501), "a\u0007b"])
      expect(await failure(api.addCriterion(dispatch, { ...body, proof }))).toMatchObject({
        status: 400,
        code: "invalid_proof",
      })
    expect((await call("POST", `${base}/scope/criteria`, { ...body, baseline: "40" })).status).toBe(
      422,
    )
  })

  it("count as a change to the scope, so a signed-off scope needs signing again", async () => {
    const before = await api.project(dispatch)
    expect(before.scope.signed_off).toBe(true)
    const c = before.scope.criteria.find((x) => x.id === "crt_k1")!
    // The same baseline and proof: nothing changes, and the sign-off stands.
    await api.updateCriterion(dispatch, c.id, criterionBody(criterionFields(c)), c.version)
    expect((await api.project(dispatch)).scope.signed_off).toBe(true)
    await api.updateCriterion(
      dispatch,
      c.id,
      { ...criterionBody(criterionFields(c)), baseline: 0.4 },
      c.version,
    )
    expect((await api.project(dispatch)).scope.signed_off).toBe(false)
  })
})

describe("a company's main contact, in the mock", () => {
  const people = async () => (await api.company(company)).stakeholders

  it("is one stakeholder at most: setting one unsets the other, and moves only their versions", async () => {
    const before = await people()
    expect(before.filter((s) => s.main_contact).map((s) => s.id)).toEqual(["stk_k1"])
    const set = await api.setMainContact(company, StakeholderId.parse("stk_k2"))
    expect(set.stakeholder).toMatchObject({ id: "stk_k2", main_contact: true })
    const after = await people()
    expect(after.filter((s) => s.main_contact).map((s) => s.id)).toEqual(["stk_k2"])
    for (const s of after) {
      const was = before.find((x) => x.id === s.id)!
      const changed = s.id === "stk_k1" || s.id === "stk_k2"
      expect(s.version, s.id).toBe(was.version + (changed ? 1 : 0))
    }
  })

  it("is cleared with null, and a stakeholder's own save keeps it", async () => {
    const [mara] = await people()
    const saved = await api.updateStakeholder(
      company,
      mara!.id,
      {
        name: mara!.name,
        role: mara!.role,
        title: "Operations director",
        email: mara!.email ?? null,
      },
      mara!.version,
    )
    expect(saved.main_contact).toBe(true)
    expect((await api.setMainContact(company, null)).stakeholder).toBeNull()
    expect((await people()).some((s) => s.main_contact)).toBe(false)
  })

  it("refuses someone who is not one of the company's stakeholders (400 invalid_stakeholder)", async () => {
    const e = await failure(api.setMainContact(company, StakeholderId.parse("stk_b1")))
    expect(e).toMatchObject({ status: 400, code: "invalid_stakeholder" })
    expect((await people()).filter((s) => s.main_contact).map((s) => s.id)).toEqual(["stk_k1"])
    expect(
      (await call("PUT", "/companies/cmp_kestrel/main-contact", { stakeholder: 7 })).status,
    ).toBe(422)
  })
})

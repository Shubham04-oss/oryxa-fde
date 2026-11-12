import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest"
import { ApiError, api } from "./client"
import type { paths } from "./fde-api.gen"
import { CompanyId, ProjectId, UserId } from "./schemas"
import { resetMockApi } from "@/dev/mock-api"

// The dev mock answers `/v1/people` and names members and assignees as the API does
// (crates/oryxa-fde-api/src/people.rs), so the screens are tried against what the API will say.

type Listed = paths["/v1/people"]["get"]["responses"]["200"]["content"]["application/json"]
const g = globalThis as Record<string, unknown>

async function status(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ApiError)
  return (error as ApiError).status
}

describe("the mock's people", () => {
  beforeEach(() => resetMockApi())
  afterEach(() => delete g.__fdeMockPeople)

  it("answers in the spec's shape", () => {
    expectTypeOf<Awaited<ReturnType<typeof api.people>>>().toExtend<Listed>()
    expectTypeOf<Listed[number]>().toEqualTypeOf<{ id: string; name?: string | null }>()
  })

  it("lists the organisation's own people by name, the unnamed last, and no guest", async () => {
    const people = await api.people()
    expect(people.map((p) => p.name ?? null)).toEqual([
      "Aurelia Montgomery-Featherstonehaugh de la Cruz Vandermeer-Okonkwo",
      "Jonah Ade",
      "Riya Kapoor",
      "Sam Okafor",
      "Tomoko Hale",
      null,
    ])
    expect(people.some((p) => p.id === "usr_visitor")).toBe(false)
    // Ids and names only: never an email.
    for (const p of people) expect(Object.keys(p).sort()).toEqual(["id", "name"])
  })

  it("is listed to an engineer too: it needs the workspace, not a company", async () => {
    resetMockApi({ engineer: true })
    expect((await api.people()).length).toBe(6)
  })

  it("answers 503 when WorkOS cannot, never a partial list, and members then carry no names", async () => {
    g.__fdeMockPeople = "unavailable"
    expect(await status(api.people())).toBe(503)
    const members = await api.members(CompanyId.parse("cmp_kestrel"))
    expect(members.map((m) => m.name ?? null)).toEqual([null, null])
  })

  it("answers 403 to someone outside the workspace", async () => {
    g.__fdeMockPeople = "forbidden"
    expect(await status(api.people())).toBe(403)
  })

  it("names a company's members and a project's assignees", async () => {
    const company = CompanyId.parse("cmp_kestrel")
    expect((await api.members(company)).map((m) => [m.user, m.name])).toEqual([
      ["usr_riya", "Riya Kapoor"],
      ["usr_jonah", "Jonah Ade"],
    ])
    const scope = { company, project: ProjectId.parse("prj_kestrel_dispatch") }
    expect((await api.assignees(scope)).map((a) => a.name)).toEqual(["Riya Kapoor", "Jonah Ade"])
  })

  it("adds someone of the organisation to a company, and not a guest or a stranger", async () => {
    const company = CompanyId.parse("cmp_kestrel")
    await api.setMember(company, UserId.parse("usr_sam"), "engineer")
    expect((await api.members(company)).at(-1)).toMatchObject({
      user: "usr_sam",
      name: "Sam Okafor",
      role: "engineer",
    })
    expect(await status(api.setMember(company, UserId.parse("usr_visitor"), "engineer"))).toBe(404)
    expect(await status(api.setMember(company, UserId.parse("usr_nobody"), "engineer"))).toBe(404)
  })

  it("takes a task's assignee who works on the project, as the API does", async () => {
    const company = CompanyId.parse("cmp_kestrel")
    const scope = { company, project: ProjectId.parse("prj_kestrel_dispatch") }
    const base = {
      title: "t",
      status: "todo" as const,
      blocker: null,
      waiting_on: null,
      due_on: null,
      blocked_by: null,
      criterion: null,
    }
    const task = await api.addTask(scope, { ...base, assignee: "usr_jonah" })
    expect(task.assignee).toBe("usr_jonah")
    const refused = await api.addTask(scope, { ...base, assignee: "usr_sam" }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((refused as ApiError).code).toBe("invalid_assignee")
  })
})

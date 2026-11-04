import { beforeEach, describe, expect, it } from "vitest"
import { ApiError, api, mockApiOn, safeReturnTo } from "./client"
import { CompanyId, Project, ProjectId } from "./schemas"
import { resetMockApi } from "@/dev/mock-api"

const company = CompanyId.parse("cmp_kestrel")
const project = ProjectId.parse("prj_kestrel_dispatch")

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe("api on the mock", () => {
  beforeEach(() => resetMockApi())

  it("answers every screen's reads, parsed against the schemas", async () => {
    const { companies } = await api.companies()
    expect(companies.map((c) => c.name)).toEqual([
      "Kestrel Freight",
      "Brightwater Clinics",
      "Lumen Grocers",
      "Atlas Mutual",
      "Cobalt Grid",
    ])
    for (const c of companies) {
      const detail = await api.company(c.id)
      for (const p of detail.projects) {
        expect((await api.project({ company: c.id, project: p.id })).company.id).toBe(c.id)
      }
    }
    expect((await api.today()).items.length).toBeGreaterThan(0)
    expect((await api.me()).organisation.name).toBe("Northlight FDE")
  })

  it("refuses everything without a session", async () => {
    resetMockApi({ signedIn: false })
    expect((await refusal(api.me())).status).toBe(401)
    expect((await refusal(api.companies())).status).toBe(401)
    await api.signIn()
    expect((await api.me()).user.name).toBe("Riya Kapoor")
    await api.signOut()
    expect((await refusal(api.today())).status).toBe(401)
  })

  it("answers 404 for a company that is not the FDE's, and for a project under the wrong company", async () => {
    expect((await refusal(api.company(CompanyId.parse("cmp_other")))).status).toBe(404)
    const elsewhere = { company: CompanyId.parse("cmp_lumen"), project }
    expect((await refusal(api.project(elsewhere))).status).toBe(404)
  })

  it("keeps the stage machine: one forward, any back, never a skip", async () => {
    const scope = { company, project }
    expect((await api.moveStage(scope, "evaluate")).stage).toBe("evaluate")
    expect((await api.moveStage(scope, "access")).stage).toBe("access")
    const skip = await refusal(api.moveStage(scope, "deploy"))
    expect([skip.status, skip.code]).toEqual([409, "stage_skip"])
    expect((await api.project(scope)).stage).toBe("access")
  })
})

describe("schemas", () => {
  it("refuse ids that break the platform's id rule", () => {
    for (const bad of ["", "a|b", "a b", "a/b", "é", "../x", "a".repeat(129)])
      expect(CompanyId.safeParse(bad).success, bad).toBe(false)
    expect(CompanyId.safeParse("cmp_01J-x").success).toBe(true)
  })

  it("fail loudly on an answer that drifts from the contract", async () => {
    resetMockApi()
    const answer = await api.project({ company, project })
    expect(Project.safeParse({ ...answer, stage: "launch" }).success).toBe(false)
    expect(Project.safeParse({ ...answer, tasks: [{ id: "t" }] }).success).toBe(false)
  })
})

describe("safeReturnTo", () => {
  it("keeps same-origin paths and refuses anything that could leave the app", () => {
    expect(safeReturnTo("/today")).toBe("/today")
    expect(safeReturnTo("/companies/cmp_1?x=1")).toBe("/companies/cmp_1?x=1")
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "today", 7])
      expect(safeReturnTo(bad)).toBe("/")
  })
})

describe("mockApiOn", () => {
  it("is on only in a dev build with its flag", () => {
    expect(mockApiOn({ DEV: true, VITE_FDE_MOCK_API: "1" })).toBe(true)
    expect(mockApiOn({ DEV: true })).toBe(false)
    expect(mockApiOn({ DEV: true, VITE_FDE_MOCK_API: "true" })).toBe(false)
    expect(mockApiOn({ DEV: false, VITE_FDE_MOCK_API: "1" })).toBe(false)
  })
})

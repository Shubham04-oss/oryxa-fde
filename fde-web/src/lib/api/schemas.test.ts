import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import type { components } from "./fde-api.gen"
import * as S from "./schemas"

type Spec = components["schemas"]

describe("schemas", () => {
  // Checked by `pnpm typecheck`: when the spec changes, `pnpm api:generate` changes these types
  // and the schemas must follow before the app builds again.
  it("accept exactly what the OpenAPI spec says each answer is", () => {
    expectTypeOf<z.input<typeof S.CompanyOut>>().toEqualTypeOf<Spec["CompanyOut"]>()
    expectTypeOf<z.input<typeof S.ProjectOut>>().toEqualTypeOf<Spec["ProjectOut"]>()
    expectTypeOf<z.input<typeof S.MemberOut>>().toEqualTypeOf<Spec["MemberOut"]>()
    expectTypeOf<z.input<typeof S.StakeholderOut>>().toEqualTypeOf<Spec["StakeholderOut"]>()
    expectTypeOf<z.input<typeof S.SystemOut>>().toEqualTypeOf<Spec["SystemOut"]>()
    expectTypeOf<z.input<typeof S.ScopeItemOut>>().toEqualTypeOf<Spec["ScopeItemOut"]>()
    expectTypeOf<z.input<typeof S.CriterionOut>>().toEqualTypeOf<Spec["CriterionOut"]>()
    expectTypeOf<z.input<typeof S.SignOffOut>>().toEqualTypeOf<Spec["SignOffOut"]>()
    expectTypeOf<z.input<typeof S.ScopeOut>>().toEqualTypeOf<Spec["ScopeOut"]>()
    expectTypeOf<z.input<typeof S.AccessRequestOut>>().toEqualTypeOf<Spec["AccessRequestOut"]>()
    expectTypeOf<z.input<typeof S.TaskOut>>().toEqualTypeOf<Spec["TaskOut"]>()
    expectTypeOf<z.input<typeof S.DecisionOut>>().toEqualTypeOf<Spec["DecisionOut"]>()
    expectTypeOf<z.input<typeof S.Stage>>().toEqualTypeOf<Spec["ProjectStage"]>()
  })

  it("refuse ids that break the platform's id rule", () => {
    for (const bad of ["", "a|b", "a b", "a/b", "é", "../x", "a".repeat(129)])
      expect(S.CompanyId.safeParse(bad).success, bad).toBe(false)
    expect(S.CompanyId.safeParse("cmp_01J-x").success).toBe(true)
  })

  it("take the API's timestamps, nanoseconds and all", () => {
    const at = "2026-11-04T10:06:24.123456789Z"
    const task = { id: "tsk_1", title: "t", status: "todo", created_at: at, updated_at: at }
    expect(S.TaskOut.parse(task).blocker).toBeUndefined()
    expect(S.TaskOut.safeParse({ ...task, updated_at: "yesterday" }).success).toBe(false)
  })

  it("fail loudly on an answer that drifts from the contract", () => {
    const at = "2026-11-04T10:06:24Z"
    const project = {
      id: "p",
      company: "c",
      name: "n",
      stage: "build",
      created_at: at,
      updated_at: at,
    }
    expect(S.ProjectOut.safeParse(project).success).toBe(true)
    expect(S.ProjectOut.safeParse({ ...project, stage: "launch" }).success).toBe(false)
    expect(S.ProjectOut.safeParse({ ...project, company: "../other" }).success).toBe(false)
  })
})

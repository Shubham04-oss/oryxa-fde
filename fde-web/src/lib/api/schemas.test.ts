import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import type { components } from "./fde-api.gen"
import * as S from "./schemas"

type Spec = components["schemas"]
/** An `allOf` comes out as an intersection; compare it as the one object it describes. */
type Flat<T> = { [K in keyof T]: T[K] }

describe("schemas", () => {
  // Checked by `pnpm typecheck`: when the spec changes, `pnpm api:generate` changes these types
  // and the schemas must follow before the app builds again.
  it("accept exactly what the OpenAPI spec says each answer is", () => {
    expectTypeOf<z.input<typeof S.CompanyOut>>().toEqualTypeOf<Spec["CompanyOut"]>()
    expectTypeOf<z.input<typeof S.ProjectOut>>().toEqualTypeOf<Spec["ProjectOut"]>()
    expectTypeOf<z.input<typeof S.StakeholderOut>>().toEqualTypeOf<Spec["StakeholderOut"]>()
    expectTypeOf<z.input<typeof S.MainContactOut>>().toEqualTypeOf<Spec["MainContactOut"]>()
    expectTypeOf<z.input<typeof S.NextStepOut>>().toEqualTypeOf<Spec["NextStepOut"]>()
    expectTypeOf<z.input<typeof S.SystemOut>>().toEqualTypeOf<Spec["SystemOut"]>()
    expectTypeOf<z.input<typeof S.MemberOut>>().toEqualTypeOf<Spec["MemberOut"]>()
    expectTypeOf<z.input<typeof S.AssigneeOut>>().toEqualTypeOf<Spec["AssigneeOut"]>()
    expectTypeOf<z.input<typeof S.PersonOut>>().toEqualTypeOf<Spec["PersonOut"]>()
    expectTypeOf<z.input<typeof S.ScopeItemOut>>().toEqualTypeOf<Spec["ScopeItemOut"]>()
    expectTypeOf<z.input<typeof S.CriterionOut>>().toEqualTypeOf<Spec["CriterionOut"]>()
    expectTypeOf<z.input<typeof S.SignOffOut>>().toEqualTypeOf<Spec["SignOffOut"]>()
    expectTypeOf<z.input<typeof S.ScopeOut>>().toEqualTypeOf<Spec["ScopeOut"]>()
    expectTypeOf<z.input<typeof S.AccessRequestOut>>().toEqualTypeOf<Spec["AccessRequestOut"]>()
    expectTypeOf<z.input<typeof S.TaskOut>>().toEqualTypeOf<Spec["TaskOut"]>()
    expectTypeOf<z.input<typeof S.DecisionOut>>().toEqualTypeOf<Spec["DecisionOut"]>()
    expectTypeOf<z.input<typeof S.MeetingNoteOut>>().toEqualTypeOf<Spec["MeetingNoteOut"]>()
    expectTypeOf<z.input<typeof S.DocumentOut>>().toEqualTypeOf<Spec["DocumentOut"]>()
    expectTypeOf<z.input<typeof S.SearchHitOut>>().toEqualTypeOf<Spec["SearchHitOut"]>()
    expectTypeOf<z.input<typeof S.IngestState>>().toEqualTypeOf<Spec["IngestState"]>()
    expectTypeOf<z.input<typeof S.ThreadOut>>().toEqualTypeOf<Spec["ThreadOut"]>()
    expectTypeOf<z.input<typeof S.Stage>>().toEqualTypeOf<Spec["ProjectStage"]>()
    expectTypeOf<z.input<typeof S.ChecklistItemOut>>().toEqualTypeOf<Spec["ChecklistItemOut"]>()
    expectTypeOf<z.input<typeof S.StageChecklistOut>>().toEqualTypeOf<Spec["StageChecklistOut"]>()
    expectTypeOf<z.input<typeof S.StageConflictBody>>().toEqualTypeOf<Spec["StageConflictBody"]>()
    expectTypeOf<z.input<typeof S.Me>>().toEqualTypeOf<Spec["MeOut"]>()
    expectTypeOf<z.input<typeof S.ProjectSummaryOut>>().toEqualTypeOf<Spec["ProjectSummaryOut"]>()
    expectTypeOf<z.input<typeof S.CompanySummaryOut>>().toEqualTypeOf<
      Flat<Spec["CompanySummaryOut"]>
    >()
    expectTypeOf<z.input<typeof S.TodayOut>>().toEqualTypeOf<Spec["TodayOut"]>()
  })

  it("refuse ids that break the platform's id rule", () => {
    for (const bad of ["", "a|b", "a b", "a/b", "é", "../x", "a".repeat(129)])
      expect(S.CompanyId.safeParse(bad).success, bad).toBe(false)
    expect(S.CompanyId.safeParse("cmp_01J-x").success).toBe(true)
  })

  it("take the API's timestamps, nanoseconds and all", () => {
    const at = "2026-11-04T10:06:24.123456789Z"
    const task = {
      id: "tsk_1",
      title: "t",
      status: "todo",
      created_at: at,
      updated_at: at,
      version: 1,
    }
    expect(S.TaskOut.parse(task).blocker).toBeUndefined()
    expect(S.TaskOut.safeParse({ ...task, updated_at: "yesterday" }).success).toBe(false)
  })

  it("refuse a record that has no version: it could only be saved unchecked", () => {
    const at = "2026-11-04T10:06:24Z"
    const records = {
      TaskOut: { id: "t", title: "t", status: "todo", created_at: at, updated_at: at },
      StakeholderOut: { id: "s", name: "n", role: "user", updated_at: at },
      SystemOut: { id: "s", name: "n", updated_at: at },
      ScopeItemOut: { id: "i", kind: "in", description: "d", updated_at: at },
      CriterionOut: {
        id: "c",
        description: "d",
        metric: "m",
        comparator: "at_least",
        target: 1,
        updated_at: at,
      },
      AccessRequestOut: {
        id: "a",
        description: "d",
        status: "requested",
        requested_at: at,
        status_changed_at: at,
        days_waiting: 0,
      },
    } as const
    for (const [name, record] of Object.entries(records)) {
      const schema = S[name as keyof typeof records]
      expect(schema.safeParse(record).success, `${name} without a version`).toBe(false)
      expect(schema.safeParse({ ...record, version: 1 }).success, `${name} with one`).toBe(true)
      expect(schema.safeParse({ ...record, version: -1 }).success, `${name} negative`).toBe(false)
    }
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

import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import type { components } from "./evals.gen"
import type { components as Main } from "./fde-api.gen"
import * as E from "./evals"

type Spec = components["schemas"]

describe("eval schemas", () => {
  // Checked by `pnpm typecheck`: when a spec changes, `pnpm api:generate` changes these types and the
  // schemas must follow. The schemas are narrower than the spec where the spec says only "string"
  // (a run's state), so those must fit inside it and name the same fields.
  it("follow the evals spec", () => {
    expectTypeOf<z.input<typeof E.Case>>().toEqualTypeOf<Spec["Case"]>()
    expectTypeOf<z.input<typeof E.Command>>().toEqualTypeOf<Spec["Command"]>()
    expectTypeOf<z.input<typeof E.CaseOutcome>>().toEqualTypeOf<Spec["CaseOutcome"]>()
    expectTypeOf<z.input<typeof E.CriterionRate>>().toEqualTypeOf<Spec["CriterionRate"]>()
    expectTypeOf<z.input<typeof E.Verdict>>().toEqualTypeOf<Spec["Verdict"]>()
    expectTypeOf<z.input<typeof E.CaseResult>>().toEqualTypeOf<Spec["CaseResult"]>()
    expectTypeOf<z.input<typeof E.Report>>().toEqualTypeOf<Spec["Report"]>()
    expectTypeOf<z.input<typeof E.Grader>>().toExtend<Spec["Grader"]>()
    expectTypeOf<Spec["Grader"]>().toExtend<z.input<typeof E.Grader>>()
    type Suite = z.input<typeof E.SuiteOut>
    expectTypeOf<keyof Suite>().toEqualTypeOf<keyof Spec["SuiteOut"]>()
    expectTypeOf<Suite>().toExtend<Spec["SuiteOut"]>()
    type Run = z.input<typeof E.EvalRunOut>
    expectTypeOf<keyof Run>().toEqualTypeOf<keyof Spec["EvalRunOut"]>()
    expectTypeOf<Run>().toExtend<Spec["EvalRunOut"]>()
  })

  it("follow the room's criteria, the one place the API says whether a criterion is met", () => {
    type Room = z.input<typeof E.RoomCriterion>
    expectTypeOf<Room>().toEqualTypeOf<Main["schemas"]["RoomCriterionOut"]>()
    expectTypeOf<keyof z.input<typeof E.ProofRoom>>().toExtend<keyof Main["schemas"]["RoomOut"]>()
  })

  it("take every kind of grader and verdict the API sends", () => {
    const graders = [
      { kind: "exact_match" },
      { kind: "exact_match", ignore_case: true },
      { kind: "regex", pattern: "^ok" },
      { kind: "json_schema", schema: { type: "object" } },
      { kind: "script", argv: ["python3", "g.py"], timeout_secs: 10 },
      { kind: "judge", rubric: "Polite." },
    ]
    for (const g of graders) expect(E.Grader.parse(g)).toEqual(g)
    for (const v of [
      { verdict: "passed", score: 0.9 },
      { verdict: "passed" },
      { verdict: "failed", reason: "no" },
      { verdict: "errored", reason: "could not decide" },
    ])
      expect(E.Verdict.parse(v)).toEqual(v)
    expect(E.Grader.safeParse({ kind: "telepathy" }).success).toBe(false)
  })

  it("refuse a run that is neither running nor finished, and an id that breaks the rule", () => {
    const run = {
      id: "eval_1",
      suite: "suite_1",
      state: "running",
      imported: false,
      created_by: "usr_1",
      created_at: "2026-11-10T10:00:00Z",
    }
    expect(E.EvalRunOut.parse(run).report).toBeUndefined()
    expect(E.EvalRunOut.safeParse({ ...run, state: "done" }).success).toBe(false)
    expect(E.EvalRunOut.safeParse({ ...run, id: "a/b" }).success).toBe(false)
  })
})

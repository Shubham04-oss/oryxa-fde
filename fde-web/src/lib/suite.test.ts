import { describe, expect, it } from "vitest"
import { blankGrader, suiteBody, suiteFields, suiteProblem } from "./suite"
import type { SuiteFields } from "./suite"

const ok = (over: Partial<SuiteFields> = {}): SuiteFields => ({
  ...suiteFields(["crt_a"]),
  name: "Answer quality",
  ...over,
})

const message = (p: ReturnType<typeof suiteProblem>) => (typeof p === "string" ? p : p?.message)
const field = (p: ReturnType<typeof suiteProblem>) => (typeof p === "string" ? undefined : p?.field)

describe("the new-suite form", () => {
  it("accepts a name, a criterion and a grader, and sends them as the API takes them", () => {
    expect(suiteProblem(ok())).toBeNull()
    expect(suiteBody(ok({ name: "  Answer quality  " }))).toEqual({
      name: "Answer quality",
      criteria: ["crt_a"],
      graders: [{ kind: "exact_match", ignore_case: false }],
      target: null,
    })
  })

  it("says which part is wrong, and names the field", () => {
    expect(field(suiteProblem(ok({ name: "  " })))).toBe("name")
    expect(field(suiteProblem(ok({ name: "a".repeat(201) })))).toBe("name")
    expect(field(suiteProblem(ok({ criteria: [] })))).toBe("criteria")
    expect(message(suiteProblem(ok({ graders: [] })))).toBe("Add at least one grader.")
  })

  it("checks each kind of grader, by number", () => {
    const regex = { ...blankGrader("regex"), pattern: "" }
    expect(message(suiteProblem(ok({ graders: [blankGrader(), regex] })))).toBe(
      "Grader 2 needs a pattern of 1 to 512 bytes.",
    )
    expect(field(suiteProblem(ok({ graders: [blankGrader(), regex] })))).toBe("grader-1")
    expect(
      message(suiteProblem(ok({ graders: [{ ...blankGrader("json_schema"), schema: "{nope" }] }))),
    ).toBe("Grader 1's schema is not JSON.")
    expect(
      message(suiteProblem(ok({ graders: [{ ...blankGrader("json_schema"), schema: "[]" }] }))),
    ).toBe("Grader 1's schema must be a JSON object.")
    expect(message(suiteProblem(ok({ graders: [blankGrader("judge")] })))).toMatch(/needs a rubric/)
    expect(message(suiteProblem(ok({ graders: [blankGrader("script")] })))).toMatch(
      /needs a command/,
    )
    expect(
      message(
        suiteProblem(
          ok({ graders: [{ ...blankGrader("script"), argv: "python3", timeout: "601" }] }),
        ),
      ),
    ).toMatch(/time limit of 1 to 600 seconds/)
  })

  it("takes a command as one argument per line, blank lines left out", () => {
    const f = ok({
      source: "command",
      argv: "node\neval/answer.mjs\n\n--fast\n",
      timeout: "30",
      graders: [{ ...blankGrader("script"), argv: "python3\ngrade.py", timeout: "10" }],
    })
    expect(suiteProblem(f)).toBeNull()
    expect(suiteBody(f)).toMatchObject({
      target: { argv: ["node", "eval/answer.mjs", "--fast"], timeout_secs: 30 },
      graders: [{ kind: "script", argv: ["python3", "grade.py"], timeout_secs: 10 }],
    })
  })

  it("needs a target command only when the outputs come from one", () => {
    expect(field(suiteProblem(ok({ source: "command", argv: "" })))).toBe("target")
    expect(suiteProblem(ok({ source: "imported", argv: "" }))).toBeNull()
  })

  it("allows at most eight graders", () => {
    expect(
      message(suiteProblem(ok({ graders: Array.from({ length: 9 }, () => blankGrader()) }))),
    ).toBe("A suite has at most 8 graders.")
  })
})

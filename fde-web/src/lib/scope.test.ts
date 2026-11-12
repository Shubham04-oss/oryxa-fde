import { describe, expect, expectTypeOf, it } from "vitest"
import type { components } from "./api/fde-api.gen"
import type { CriterionOut, ScopeItemOut, StakeholderOut } from "./api/schemas"
import { CriterionId, ScopeItemId, StakeholderId } from "./api/schemas"
import {
  changesSince,
  criterionBody,
  criterionChanged,
  criterionFields,
  criterionProblem,
  inUnit,
  itemBody,
  itemChanged,
  itemFields,
  itemProblem,
  measure,
  proofChanged,
  signOffState,
  signers,
  targetOf,
} from "./scope"
import type { CriterionBody, CriterionSave } from "./scope"

const at = "2026-11-04T10:06:24Z"
const item: ScopeItemOut = {
  id: ScopeItemId.parse("itm_1"),
  kind: "in",
  description: "Draft next-day load plans",
  updated_at: at,
  version: 1,
}
const criterion: CriterionOut = {
  id: CriterionId.parse("crt_1"),
  description: "Plans dispatchers accept with no changes",
  metric: "plans accepted unchanged",
  comparator: "at_least",
  target: 70,
  unit: "%",
  updated_at: at,
  version: 1,
}
const person = (id: string, name: string, role: StakeholderOut["role"]): StakeholderOut => ({
  id: StakeholderId.parse(id),
  name,
  role,
  title: null,
  email: null,
  updated_at: at,
  version: 1,
})

describe("scope items", () => {
  it("need words, on the side they are listed", () => {
    expect(itemProblem({ kind: "in", description: " " })).toBe("Write what is in scope.")
    expect(itemProblem({ kind: "out", description: "" })).toBe("Write what is out of scope.")
    expect(itemProblem({ kind: "in", description: "x".repeat(4001) })).toBe(
      "The description is plain text, up to 4000 characters.",
    )
    // A long item with several lines is fine: it is what the textarea is for.
    expect(itemProblem({ kind: "in", description: `${"line\n".repeat(200)}end` })).toBeNull()
  })

  it("send the side and the trimmed words, and count as changed only when one differs", () => {
    expect(itemBody({ kind: "out", description: "  Live re-routing " })).toEqual({
      kind: "out",
      description: "Live re-routing",
    })
    expect(itemChanged(item, itemFields(item))).toBe(false)
    expect(
      itemChanged(item, { ...itemFields(item), description: " Draft next-day load plans " }),
    ).toBe(false)
    expect(itemChanged(item, { ...itemFields(item), kind: "out" })).toBe(true)
    expect(itemChanged(item, { ...itemFields(item), description: "Plans for one depot" })).toBe(
      true,
    )
  })

  it("start on the side whose Add was pressed", () => {
    expect(itemFields(undefined, "out")).toEqual({ kind: "out", description: "" })
  })
})

describe("success criteria", () => {
  const ok = criterionFields(criterion)

  it("hold every field of the record, the target as text", () => {
    expect(ok).toEqual({
      description: "Plans dispatchers accept with no changes",
      metric: "plans accepted unchanged",
      comparator: "at_least",
      target: "70",
      unit: "%",
      baseline: "",
      proof: "",
    })
    expect(criterionProblem(ok)).toBeNull()
    expect(
      criterionFields({ ...criterion, baseline: 0.42, proof: "The acceptance suite" }),
    ).toMatchObject({ baseline: "0.42", proof: "The acceptance suite" })
    // Zero is a baseline, not none.
    expect(criterionFields({ ...criterion, baseline: 0 }).baseline).toBe("0")
  })

  it("take a baseline as a number in the target's unit, and a proof of up to 500 characters", () => {
    expect(
      criterionProblem({ ...ok, baseline: "61.5", proof: "line one\nline two\tok" }),
    ).toBeNull()
    expect(criterionProblem({ ...ok, baseline: "  " })).toBeNull()
    expect(criterionProblem({ ...ok, baseline: "lots" })).toBe(
      "The baseline must be a number, in the same unit as the target.",
    )
    expect(criterionProblem({ ...ok, baseline: "Infinity" })).toBe(
      "The baseline must be a number, in the same unit as the target.",
    )
    const tooLong = "How it will be proven is plain text, up to 500 characters."
    expect(criterionProblem({ ...ok, proof: "x".repeat(500) })).toBeNull()
    expect(criterionProblem({ ...ok, proof: ` ${"x".repeat(500)} ` })).toBeNull()
    expect(criterionProblem({ ...ok, proof: "x".repeat(501) })).toBe(tooLong)
    // The API's control characters: C0 but newline and tab, DEL, and C1.
    for (const bad of ["a\u0007b", "a\u001b[31mb", "a\rb", "a\u0085b"])
      expect(criterionProblem({ ...ok, proof: bad }), JSON.stringify(bad)).toBe(tooLong)
  })

  it("say what is missing, one thing at a time", () => {
    expect(criterionProblem({ ...ok, description: "" })).toBe("Say what must be true.")
    expect(criterionProblem({ ...ok, metric: " " })).toBe("Say what is measured.")
    expect(criterionProblem({ ...ok, target: "" })).toBe("The target must be a number.")
    expect(criterionProblem({ ...ok, target: "seventy" })).toBe("The target must be a number.")
    expect(criterionProblem({ ...ok, target: "Infinity" })).toBe("The target must be a number.")
    expect(criterionProblem({ ...ok, metric: "m".repeat(201) })).toBe(
      "What is measured is one line, up to 200 characters.",
    )
    expect(criterionProblem({ ...ok, unit: "u".repeat(201) })).toBe(
      "The unit is one line, up to 200 characters, such as % or s.",
    )
  })

  it("read a target the way a person types it", () => {
    expect(targetOf(" 0.95 ")).toBe(0.95)
    expect(targetOf("0")).toBe(0)
    expect(targetOf("-3")).toBe(-3)
    expect(targetOf("")).toBeNull()
    expect(targetOf("1,5")).toBeNull()
  })

  it("send every field, a blank unit, baseline or proof as none", () => {
    expect(criterionBody({ ...ok, unit: " ", target: "2" })).toEqual({
      description: "Plans dispatchers accept with no changes",
      metric: "plans accepted unchanged",
      comparator: "at_least",
      target: 2,
      unit: null,
      baseline: null,
      proof: null,
    })
    expect(
      criterionBody({ ...ok, baseline: " 0 ", proof: "  The acceptance suite " }),
    ).toMatchObject({ baseline: 0, proof: "The acceptance suite" })
  })

  it("is the API's criterion body, with every field a PUT clears when left out required", () => {
    type Spec = components["schemas"]
    expectTypeOf<keyof CriterionBody>().toEqualTypeOf<
      Exclude<keyof Spec["CriterionBody"], "version">
    >()
    expectTypeOf<CriterionSave>().toExtend<Spec["CriterionBody"]>()
    expectTypeOf<Pick<CriterionSave, "baseline" | "proof" | "unit">>().toEqualTypeOf<{
      baseline: number | null
      proof: string | null
      unit: string | null
    }>()
    expectTypeOf(criterionBody).returns.toEqualTypeOf<CriterionSave>()
  })

  it("count as changed only when a field differs", () => {
    expect(criterionChanged(criterion, ok)).toBe(false)
    expect(criterionChanged(criterion, { ...ok, target: "70.0" })).toBe(false)
    expect(criterionChanged(criterion, { ...ok, comparator: "at_most" })).toBe(true)
    expect(criterionChanged(criterion, { ...ok, target: "75" })).toBe(true)
    expect(criterionChanged(criterion, { ...ok, unit: "" })).toBe(true)
    expect(criterionChanged(criterion, { ...ok, baseline: "40" })).toBe(true)
    expect(criterionChanged(criterion, { ...ok, proof: "The acceptance suite" })).toBe(true)
  })

  it("tell a change to the baseline or the proof, which are part of what is signed", () => {
    const proven = { ...criterion, baseline: 40, proof: "The acceptance suite" }
    const same = criterionFields(proven)
    expect(proofChanged(proven, same)).toBe(false)
    expect(
      proofChanged(proven, { ...same, baseline: "40.0", proof: " The acceptance suite " }),
    ).toBe(false)
    expect(proofChanged(proven, { ...same, baseline: "" })).toBe(true)
    expect(proofChanged(proven, { ...same, proof: "" })).toBe(true)
    // A change elsewhere is not one.
    expect(proofChanged(proven, { ...same, target: "90" })).toBe(false)
    expect(criterionChanged(proven, { ...same, proof: "" })).toBe(true)
  })

  it("write a number in the criterion's unit", () => {
    expect(inUnit(42, "%")).toBe("42%")
    expect(inUnit(45, "min")).toBe("45 min")
    expect(inUnit(0.42, null)).toBe("0.42")
  })

  it("read as a sentence the customer would agree to", () => {
    expect(measure(criterion)).toBe("plans accepted unchanged is at least 70%")
    expect(
      measure({ metric: "minutes per depot", comparator: "at_most", target: 2, unit: "min" }),
    ).toBe("minutes per depot is at most 2 min")
    expect(measure({ metric: "rule breaks", comparator: "at_most", target: 0, unit: null })).toBe(
      "rule breaks is at most 0",
    )
  })
})

describe("sign-off", () => {
  const signed = { version: 4, stakeholder: StakeholderId.parse("stk_1") } as never

  it("is one of three states", () => {
    expect(signOffState({ sign_off: null, signed_off: false })).toBe("none")
    expect(signOffState({ sign_off: undefined, signed_off: false })).toBe("none")
    expect(signOffState({ sign_off: signed, signed_off: true })).toBe("signed")
    expect(signOffState({ sign_off: signed, signed_off: false })).toBe("changed")
  })

  it("counts the changes made since", () => {
    expect(changesSince({ version: 6, sign_off: signed })).toBe(2)
    expect(changesSince({ version: 4, sign_off: signed })).toBe(0)
    expect(changesSince({ version: 6, sign_off: null })).toBe(0)
  })

  it("offers sponsors first, then the rest by name", () => {
    const people = [
      person("stk_1", "Zed", "other"),
      person("stk_2", "Ana", "it"),
      person("stk_3", "Mara", "sponsor"),
      person("stk_4", "Bo", "sponsor"),
    ]
    expect(signers(people).map((p) => p.name)).toEqual(["Bo", "Mara", "Ana", "Zed"])
    // The list the page holds is left as it was.
    expect(people[0]!.name).toBe("Zed")
  })
})

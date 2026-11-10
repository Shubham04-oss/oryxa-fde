import { describe, expect, it } from "vitest"
import type { CriterionOut, ScopeItemOut, StakeholderOut } from "./api/schemas"
import { CriterionId, ScopeItemId, StakeholderId } from "./api/schemas"
import {
  changesSince,
  criterionBody,
  criterionChanged,
  criterionFields,
  criterionProblem,
  itemBody,
  itemChanged,
  itemFields,
  itemProblem,
  measure,
  signOffState,
  signers,
  targetOf,
} from "./scope"

const at = "2026-11-04T10:06:24Z"
const item: ScopeItemOut = {
  id: ScopeItemId.parse("itm_1"),
  kind: "in",
  description: "Draft next-day load plans",
  updated_at: at,
}
const criterion: CriterionOut = {
  id: CriterionId.parse("crt_1"),
  description: "Plans dispatchers accept with no changes",
  metric: "plans accepted unchanged",
  comparator: "at_least",
  target: 70,
  unit: "%",
  updated_at: at,
}
const person = (id: string, name: string, role: StakeholderOut["role"]): StakeholderOut => ({
  id: StakeholderId.parse(id),
  name,
  role,
  title: null,
  email: null,
  updated_at: at,
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
    })
    expect(criterionProblem(ok)).toBeNull()
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

  it("send every field, a blank unit as none", () => {
    expect(criterionBody({ ...ok, unit: " ", target: "2" })).toEqual({
      description: "Plans dispatchers accept with no changes",
      metric: "plans accepted unchanged",
      comparator: "at_least",
      target: 2,
      unit: null,
    })
  })

  it("count as changed only when a field differs", () => {
    expect(criterionChanged(criterion, ok)).toBe(false)
    expect(criterionChanged(criterion, { ...ok, target: "70.0" })).toBe(false)
    expect(criterionChanged(criterion, { ...ok, comparator: "at_most" })).toBe(true)
    expect(criterionChanged(criterion, { ...ok, target: "75" })).toBe(true)
    expect(criterionChanged(criterion, { ...ok, unit: "" })).toBe(true)
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

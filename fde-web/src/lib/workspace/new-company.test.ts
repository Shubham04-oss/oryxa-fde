import { describe, expect, it } from "vitest"
import {
  NO_ANSWERS,
  answerText,
  defaultRules,
  nextStep,
  proposePlan,
  readyToCreate,
  reviewChecklist,
  summaryBlocks,
} from "./new-company"
import type { Answers } from "./new-company"
import { MAX_NAME, MAX_TEXT } from "@/lib/records"

const company = { name: "Orion Rail", industry: "", region: "", summary: "Claims intake." }
const start = (approach: "talk" | "scope" | "pilot", contact = "", criterion = "") => ({
  approach,
  contact,
  criterion,
})
const all: Answers = {
  company,
  start: start("talk", "Dana Ortiz", "Claims triaged within two hours"),
  rules: defaultRules(),
  people: [],
  plan: proposePlan({ ...NO_ANSWERS, start: start("talk") }),
}

describe("the new-company conversation", () => {
  it("asks each step in turn, then reviews", () => {
    expect(nextStep(NO_ANSWERS)).toBe("company")
    expect(nextStep({ ...NO_ANSWERS, company })).toBe("start")
    expect(nextStep({ ...all, people: null })).toBe("people")
    expect(nextStep(all)).toBe("review")
  })

  it("may create only once every required step is answered; people are optional", () => {
    expect(readyToCreate(NO_ANSWERS)).toBe(false)
    expect(readyToCreate({ ...all, rules: null })).toBe(false)
    expect(readyToCreate({ ...all, plan: [] })).toBe(false)
    expect(readyToCreate({ ...all, company: { ...company, name: "  " } })).toBe(false)
    expect(readyToCreate({ ...all, people: null })).toBe(true)
  })

  it("proposes a plan that starts where the FDE said, as tasks on stages", () => {
    const talk = proposePlan({ ...NO_ANSWERS, start: start("talk", "Dana Ortiz") })
    expect(talk[0]).toMatchObject({
      title: "Discovery call",
      stage: "discover",
      with: "Dana Ortiz",
    })
    expect(talk.map((s) => s.stage)).toEqual([
      "discover",
      "scope",
      "access",
      "build",
      "evaluate",
      "handoff",
    ])

    const pilot = proposePlan({ ...NO_ANSWERS, start: start("pilot") })
    expect(pilot[0]).toMatchObject({ stage: "access" })
    expect(pilot.some((s) => s.stage === "discover")).toBe(false)

    const scope = proposePlan({ ...NO_ANSWERS, start: start("scope") })
    expect(scope[0]).toMatchObject({ title: "Agree scope and success criteria", stage: "scope" })
  })

  it("ties the criterion the FDE gave to the steps that agree and prove it, with how", () => {
    const plan = proposePlan({
      ...NO_ANSWERS,
      start: start("talk", "", "Claims triaged within two hours"),
    })
    const proving = plan.filter((s) => s.criterion)
    expect(proving.map((s) => s.stage)).toEqual(["scope", "evaluate"])
    for (const step of proving)
      expect(step.criterion).toEqual({
        name: "Claims triaged within two hours",
        proof: expect.stringMatching(/eval/),
      })
    // With no criterion named, only the evaluation says how it will be proven.
    const plain = proposePlan({ ...NO_ANSWERS, start: start("talk") })
    expect(plain.filter((s) => s.criterion).map((s) => s.stage)).toEqual(["evaluate"])
  })

  it("fills the summary as blocks that pass their schemas, one per answered step", () => {
    expect(summaryBlocks(NO_ANSWERS)).toEqual([])
    expect(summaryBlocks({ ...NO_ANSWERS, company }).map((b) => b.type)).toEqual(["brief"])
    expect(summaryBlocks(all).map((b) => b.type)).toEqual(["brief", "plan", "rules", "people"])
  })

  it("never drops a section at the longest answers the forms take", () => {
    // Each field at its form's limit, counted as the forms count (characters, not UTF-16 units).
    const long = (n: number, unit = "a") => unit.repeat(n)
    const answers: Answers = {
      company: {
        name: long(MAX_NAME, "é"),
        industry: long(MAX_NAME),
        region: long(MAX_NAME),
        summary: long(MAX_TEXT - 1, "𝒶") + "\n",
      },
      start: start("talk", long(120), long(200)),
      rules: defaultRules(),
      people: [{ email: `${long(64)}@example.com`, role: "sponsor" }],
      plan: null,
    }
    for (const approach of ["talk", "scope", "pilot"] as const) {
      const shown = { ...answers, start: { ...answers.start!, approach } }
      const blocks = summaryBlocks({ ...shown, plan: proposePlan(shown) })
      expect(blocks.map((b) => b.type)).toEqual(["brief", "plan", "rules", "people"])
      const brief = blocks[0]
      expect(
        brief?.type === "brief" && brief.items.find((i) => i.label === "Delivering")?.value,
      ).toBe(long(MAX_TEXT - 1, "𝒶"))
    }
  })

  it("keeps real customer data off whatever the answer says", () => {
    const rules = {
      ...defaultRules(),
      verdicts: { ...defaultRules().verdicts, real_data: "allowed" as const },
    }
    const block = summaryBlocks({ ...all, rules }).find((b) => b.type === "rules")
    expect(block?.type === "rules" && block.rules.find((r) => r.id === "real_data")?.verdict).toBe(
      "never",
    )
  })

  it("checks optional people apart from what is required", () => {
    const list = reviewChecklist(all)
    expect(list?.type === "checklist" && list.items.at(-1)).toEqual({
      label: "People to invite",
      done: false,
      optional: true,
    })
  })

  it("says each answer back in plain words", () => {
    expect(answerText("rules", all)).toBe("Agents ask first for 2 things. You approve.")
    expect(answerText("rules", { ...all, rules: { ...defaultRules(), approver: "leads" } })).toBe(
      "Agents ask first for 2 things. Any lead on the company approves.",
    )
    expect(answerText("people", all)).toBe("No one for now.")
    expect(answerText("start", all)).toBe("Talk to them first. Main contact: Dana Ortiz")
  })
})

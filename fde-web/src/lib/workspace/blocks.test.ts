import { describe, expect, it } from "vitest"
import { parseBlock, parseBlocks } from "./blocks"
import { CompanyId, STAGES } from "@/lib/api/schemas"
import { MAX_TEXT } from "@/lib/records"

const suggestion = {
  type: "suggestion",
  id: "s1",
  title: "Start the first project",
  approve: { label: "Open", to: { screen: "company", company: "cmp_kestrel" } },
}
const plan = {
  type: "plan",
  steps: [
    {
      id: "step_1",
      title: "Evaluate",
      stage: "evaluate",
      criterion: { name: "Claims triaged in two hours", proof: "An eval on sample data." },
    },
  ],
}

describe("blocks", () => {
  it("keeps every block that passes its schema, in order", () => {
    const people = { type: "people", people: [{ email: "sam@example.com", role: "sponsor" }] }
    expect(parseBlocks([plan, suggestion, people]).map((b) => b.type)).toEqual([
      "plan",
      "suggestion",
      "people",
    ])
  })

  it("drops a block of a type outside the catalogue, and keeps the rest", () => {
    const blocks = parseBlocks([
      { type: "html", html: "<script>alert(1)</script>" },
      { type: "iframe", src: "https://example.com" },
      suggestion,
      { title: "no type at all" },
      null,
      "plan",
    ])
    expect(blocks).toEqual([suggestion])
  })

  it("drops anything that is not a list of blocks", () => {
    expect(parseBlocks({ type: "plan", steps: [] })).toEqual([])
    expect(parseBlocks("[]")).toEqual([])
    expect(parseBlocks(undefined)).toEqual([])
  })

  it.each([
    ["an empty title", { ...suggestion, title: "   " }],
    ["a title that is too long", { ...suggestion, title: "x".repeat(161) }],
    ["a control character in a line", { ...suggestion, title: "Open\u0000now" }],
    ["a line break in a title", { ...suggestion, title: "One\nTwo" }],
    [
      "a link to another host",
      { ...suggestion, approve: { label: "Go", to: "https://evil.example" } },
    ],
    [
      "a screen we do not have",
      { ...suggestion, approve: { label: "Go", to: { screen: "settings" } } },
    ],
    [
      "a company id that is not an id",
      { ...suggestion, approve: { label: "Go", to: { screen: "company", company: "../admin" } } },
    ],
    ["a part id with spaces", { ...suggestion, id: "a b" }],
    ["a plan step with no stage", { type: "plan", steps: [{ id: "s", title: "Build" }] }],
    [
      "a plan step on a stage we do not have",
      { type: "plan", steps: [{ id: "s", title: "Build", stage: "ship" }] },
    ],
    [
      "a plan of more than 12 steps",
      {
        type: "plan",
        steps: Array.from({ length: 13 }, (_, i) => ({
          id: `s${i}`,
          title: "Build",
          stage: "build",
        })),
      },
    ],
    [
      "a rule with a verdict we do not have",
      { type: "rules", approver: "Me", rules: [{ id: "r", action: "Read", verdict: "maybe" }] },
    ],
    [
      "an invite that is not an address",
      { type: "people", people: [{ email: "sam at example", role: "lead" }] },
    ],
    [
      "an invite role we do not have",
      { type: "people", people: [{ email: "sam@example.com", role: "owner" }] },
    ],
    [
      "a checklist item that is not done or open",
      { type: "checklist", items: [{ label: "Named", done: "yes" }] },
    ],
  ])("drops a malformed block: %s", (_, block) => {
    expect(parseBlock(block)).toBeNull()
  })

  it("keeps markup in text as the text it is: it is never read as HTML", () => {
    const parsed = parseBlock({ ...suggestion, title: "<img src=x onerror=alert(1)>" })
    expect(parsed?.type === "suggestion" && parsed.title).toBe("<img src=x onerror=alert(1)>")
  })

  it("trims text and strips keys the schema does not know", () => {
    const parsed = parseBlock({ ...suggestion, title: "  Start  ", onClick: "alert(1)" })
    expect(parsed).toEqual({ ...suggestion, title: "Start" })
  })
})

describe("the catalogue's own copies of the API's rules", () => {
  // blocks.ts imports nothing but zod, so the assistant Worker can check blocks with the same file.
  it("match the API's ids, stages and longest text", () => {
    const step = (stage: string) =>
      parseBlock({ type: "plan", steps: [{ id: "s", title: "Step", stage }] })
    expect(STAGES.filter((s) => step(s) === null)).toEqual([])
    expect(step("launch")).toBeNull()
    for (const id of ["cmp_1", "a".repeat(128), "", "a".repeat(129), "cmp:1", "cmp/1"]) {
      const go = {
        type: "suggestion",
        id: "s",
        title: "Go",
        approve: { label: "Go", to: { screen: "company", company: id } },
      }
      expect(parseBlock(go) !== null, id).toBe(CompanyId.safeParse(id).success)
    }
    const brief = (value: string) =>
      parseBlock({ type: "brief", items: [{ label: "Summary", value }] })
    expect(brief("x".repeat(MAX_TEXT))).not.toBeNull()
    expect(brief("x".repeat(MAX_TEXT + 1))).toBeNull()
  })
})

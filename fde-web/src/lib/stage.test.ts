import { describe, expect, it } from "vitest"
import { STAGES } from "./api/schemas"
import { MAX_REASON, canMove, reasonLength, reasonProblem } from "./stage"

// The same cases as oryxa_fde_core::stage's tests: the web must refuse what the API refuses.
describe("canMove", () => {
  it("advances one stage at a time", () => {
    expect(canMove("discover", "scope")).toBe(true)
    expect(canMove("discover", "build")).toBe(false)
  })

  it("may go back to any earlier stage for rework", () => {
    expect(canMove("evaluate", "build")).toBe(true)
    expect(canMove("operate", "discover")).toBe(true)
  })

  it("refuses a no-op", () => {
    for (const stage of STAGES) expect(canMove(stage, stage)).toBe(false)
  })

  it("has nowhere forward from the last stage", () => {
    const forward = STAGES.filter((to) => canMove("operate", to) && to !== "operate")
    expect(forward).toEqual(STAGES.slice(0, -1))
  })

  it("allows exactly the earlier stages and the next one, from every stage", () => {
    STAGES.forEach((from, i) => {
      const allowed = STAGES.filter((to) => canMove(from, to))
      expect(allowed).toEqual([...STAGES.slice(0, i), ...STAGES.slice(i + 1, i + 2)])
    })
  })
})

// The same rule as oryxa-fde-store's `Reason`: 1 to 500 characters once trimmed, no control
// character but a newline or a tab.
describe("reasonProblem", () => {
  it("needs words", () => {
    for (const blank of ["", "   ", "\n\t "]) expect(reasonProblem(blank)).toMatch(/Say why/)
  })

  it("accepts up to 500 characters once trimmed, and counts what the API counts", () => {
    expect(reasonProblem("x".repeat(MAX_REASON))).toBeNull()
    expect(reasonProblem(`  ${"x".repeat(MAX_REASON)}  `)).toBeNull()
    expect(reasonProblem("x".repeat(MAX_REASON + 1))).toMatch(/500 characters or fewer/)
    // An emoji is one character to the API, though two UTF-16 units.
    expect(reasonLength("😀😀")).toBe(2)
    expect(reasonProblem("😀".repeat(MAX_REASON))).toBeNull()
  })

  it("allows newlines and tabs, and no other control character", () => {
    expect(reasonProblem("one\ntwo\tthree")).toBeNull()
    for (const bad of ["bell\u0007", "nul\u0000", "esc\u001b", "del\u007f", "c1\u0085x"])
      expect(reasonProblem(bad), bad).toMatch(/plain text/)
    // The API trims before it looks, so trailing whitespace control characters are not refused.
    expect(reasonProblem("windows line\r\n")).toBeNull()
  })
})

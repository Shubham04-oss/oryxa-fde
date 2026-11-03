import { describe, expect, it } from "vitest"
import { STAGES } from "./api/schemas"
import { canMove } from "./stage"

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

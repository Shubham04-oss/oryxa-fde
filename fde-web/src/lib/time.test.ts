import { describe, expect, it } from "vitest"
import { dayOf, daysBetween, localDay, shortDate, updatedLabel, waitingLabel } from "./time"

describe("time", () => {
  it("counts whole days between dates, across a month end", () => {
    expect(daysBetween("2026-10-30", "2026-11-03")).toBe(4)
    expect(daysBetween("2026-11-03", "2026-11-01")).toBe(-2)
    expect(daysBetween("2026-11-03", "2026-11-03")).toBe(0)
  })

  it("says how long a wait has lasted, and on whom when known", () => {
    expect(waitingLabel(6, "Priya Raman")).toBe("Waiting 6 days on Priya Raman")
    expect(waitingLabel(1, "Priya Raman")).toBe("Waiting 1 day on Priya Raman")
    expect(waitingLabel(0, "Priya Raman")).toBe("Waiting since today on Priya Raman")
    expect(waitingLabel(3, null)).toBe("Waiting 3 days")
  })

  it("says how long ago something changed", () => {
    expect(updatedLabel("2026-11-03", "2026-11-03")).toBe("Updated today")
    expect(updatedLabel("2026-11-02", "2026-11-03")).toBe("Updated 1 day ago")
    expect(updatedLabel("2026-10-31", "2026-11-03")).toBe("Updated 3 days ago")
  })

  it("writes the browser's own day, the day of an instant, and a short date", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05")
    expect(dayOf(new Date(2026, 0, 5, 23, 59).toISOString())).toBe("2026-01-05")
    expect(shortDate("2026-11-03")).toBe("3 Nov 2026")
  })
})

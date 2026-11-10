import { describe, expect, it } from "vitest"
import { dayOf, daysBetween, dueLabel, localDay, shortDate, waitingLabel } from "./time"

describe("time", () => {
  it("counts whole days between dates, across a month end", () => {
    expect(daysBetween("2026-10-30", "2026-11-03")).toBe(4)
    expect(daysBetween("2026-11-03", "2026-11-01")).toBe(-2)
    expect(daysBetween("2026-11-03", "2026-11-03")).toBe(0)
  })

  it("says when something is due, or how late it is", () => {
    const today = "2026-11-03"
    expect(dueLabel("2026-11-03", today)).toBe("Due today")
    expect(dueLabel("2026-11-04", today)).toBe("Due tomorrow")
    expect(dueLabel("2026-11-07", today)).toBe("Due in 4 days")
    expect(dueLabel("2026-11-02", today)).toBe("Overdue by 1 day")
    expect(dueLabel("2026-10-31", today)).toBe("Overdue by 3 days")
  })

  it("says how long a wait has lasted, and on whom when known", () => {
    expect(waitingLabel(6, "Priya Raman")).toBe("Waiting 6 days on Priya Raman")
    expect(waitingLabel(1, "Priya Raman")).toBe("Waiting 1 day on Priya Raman")
    expect(waitingLabel(0, "Priya Raman")).toBe("Waiting less than a day on Priya Raman")
    expect(waitingLabel(3, null)).toBe("Waiting 3 days")
  })

  it("writes the browser's own day, the day of an instant, and a short date", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05")
    expect(dayOf(new Date(2026, 0, 5, 23, 59).toISOString())).toBe("2026-01-05")
    expect(shortDate("2026-11-03")).toBe("3 Nov 2026")
  })
})

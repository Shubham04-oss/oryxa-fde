// Days are ISO dates (`2026-11-03`) in the FDE's own time zone; instants are ISO date-times.

/** Today's date where the browser is, as `YYYY-MM-DD`. */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`: negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "Due today", "Due tomorrow", "Overdue by 3 days", "Due in 4 days". */
export function dueLabel(due: string, today: string): string {
  const days = daysBetween(today, due)
  if (days === 0) return "Due today"
  if (days === 1) return "Due tomorrow"
  if (days < 0) return `Overdue by ${plural(-days, "day")}`
  return `Due in ${plural(days, "day")}`
}

/** "Waiting 6 days on Priya Raman", or "Waiting since today on …". */
export function waitingLabel(since: string, who: string, today: string): string {
  const days = daysBetween(since, today)
  return days <= 0 ? `Waiting since today on ${who}` : `Waiting ${plural(days, "day")} on ${who}`
}

/** "3 Nov 2026": a day, for things that last. */
export function shortDate(day: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.parse(day))
}

// Days are ISO dates (`2026-11-03`) in the FDE's own time zone; instants are the API's RFC 3339
// date-times.

/** Today's date where the browser is, as `YYYY-MM-DD`. */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The day an instant falls on where the browser is. */
export const dayOf = (instant: string) => localDay(new Date(instant))

/** Whole days from `from` to `to`, both `YYYY-MM-DD`: negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "Waiting 6 days on Priya Raman", "Waiting since today", from the API's day count. */
export function waitingLabel(days: number, who: string | null): string {
  const wait = days <= 0 ? "Waiting since today" : `Waiting ${plural(days, "day")}`
  return who ? `${wait} on ${who}` : wait
}

/** "Updated today", "Updated 3 days ago". */
export function updatedLabel(day: string, today: string): string {
  const days = daysBetween(day, today)
  return days <= 0 ? "Updated today" : `Updated ${plural(days, "day")} ago`
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

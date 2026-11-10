import type { QueryClient } from "@tanstack/react-query"
import { queries } from "./api/client"
import type { components } from "./api/fde-api.gen"
import type { MeetingNoteOut, NotePlace } from "./api/schemas"
import { at, checkName, say } from "./records"
import type { Problem } from "./records"
import { localDay } from "./time"

// What the Notes card says and sends (DESIGN.md §3): a meeting note's form, the checks the API makes
// (so a mistake is caught before the wire, in the API's own words), the whole-record body its `PUT`
// takes, how a saved note reaches the page and the stage checklist, and how a line of a note becomes
// the first words of a task or a decision.

export type NoteBody = components["schemas"]["MeetingNoteBody"]

/** The longest a note is, in characters, once trimmed (`NoteText` in `oryxa-fde-store`). */
export const MAX_NOTE = 20_000
/** The most stakeholders, and the most attendees, one note names. */
export const MAX_PEOPLE = 50

// All but newline and tab, and C1 too: what `NoteText` refuses.
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

const length = (value: string) => [...value].length
/** Line endings are not a change a person made. */
const plain = (value: string) => value.replace(/\r\n?/g, "\n").trim()

// ── The form ───────────────────────────────────────────────────────────────

export type NoteFields = {
  title: string
  /** `YYYY-MM-DD`. */
  heldOn: string
  body: string
  /** Stakeholder ids of the company. */
  stakeholders: Array<string>
  /** User ids: the API has no names for them yet. */
  attendees: Array<string>
}

/** A new note: held today, with the FDE as one who was there. */
export const blankNote = (me: string | undefined, today = localDay()): NoteFields => ({
  title: "",
  heldOn: today,
  body: "",
  stakeholders: [],
  attendees: me ? [me] : [],
})

export const noteFields = (n: MeetingNoteOut): NoteFields => ({
  title: n.title,
  heldOn: n.held_on,
  body: n.body,
  stakeholders: [...n.stakeholders],
  attendees: [...n.attendees],
})

/** The API's code for a refusal, and the field it is about. */
export const NOTE_FIELD: Record<string, string> = {
  invalid_title: "title",
  invalid_held_on: "heldOn",
  invalid_body: "body",
  invalid_stakeholders: "stakeholders",
  invalid_attendees: "attendees",
}

/** What the API would refuse, in its own words, in the order the form reads. */
export function noteProblem(f: NoteFields): Problem | null {
  if (!f.title.trim()) return at("title", "Give the note a title.")
  const title = checkName(f.title, "invalid_title", true)
  if (title) return at("title", title)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.heldOn)) return at("heldOn", say("invalid_held_on"))
  const body = plain(f.body)
  if (!body) return at("body", "Write the note first.")
  if (length(body) > MAX_NOTE)
    return at(
      "body",
      `A note is up to ${MAX_NOTE.toLocaleString("en-GB")} characters. This one is ${length(body).toLocaleString("en-GB")}.`,
    )
  if (NOTE_CONTROL.test(body)) return at("body", say("invalid_body"))
  if (f.stakeholders.length > MAX_PEOPLE)
    return at("stakeholders", `A note names up to ${MAX_PEOPLE} stakeholders.`)
  if (f.attendees.length > MAX_PEOPLE)
    return at("attendees", `A note names up to ${MAX_PEOPLE} attendees.`)
  return null
}

/** How many characters the note counts for: trimmed, as the API counts it. */
export const noteLength = (body: string) => length(plain(body))

/** A new note's body, or an edit's when it has nothing to compare with. */
export const noteBody = (f: NoteFields): NoteBody => ({
  title: f.title.trim(),
  held_on: f.heldOn,
  body: plain(f.body),
  stakeholders: f.stakeholders,
  attendees: f.attendees,
})

const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")

/** Whether the form holds something other than what it opened on (a note, or a blank one). */
export function noteChanged(opened: NoteFields, f: NoteFields) {
  return (
    f.title.trim() !== opened.title.trim() ||
    f.heldOn !== opened.heldOn ||
    plain(f.body) !== plain(opened.body) ||
    !same(f.stakeholders, opened.stakeholders) ||
    !same(f.attendees, opened.attendees)
  )
}

/**
 * An edit's body, every field, because the API's `PUT` replaces the note. What the form changed
 * (against the copy taken when it opened) is the form's; everything else is the note as it is now
 * (`now`), so a teammate's change to another field is not undone by saving this one.
 */
export function noteEditBody(
  opened: MeetingNoteOut,
  now: MeetingNoteOut | undefined,
  f: NoteFields,
): NoteBody {
  const was = noteFields(opened)
  const live = noteFields(now ?? opened)
  return {
    title: f.title.trim() !== was.title.trim() ? f.title.trim() : live.title,
    held_on: f.heldOn !== was.heldOn ? f.heldOn : live.heldOn,
    body: plain(f.body) !== plain(was.body) ? plain(f.body) : live.body,
    stakeholders: same(f.stakeholders, was.stakeholders) ? live.stakeholders : f.stakeholders,
    attendees: same(f.attendees, was.attendees) ? live.attendees : f.attendees,
  }
}

// ── The card ───────────────────────────────────────────────────────────────

/** The API's order: the latest meeting first, a note written later first among one day's. */
export const latestFirst = (list: ReadonlyArray<MeetingNoteOut>) =>
  [...list].sort(
    (a, b) =>
      b.held_on.localeCompare(a.held_on) ||
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      a.id.localeCompare(b.id),
  )

/** Who of the workspace was there, as far as the page knows: "You and 2 teammates". Null when no one is named. */
export function attendeesLine(note: MeetingNoteOut, me: string | undefined): string | null {
  const you = me !== undefined && (note.attendees as ReadonlyArray<string>).includes(me)
  const others = note.attendees.length - (you ? 1 : 0)
  const parts = [
    ...(you ? ["You"] : []),
    ...(others > 0 ? [others === 1 ? "a teammate" : `${others} teammates`] : []),
  ]
  if (parts.length === 0) return null
  const line = parts.join(" and ")
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** The customer's people who were there, by name; one the company no longer lists is left out. */
export function stakeholdersLine(
  note: MeetingNoteOut,
  people: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  const names = note.stakeholders.flatMap((id) => people.find((p) => p.id === id)?.name ?? [])
  return names.length > 0 ? names.join(", ") : null
}

// ── Reaching the views ─────────────────────────────────────────────────────

/**
 * A note the API has saved, in the notes list. A new one on a project also reads the stage checklist
 * again: "a meeting note on the project" is the Discover stage's item. A note on the company is
 * not counted by it.
 */
export async function commitNote(
  client: QueryClient,
  place: NotePlace,
  saved: MeetingNoteOut,
  added: boolean,
) {
  const key = queries.notes(place).queryKey
  // Reads sent before the write would land after it without the note.
  await client.cancelQueries({ queryKey: key })
  const had = client.getQueryData(key)
  client.setQueryData(key, (old) =>
    old
      ? latestFirst(
          old.some((n) => n.id === saved.id)
            ? old.map((n) => (n.id === saved.id ? saved : n))
            : [...old, saved],
        )
      : old,
  )
  // Nothing was read yet (the dialog came from the checklist): read it, so the card shows the note.
  if (!had) void client.invalidateQueries({ queryKey: key })
  if (added) rereadChecklist(client, place)
}

/** A note the API has removed. */
export async function commitNoteRemoved(client: QueryClient, place: NotePlace, id: string) {
  const key = queries.notes(place).queryKey
  await client.cancelQueries({ queryKey: key })
  client.setQueryData(key, (old) => old && old.filter((n) => n.id !== id))
  rereadChecklist(client, place)
}

function rereadChecklist(client: QueryClient, place: NotePlace) {
  if (place.project !== undefined)
    void client.invalidateQueries({
      queryKey: queries.stageChecklist({ company: place.company, project: place.project }).queryKey,
    })
}

// ── From a line to a commitment ────────────────────────────────────────────

/** The longest a task's or a decision's title is. */
const MAX_TITLE = 200

/**
 * A title from some of a note: one line, the list marker or checkbox in front dropped, cut at the
 * API's limit. The FDE reads and changes it in the form that opens, so this only has to start them well.
 */
export function lineToTitle(text: string): string {
  const one = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
  const bare = one.replace(/^(?:(?:[-*•–]|\d+[.)]|\[[ xX]?\])\s+)+/, "").trim()
  return length(bare) > MAX_TITLE ? `${[...bare].slice(0, MAX_TITLE - 1).join("")}…` : bare
}

/** The line a caret is on, in a text. */
export function lineAt(value: string, caret: number): string {
  const start = caret === 0 ? 0 : value.lastIndexOf("\n", caret - 1) + 1
  const end = value.indexOf("\n", caret)
  return value.slice(start, end === -1 ? value.length : end)
}

/** What the FDE pointed at in a textarea: what is selected, or else the line the cursor is on. */
export function chosenIn(
  field: Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">,
) {
  const { value, selectionStart: from, selectionEnd: to } = field
  return lineToTitle(from !== to ? value.slice(from, to) : lineAt(value, from))
}

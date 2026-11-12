import { ApiError } from "./api/client"
import type { PersonOut } from "./api/schemas"

// Who a user id is (DESIGN.md §3, People): one lookup for every screen, fed by `GET /v1/people` and by
// the names the API puts on a company's members and a project's assignees. A name is WorkOS's text,
// untrusted and of any length: it is rendered as text, never markup, and clipped only where a control
// cannot wrap it. Nothing here is logged or stored.

/** The names the page has, by user id: `null` for someone the API lists with no name. */
export type Book = ReadonlyMap<string, string | null>

/**
 * What the page knows of the organisation's people. `listed`: `/v1/people` answered, so someone not in
 * the book has left. `unavailable`: it answered 503 or 403, and the screens fall back to ids.
 */
export type Directory = { book: Book; state: "listed" | "loading" | "unavailable"; me?: string }

/** A person as a screen shows them. */
export type Person = {
  id: string
  /** At the start of a sentence or alone: "You", "Mara Lindqvist", "Unnamed teammate". */
  label: string
  /** Inside a sentence: "you", "Mara Lindqvist", "an unnamed teammate". */
  phrase: string
  you: boolean
  /** No name to show: unnamed, no longer listed, or names are unavailable. Drawn quieter. */
  nameless: boolean
}

/**
 * Every name the page has from the API's answers; a name from `/v1/people` wins. Only that list can say
 * someone has no name: a member or an assignee without one may just mean WorkOS did not answer.
 */
export function bookOf(
  people: ReadonlyArray<PersonOut> | undefined,
  ...lists: ReadonlyArray<ReadonlyArray<{ user: string; name?: string | null }> | undefined>
): Map<string, string | null> {
  const book = new Map<string, string | null>()
  const named = (name: string | null | undefined) => (name?.trim() ? name.trim() : null)
  for (const list of lists)
    for (const m of list ?? []) {
      const name = named(m.name)
      if (name) book.set(m.user, name)
    }
  for (const p of people ?? []) book.set(p.id, named(p.name) ?? book.get(p.id) ?? null)
  return book
}

/** Who `id` is. "You" stays for the signed-in person; nobody is ever shown as an id alone. */
export function personOf(id: string, dir: Directory): Person {
  const you = id === dir.me
  if (you) return { id, label: "You", phrase: "you", you, nameless: false }
  const name = dir.book.get(id)
  if (name) return { id, label: name, phrase: name, you, nameless: false }
  if (dir.book.has(id))
    return { id, label: "Unnamed teammate", phrase: "an unnamed teammate", you, nameless: true }
  // Only once it knows who you are: until then the one not listed may be you.
  if (dir.state === "listed" && dir.me !== undefined)
    return {
      id,
      label: "A teammate no longer listed",
      phrase: "a teammate no longer listed",
      you,
      nameless: true,
    }
  // Names are unavailable (or still on their way): the end of the id tells two teammates apart, as before names.
  const tail = `A teammate …${id.slice(-6)}`
  return { id, label: tail, phrase: `a${tail.slice(1)}`, you, nameless: true }
}

/** Whether a failed read of `/v1/people` means names are unavailable here (403) or for now (503, or no answer). */
export function peopleProblem(error: unknown): "forbidden" | "unavailable" {
  return error instanceof ApiError && error.status === 403 ? "forbidden" : "unavailable"
}

/** "Mara, Tomas and Ines"; past `most`, "Mara, Tomas and 3 others". */
export function listOf(parts: ReadonlyArray<string>, most = 3): string {
  if (parts.length <= 1) return parts[0] ?? ""
  const shown = parts.length > most ? parts.slice(0, most - 1) : parts.slice(0, -1)
  const rest = parts.length > most ? `${parts.length - shown.length} others` : parts.at(-1)!
  return `${shown.join(", ")} and ${rest}`
}

/** People to choose from, the signed-in person first and the rest by name, the nameless last. */
export function byName(people: ReadonlyArray<Person>): Array<Person> {
  return [...people].sort(
    (a, b) =>
      Number(b.you) - Number(a.you) ||
      Number(a.nameless) - Number(b.nameless) ||
      a.label.localeCompare(b.label, "en", { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  )
}

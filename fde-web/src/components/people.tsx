import { useQueries, useQuery } from "@tanstack/react-query"
import { initials } from "./app-shell"
import { Button } from "./ui/button"
import { Icon } from "./ui/icon"
import { queries } from "@/lib/api/client"
import type { NotePlace } from "@/lib/api/schemas"
import { bookOf, peopleProblem, personOf } from "@/lib/people"
import type { Directory, Person } from "@/lib/people"
import { cn } from "@/lib/utils"

// The one way a screen names a person (DESIGN.md §3, People). `useNames` reads `/v1/people` (cached
// for five minutes, never retried) and takes the names already on the place's members and assignees
// from the cache without reading them again.

/** A member or an assignee: the API puts their name on them. */
type Named = { user: string; name?: string | null }

export type Names = {
  /** Who `id` is. */
  of: (id: string) => Person
  dir: Directory
  /** Why there are no names, when `/v1/people` refused or could not answer. */
  problem: "forbidden" | "unavailable" | null
  retry: () => void
}

/** Names for the screens of `place` (a company, or a project), or for screens of no one place. */
export function useNames(place?: NotePlace): Names {
  const me = useQuery(queries.me())
  const people = useQuery(queries.people())
  // Only what is cached already, by key: a card that needs the team reads it itself.
  const lists = useQueries({
    queries: [
      ...(place ? [queries.members(place.company).queryKey] : []),
      ...(place?.project !== undefined
        ? [queries.assignees({ company: place.company, project: place.project }).queryKey]
        : []),
    ].map((queryKey) => ({ queryKey, enabled: false })),
  })
  const dir: Directory = {
    book: bookOf(people.data, ...lists.map((l) => l.data as ReadonlyArray<Named> | undefined)),
    state: people.isSuccess ? "listed" : people.isError ? "unavailable" : "loading",
    me: me.data?.user.id,
  }
  return {
    of: (id) => personOf(id, dir),
    dir,
    problem: people.isError ? peopleProblem(people.error) : null,
    retry: () => void people.refetch(),
  }
}

/** Who has a task, in words: "Assigned to you", "Assigned to Mara Lindqvist", "Unassigned". */
export function assigneeLabel(assignee: string | null | undefined, names: Names) {
  if (!assignee) return "Unassigned"
  // Until we know who you are, a card does not guess.
  if (!names.dir.me) return ""
  return `Assigned to ${names.of(assignee).phrase}`
}

/**
 * Who works on a company or a project, as far as the page can read: you, the company's team and, on a
 * project, its assignees. The API also counts an organisation admin; the page cannot list them, so they
 * are not offered. Someone assigned only to a project cannot read the company's team (403), and is
 * offered the rest.
 */
export function useWorkingOn(place: NotePlace): Array<string> {
  const me = useQuery(queries.me())
  const team = useQuery(queries.members(place.company))
  const assigned = useQuery({
    ...queries.assignees({ company: place.company, project: place.project! }),
    enabled: place.project !== undefined,
  })
  return [
    ...new Set<string>([
      ...(me.data ? [me.data.user.id] : []),
      ...(assigned.data ?? []).map((a) => a.user),
      ...(team.data ?? []).map((m) => m.user),
    ]),
  ]
}

/** A person's name as text, cut with an ellipsis when it does not fit, the whole of it on hover and to a screen reader. */
export function PersonName({ person, className }: { person: Person; className?: string }) {
  return (
    <span
      title={person.label}
      className={cn(
        "block min-w-0 truncate",
        person.nameless && "text-muted-foreground",
        className,
      )}
    >
      {person.label}
    </span>
  )
}

/** Initials in a neutral circle; a person with no name to show gets the outline of one. */
export function PersonAvatar({ person, me }: { person: Person; me?: string }) {
  const name = person.you ? (me ?? "You") : person.label
  return (
    <span className="app-avatar" aria-hidden="true">
      {person.nameless ? <Icon name="person" size={15} strokeWidth={1.7} /> : initials(name)}
    </span>
  )
}

/** Says plainly that names are unavailable, and what the screen shows instead; nothing when there are names. */
export function NamesUnavailable({ names, className }: { names: Names; className?: string }) {
  if (!names.problem) return null
  return (
    <p
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-2 text-[11px] leading-normal text-muted-foreground",
        className,
      )}
    >
      {names.problem === "forbidden"
        ? "Names are not available to you here, so teammates show by the end of their id."
        : "Names are unavailable right now, so teammates show by the end of their id."}
      {names.problem === "unavailable" && (
        <Button variant="ghost" size="sm" onClick={names.retry}>
          Try again
        </Button>
      )}
    </p>
  )
}

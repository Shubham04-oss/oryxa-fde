import type { QueryClient } from "@tanstack/react-query"
import { ApiError, queries } from "./api/client"
import type { ProjectScope, TaskOut, TaskState } from "./api/schemas"
import { STATUS_LABEL, placed } from "./board"
import type { Place } from "./board"

// What the board and Today share when a task changes: how a refusal reads, and how a saved or
// removed task reaches every cached view of it. The rules for what a move sends are in board.ts.

/** Why a save failed, in words: what the API said, or a short generic line. */
export function reason(error: unknown, what = "task") {
  if (error instanceof ApiError) {
    if (error.status === 404) return `The ${what} is no longer there.`
    if (error.message !== error.code) return error.message
  }
  return "Check your connection and try again."
}

/**
 * A move that did not happen, and why: the API refused it (`refused`), the task had changed since
 * the page read it (`stale`: `task` is then the task as it now stands), or someone had already made
 * the move (`already`). Only a stale move is offered again. `place` is where in the column it was going.
 */
export type Refusal = {
  scope: ProjectScope
  task: TaskOut
  to: TaskState
  place?: Place
  why: string
  kind: "refused" | "stale" | "already"
}

/**
 * A refusal in a sentence. `named` says which task, for a place that is not the task's own row
 * (above the board, or above Today's groups); a row already shows it.
 */
export function refusalLine({ task, to, place, why, kind }: Refusal, named: boolean) {
  const it = named ? `“${task.title}”` : "it"
  const wording = named ? `“${task.title}”` : "This task"
  if (kind === "already") return `Someone already moved ${it} to ${STATUS_LABEL[to]}.`
  if (kind === "stale")
    return `${wording} changed since you last read it, so it was not moved. It is now ${STATUS_LABEL[task.status]}.`
  return `Couldn't move ${it}${place && task.status === to ? "" : ` to ${STATUS_LABEL[to]}`}. ${why}`
}

/** Drops the reads of a project and of Today that were sent before a write: they would land after it with the old record. */
async function settle(client: QueryClient, scope: ProjectScope) {
  await Promise.all([
    client.cancelQueries({ queryKey: queries.project(scope).queryKey }),
    client.cancelQueries({ queryKey: queries.today().queryKey }),
  ])
}

/**
 * Puts a task the API has confirmed into the project, where `place` put it (`placed`), and into Today,
 * then reads Today again.
 */
export async function commitTask(
  client: QueryClient,
  scope: ProjectScope,
  saved: TaskOut,
  place?: Place,
) {
  await settle(client, scope)
  client.setQueryData(
    queries.project(scope).queryKey,
    (old) => old && { ...old, tasks: placed(old.tasks, saved, place) },
  )
  client.setQueryData(
    queries.today().queryKey,
    (old) =>
      old && {
        ...old,
        items: old.items.map((item) =>
          item.kind === "task" && item.task.id === saved.id ? { ...item, task: saved } : item,
        ),
      },
  )
  void client.invalidateQueries({ queryKey: queries.today().queryKey })
}

/** Takes a task the API has deleted out of the project and Today. */
export async function commitRemoved(client: QueryClient, scope: ProjectScope, task: TaskOut) {
  await settle(client, scope)
  client.setQueryData(
    queries.project(scope).queryKey,
    (old) => old && { ...old, tasks: old.tasks.filter((t) => t.id !== task.id) },
  )
  client.setQueryData(
    queries.today().queryKey,
    (old) =>
      old && {
        ...old,
        items: old.items.filter((item) => !(item.kind === "task" && item.task.id === task.id)),
      },
  )
  void client.invalidateQueries({ queryKey: queries.today().queryKey })
}

/** What a refusal shows and, for a stale move, the offer to do it again. `again` is what the offer does. */
export function refusalNote(refusal: Refusal, named: boolean, again: () => void) {
  return {
    text: refusalLine(refusal, named),
    held: refusal.kind !== "refused",
    again:
      refusal.kind === "stale"
        ? {
            // A move within its column is offered as itself: "Move to To do" would read as a no-op.
            label:
              refusal.place && refusal.task.status === refusal.to
                ? "Move it again"
                : `Move to ${STATUS_LABEL[refusal.to]}`,
            run: again,
          }
        : undefined,
  }
}

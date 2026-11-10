import type { QueryClient } from "@tanstack/react-query"
import { ApiError, queries } from "./api/client"
import type { ProjectScope, TaskOut } from "./api/schemas"

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

/** Drops the reads of a project and of Today that were sent before a write: they would land after it with the old record. */
async function settle(client: QueryClient, scope: ProjectScope) {
  await Promise.all([
    client.cancelQueries({ queryKey: queries.project(scope).queryKey }),
    client.cancelQueries({ queryKey: queries.today().queryKey }),
  ])
}

/** Puts a task the API has confirmed into the project and Today, then reads Today again. */
export async function commitTask(client: QueryClient, scope: ProjectScope, saved: TaskOut) {
  await settle(client, scope)
  client.setQueryData(
    queries.project(scope).queryKey,
    (old) =>
      old && {
        ...old,
        tasks: old.tasks.some((t) => t.id === saved.id)
          ? old.tasks.map((t) => (t.id === saved.id ? saved : t))
          : [...old.tasks, saved],
      },
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

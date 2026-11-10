import type { components } from "./api/fde-api.gen"
import type { TaskOut, TaskState } from "./api/schemas"
import type { Labels } from "./stale"

// The project board's rules (DESIGN.md §3): the columns, and what each save sends. The API's
// `PUT .../tasks/{task}` replaces the whole task, so every save sends every field.

/** A save's fields. The `version` is not one of them: only the call that updates adds it, so a create cannot send one. */
export type TaskBody = Omit<components["schemas"]["TaskBody"], "version">

/** One column per status, in the order a task usually travels. */
export const COLUMNS: ReadonlyArray<{ status: TaskState; label: string }> = [
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "waiting_on_customer", label: "Waiting on the customer" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
]

export const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.status, c.label])) as Record<
  TaskState,
  string
>

/** The task's own words and picks, as a form holds them. */
export type Fields = {
  title: string
  status: TaskState
  /** Why it is blocked; sent only while the status is `blocked`. */
  blocker: string
  /** The stakeholder it waits on; sent only while it waits on the customer. */
  waitingOn: string | null
  /** `YYYY-MM-DD`, or "" for no date. */
  due: string
  /** A WorkOS user id. */
  assignee: string | null
  /** The access request it is blocked on; kept, never chosen here. */
  blockedBy: string | null
}

/** Each field's name in a sentence, when a stale save says which differ (`lib/stale.ts`). */
export const TASK_LABELS: Labels<Fields> = {
  title: "title",
  status: "status",
  blocker: "blocker",
  waitingOn: "person it waits on",
  due: "due date",
  assignee: "assignee",
  blockedBy: "access request it is blocked on",
}

export const MAX_TITLE = 200
export const MAX_BLOCKER = 4000

export const fieldsOf = (task: TaskOut): Fields => ({
  title: task.title,
  status: task.status,
  blocker: task.blocker ?? "",
  waitingOn: task.waiting_on ?? null,
  due: task.due_on ?? "",
  assignee: task.assignee ?? null,
  blockedBy: task.blocked_by ?? null,
})

/** The request body for `fields`, clearing what the status does not use (the API refuses a stray `blocked_by`). */
export function toBody(fields: Fields): TaskBody {
  const blocked = fields.status === "blocked"
  return {
    title: fields.title.trim(),
    status: fields.status,
    assignee: fields.assignee,
    due_on: fields.due || null,
    blocker: blocked ? fields.blocker.trim() : null,
    blocked_by: blocked ? fields.blockedBy : null,
    waiting_on: fields.status === "waiting_on_customer" ? fields.waitingOn : null,
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /[\u0000-\u001f\u007f]/

/** What is wrong with `fields` before it is sent, in words, or null. The API checks again. */
export function problem(fields: Fields): string | null {
  const title = fields.title.trim()
  if (!title) return "Give the task a title."
  if ([...title].length > MAX_TITLE || NO_CONTROL.test(title))
    return `The title is one line, up to ${MAX_TITLE} characters.`
  if (fields.status === "blocked") {
    const blocker = fields.blocker.trim()
    if (!blocker) return "Say what is blocking it."
    if ([...blocker].length > MAX_BLOCKER || CONTROL.test(blocker))
      return `Keep it to plain text, up to ${MAX_BLOCKER} characters.`
  }
  if (fields.due && !/^\d{4}-\d{2}-\d{2}$/.test(fields.due)) return "Use a date like 2026-11-30."
  return null
}

/** Whether moving a task into `status` needs an answer first. */
export const asksFirst = (status: TaskState): status is "blocked" | "waiting_on_customer" =>
  status === "blocked" || status === "waiting_on_customer"

/** A column's tasks in creation order: the API has no position, so the board does not invent one. */
export function inColumn(tasks: ReadonlyArray<TaskOut>, status: TaskState): Array<TaskOut> {
  return tasks
    .filter((t) => t.status === status)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
}

/** Done tasks to list before "Show all": the board shows the latest, the rest sit behind a button. */
export const DONE_SHOWN = 5

/** A done column's tasks, the most recently finished first (a task's last save is when it moved). */
export function recentDone(tasks: ReadonlyArray<TaskOut>): Array<TaskOut> {
  return tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
}

/** Whether an open task is past its due day. */
export const isOverdue = (task: TaskOut, today: string) =>
  task.status !== "done" && !!task.due_on && task.due_on < today

/** What the summary line counts: stuck work an FDE opens the board to find. */
export function summarise(tasks: ReadonlyArray<TaskOut>, today: string) {
  return {
    blocked: tasks.filter((t) => t.status === "blocked").length,
    waiting: tasks.filter((t) => t.status === "waiting_on_customer").length,
    overdue: tasks.filter((t) => isOverdue(t, today)).length,
  }
}

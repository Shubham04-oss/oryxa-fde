import type { TaskBody, TaskSave } from "@/lib/board"

/**
 * A full task save from only the fields a test is about: every other field the API replaces is
 * sent as null, as a save that clears it would send it.
 */
export const saveOf = (body: TaskBody): TaskSave => ({
  assignee: null,
  due_on: null,
  blocker: null,
  blocked_by: null,
  waiting_on: null,
  criterion: null,
  ...body,
})

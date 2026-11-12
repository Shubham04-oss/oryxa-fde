import { useId } from "react"
import { assigneeLabel, useNames } from "./people"
import { Button } from "./ui/button"
import type { Project, ProjectScope, TaskOut } from "@/lib/api/schemas"
import { dueLabel, localDay } from "@/lib/time"

/**
 * A project's next step (direction §4, DESIGN.md §3): the first thing on the page. The API's
 * `next_step` (its first task in order that is not done), with who has it and when it is due, or a
 * plain "No next step yet" with the one action that gives it one.
 */
export function NextStep({
  scope,
  project,
  onOpen,
  onAdd,
  today = localDay(),
}: {
  scope: ProjectScope
  project: Project
  /** Opens the task's own form, as its card on the board does. */
  onOpen: (task: TaskOut) => void
  onAdd: () => void
  today?: string
}) {
  const heading = useId()
  const names = useNames(scope)
  const next = project.next_step
  const task = next && project.tasks.find((t) => t.id === next.task)
  const late = !!next?.due_on && next.due_on < today
  const who = next ? assigneeLabel(next.assignee, names) : ""

  return (
    <section
      aria-labelledby={heading}
      data-next-step={next ? "set" : "none"}
      className="grid gap-1 rounded-[14px] border bg-card px-5 py-4 max-[800px]:p-4"
    >
      <h2 id={heading} className="text-micro text-muted-foreground">
        Next step
      </h2>
      {next ? (
        <>
          {/* The API's words, as text. A task the page has not read yet is shown, not offered. */}
          {task ? (
            <button
              type="button"
              onClick={() => onOpen(task)}
              className="w-fit text-left text-body font-semibold [overflow-wrap:anywhere] underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-ring"
            >
              {next.title}
            </button>
          ) : (
            <p className="text-body font-semibold [overflow-wrap:anywhere]">{next.title}</p>
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-soft">
            {who && <span className="[overflow-wrap:anywhere]">{who}</span>}
            <span className="inline-flex items-center gap-1.5">
              {late && (
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
              )}
              {next.due_on ? dueLabel(next.due_on, today) : "No due date"}
            </span>
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="grid gap-0.5">
            <p className="text-body font-semibold">No next step yet</p>
            <p className="text-meta text-muted-foreground">
              Every task is done, or there are none. Add what comes next, with who has it and when.
            </p>
          </div>
          <Button onClick={onAdd}>Add a task</Button>
        </div>
      )}
    </section>
  )
}

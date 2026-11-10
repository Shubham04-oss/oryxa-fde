import { useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog"
import { ApiError, StaleSaveError, api, queries } from "@/lib/api/client"
import type {
  AccessRequestOut,
  ProjectScope,
  StakeholderOut,
  TaskOut,
  TaskState,
} from "@/lib/api/schemas"
import { blockers, clip } from "@/lib/access"
import { STATUS_LABEL, TASK_LABELS, asksFirst, fieldsOf, problem, toBody } from "@/lib/board"
import type { Fields } from "@/lib/board"
import { isHeld } from "@/lib/records"
import { commitTask, reason } from "@/lib/task-move"
import type { Refusal } from "@/lib/task-move"
import { ACCESS_LABEL } from "@/lib/today"
import { StaleNotice, useVersionedForm } from "./versioned-form"

// What the board and Today share when a task moves (DESIGN.md §3): the two prompts, saving that
// shows nothing as done until the API confirms it, and a refused move that stays put and says why.

export const FIELD =
  "w-full rounded-lg border bg-raised px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:border-strong aria-invalid:border-destructive"

/** The question a move into Blocked or Waiting on the customer asks first. */
export type Ask = { scope: ProjectScope; task: TaskOut; to: "blocked" | "waiting_on_customer" }
export function useTaskMover({ onSaved }: { onSaved?: (task: TaskOut) => void } = {}) {
  const queryClient = useQueryClient()
  // The status each task is on its way to, until the API answers.
  const [saving, setSaving] = useState<Record<string, TaskState>>({})
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [announcement, say] = useState("")
  const [ask, setAsk] = useState<Ask | null>(null)

  // An edit is based on a copy of the task, and sends that copy's version (DESIGN.md §3, A stale save).
  const save = useMutation({
    mutationFn: ({
      scope,
      base,
      fields,
    }: {
      scope: ProjectScope
      base: TaskOut | null
      fields: Fields
    }) =>
      base
        ? api.updateTask(scope, base.id, toBody(fields), base.version)
        : api.addTask(scope, toBody(fields)),
    async onSuccess(saved, { scope }) {
      await commitTask(queryClient, scope, saved)
      onSaved?.(saved)
    },
  })

  /**
   * Moves a task that needs no answer, or one whose answer is in `fields`, as a copy of the task
   * the page had when the person acted. If the task has moved on since, nothing is saved: the
   * current task goes into the page and the person is told, with the move offered again.
   */
  async function move(scope: ProjectScope, task: TaskOut, fields: Fields) {
    setRefusal(null)
    setSaving((s) => ({ ...s, [task.id]: fields.status }))
    try {
      await save.mutateAsync({ scope, base: task, fields })
      say(`Moved “${task.title}” to ${STATUS_LABEL[fields.status]}.`)
    } catch (e) {
      say("")
      if (e instanceof StaleSaveError) {
        const now = e.current as TaskOut
        await commitTask(queryClient, scope, now)
        setRefusal({
          scope,
          task: now,
          to: fields.status,
          why: e.message,
          kind: now.status === fields.status ? "already" : "stale",
        })
      } else {
        setRefusal({ scope, task, to: fields.status, why: reason(e), kind: "refused" })
        // The task may have changed or gone elsewhere: read it again.
        if (e instanceof ApiError && e.status === 404) {
          void queryClient.invalidateQueries({ queryKey: queries.project(scope).queryKey })
          void queryClient.invalidateQueries({ queryKey: queries.today().queryKey })
        }
      }
    } finally {
      setSaving(({ [task.id]: _, ...rest }) => rest)
    }
  }

  /** A move to `to`: straight through, or after asking first. */
  function request(scope: ProjectScope, task: TaskOut, to: TaskState) {
    if (to === task.status || saving[task.id]) return
    if (asksFirst(to)) setAsk({ scope, task, to })
    else void move(scope, task, { ...fieldsOf(task), status: to })
  }

  return {
    saving,
    refusal,
    announcement,
    ask,
    say,
    dismiss: () => setRefusal(null),
    cancelAsk: () => setAsk(null),
    request,
    /** The move a stale refusal offers again, on the task as it now stands. */
    again() {
      if (!refusal || refusal.kind !== "stale") return
      setRefusal(null)
      request(refusal.scope, refusal.task, refusal.to)
    },
    /**
     * A dialog's save, as a copy of the task the dialog opened on (null for a new task). Throws what
     * the API refused with, a `StaleSaveError` among it: the dialog says what to do about it.
     */
    async send(scope: ProjectScope, base: TaskOut | null, fields: Fields) {
      await save.mutateAsync({ scope, base, fields })
      say(base ? `Saved “${fields.title.trim()}”.` : `Added “${fields.title.trim()}”.`)
      setRefusal(null)
    },
    /** A task the API answered a stale save with, in the page. */
    adopt: (scope: ProjectScope, current: TaskOut) => commitTask(queryClient, scope, current),
  }
}

export type TaskMover = ReturnType<typeof useTaskMover>

/** The prompt for a move that asks first. `people` are who the company's task can wait on. */
export function MoveAsk({
  mover,
  people,
  peopleNote,
  requests = [],
  requestsNote,
}: {
  mover: TaskMover
  people: Array<StakeholderOut>
  /** Why the list of people is empty, when it is not because there are none. */
  peopleNote?: string
  /** The project's access requests, for a task that can be blocked on one. */
  requests?: ReadonlyArray<AccessRequestOut>
  requestsNote?: string
}) {
  const { ask } = mover
  return (
    <Dialog open={ask !== null} onOpenChange={(open) => !open && mover.cancelAsk()}>
      {ask && (
        <AskDialog
          key={ask.task.id + ask.to}
          task={ask.task}
          to={ask.to}
          people={people}
          peopleNote={peopleNote}
          requests={requests}
          requestsNote={requestsNote}
          onSave={(base, fields) => mover.send(ask.scope, base ?? null, fields)}
          onAdopt={(current) => mover.adopt(ask.scope, current)}
          onClose={mover.cancelAsk}
        />
      )}
    </Dialog>
  )
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-[11px] text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

/** The stakeholder choices for a task that waits on the customer. */
export function WaitingOn({
  value,
  people,
  onChange,
}: {
  value: string | null
  people: Array<StakeholderOut>
  onChange: (id: string | null) => void
}) {
  const listed = value === null || people.some((s) => s.id === value)
  return (
    <select
      className={FIELD}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">No one in particular</option>
      {!listed && <option value={value}>A stakeholder no longer listed</option>}
      {people.map((s) => (
        <option key={s.id} value={s.id}>
          {s.title ? `${s.name}, ${s.title}` : s.name}
        </option>
      ))}
    </select>
  )
}

/**
 * The access request a blocked task waits on, chosen from the project's: any not granted yet (granted,
 * the API puts the task back to do), and the one it names now. Nothing shows when there is nothing to choose.
 */
export function BlockedBy({
  value,
  requests,
  note,
  onChange,
}: {
  value: string | null
  requests: ReadonlyArray<AccessRequestOut>
  /** Why the list is empty, when it is not because there are none. */
  note?: string
  onChange: (id: string | null) => void
}) {
  const options = blockers(requests, value)
  if (options.length === 0 && value === null && !note) return null
  const listed = value === null || options.some((r) => r.id === value)
  return (
    <div className="grid gap-1">
      <Labelled label="Blocked by an access request">
        <select
          className={FIELD}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">None, something else</option>
          {!listed && <option value={value}>An access request no longer listed</option>}
          {options.map((r) => (
            <option key={r.id} value={r.id}>
              {clip(r.description, 60)}
              {r.status === "requested" ? "" : ` (${ACCESS_LABEL[r.status].toLowerCase()})`}
            </option>
          ))}
        </select>
      </Labelled>
      <p className="text-[11px] text-muted-foreground">
        {note ?? "Once it is granted, the task goes back to To do."}
      </p>
    </div>
  )
}

/** The dialog's buttons and the API's answer to Save, shared by every form. */
export function Footer({
  busy,
  error,
  errorId,
  save,
  onClose,
  extra,
}: {
  busy: boolean
  error: string | null
  /** What a field the error is about points to, so a screen reader reads it with the field. */
  errorId?: string
  save: string
  onClose: () => void
  extra?: ReactNode
}) {
  return (
    <>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {extra}
        <Button type="button" variant="ghost" onClick={onClose} className="max-[800px]:ml-auto">
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : save}
        </Button>
      </div>
    </>
  )
}

/** Asks what blocks a task, or who it waits on, before it moves. */
function AskDialog({
  task,
  to,
  people,
  peopleNote,
  requests,
  requestsNote,
  onSave,
  onAdopt,
  onClose,
}: {
  task: TaskOut
  to: "blocked" | "waiting_on_customer"
  people: Array<StakeholderOut>
  peopleNote?: string
  requests: ReadonlyArray<AccessRequestOut>
  requestsNote?: string
  onSave: (base: TaskOut | undefined, fields: Fields) => Promise<unknown>
  onAdopt: (current: TaskOut) => Promise<void>
  onClose: () => void
}) {
  // The task as it was when the prompt opened is what the move is based on: if it has changed by the
  // time of Save, the person is told, and what they typed stays.
  const form = useVersionedForm({
    record: task,
    snapshot: fieldsOf,
    initial: { ...fieldsOf(task), status: to, blocker: "" },
    labels: TASK_LABELS,
    send: onSave,
    adopt: onAdopt,
    what: "task",
  })
  const { fields, set } = form
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const blocked = to === "blocked"

  async function submit(event: FormEvent) {
    event.preventDefault()
    const bad = problem(fields)
    if (bad) return setError(bad)
    setBusy(true)
    const failed = await form.submit()
    setBusy(false)
    if (isHeld(failed)) setError(null)
    else if (failed) setError(typeof failed === "string" ? failed : failed.message)
    else onClose()
  }

  return (
    <DialogContent placement="center" className="p-5">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3.5 text-xs">
        <div className="grid gap-1">
          <DialogTitle className="text-[13px] font-semibold">
            {blocked ? "What is blocking this?" : "Who is this waiting on?"}
          </DialogTitle>
          <DialogDescription className="text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
            {task.title}
          </DialogDescription>
        </div>
        {blocked ? (
          <>
            <Labelled label="The blocker">
              <textarea
                autoFocus
                className={`${FIELD} min-h-20`}
                value={fields.blocker}
                onChange={(e) => set({ blocker: e.target.value })}
              />
            </Labelled>
            <BlockedBy
              value={fields.blockedBy}
              requests={requests}
              note={requestsNote}
              onChange={(blockedBy) => set({ blockedBy })}
            />
          </>
        ) : (
          <div className="grid gap-1">
            <Labelled label="Waiting on">
              <WaitingOn
                value={fields.waitingOn}
                people={people}
                onChange={(waitingOn) => set({ waitingOn })}
              />
            </Labelled>
            {peopleNote && <p className="text-[11px] text-muted-foreground">{peopleNote}</p>}
          </div>
        )}
        <StaleNotice stale={form.stale} noun="task" />
        <Footer
          busy={busy}
          error={error}
          save={form.save(`Move to ${STATUS_LABEL[to]}`)}
          onClose={onClose}
        />
      </form>
    </DialogContent>
  )
}

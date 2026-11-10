import { useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog"
import { ApiError, api, queries } from "@/lib/api/client"
import type {
  AccessRequestOut,
  ProjectScope,
  StakeholderOut,
  TaskOut,
  TaskState,
} from "@/lib/api/schemas"
import { blockers, clip } from "@/lib/access"
import { STATUS_LABEL, asksFirst, fieldsOf, problem, toBody } from "@/lib/board"
import type { Fields } from "@/lib/board"
import { commitTask, reason } from "@/lib/task-move"
import { ACCESS_LABEL } from "@/lib/today"

// What the board and Today share when a task moves (DESIGN.md §3): the two prompts, saving that
// shows nothing as done until the API confirms it, and a refused move that stays put and says why.

export const FIELD =
  "w-full rounded-lg border bg-raised px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:border-strong aria-invalid:border-destructive"

/** The question a move into Blocked or Waiting on the customer asks first. */
export type Ask = { scope: ProjectScope; task: TaskOut; to: "blocked" | "waiting_on_customer" }
/** A move the API refused, and why. */
export type Refusal = { task: TaskOut; to: TaskState; why: string }

export function useTaskMover({ onSaved }: { onSaved?: (task: TaskOut) => void } = {}) {
  const queryClient = useQueryClient()
  // The status each task is on its way to, until the API answers.
  const [saving, setSaving] = useState<Record<string, TaskState>>({})
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [announcement, say] = useState("")
  const [ask, setAsk] = useState<Ask | null>(null)

  const save = useMutation({
    mutationFn: ({
      scope,
      task,
      fields,
    }: {
      scope: ProjectScope
      task: TaskOut | null
      fields: Fields
    }) =>
      task ? api.updateTask(scope, task.id, toBody(fields)) : api.addTask(scope, toBody(fields)),
    async onSuccess(saved, { scope }) {
      await commitTask(queryClient, scope, saved)
      onSaved?.(saved)
    },
  })

  /** Moves a task that needs no answer, or one whose answer is in `fields`. */
  async function move(scope: ProjectScope, task: TaskOut, fields: Fields) {
    setRefusal(null)
    setSaving((s) => ({ ...s, [task.id]: fields.status }))
    try {
      await save.mutateAsync({ scope, task, fields })
      say(`Moved “${task.title}” to ${STATUS_LABEL[fields.status]}.`)
    } catch (e) {
      say("")
      setRefusal({ task, to: fields.status, why: reason(e) })
      // The task may have changed or gone elsewhere: read it again.
      if (e instanceof ApiError && e.status === 404) {
        void queryClient.invalidateQueries({ queryKey: queries.project(scope).queryKey })
        void queryClient.invalidateQueries({ queryKey: queries.today().queryKey })
      }
    } finally {
      setSaving(({ [task.id]: _, ...rest }) => rest)
    }
  }

  return {
    saving,
    refusal,
    announcement,
    ask,
    say,
    dismiss: () => setRefusal(null),
    cancelAsk: () => setAsk(null),
    /** A move to `to`: straight through, or after asking first. */
    request(scope: ProjectScope, task: TaskOut, to: TaskState) {
      if (to === task.status || saving[task.id]) return
      if (asksFirst(to)) setAsk({ scope, task, to })
      else void move(scope, task, { ...fieldsOf(task), status: to })
    },
    /** What a dialog's Save does: null when the API confirmed it, or why it did not. */
    async submit(scope: ProjectScope, task: TaskOut | null, fields: Fields) {
      try {
        await save.mutateAsync({ scope, task, fields })
        say(task ? `Saved “${fields.title.trim()}”.` : `Added “${fields.title.trim()}”.`)
        setRefusal(null)
        return null
      } catch (e) {
        return reason(e)
      }
    },
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
          onSave={(fields) => mover.submit(ask.scope, ask.task, fields)}
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
  onClose,
}: {
  task: TaskOut
  to: "blocked" | "waiting_on_customer"
  people: Array<StakeholderOut>
  peopleNote?: string
  requests: ReadonlyArray<AccessRequestOut>
  requestsNote?: string
  onSave: (fields: Fields) => Promise<string | null>
  onClose: () => void
}) {
  const [fields, setFields] = useState<Fields>({ ...fieldsOf(task), status: to, blocker: "" })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const blocked = to === "blocked"

  async function submit(event: FormEvent) {
    event.preventDefault()
    const bad = problem(fields)
    if (bad) return setError(bad)
    setBusy(true)
    const failed = await onSave(fields)
    setBusy(false)
    if (failed) setError(failed)
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
                onChange={(e) => setFields({ ...fields, blocker: e.target.value })}
              />
            </Labelled>
            <BlockedBy
              value={fields.blockedBy}
              requests={requests}
              note={requestsNote}
              onChange={(blockedBy) => setFields({ ...fields, blockedBy })}
            />
          </>
        ) : (
          <div className="grid gap-1">
            <Labelled label="Waiting on">
              <WaitingOn
                value={fields.waitingOn}
                people={people}
                onChange={(waitingOn) => setFields({ ...fields, waitingOn })}
              />
            </Labelled>
            {peopleNote && <p className="text-[11px] text-muted-foreground">{peopleNote}</p>}
          </div>
        )}
        <Footer busy={busy} error={error} save={`Move to ${STATUS_LABEL[to]}`} onClose={onClose} />
      </form>
    </DialogContent>
  )
}

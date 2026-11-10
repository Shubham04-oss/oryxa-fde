import { useId, useState } from "react"
import type { DragEvent, FormEvent, KeyboardEvent, ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Ellipsis } from "lucide-react"
import { Card, Quiet } from "./page"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog"
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu"
import { ApiError, api, queries } from "@/lib/api/client"
import type { Project, ProjectScope, StakeholderOut, TaskOut, TaskState } from "@/lib/api/schemas"
import { COLUMNS, STATUS_LABEL, asksFirst, fieldsOf, inColumn, problem, toBody } from "@/lib/board"
import type { Fields } from "@/lib/board"
import { dayOf, daysBetween, dueLabel, localDay, waitingLabel } from "@/lib/time"
import { cn } from "@/lib/utils"

const FIELD =
  "w-full rounded-lg border bg-raised px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:border-strong"

const DOT: Record<TaskState, string> = {
  todo: "bg-strong",
  in_progress: "bg-strong",
  waiting_on_customer: "bg-strong",
  blocked: "bg-attention",
  done: "bg-success",
}

/** Why a save failed, in words: what the API said, or a short generic line. */
function reason(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 404) return "The task is no longer there."
    if (error.message !== error.code) return error.message
  }
  return "Check your connection and try again."
}

type Dialogs =
  | { kind: "new"; status: TaskState }
  | { kind: "edit"; task: TaskOut }
  | { kind: "ask"; task: TaskOut; to: "blocked" | "waiting_on_customer" }

/**
 * The project's tasks as a board (DESIGN.md §3): one column per status. A card moves by drag, or
 * by its menu, which also works by keyboard and is the way on a phone. Moving into Blocked asks
 * what blocks it and into Waiting on the customer asks who it waits on. Nothing moves until the
 * API confirms it.
 */
export function Board({ scope, project }: { scope: ProjectScope; project: Project }) {
  const queryClient = useQueryClient()
  const me = useQuery(queries.me())
  const [dialog, setDialog] = useState<Dialogs | null>(null)
  // The status each card is on its way to, until the API answers.
  const [saving, setSaving] = useState<Record<string, TaskState>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<TaskState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState("")

  const key = queries.project(scope).queryKey
  const change = (edit: (tasks: Array<TaskOut>) => Array<TaskOut>) =>
    queryClient.setQueryData(key, (old) => old && { ...old, tasks: edit(old.tasks) })
  // Today lists the same tasks.
  const refreshToday = () =>
    void queryClient.invalidateQueries({ queryKey: queries.today().queryKey })

  const save = useMutation({
    mutationFn: ({ task, fields }: { task: TaskOut | null; fields: Fields }) =>
      task ? api.updateTask(scope, task.id, toBody(fields)) : api.addTask(scope, toBody(fields)),
    onSuccess(saved) {
      change((tasks) =>
        tasks.some((t) => t.id === saved.id)
          ? tasks.map((t) => (t.id === saved.id ? saved : t))
          : [...tasks, saved],
      )
      refreshToday()
    },
  })
  const remove = useMutation({
    mutationFn: (task: TaskOut) => api.removeTask(scope, task.id),
    onSuccess(_, task) {
      change((tasks) => tasks.filter((t) => t.id !== task.id))
      refreshToday()
    },
  })

  const people = new Map(project.stakeholders.map((s) => [s.id as string, s.name]))
  const today = localDay()

  /** Moves a task that needs no answer, or one whose answer is in `fields`. */
  async function move(task: TaskOut, fields: Fields) {
    setError(null)
    setSaving((s) => ({ ...s, [task.id]: fields.status }))
    try {
      await save.mutateAsync({ task, fields })
      setDone(`Moved “${task.title}” to ${STATUS_LABEL[fields.status]}.`)
    } catch (e) {
      setDone("")
      setError(`Couldn't move “${task.title}” to ${STATUS_LABEL[fields.status]}. ${reason(e)}`)
      // The task may have changed or gone elsewhere: read the board again.
      if (e instanceof ApiError && e.status === 404)
        void queryClient.invalidateQueries({ queryKey: key })
    } finally {
      setSaving(({ [task.id]: _, ...rest }) => rest)
    }
  }

  function requestMove(task: TaskOut, to: TaskState) {
    if (to === task.status || saving[task.id]) return
    if (asksFirst(to)) setDialog({ kind: "ask", task, to })
    else void move(task, { ...fieldsOf(task), status: to })
  }

  /** What a dialog's Save does: null when the API confirmed it, or why it did not. */
  async function submit(task: TaskOut | null, fields: Fields) {
    try {
      await save.mutateAsync({ task, fields })
      setDone(task ? `Saved “${fields.title.trim()}”.` : `Added “${fields.title.trim()}”.`)
      setError(null)
      return null
    } catch (e) {
      return reason(e)
    }
  }

  async function discard(task: TaskOut) {
    try {
      await remove.mutateAsync(task)
      setDone(`Deleted “${task.title}”.`)
      setError(null)
      return null
    } catch (e) {
      return reason(e)
    }
  }

  function onDrop(event: DragEvent, to: TaskState) {
    event.preventDefault()
    const task = project.tasks.find((t) => t.id === dragging)
    setDragging(null)
    setOver(null)
    if (task) requestMove(task, to)
  }

  const tasks = project.tasks
  return (
    <Card
      title="Board"
      aside={
        <Button variant="outline" onClick={() => setDialog({ kind: "new", status: "todo" })}>
          New task
        </Button>
      }
    >
      <p role="status" className="sr-only">
        {done}
      </p>
      {error && (
        <p
          role="alert"
          className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-destructive"
        >
          {error}
          <button
            type="button"
            className="text-muted-foreground underline"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </p>
      )}
      {tasks.length === 0 ? (
        <Quiet>No tasks yet. Add the first one.</Quiet>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1 pb-1 max-[800px]:mx-0 max-[800px]:overflow-visible max-[800px]:px-0">
          <div className="grid auto-cols-[minmax(176px,1fr)] grid-flow-col gap-3 max-[800px]:auto-cols-auto max-[800px]:grid-flow-row">
            {COLUMNS.map(({ status, label }) => {
              const column = inColumn(tasks, status)
              return (
                <Column
                  key={status}
                  status={status}
                  label={label}
                  count={column.length}
                  active={over === status}
                  onDragOver={(event) => {
                    const task = tasks.find((t) => t.id === dragging)
                    if (!task || task.status === status) return
                    event.preventDefault()
                    setOver(status)
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setOver((now) => (now === status ? null : now))
                  }}
                  onDrop={(event) => onDrop(event, status)}
                >
                  {column.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      to={saving[task.id]}
                      me={me.data?.user.id}
                      today={today}
                      person={(id) => people.get(id) ?? "a stakeholder no longer listed"}
                      onOpen={() => setDialog({ kind: "edit", task })}
                      onMove={(to) => requestMove(task, to)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", task.id)
                        event.dataTransfer.effectAllowed = "move"
                        setDragging(task.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                    />
                  ))}
                </Column>
              )
            })}
          </div>
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog?.kind === "ask" && (
          <AskDialog
            key={dialog.task.id + dialog.to}
            task={dialog.task}
            to={dialog.to}
            people={project.stakeholders}
            onSave={(fields) => submit(dialog.task, fields)}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog && dialog.kind !== "ask" && (
          <TaskDialog
            key={dialog.kind === "edit" ? dialog.task.id : "new"}
            task={dialog.kind === "edit" ? dialog.task : null}
            status={dialog.kind === "new" ? dialog.status : "todo"}
            people={project.stakeholders}
            me={me.data?.user.id}
            onSave={(fields) => submit(dialog.kind === "edit" ? dialog.task : null, fields)}
            onDelete={dialog.kind === "edit" ? () => discard(dialog.task) : undefined}
            onClose={() => setDialog(null)}
          />
        )}
      </Dialog>
    </Card>
  )
}

function Column({
  status,
  label,
  count,
  active,
  children,
  ...drop
}: {
  status: TaskState
  label: string
  count: number
  active: boolean
  children: ReactNode
  onDragOver: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}) {
  const heading = useId()
  return (
    <section
      aria-labelledby={heading}
      {...drop}
      className={cn(
        "min-w-0 rounded-xl border border-transparent p-1.5 transition-colors",
        active && "border-dashed border-strong bg-selected",
      )}
    >
      <h3 className="mb-2 flex items-center gap-1.5 px-0.5 text-[11px] text-soft">
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[status])} />
        <span id={heading}>{label}</span>
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </h3>
      {count === 0 ? (
        <Quiet className="px-0.5 py-1">{active ? "Drop it here." : "Nothing here."}</Quiet>
      ) : (
        <ul aria-label={label} className="grid gap-2">
          {children}
        </ul>
      )}
    </section>
  )
}

/** A card's lines under the title: who has it, why it is stuck or who it waits on, and when it is due. */
// ponytail: the API returns only the assignee's WorkOS user id, so a teammate can't be named yet.
function assigneeLabel(assignee: string | null | undefined, me: string | undefined) {
  if (!assignee) return "Unassigned"
  // Until we know who you are, a card does not guess.
  if (!me) return ""
  return assignee === me ? "Assigned to you" : "Assigned to a teammate"
}

function lines(task: TaskOut, today: string, person: (id: string) => string) {
  const out: Array<{ text: string; attention: boolean }> = []
  if (task.status === "blocked" && task.blocker) out.push({ text: task.blocker, attention: true })
  if (task.status === "waiting_on_customer") {
    const days = daysBetween(dayOf(task.waiting_since ?? task.updated_at), today)
    out.push({
      text: waitingLabel(days, task.waiting_on ? person(task.waiting_on) : null),
      attention: false,
    })
  }
  if (task.status !== "done" && task.due_on)
    out.push({ text: dueLabel(task.due_on, today), attention: task.due_on < today })
  return out
}

function TaskCard({
  task,
  to,
  me,
  today,
  person,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  task: TaskOut
  /** Where it is on its way to, while the API has not answered. */
  to: TaskState | undefined
  me: string | undefined
  today: string
  person: (id: string) => string
  onOpen: () => void
  onMove: (to: TaskState) => void
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
}) {
  const pending = to !== undefined
  const detail = lines(task, today, person)
  const who = assigneeLabel(task.assignee, me)

  function key(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onOpen()
  }

  return (
    <li
      draggable={!pending}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-busy={pending}
      className={cn(
        "group relative min-w-0 rounded-lg border bg-raised px-2.5 py-2 hover:border-strong",
        !pending && "cursor-grab active:cursor-grabbing",
        pending && "opacity-60",
      )}
    >
      {/* Not a <button>: Firefox will not start a drag from one. */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Edit ${task.title}`}
        onClick={onOpen}
        onKeyDown={key}
        className="grid min-w-0 gap-0.5 rounded-md pr-7 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="text-xs leading-snug [overflow-wrap:anywhere]">{task.title}</span>
        {who && <span className="text-[11px] text-muted-foreground">{who}</span>}
        {detail.map((line) => (
          <span
            key={line.text}
            className="flex items-start gap-1.5 text-[11px] leading-normal [overflow-wrap:anywhere] text-soft"
          >
            {line.attention && (
              <span
                aria-hidden="true"
                className="mt-[5px] size-1.5 shrink-0 rounded-full bg-attention"
              />
            )}
            {line.text}
          </span>
        ))}
        {pending && (
          <span className="text-[11px] text-muted-foreground">Moving to {STATUS_LABEL[to]}…</span>
        )}
      </div>
      <Menu>
        <MenuTrigger
          aria-label={`Actions for ${task.title}`}
          disabled={pending}
          className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-selected hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-popup-open:bg-selected max-[800px]:size-9"
        >
          <Ellipsis size={15} strokeWidth={1.7} aria-hidden="true" />
        </MenuTrigger>
        <MenuContent label={`Actions for ${task.title}`}>
          <MenuGroup>
            <MenuLabel>Move to</MenuLabel>
            {COLUMNS.filter((c) => c.status !== task.status).map((c) => (
              <MenuItem key={c.status} onClick={() => onMove(c.status)}>
                {c.label}
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={onOpen}>Edit</MenuItem>
        </MenuContent>
      </Menu>
    </li>
  )
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-[11px] text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

/** The stakeholder choices for a task that waits on the customer. */
function WaitingOn({
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

/** The dialog's buttons and the API's answer to Save, shared by both dialogs. */
function Footer({
  busy,
  error,
  save,
  onClose,
  extra,
}: {
  busy: boolean
  error: string | null
  save: string
  onClose: () => void
  extra?: ReactNode
}) {
  return (
    <>
      {error && (
        <p role="alert" className="text-xs text-destructive">
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
  onSave,
  onClose,
}: {
  task: TaskOut
  to: "blocked" | "waiting_on_customer"
  people: Array<StakeholderOut>
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
    <DialogContent className="p-5">
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
          <Labelled label="The blocker">
            <textarea
              autoFocus
              className={`${FIELD} min-h-20`}
              value={fields.blocker}
              onChange={(e) => setFields({ ...fields, blocker: e.target.value })}
            />
          </Labelled>
        ) : (
          <Labelled label="Waiting on">
            <WaitingOn
              value={fields.waitingOn}
              people={people}
              onChange={(waitingOn) => setFields({ ...fields, waitingOn })}
            />
          </Labelled>
        )}
        <Footer busy={busy} error={error} save={`Move to ${STATUS_LABEL[to]}`} onClose={onClose} />
      </form>
    </DialogContent>
  )
}

/** Creates a task, or edits one; an edit can also delete it, after asking. */
function TaskDialog({
  task,
  status,
  people,
  me,
  onSave,
  onDelete,
  onClose,
}: {
  task: TaskOut | null
  status: TaskState
  people: Array<StakeholderOut>
  me: string | undefined
  onSave: (fields: Fields) => Promise<string | null>
  onDelete: (() => Promise<string | null>) | undefined
  onClose: () => void
}) {
  const [fields, setFields] = useState<Fields>(
    task
      ? fieldsOf(task)
      : {
          title: "",
          status,
          blocker: "",
          waitingOn: null,
          due: "",
          assignee: null,
          blockedBy: null,
        },
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const set = (patch: Partial<Fields>) => setFields({ ...fields, ...patch })

  async function run(work: () => Promise<string | null>) {
    setBusy(true)
    const failed = await work()
    setBusy(false)
    if (failed) setError(failed)
    else onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const bad = problem(fields)
    if (bad) return setError(bad)
    void run(() => onSave(fields))
  }

  // A teammate has no name here yet, only an id, so they are kept as "a teammate".
  const teammate = fields.assignee !== null && fields.assignee !== me

  return (
    <DialogContent className="max-h-[calc(100dvh-24vh)] overflow-y-auto p-5">
      <form onSubmit={submit} className="grid gap-3.5 text-xs">
        <DialogTitle className="text-[13px] font-semibold">
          {task ? "Edit task" : "New task"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {task ? "Change this task, or delete it." : "Add a task to the board."}
        </DialogDescription>
        <Labelled label="Title">
          <input
            autoFocus
            className={FIELD}
            value={fields.title}
            onChange={(e) => set({ title: e.target.value })}
            autoComplete="off"
          />
        </Labelled>
        <Labelled label="Status">
          <select
            className={FIELD}
            value={fields.status}
            onChange={(e) => set({ status: e.target.value as TaskState })}
          >
            {COLUMNS.map((c) => (
              <option key={c.status} value={c.status}>
                {c.label}
              </option>
            ))}
          </select>
        </Labelled>
        {fields.status === "blocked" && (
          <Labelled label="The blocker">
            <textarea
              className={`${FIELD} min-h-20`}
              value={fields.blocker}
              onChange={(e) => set({ blocker: e.target.value })}
            />
          </Labelled>
        )}
        {fields.status === "waiting_on_customer" && (
          <Labelled label="Waiting on">
            <WaitingOn
              value={fields.waitingOn}
              people={people}
              onChange={(waitingOn) => set({ waitingOn })}
            />
          </Labelled>
        )}
        <div className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
          <Labelled label="Due">
            <input
              type="date"
              className={FIELD}
              value={fields.due}
              onChange={(e) => set({ due: e.target.value })}
            />
          </Labelled>
          <Labelled label="Assigned to">
            <select
              className={FIELD}
              value={fields.assignee ?? ""}
              onChange={(e) => set({ assignee: e.target.value || null })}
            >
              <option value="">Unassigned</option>
              {me && <option value={me}>You</option>}
              {teammate && <option value={fields.assignee!}>A teammate</option>}
            </select>
          </Labelled>
        </div>
        {deleting ? (
          <div
            role="group"
            aria-label="Confirm the delete"
            className="flex flex-wrap items-center gap-2 rounded-xl border bg-raised px-3.5 py-2.5"
          >
            <p className="mr-auto">Delete this task? This cannot be undone.</p>
            <Button type="button" variant="ghost" onClick={() => setDeleting(false)}>
              Keep it
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(() => onDelete!())}>
              Delete
            </Button>
          </div>
        ) : null}
        <Footer
          busy={busy}
          error={error}
          save={task ? "Save" : "Add task"}
          onClose={onClose}
          extra={
            onDelete &&
            !deleting && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive"
                onClick={() => setDeleting(true)}
              >
                Delete task
              </Button>
            )
          }
        />
      </form>
    </DialogContent>
  )
}

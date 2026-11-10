import { useId, useRef, useState } from "react"
import type { DragEvent, FormEvent, KeyboardEvent, ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react"
import { Card, Quiet } from "./page"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog"
import { FIELD, Footer, Labelled, MoveAsk, WaitingOn, useTaskMover } from "./task-move"
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu"
import { api, queries } from "@/lib/api/client"
import type { Project, ProjectScope, StakeholderOut, TaskOut, TaskState } from "@/lib/api/schemas"
import {
  COLUMNS,
  DONE_SHOWN,
  STATUS_LABEL,
  fieldsOf,
  inColumn,
  isOverdue,
  problem,
  recentDone,
  summarise,
} from "@/lib/board"
import type { Fields } from "@/lib/board"
import { commitRemoved, reason } from "@/lib/task-move"
import { dayOf, daysBetween, dueLabel, localDay, waitingLabel } from "@/lib/time"
import { cn } from "@/lib/utils"

const DOT: Record<TaskState, string> = {
  todo: "bg-strong",
  in_progress: "bg-strong",
  waiting_on_customer: "bg-strong",
  blocked: "bg-attention",
  done: "bg-success",
}

type Dialogs = { kind: "new"; status: TaskState } | { kind: "edit"; task: TaskOut }

/**
 * The project's tasks as a board (DESIGN.md §3): one column per status. A card moves by drag, or
 * by its menu, which also works by keyboard and is the way on a phone. Moving into Blocked asks
 * what blocks it and into Waiting on the customer asks who it waits on. Nothing moves until the
 * API confirms it.
 */
export function Board({ scope, project }: { scope: ProjectScope; project: Project }) {
  const queryClient = useQueryClient()
  const me = useQuery(queries.me())
  const mover = useTaskMover()
  const { saving } = mover
  const [dialog, setDialog] = useState<Dialogs | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<TaskState | null>(null)
  // Done is the longest and least urgent column, so it starts collapsed (DESIGN.md §3).
  const [doneOpen, setDoneOpen] = useState(false)
  const [doneAll, setDoneAll] = useState(false)
  const columns = useRef(new Map<TaskState, HTMLElement>())

  const remove = useMutation({
    mutationFn: (task: TaskOut) => api.removeTask(scope, task.id),
    onSuccess: (_, task) => commitRemoved(queryClient, scope, task),
  })

  const people = new Map(project.stakeholders.map((s) => [s.id as string, s.name]))
  const today = localDay()
  const refused = mover.refusal
  const error =
    refused &&
    `Couldn't move “${refused.task.title}” to ${STATUS_LABEL[refused.to]}. ${refused.why}`

  const requestMove = (task: TaskOut, to: TaskState) => mover.request(scope, task, to)

  async function discard(task: TaskOut) {
    try {
      await remove.mutateAsync(task)
      mover.say(`Deleted “${task.title}”.`)
      mover.dismiss()
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

  /** Scrolls a column into view, and moves focus to it or to a card in it. */
  function reveal(status: TaskState, focus: (column: HTMLElement) => HTMLElement | null) {
    const column = columns.current.get(status)
    if (!column) return
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    column.scrollIntoView({
      behavior: calm ? "auto" : "smooth",
      block: "nearest",
      inline: "start",
    })
    // The scroll above brings it into view; focus must not jump the canvas a second time.
    focus(column)?.focus({ preventScroll: true })
  }

  function showStuck(part: "blocked" | "waiting" | "overdue") {
    if (part === "blocked") return reveal("blocked", (column) => column)
    if (part === "waiting") return reveal("waiting_on_customer", (column) => column)
    // Overdue spans columns: go to the first card that is late, in column order.
    const first = COLUMNS.find(({ status }) =>
      columns.current.get(status)?.querySelector("[data-overdue]"),
    )
    if (first) reveal(first.status, (column) => column.querySelector<HTMLElement>("[data-overdue]"))
  }

  const tasks = project.tasks
  const summary = summarise(tasks, today)
  const finished = recentDone(tasks)
  return (
    <Card
      title="Board"
      className="mx-auto w-full max-w-[1600px]"
      aside={
        <Button variant="outline" onClick={() => setDialog({ kind: "new", status: "todo" })}>
          New task
        </Button>
      }
    >
      <p role="status" className="sr-only">
        {mover.announcement}
      </p>
      {error && (
        <p
          role="alert"
          className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-destructive"
        >
          {error}
          <button type="button" className="text-muted-foreground underline" onClick={mover.dismiss}>
            Dismiss
          </button>
        </p>
      )}
      {tasks.length === 0 ? (
        <Quiet>No tasks yet. Add the first one.</Quiet>
      ) : (
        <>
          <Summary counts={summary} onShow={showStuck} />
          <div className="board-scroll @container snap-x snap-mandatory overflow-x-auto pb-2 max-[800px]:overflow-visible max-[800px]:pb-0">
            <div
              data-done={doneOpen ? "open" : "collapsed"}
              // The columns are 220px at least. When they do not all fit, each is sized so that a
              // part of the next one always shows: n whole columns and about a third of the next.
              className={cn(
                "grid grid-flow-col grid-cols-[repeat(4,minmax(var(--col),1fr))_var(--last)] gap-3",
                "[--col:max(220px,calc((100cqw-12px)/1.35))]",
                "@min-[541px]:[--col:max(220px,calc((100cqw-24px)/2.35))]",
                "@min-[773px]:[--col:max(220px,calc((100cqw-36px)/3.35))]",
                "data-[done=open]:@min-[1005px]:[--col:max(220px,calc((100cqw-48px)/4.35))]",
                "data-[done=collapsed]:@min-[984px]:[--col:220px]",
                "data-[done=open]:@min-[1148px]:[--col:220px]",
                "data-[done=collapsed]:[--last:3.5rem] data-[done=open]:[--last:minmax(var(--col),1fr)]",
                "max-[800px]:grid-flow-row max-[800px]:grid-cols-1",
              )}
            >
              {COLUMNS.map(({ status, label }) => {
                const isDone = status === "done"
                const column = isDone
                  ? doneAll
                    ? finished
                    : finished.slice(0, DONE_SHOWN)
                  : inColumn(tasks, status)
                const count = isDone ? finished.length : column.length
                return (
                  <Column
                    key={status}
                    status={status}
                    label={label}
                    count={count}
                    collapsed={isDone && !doneOpen}
                    onToggle={
                      isDone
                        ? () => {
                            setDoneOpen(!doneOpen)
                            // Opened, it is bigger than a strip: bring it into view once it has laid out.
                            if (!doneOpen) requestAnimationFrame(() => reveal("done", () => null))
                          }
                        : undefined
                    }
                    sectionRef={(element) => {
                      if (element) columns.current.set(status, element)
                      else columns.current.delete(status)
                    }}
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
                    more={
                      isDone && doneOpen && finished.length > DONE_SHOWN ? (
                        <button
                          type="button"
                          aria-expanded={doneAll}
                          className="px-0.5 pt-2 text-left text-[11px] text-muted-foreground underline"
                          onClick={() => setDoneAll(!doneAll)}
                        >
                          {doneAll
                            ? `Show the latest ${DONE_SHOWN}`
                            : `Show all ${finished.length}`}
                        </button>
                      ) : null
                    }
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
        </>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog && (
          <TaskDialog
            key={dialog.kind === "edit" ? dialog.task.id : "new"}
            task={dialog.kind === "edit" ? dialog.task : null}
            status={dialog.kind === "new" ? dialog.status : "todo"}
            people={project.stakeholders}
            me={me.data?.user.id}
            onSave={(fields) =>
              mover.submit(scope, dialog.kind === "edit" ? dialog.task : null, fields)
            }
            onDelete={dialog.kind === "edit" ? () => discard(dialog.task) : undefined}
            onClose={() => setDialog(null)}
          />
        )}
      </Dialog>
      <MoveAsk mover={mover} people={project.stakeholders} />
    </Card>
  )
}

/** What needs the FDE, always visible above the columns; each part goes to where that work is. */
function Summary({
  counts,
  onShow,
}: {
  counts: ReturnType<typeof summarise>
  onShow: (part: "blocked" | "waiting" | "overdue") => void
}) {
  const parts = [
    { part: "blocked", n: counts.blocked, text: `${counts.blocked} blocked`, dot: "bg-attention" },
    {
      part: "waiting",
      n: counts.waiting,
      text: `${counts.waiting} waiting on the customer`,
      dot: "bg-strong",
    },
    { part: "overdue", n: counts.overdue, text: `${counts.overdue} overdue`, dot: "bg-attention" },
  ] as const
  const shown = parts.filter((p) => p.n > 0)
  if (shown.length === 0)
    return <Quiet className="mb-3">Nothing is blocked, waiting or overdue.</Quiet>
  return (
    <div
      role="group"
      aria-label="What needs attention"
      className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-soft"
    >
      {shown.map((p) => (
        <button
          key={p.part}
          type="button"
          onClick={() => onShow(p.part)}
          className="inline-flex items-center gap-1.5 rounded-md outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", p.dot)} />
          {p.text}
        </button>
      ))}
    </div>
  )
}

function Column({
  status,
  label,
  count,
  active,
  collapsed,
  onToggle,
  sectionRef,
  more,
  children,
  ...drop
}: {
  status: TaskState
  label: string
  count: number
  active: boolean
  /** Only Done collapses: a narrow strip with its count that still takes a drop. */
  collapsed: boolean
  onToggle: (() => void) | undefined
  sectionRef: (element: HTMLElement | null) => void
  more: ReactNode
  children: ReactNode
  onDragOver: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}) {
  const heading = useId()
  const dot = (
    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[status])} />
  )
  return (
    <section
      ref={sectionRef}
      aria-labelledby={heading}
      tabIndex={-1}
      {...drop}
      className={cn(
        "min-w-0 snap-start rounded-xl border border-transparent p-1.5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
        collapsed && "border-border",
        active && "border-dashed border-strong bg-selected",
      )}
    >
      {onToggle ? (
        <h3 className="mb-2 text-[11px] text-soft max-[800px]:mb-0">
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggle}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-0.5 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
              collapsed &&
                "flex-col py-1 max-[800px]:flex-row max-[800px]:py-1.5 min-[801px]:gap-2",
            )}
          >
            {dot}
            <span
              id={heading}
              className={
                collapsed
                  ? "[writing-mode:vertical-rl] max-[800px]:[writing-mode:horizontal-tb]"
                  : ""
              }
            >
              {label}
            </span>
            <span className="text-muted-foreground tabular-nums">{count}</span>
            {collapsed ? (
              <ChevronRight
                size={13}
                strokeWidth={1.7}
                aria-hidden="true"
                className="text-muted-foreground max-[800px]:order-last max-[800px]:ml-auto"
              />
            ) : (
              <ChevronDown
                size={13}
                strokeWidth={1.7}
                aria-hidden="true"
                className="ml-auto text-muted-foreground"
              />
            )}
          </button>
        </h3>
      ) : (
        <h3 className="mb-2 flex items-center gap-1.5 px-0.5 text-[11px] text-soft">
          {dot}
          <span id={heading}>{label}</span>
          <span className="text-muted-foreground tabular-nums">{count}</span>
        </h3>
      )}
      {collapsed ? null : count === 0 ? (
        <Quiet className="px-0.5 py-1">{active ? "Drop it here." : "Nothing here."}</Quiet>
      ) : (
        <>
          <ul aria-label={label} className="grid gap-2">
            {children}
          </ul>
          {more}
        </>
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
  const late = isOverdue(task, today)
  const detail = lines(task, today, person)
  const who = assigneeLabel(task.assignee, me)

  // A card whose move is not confirmed shows the old status: the form would save it and undo the move.
  const open = () => {
    if (!pending) onOpen()
  }
  function key(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    open()
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
        aria-disabled={pending || undefined}
        data-overdue={late || undefined}
        onClick={open}
        onKeyDown={key}
        className="grid min-w-0 gap-0.5 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {/* The menu button sits over the title's first line. With a mouse a float beside it makes that
            line stop short, and the rest use the full width. On touch the button is bigger and always
            there, so every line leaves it room. */}
        <span className="text-xs leading-snug [overflow-wrap:anywhere] pointer-coarse:pr-8">
          <span
            aria-hidden="true"
            data-menu-gap
            className="float-right h-4 w-[22px] pointer-coarse:hidden"
          />
          {task.title}
        </span>
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
          className={cn(
            "absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-md bg-raised text-muted-foreground outline-none hover:bg-selected hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-popup-open:bg-selected max-[800px]:size-9 pointer-coarse:size-9",
            // With a mouse it shows on hover and keyboard focus; touch has no hover, so it stays.
            "pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 pointer-fine:data-popup-open:opacity-100",
          )}
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
    <DialogContent placement="center" className="p-5">
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

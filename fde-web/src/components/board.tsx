import { useEffect, useId, useRef, useState } from "react"
import type { DragEvent, KeyboardEvent, ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, Quiet } from "./page"
import { Button } from "./ui/button"
import { FormDialog } from "./form-dialog"
import { RefusalNote } from "./refusal-note"
import { StaleNotice, useVersionedForm } from "./versioned-form"
import { Dialog } from "./ui/dialog"
import { BlockedBy, FIELD, Labelled, MoveAsk, WaitingOn, useTaskMover } from "./task-move"
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
import type {
  AccessRequestOut,
  CriterionOut,
  Project,
  ProjectScope,
  StakeholderOut,
  TaskOut,
  TaskState,
} from "@/lib/api/schemas"
import {
  COLUMNS,
  DONE_SHOWN,
  STATUS_LABEL,
  TASK_LABELS,
  fieldsOf,
  inColumn,
  isOverdue,
  placeAt,
  problem,
  recentDone,
  stays,
  summarise,
} from "@/lib/board"
import type { Fields, Place } from "@/lib/board"
import { clip } from "@/lib/access"
import { commitRemoved, reason, refusalNote } from "@/lib/task-move"
import { dayOf, daysBetween, dueLabel, localDay, waitingLabel } from "@/lib/time"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

const DOT: Record<TaskState, string> = {
  todo: "bg-strong",
  in_progress: "bg-strong",
  waiting_on_customer: "bg-strong",
  blocked: "bg-attention",
  done: "bg-success",
}

type Dialogs = { kind: "new"; status: TaskState } | { kind: "edit"; task: TaskOut }

/** Where a dragged card would land: a column, and for one that keeps an order, the index among its other cards. */
type Over = { status: TaskState; index: number | null }

/**
 * The project's tasks as a board (DESIGN.md §3): one column per status, each in the project's order.
 * A card moves by drag, to another column or to another place in its own, or by its menu (Move up,
 * Move down, Move to), which also works by keyboard and is the way on a phone. Moving into Blocked
 * asks what blocks it and into Waiting on the customer asks who it waits on. Nothing moves until the
 * API confirms it.
 */
export function Board({ scope, project }: { scope: ProjectScope; project: Project }) {
  const queryClient = useQueryClient()
  const me = useQuery(queries.me())
  const mover = useTaskMover()
  const { saving } = mover
  const [dialog, setDialog] = useState<Dialogs | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  // A card moved from its menu gets the focus back once it has landed, so the next Move up is one key away.
  const [refocus, setRefocus] = useState<string | null>(null)
  // Done is the longest and least urgent column, so it starts collapsed (DESIGN.md §3).
  const [doneOpen, setDoneOpen] = useState(false)
  const [doneAll, setDoneAll] = useState(false)
  const columns = useRef(new Map<TaskState, HTMLElement>())

  const remove = useMutation({
    mutationFn: (task: TaskOut) => api.removeTask(scope, task.id),
    onSuccess: (_, task) => commitRemoved(queryClient, scope, task),
  })

  const people = new Map(project.stakeholders.map((s) => [s.id as string, s.name]))
  const criteria = new Map(project.scope.criteria.map((c) => [c.id as string, c.description]))
  const today = localDay()
  const refused = mover.refusal

  const requestMove = (task: TaskOut, to: TaskState, place?: Place) =>
    mover.request(scope, task, to, place)

  useEffect(() => {
    if (!refocus || saving[refocus]) return
    const trigger = [...document.querySelectorAll<HTMLElement>("[data-actions]")].find(
      (el) => el.dataset.actions === refocus,
    )
    trigger?.focus()
    setRefocus(null)
  }, [refocus, saving, project.tasks])

  /** Moves a card one place up or down its column, from its menu. */
  async function step(task: TaskOut, by: -1 | 1) {
    const column = inColumn(project.tasks, task.status)
    const neighbour = column[column.findIndex((t) => t.id === task.id) + by]
    if (!neighbour) return
    const place: Place = { side: by < 0 ? "before" : "after", anchor: neighbour }
    if (await requestMove(task, task.status, place)) setRefocus(task.id)
  }

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

  /** Where a drop in column `to` would put `task`: none in Done, which lists the latest first. */
  function landing(task: TaskOut, to: TaskState, index: number | null) {
    if (to === "done") return undefined
    const others = inColumn(project.tasks, to).filter((t) => t.id !== task.id)
    return placeAt(others, index ?? others.length)
  }

  /** Whether dropping `task` in `to` at `index` would leave it where it is. */
  function still(task: TaskOut, to: TaskState, index: number | null) {
    if (task.status !== to) return false
    return to === "done" || stays(inColumn(project.tasks, to), task, landing(task, to, index))
  }

  /** The line a drop would land on: above the card it goes before, or below the one it goes after. */
  function dropMark(card: TaskOut) {
    const task = project.tasks.find((t) => t.id === dragging)
    if (!task || over?.status !== card.status || still(task, over.status, over.index)) return
    const place = landing(task, over.status, over.index)
    return place?.anchor.id === card.id ? place.side : undefined
  }

  function onDrop(event: DragEvent, to: TaskState) {
    event.preventDefault()
    const task = project.tasks.find((t) => t.id === dragging)
    const index = over?.status === to ? over.index : null
    setDragging(null)
    setOver(null)
    if (!task || still(task, to, index)) return
    void requestMove(task, to, landing(task, to, index))
  }

  /** A card under the pointer: the drop goes above it, or below it past its middle. */
  function onCardOver(event: DragEvent, status: TaskState, target: TaskOut) {
    const task = project.tasks.find((t) => t.id === dragging)
    // Done keeps no order of its own: its column takes the drop.
    if (!task || status === "done") return
    event.preventDefault()
    event.stopPropagation()
    const column = inColumn(project.tasks, status)
    const others = column.filter((t) => t.id !== task.id)
    const box = event.currentTarget.getBoundingClientRect()
    const below = event.clientY > box.top + box.height / 2
    const index =
      target.id === task.id
        ? column.findIndex((t) => t.id === task.id)
        : others.findIndex((t) => t.id === target.id) + (below ? 1 : 0)
    setOver({ status, index })
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
  const dragged = tasks.find((t) => t.id === dragging)
  const summary = summarise(tasks, today)
  const finished = recentDone(tasks)
  return (
    <Card
      title="Board"
      // Empty, it sits in the page column with the other cards; it widens once it has columns to show.
      className={cn(
        "mx-auto w-full",
        tasks.length === 0 ? "max-w-[min(1040px,100%)]" : "max-w-[1600px]",
      )}
      aside={
        <Button variant="outline" onClick={() => setDialog({ kind: "new", status: "todo" })}>
          New task
        </Button>
      }
    >
      <p role="status" className="sr-only">
        {mover.announcement}
      </p>
      {refused && (
        <RefusalNote
          note={refusalNote(refused, true, mover.again)}
          onDismiss={mover.dismiss}
          className="mb-3 text-xs"
        />
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
                    // A card from another column; within its own, the line between cards says where.
                    active={over?.status === status && dragged?.status !== status}
                    onDragOver={(event) => {
                      const task = tasks.find((t) => t.id === dragging)
                      // Done takes a card from another column; any other column also reorders its own.
                      if (!task || (isDone && task.status === status)) return
                      event.preventDefault()
                      // Below the cards: the end of the column.
                      setOver({ status, index: null })
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                        setOver((now) => (now?.status === status ? null : now))
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
                    {column.map((task, i) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        to={saving[task.id]}
                        me={me.data?.user.id}
                        today={today}
                        person={(id) => people.get(id) ?? "a stakeholder no longer listed"}
                        criterion={task.criterion ? criteria.get(task.criterion) : undefined}
                        drop={dropMark(task)}
                        onOpen={() => setDialog({ kind: "edit", task })}
                        onMove={(to) => void requestMove(task, to)}
                        onStep={
                          isDone
                            ? undefined
                            : {
                                up: i > 0 ? () => void step(task, -1) : undefined,
                                down: i < column.length - 1 ? () => void step(task, 1) : undefined,
                              }
                        }
                        onDragOver={(event) => onCardOver(event, status, task)}
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
            requests={project.access}
            criteria={project.scope.criteria}
            me={me.data?.user.id}
            send={(base, fields) => mover.send(scope, base, fields)}
            adopt={(current) => mover.adopt(scope, current)}
            onDelete={dialog.kind === "edit" ? () => discard(dialog.task) : undefined}
            onClose={() => setDialog(null)}
          />
        )}
      </Dialog>
      <MoveAsk mover={mover} people={project.stakeholders} requests={project.access} />
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
              <Icon
                name="chevron-right"
                size={13}
                strokeWidth={1.7}
                aria-hidden="true"
                className="text-muted-foreground max-[800px]:order-last max-[800px]:ml-auto"
              />
            ) : (
              <Icon
                name="chevron-down"
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
  criterion,
  drop,
  onOpen,
  onMove,
  onStep,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  task: TaskOut
  /** Where it is on its way to, while the API has not answered. */
  to: TaskState | undefined
  me: string | undefined
  today: string
  person: (id: string) => string
  /** What the success criterion it works towards says. */
  criterion: string | undefined
  /** Where a dragged card would land beside this one. */
  drop: "before" | "after" | undefined
  onOpen: () => void
  onMove: (to: TaskState) => void
  /** Moves it one place within its column; absent where it cannot go, and in Done. */
  onStep: { up: (() => void) | undefined; down: (() => void) | undefined } | undefined
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
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
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      aria-busy={pending}
      className={cn(
        "group relative min-w-0 rounded-lg border bg-raised px-2.5 py-2 hover:border-strong",
        !pending && "cursor-grab active:cursor-grabbing",
        pending && "opacity-60",
      )}
    >
      {drop && (
        // In the 8px gap between two cards, so the line never covers either.
        <span
          aria-hidden="true"
          data-drop={drop}
          className={cn(
            "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-tint",
            drop === "before" ? "-top-[5px]" : "-bottom-[5px]",
          )}
        />
      )}
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
        {criterion && (
          <span className="truncate text-[11px] text-muted-foreground" title={criterion}>
            Towards: {criterion}
          </span>
        )}
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
          <span className="text-[11px] text-muted-foreground">
            {to === task.status ? "Moving…" : `Moving to ${STATUS_LABEL[to]}…`}
          </span>
        )}
      </div>
      <Menu>
        <MenuTrigger
          aria-label={`Actions for ${task.title}`}
          data-actions={task.id}
          disabled={pending}
          className={cn(
            "absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-md bg-raised text-muted-foreground outline-none hover:bg-selected hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-popup-open:bg-selected max-[800px]:size-9 pointer-coarse:size-9",
            // With a mouse it shows on hover and keyboard focus; touch has no hover, so it stays.
            "pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 pointer-fine:data-popup-open:opacity-100",
          )}
        >
          <Icon name="more" size={15} strokeWidth={1.7} aria-hidden="true" />
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
          {(onStep?.up || onStep?.down) && (
            <>
              <MenuSeparator />
              {onStep.up && <MenuItem onClick={onStep.up}>Move up</MenuItem>}
              {onStep.down && <MenuItem onClick={onStep.down}>Move down</MenuItem>}
            </>
          )}
          <MenuSeparator />
          <MenuItem onClick={onOpen}>Edit</MenuItem>
        </MenuContent>
      </Menu>
    </li>
  )
}

/**
 * Creates a task, or edits one; an edit can also delete it, after asking. `title` starts a new task's
 * title (a line of a meeting note).
 */
export function TaskDialog({
  task,
  status,
  title,
  people,
  requests,
  criteria,
  me,
  send,
  adopt,
  onDelete,
  onClose,
}: {
  task: TaskOut | null
  status: TaskState
  title?: string
  people: Array<StakeholderOut>
  requests: ReadonlyArray<AccessRequestOut>
  /** The project's success criteria, one of which the task may work towards. */
  criteria: ReadonlyArray<CriterionOut>
  me: string | undefined
  /** Saves over the copy the form opened on (null for a new task): throws what the API refused with. */
  send: (base: TaskOut | null, fields: Fields) => Promise<unknown>
  /** Puts the task a stale save was answered with where the page shows it. */
  adopt: (current: TaskOut) => Promise<void>
  onDelete: (() => Promise<string | null>) | undefined
  onClose: () => void
}) {
  // The form is based on the task as it was when it opened, and says so if it has moved on.
  const form = useVersionedForm({
    record: task ?? undefined,
    snapshot: fieldsOf,
    initial: task
      ? fieldsOf(task)
      : {
          title: title ?? "",
          status,
          blocker: "",
          waitingOn: null,
          due: "",
          assignee: null,
          blockedBy: null,
          criterion: null,
        },
    labels: TASK_LABELS,
    send: (base, fields) => send(base ?? null, fields),
    adopt,
    what: "task",
  })
  const { fields, set } = form

  // A teammate has no name here yet, only an id, so they are kept as "a teammate".
  const teammate = fields.assignee !== null && fields.assignee !== me

  return (
    <FormDialog
      title={task ? "Edit task" : "New task"}
      description={task ? "Change this task, or delete it." : "Add a task to the board."}
      save={form.save(task ? "Save" : "Add task")}
      validate={() => problem(fields)}
      onSubmit={form.submit}
      notice={<StaleNotice stale={form.stale} noun="task" />}
      remove={
        onDelete && {
          label: "Delete task",
          ask: "Delete this task? This cannot be undone.",
          group: "Confirm the delete",
          confirm: "Delete",
          run: onDelete,
        }
      }
      onClose={onClose}
    >
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
      {fields.status === "blocked" && (
        <BlockedBy
          value={fields.blockedBy}
          requests={requests}
          onChange={(blockedBy) => set({ blockedBy })}
        />
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
      <Criterion
        value={fields.criterion}
        criteria={criteria}
        onChange={(criterion) => set({ criterion })}
      />
    </FormDialog>
  )
}

/**
 * The success criterion a task works towards, from the project's. Nothing shows while the project has
 * none and the task names none: there is nothing to choose.
 */
function Criterion({
  value,
  criteria,
  onChange,
}: {
  value: string | null
  criteria: ReadonlyArray<CriterionOut>
  onChange: (id: string | null) => void
}) {
  if (criteria.length === 0 && value === null) return null
  const listed = value === null || criteria.some((c) => c.id === value)
  return (
    <Labelled label="Works towards">
      <select
        className={FIELD}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">No success criterion</option>
        {!listed && <option value={value}>A criterion no longer listed</option>}
        {criteria.map((c) => (
          <option key={c.id} value={c.id}>
            {clip(c.description, 60)}
          </option>
        ))}
      </select>
    </Labelled>
  )
}

import type { CSSProperties } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { UseQueryResult } from "@tanstack/react-query"
import { useNames } from "@/components/people"
import { Icon } from "@/components/ui/icon"
import type { IconName } from "@/components/ui/icon"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { ChecklistOpenError, api, queries } from "@/lib/api/client"
import { STAGES } from "@/lib/api/schemas"
import type {
  Project,
  ProjectOut,
  ProjectScope,
  StageChecklist,
  TaskOut,
  UserId,
} from "@/lib/api/schemas"
import { LONG_WAIT_DAYS, glance, isOpen } from "@/lib/access"
import { hintFor } from "@/lib/checklist"
import type { Fix } from "@/lib/checklist"
import { proofs, STATUS, targetText, valueText } from "@/lib/proof"
import { PART_LABEL } from "@/lib/records"
import { GAP_TEXT, attention, comingUp, dueShort, gapStage, setUpNext, trackOf } from "@/lib/round2"
import type { Attention, Gap } from "@/lib/round2"
import { STAGE_LABEL } from "@/lib/stage"
import { reason as said } from "@/lib/task-move"
import { cn } from "@/lib/utils"
import { Block, Initials, Num, R2Button, Skeleton, StatusMark, r2Button, useInitialsOf } from "./ui"
import { TrackBar, WaitBar } from "./visuals"

/** What the overview asks the page to do: put something right on another tab, or open a task. */
export type Act = Fix | "criteria" | { open: TaskOut }

/**
 * Overview: the answer to "what do I do now". The stage's checklist, what needs attention and what to set up
 * next in the main column; proof, access and people at a glance in the rail. A section with nothing in it
 * is not drawn: what is missing is offered once, in Set up next.
 */
export function Overview({
  scope,
  project: p,
  checklist,
  act,
  today,
}: {
  scope: ProjectScope
  project: Project
  checklist: UseQueryResult<StageChecklist, unknown>
  act: (what: Act) => void
  today: string
}) {
  const notes = useQuery(queries.notes(scope))
  const suites = useQuery(queries.evalSuites(scope))
  const assignees = useQuery(queries.assignees(scope))
  const current = checklist.data?.stage === p.stage ? checklist.data : undefined
  const open = new Set(current?.items.filter((i) => !i.met).map((i) => i.key) ?? [])
  const criteria = p.scope.criteria
  const gaps = setUpNext(
    {
      stakeholders: p.stakeholders.length,
      inScope: p.scope.items.filter((i) => i.kind === "in").length,
      criteria: criteria.length,
      withoutBaseline: criteria.filter((c) => c.baseline == null).length,
      access: p.access.length,
      notes: notes.data ? notes.data.length : null,
      // Unread, or not served here (a 404): nothing is said about suites.
      suites: suites.data ? suites.data.length : null,
      assignees: assignees.data ? assignees.data.length : null,
    },
    p.stage,
    open,
  )
  const needs = attention(p.tasks, today)
  const next = comingUp(
    p.tasks,
    new Set([...(p.next_step ? [p.next_step.task as string] : []), ...needs.map((n) => n.task.id)]),
  )
  const people = (assignees.data?.length ?? 0) + p.stakeholders.length

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-(--r2-gap) max-[1024px]:grid-cols-1">
      <div className="grid min-w-0 gap-(--r2-gap)">
        <ChecklistBlock scope={scope} project={p} checklist={checklist} act={act} />
        {needs.length > 0 && <NeedsBlock scope={scope} needs={needs} act={act} />}
        {next.length > 0 && <ComingUpBlock scope={scope} tasks={next} act={act} today={today} />}
        {gaps.length > 0 && <SetUpBlock scope={scope} gaps={gaps} act={act} project={p} />}
      </div>
      <aside aria-label="At a glance" className="grid min-w-0 gap-(--r2-gap)">
        {criteria.length > 0 && <ProofGlance scope={scope} project={p} />}
        {p.access.length > 0 && <AccessGlance project={p} />}
        {people > 0 && <PeopleGlance scope={scope} project={p} />}
      </aside>
    </div>
  )
}

const ROW = "flex min-h-(--r2-row) items-center gap-3 border-t px-(--r2-pad)"

// ── The stage's checklist ──────────────────────────────────────────────────

function ChecklistBlock({
  scope,
  project: p,
  checklist,
  act,
}: {
  scope: ProjectScope
  project: Project
  checklist: UseQueryResult<StageChecklist, unknown>
  act: (what: Act) => void
}) {
  const client = useQueryClient()
  const next = STAGES[STAGES.indexOf(p.stage) + 1]
  const move = useMutation({
    mutationFn: () => api.moveStage(scope, next!),
    onSuccess: async (moved: ProjectOut) => {
      await client.cancelQueries({ queryKey: queries.project(scope).queryKey })
      client.setQueryData(
        queries.project(scope).queryKey,
        (old) => old && { ...old, stage: moved.stage, updated_at: moved.updated_at },
      )
      void client.invalidateQueries({ queryKey: ["companies"], exact: false })
    },
    onError: (error) => {
      if (error instanceof ChecklistOpenError)
        void client.invalidateQueries({ queryKey: queries.stageChecklist(scope).queryKey })
    },
  })
  const title = `To leave ${STAGE_LABEL[p.stage]}`
  const current = checklist.data?.stage === p.stage ? checklist.data : undefined
  if (checklist.isError)
    return (
      <Block title={title}>
        <p
          role="alert"
          className="flex items-center justify-between gap-3 text-r2-meta text-muted-foreground"
        >
          We couldn't read what this stage needs.
          <R2Button level="quiet" size="sm" onClick={() => void checklist.refetch()}>
            Try again
          </R2Button>
        </p>
      </Block>
    )
  if (!current)
    return (
      <Block title={title} flush>
        <Skeleton rows={2} label="Reading what this stage needs…" />
      </Block>
    )
  if (current.items.length === 0) return null
  const met = current.items.filter((i) => i.met).length
  const all = met === current.items.length
  return (
    <Block
      title={title}
      flush
      aside={
        <span className="flex items-center gap-3">
          <Meter met={met} total={current.items.length} />
          {all && next && (
            <R2Button size="sm" disabled={move.isPending} onClick={() => move.mutate()}>
              {move.isPending ? "Moving…" : `Move to ${STAGE_LABEL[next]}`}
            </R2Button>
          )}
        </span>
      }
    >
      <ul>
        {current.items.map((item) => {
          const fix = item.met ? undefined : hintFor(item.key, p)?.fix
          return (
            <li key={item.key} className={ROW}>
              <Icon
                name={item.met ? "check-circle" : "minus-circle"}
                size={18}
                strokeWidth={1.8}
                className={item.met ? "text-success" : "text-muted-foreground"}
              />
              <span
                className={cn("min-w-0 flex-1 text-r2-body", item.met && "text-muted-foreground")}
              >
                <span className="sr-only">{item.met ? "Met: " : "Open: "}</span>
                {item.label}
              </span>
              {fix &&
                (fix.do === "add-stakeholder" ? (
                  <Link
                    to="/companies/$companyId"
                    params={{ companyId: p.company.id }}
                    search={{ add: "stakeholder" }}
                    className={r2Button({ level: "quiet", size: "sm" })}
                  >
                    {fix.label}
                  </Link>
                ) : (
                  <R2Button level="quiet" size="sm" onClick={() => act(fix.do)}>
                    {fix.label}
                  </R2Button>
                ))}
            </li>
          )
        })}
      </ul>
      {move.isError && (
        <p role="alert" className="border-t px-(--r2-pad) py-3 text-r2-meta text-attention">
          {move.error instanceof ChecklistOpenError
            ? "Something on the checklist is open again. It has been read again."
            : said(move.error, "project")}
        </p>
      )}
    </Block>
  )
}

/** "2 of 3" with a segment per item. */
function Meter({ met, total }: { met: number; total: number }) {
  return (
    <span className="flex items-center gap-2 text-r2-meta whitespace-nowrap text-muted-foreground">
      <span aria-hidden="true" className="flex gap-0.5">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn("h-1.5 w-3 rounded-full", i < met ? "bg-success" : "bg-selected")}
          />
        ))}
      </span>
      <span className="tabular-nums">
        {met} of {total} met
      </span>
    </span>
  )
}

// ── What needs attention ───────────────────────────────────────────────────

const NEED: Record<Attention["kind"], { icon: IconName; text: (days: number) => string }> = {
  blocked: { icon: "alert", text: () => "Blocked" },
  overdue: { icon: "clock", text: (d) => `Overdue ${d} ${d === 1 ? "day" : "days"}` },
  waiting: {
    icon: "clock",
    text: (d) => (d <= 0 ? "Waiting today" : `Waiting ${d} ${d === 1 ? "day" : "days"}`),
  },
}

const NEEDS_COLS =
  "grid grid-cols-[minmax(0,1fr)_168px_148px] items-center gap-4 max-[640px]:grid-cols-[minmax(0,1fr)_auto]"

function NeedsBlock({
  scope,
  needs,
  act,
}: {
  scope: ProjectScope
  needs: Array<Attention>
  act: (what: Act) => void
}) {
  const names = useNames(scope)
  const initialsOf = useInitialsOf()
  return (
    <Block
      title="Needs attention"
      flush
      aside={<Num className="text-r2-meta text-muted-foreground">{needs.length}</Num>}
    >
      <div
        className={cn(
          "r2-colhead border-t px-(--r2-pad) py-2 text-r2-meta text-muted-foreground max-[640px]:hidden",
          NEEDS_COLS,
        )}
      >
        <span>Task</span>
        <span className="max-[640px]:hidden">Owner</span>
        <span className="text-right">Status</span>
      </div>
      <ul>
        {needs.map(({ task, kind, days }) => {
          const person = task.assignee ? names.of(task.assignee) : null
          const owner = person?.label ?? "Unassigned"
          return (
            <li key={task.id} className="border-t">
              <button
                type="button"
                onClick={() => act({ open: task })}
                className={cn(
                  "min-h-(--r2-row) w-full px-(--r2-pad) py-2 text-left transition-colors hover:bg-selected/60 focus-visible:-outline-offset-2",
                  NEEDS_COLS,
                )}
              >
                <span className="truncate text-r2-body">{task.title}</span>
                <span className="flex min-w-0 items-center gap-2 text-r2-meta text-soft max-[640px]:hidden">
                  <Initials
                    name={person ? initialsOf(person) : ""}
                    className="size-6 text-[10px]"
                  />
                  <span className="truncate">{owner}</span>
                </span>
                <StatusMark
                  tone={kind === "waiting" ? "neutral" : "attention"}
                  icon={NEED[kind].icon}
                  className="justify-self-end tabular-nums"
                >
                  {NEED[kind].text(days)}
                </StatusMark>
              </button>
            </li>
          )
        })}
      </ul>
    </Block>
  )
}

// ── Coming up ──────────────────────────────────────────────────────────────

const NEXT_COLS =
  "grid grid-cols-(--cols) items-center gap-4 max-[640px]:grid-cols-[minmax(0,1fr)_auto]"

function ComingUpBlock({
  scope,
  tasks,
  act,
  today,
}: {
  scope: ProjectScope
  tasks: Array<TaskOut>
  act: (what: Act) => void
  today: string
}) {
  const names = useNames(scope)
  const initialsOf = useInitialsOf()
  // A column that would say the same empty thing on every row is left out.
  const owners = tasks.some((t) => t.assignee)
  const dues = tasks.some((t) => t.due_on)
  const cols = {
    "--cols": ["minmax(0,1fr)", owners && "168px", "96px", dues && "120px"]
      .filter(Boolean)
      .join(" "),
  } as CSSProperties
  return (
    <Block title="Coming up" flush>
      <div
        style={cols}
        className={cn(
          "r2-colhead border-t px-(--r2-pad) py-2 text-r2-meta text-muted-foreground max-[640px]:hidden",
          NEXT_COLS,
        )}
      >
        <span>Task</span>
        {owners && <span className="max-[640px]:hidden">Owner</span>}
        <span className="max-[640px]:hidden">Stage</span>
        {dues && <span className="text-right">Due</span>}
      </div>
      <ul>
        {tasks.map((task) => {
          const person = task.assignee ? names.of(task.assignee) : null
          return (
            <li key={task.id} className="border-t">
              <button
                type="button"
                style={cols}
                onClick={() => act({ open: task })}
                className={cn(
                  "min-h-(--r2-row) w-full px-(--r2-pad) py-2 text-left transition-colors hover:bg-selected/60 focus-visible:-outline-offset-2",
                  NEXT_COLS,
                )}
              >
                <span className="truncate text-r2-body">{task.title}</span>
                {owners && (
                  <span className="flex min-w-0 items-center gap-2 text-r2-meta text-soft max-[640px]:hidden">
                    <Initials
                      name={person ? initialsOf(person) : ""}
                      className="size-6 text-[10px]"
                    />
                    <span className="truncate">{person?.label ?? "Unassigned"}</span>
                  </span>
                )}
                <span className="text-r2-meta text-muted-foreground max-[640px]:hidden">
                  {task.stage ? STAGE_LABEL[task.stage] : ""}
                </span>
                {dues && (
                  <Num className="text-r2-meta text-muted-foreground">
                    {task.due_on ? dueShort(task.due_on, today) : ""}
                  </Num>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </Block>
  )
}

// ── Set up next ────────────────────────────────────────────────────────────

const GAP_ICON: Record<Gap, IconName> = {
  "name-people": "user-plus",
  assign: "person",
  "write-note": "note",
  "add-scope": "clipboard",
  "add-criterion": "trend",
  "add-baseline": "trend",
  "request-access": "key",
  "add-suite": "trend",
}

const GAP_ACT: Record<Exclude<Gap, "name-people" | "assign">, Act> = {
  "write-note": "write-note",
  "add-scope": "add-in-scope",
  "add-criterion": "add-criterion",
  "add-baseline": "criteria",
  "request-access": "request-access",
  "add-suite": "proof",
}

function SetUpBlock({
  scope,
  project: p,
  gaps,
  act,
}: {
  scope: ProjectScope
  project: Project
  gaps: Array<Gap>
  act: (what: Act) => void
}) {
  return (
    <Block title="Set up next" flush>
      <ul>
        {gaps.map((gap) => (
          <li key={gap} className={ROW}>
            <span className="grid size-8 flex-none place-items-center rounded-r2-control border bg-raised text-soft max-[640px]:hidden">
              <Icon name={GAP_ICON[gap]} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-r2-body max-[640px]:whitespace-normal">
              {GAP_TEXT[gap].title}
            </span>
            <span className="text-r2-meta text-muted-foreground max-[640px]:hidden">
              {STAGE_LABEL[gapStage(gap)]}
            </span>
            {gap === "name-people" ? (
              <Link
                to="/companies/$companyId"
                params={{ companyId: p.company.id }}
                search={{ add: "stakeholder" }}
                className={r2Button({ level: "secondary", size: "sm" })}
              >
                {GAP_TEXT[gap].action}
              </Link>
            ) : gap === "assign" ? (
              <AssignMenu scope={scope} />
            ) : (
              <R2Button size="sm" onClick={() => act(GAP_ACT[gap])}>
                {GAP_TEXT[gap].action}
              </R2Button>
            )}
          </li>
        ))}
      </ul>
    </Block>
  )
}

/** Assign someone from the company's team: the styled menu, not a native select. */
function AssignMenu({ scope }: { scope: ProjectScope }) {
  const client = useQueryClient()
  const members = useQuery(queries.members(scope.company))
  const assignees = useQuery(queries.assignees(scope))
  const names = useNames(scope)
  const taken = new Set<string>(assignees.data?.map((a) => a.user) ?? [])
  const free = members.data?.filter((m) => !taken.has(m.user)) ?? []
  const assign = useMutation({
    mutationFn: (user: UserId) => api.assign(scope, user),
    onSuccess: () => void client.invalidateQueries({ queryKey: queries.assignees(scope).queryKey }),
  })
  return (
    <Menu>
      <MenuTrigger
        className={r2Button({ level: "secondary", size: "sm" })}
        disabled={assign.isPending}
      >
        {assign.isPending ? "Assigning…" : "Assign"}
        <Icon name="chevron-down" size={14} />
      </MenuTrigger>
      <MenuContent label="Assign an engineer">
        {members.isPending ? (
          <MenuItem disabled>Reading the team…</MenuItem>
        ) : free.length === 0 ? (
          <MenuItem disabled>Everyone on the team is assigned</MenuItem>
        ) : (
          free.map((m) => (
            <MenuItem key={m.user} onClick={() => assign.mutate(m.user)}>
              <Initials name={names.of(m.user).label} className="size-6 text-[10px]" />
              {names.of(m.user).label}
            </MenuItem>
          ))
        )}
      </MenuContent>
    </Menu>
  )
}

// ── The rail ───────────────────────────────────────────────────────────────

function ProofGlance({ scope, project: p }: { scope: ProjectScope; project: Project }) {
  const suites = useQuery(queries.evalSuites(scope))
  const runs = useQuery(queries.evalRuns(scope))
  const room = useQuery(queries.room(scope))
  const rows = proofs(p.scope.criteria, room.data?.criteria, suites.data ?? [], runs.data ?? [])
  const met = rows.filter((r) => r.status === "met").length
  return (
    <Block
      title="Proof"
      flush
      aside={
        room.data && (
          <span className="text-r2-meta text-muted-foreground tabular-nums">
            {met} of {rows.length} met
          </span>
        )
      }
    >
      <ul>
        {rows.map((r) => {
          const tone = STATUS[r.status].tone
          return (
            <li key={r.criterion.id} className="grid gap-1.5 border-t px-(--r2-pad) py-3">
              <p className="flex items-baseline justify-between gap-3 text-r2-meta">
                <span className="min-w-0 truncate">{r.criterion.description}</span>
                <Num className={cn("font-semibold", r.value === null && "text-muted-foreground")}>
                  {r.value === null ? "None" : valueText(r.value)}
                </Num>
              </p>
              <TrackBar track={trackOf(r.criterion, r.value)} tone={tone} thin />
              <span className="sr-only">
                {STATUS[r.status].label}.{" "}
                {r.criterion.baseline != null && `Baseline ${valueText(r.criterion.baseline)}. `}
                {r.value !== null && `Now ${valueText(r.value)}. `}
                Target {targetText(r.criterion)}.
              </span>
            </li>
          )
        })}
      </ul>
    </Block>
  )
}

function AccessGlance({ project: p }: { project: Project }) {
  const who = (id: string) => p.stakeholders.find((s) => s.id === id)?.name ?? "No one named"
  const g = glance(p.access, who)
  const stuck = p.access
    .filter((a) => a.status !== "granted")
    .sort((a, b) => b.days_waiting - a.days_waiting)
  const scale = Math.max(g.longest ?? 0, LONG_WAIT_DAYS) * 1.15
  return (
    <Block
      title="Access"
      flush
      aside={
        <span className="text-r2-meta text-muted-foreground tabular-nums">
          {g.notGranted} of {g.total} waiting
        </span>
      }
    >
      {stuck.length === 0 ? (
        <p className={cn(ROW, "text-r2-meta")}>
          <StatusMark tone="success">All granted</StatusMark>
        </p>
      ) : (
        <ul>
          {stuck.map((a) => (
            <li key={a.id} className="grid gap-1.5 border-t px-(--r2-pad) py-3">
              <p className="flex items-baseline justify-between gap-3 text-r2-meta">
                <span className="min-w-0 truncate">{a.description}</span>
                {isOpen(a.status) ? (
                  <Num
                    className={cn(
                      "font-semibold",
                      a.days_waiting >= LONG_WAIT_DAYS && "text-attention",
                    )}
                  >
                    {a.days_waiting} {a.days_waiting === 1 ? "day" : "days"}
                  </Num>
                ) : (
                  <StatusMark tone="attention">
                    {a.status === "denied" ? "Denied" : "Revoked"}
                  </StatusMark>
                )}
              </p>
              {isOpen(a.status) && (
                <WaitBar days={a.days_waiting} scale={scale} long={LONG_WAIT_DAYS} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Block>
  )
}

function PeopleGlance({ scope, project: p }: { scope: ProjectScope; project: Project }) {
  const assignees = useQuery(queries.assignees(scope))
  const names = useNames(scope)
  const initialsOf = useInitialsOf()
  const ours = assignees.data ?? []
  return (
    <Block title="People" flush>
      <ul>
        {ours.map((a) => {
          const person = names.of(a.user)
          return (
            <li key={a.user} className={ROW}>
              <Initials name={initialsOf(person)} />
              <span className="min-w-0 flex-1 truncate text-r2-meta">{person.label}</span>
              <span className="text-r2-meta text-muted-foreground">Engineer</span>
            </li>
          )
        })}
        {p.stakeholders.map((s) => (
          <li key={s.id} className={ROW}>
            <Initials name={s.name} />
            <span className="min-w-0 flex-1 truncate text-r2-meta">{s.name}</span>
            <span className="text-r2-meta text-muted-foreground">
              {s.main_contact ? "Main contact" : PART_LABEL[s.role]}
            </span>
          </li>
        ))}
      </ul>
    </Block>
  )
}

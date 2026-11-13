import { useEffect, useRef, useState } from "react"
import { Tabs } from "@base-ui/react/tabs"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AccessCard } from "@/components/access-card"
import type { AccessCardHandle } from "@/components/access-card"
import { Board } from "@/components/board"
import type { BoardHandle } from "@/components/board"
import { ProjectDialog } from "@/components/company-forms"
import { DecisionsCard } from "@/components/decisions-card"
import { NotesCard } from "@/components/notes-card"
import type { NotesHandle } from "@/components/notes-card"
import { Failed, NotFound, isNotFound } from "@/components/page"
import { useNames } from "@/components/people"
import { RunsCard } from "@/components/runs"
import { CriteriaCard, ScopeCard } from "@/components/scope-cards"
import type { CriteriaCardHandle, ScopeCardHandle } from "@/components/scope-cards"
import { Dialog } from "@/components/ui/dialog"
import { Icon } from "@/components/ui/icon"
import type { IconName } from "@/components/ui/icon"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { queries } from "@/lib/api/client"
import type { Project, ProjectScope } from "@/lib/api/schemas"
import { TAB_LABEL, TABS } from "@/lib/round2"
import type { Look, Tab } from "@/lib/round2"
import { dueLabel, localDay } from "@/lib/time"
import { cn } from "@/lib/utils"
import { Dock } from "./dock"
import { Overview } from "./overview"
import type { Act } from "./overview"
import { ProofTab } from "./proof"
import { Stepper } from "./stepper"
import { Initials, R2Button, StatusMark, useInitialsOf } from "./ui"

const TAB_ICON: Record<Tab, IconName> = {
  overview: "dashboard",
  plan: "clipboard",
  proof: "trend",
  access: "key",
  notes: "note",
  agent: "bot",
}

/** The look on <html> while the prototype is open, so the shell around it takes the same tokens. */
function useLook(look: Look) {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.look = look
    return () => {
      delete root.dataset.look
    }
  }, [look])
}

/**
 * The round 2 project page (DESIGN.md "Round 2", issue #262): a header with the stage and the one next
 * step, then tabs. Dev mock only. Overview and Proof are new; the other tabs hold today's cards, so every
 * action on the project still works here.
 */
export function Round2Project({
  scope,
  tab,
  look,
  onTab,
  today = localDay(),
}: {
  scope: ProjectScope
  tab: Tab
  look: Look
  onTab: (tab: Tab) => void
  today?: string
}) {
  useLook(look)
  const project = useQuery(queries.project(scope))
  const checklist = useQuery(queries.stageChecklist(scope))
  const board = useRef<BoardHandle>(null)
  const scopeCard = useRef<ScopeCardHandle>(null)
  const criteriaCard = useRef<CriteriaCardHandle>(null)
  const accessCard = useRef<HTMLElement>(null)
  const accessHandle = useRef<AccessCardHandle>(null)
  const notesHandle = useRef<NotesHandle>(null)
  const me = useQuery(queries.me())
  const [editing, setEditing] = useState(false)
  // What to do once the tab it belongs to has rendered: open a form, or a task.
  const pending = useRef<(() => void) | null>(null)
  useEffect(() => {
    const then = pending.current
    pending.current = null
    then?.()
  }, [tab])

  function go(to: Tab, then?: () => void) {
    if (to === tab) then?.()
    else {
      pending.current = then ?? null
      onTab(to)
    }
  }

  function act(what: Act) {
    if (typeof what === "object") return go("plan", () => board.current?.open(what.open))
    switch (what) {
      case "add-in-scope":
        return go("plan", () => scopeCard.current?.add("in"))
      case "add-out-of-scope":
        return go("plan", () => scopeCard.current?.add("out"))
      case "sign-off":
        return go("plan", () => scopeCard.current?.signOff())
      case "add-criterion":
        return go("plan", () => criteriaCard.current?.add())
      case "criteria":
        return go("plan", () => criteriaCard.current?.show())
      case "proof":
        return go("proof")
      case "request-access":
        return go("access", () => accessHandle.current?.request())
      case "access":
        return go("access")
      case "write-note":
        return go("notes", () => notesHandle.current?.write())
      case "add-stakeholder":
        // A link to the company page in the overview; nothing to do here.
        return
    }
  }

  if (project.isPending) return <PageSkeleton />
  if (isNotFound(project.error)) return <NotFound what="project" />
  if (project.isError)
    return (
      <Frame>
        <Failed
          title="We couldn't load this project."
          error={project.error}
          onRetry={() => void project.refetch()}
        />
      </Frame>
    )

  const p = project.data
  return (
    <Frame>
      <header className="grid gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            <Link
              to="/companies/$companyId"
              params={{ companyId: p.company.id }}
              className="inline-flex w-fit items-center gap-1 rounded-sm text-r2-meta text-muted-foreground hover:text-foreground"
            >
              <Icon name="chevron-left" size={14} />
              {p.company.name}
            </Link>
            <h2 className="text-r2-page font-semibold text-balance">{p.name}</h2>
            {p.summary && <p className="text-r2-meta text-soft">{p.summary}</p>}
          </div>
          <div className="flex flex-none items-center gap-2">
            <Dock project={p.name} />
            <Menu>
              <MenuTrigger
                aria-label="More for this project"
                className="grid size-8 place-items-center rounded-r2-control border text-muted-foreground hover:border-strong hover:text-foreground"
              >
                <Icon name="more" size={16} />
              </MenuTrigger>
              <MenuContent label="More for this project">
                <MenuItem onClick={() => setEditing(true)}>
                  <Icon name="pencil" size={14} />
                  Edit project
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        <Stepper stage={p.stage} />
        <NextStepBar
          scope={scope}
          project={p}
          today={today}
          onOpen={() => {
            const task = p.tasks.find((t) => t.id === p.next_step?.task)
            if (task) act({ open: task })
          }}
          onAdd={() => go("plan", () => board.current?.add())}
        />
      </header>

      <Tabs.Root
        value={tab}
        onValueChange={(value) => onTab(value as Tab)}
        className="grid gap-(--r2-gap)"
      >
        <Tabs.List
          aria-label="Project"
          className="relative flex [scrollbar-width:none] gap-1 overflow-x-auto border-b max-[640px]:-mx-4 max-[640px]:px-4"
        >
          {TABS.map((t) => (
            <Tabs.Tab
              key={t}
              value={t}
              className="flex h-10 flex-none items-center gap-2 rounded-t-md px-3 text-r2-meta font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus) data-active:text-foreground"
            >
              <Icon name={TAB_ICON[t]} size={16} />
              {TAB_LABEL[t]}
              <TabCount tab={t} project={p} />
            </Tabs.Tab>
          ))}
          <Tabs.Indicator className="absolute bottom-0 left-(--active-tab-left) h-0.5 w-(--active-tab-width) rounded-full bg-brand transition-[left,width] duration-200 ease-(--ease-calm) motion-reduce:transition-none" />
        </Tabs.List>

        <Tabs.Panel value={tab} className="outline-none motion-safe:animate-rise">
          {tab === "overview" && (
            <Overview scope={scope} project={p} checklist={checklist} act={act} today={today} />
          )}
          {tab === "plan" && (
            <div className="grid gap-(--r2-gap)">
              <Board handle={board} scope={scope} project={p} />
              <div className="grid grid-cols-2 gap-(--r2-gap) max-[960px]:grid-cols-1">
                <ScopeCard handle={scopeCard} scope={scope} project={p} />
                <CriteriaCard
                  handle={criteriaCard}
                  scope={scope}
                  criteria={p.scope.criteria}
                  signedOff={p.scope.signed_off}
                />
              </div>
            </div>
          )}
          {tab === "proof" && (
            <ProofTab scope={scope} project={p} onAddCriterion={() => act("add-criterion")} />
          )}
          {tab === "access" && (
            <AccessCard card={accessCard} handle={accessHandle} scope={scope} project={p} />
          )}
          {tab === "notes" && (
            <div className="grid gap-(--r2-gap)">
              <NotesCard handle={notesHandle} place={scope} people={p.stakeholders} project={p} />
              <DecisionsCard scope={scope} project={p} me={me.data?.user.name} />
            </div>
          )}
          {tab === "agent" && <RunsCard scope={scope} />}
        </Tabs.Panel>
      </Tabs.Root>

      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && (
          <ProjectDialog company={p.company.id} project={p} onClose={() => setEditing(false)} />
        )}
      </Dialog>
    </Frame>
  )
}

/** One content width and one rhythm for every tab. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid w-[min(1120px,calc(100%-48px))] gap-8 py-8 text-r2-body max-[800px]:w-[calc(100%-32px)] max-[800px]:gap-6 max-[800px]:py-5">
      {children}
    </div>
  )
}

/** A count beside a tab where one says something: open tasks, criteria met, access waiting. */
function TabCount({ tab, project: p }: { tab: Tab; project: Project }) {
  const n =
    tab === "plan"
      ? p.tasks.filter((t) => t.status !== "done").length
      : tab === "access"
        ? p.access.filter((a) => a.status !== "granted").length
        : null
  if (!n) return null
  return (
    <span className="rounded-full bg-selected px-1.5 text-[11px] leading-[18px] text-soft tabular-nums">
      <span className="sr-only">(</span>
      {n}
      <span className="sr-only">{tab === "plan" ? " open)" : " waiting)"}</span>
    </span>
  )
}

/** The page's one primary action: the next step, with who has it and when, or adding one. */
function NextStepBar({
  scope,
  project: p,
  today,
  onOpen,
  onAdd,
}: {
  scope: ProjectScope
  project: Project
  today: string
  onOpen: () => void
  onAdd: () => void
}) {
  const names = useNames(scope)
  const next = p.next_step
  const late = !!next?.due_on && next.due_on < today
  const initialsOf = useInitialsOf()
  const person = next?.assignee ? names.of(next.assignee) : null
  const who = person?.label ?? "Unassigned"
  return (
    <section
      aria-label="Next step"
      className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-r2 border border-brand/25 bg-tint-soft px-(--r2-pad) py-3 max-[640px]:grid"
    >
      <span className="text-r2-meta font-semibold text-brand">Next step</span>
      {next ? (
        <>
          <span className="min-w-0 flex-1 basis-56 text-r2-body font-semibold [overflow-wrap:anywhere]">
            {next.title}
          </span>
          <span className="flex items-center gap-4 text-r2-meta text-soft">
            <span className="flex items-center gap-2">
              <Initials name={person ? initialsOf(person) : ""} className="size-6 text-[10px]" />
              {who}
            </span>
            {late ? (
              <StatusMark tone="attention" icon="clock">
                {dueLabel(next.due_on!, today)}
              </StatusMark>
            ) : (
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <Icon name="calendar-check" size={14} />
                {next.due_on ? dueLabel(next.due_on, today) : "No due date"}
              </span>
            )}
          </span>
          <R2Button level="primary" onClick={onOpen} className="max-[640px]:w-full">
            Open the task
            <Icon name="arrow-right" size={15} />
          </R2Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-r2-body font-semibold">No next step yet</span>
          <R2Button level="primary" onClick={onAdd} className="max-[640px]:w-full">
            Add a task
          </R2Button>
        </>
      )}
    </section>
  )
}

/** The page's shape while the project is read: header, stepper, tabs and two blocks. */
function PageSkeleton() {
  const bar = "rounded bg-selected motion-safe:animate-pulse"
  return (
    <Frame>
      <div role="status" className="grid gap-6">
        <span className="sr-only">Loading the project…</span>
        <div aria-hidden="true" className="grid gap-2">
          <span className={cn(bar, "h-3 w-28")} />
          <span className={cn(bar, "h-7 w-72")} />
        </div>
        <span aria-hidden="true" className={cn(bar, "h-9 w-full")} />
        <span aria-hidden="true" className={cn(bar, "h-14 w-full")} />
        <span aria-hidden="true" className={cn(bar, "h-10 w-full")} />
        <div
          aria-hidden="true"
          className="grid grid-cols-[minmax(0,1fr)_320px] gap-6 max-[1024px]:grid-cols-1"
        >
          <span className={cn(bar, "h-48")} />
          <span className={cn(bar, "h-48")} />
        </div>
      </div>
    </Frame>
  )
}

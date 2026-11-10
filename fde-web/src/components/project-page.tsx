import { useRef, useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronLeft } from "lucide-react"
import { Failed, Loading, NotFound, Page, Quiet, isNotFound } from "./page"
import { Board } from "./board"
import { ProjectDialog } from "./company-forms"
import { AccessCard } from "./access-card"
import type { AccessCardHandle } from "./access-card"
import { DecisionsCard } from "./decisions-card"
import { NotesCard } from "./notes-card"
import type { NotesHandle } from "./notes-card"
import { ScopeCard, CriteriaCard } from "./scope-cards"
import type { CriteriaCardHandle, ScopeCardHandle } from "./scope-cards"
import { AssigneesCard } from "./team"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { StageBar } from "./stage-bar"
import type { MoveRefusal } from "./stage-bar"
import { StageChecklist } from "./stage-checklist"
import { RunsCard } from "./runs"
import { ChecklistOpenError, api, queries } from "@/lib/api/client"
import type { ProjectOut, ProjectScope, Stage } from "@/lib/api/schemas"
import type { Fix } from "@/lib/checklist"
import { canManage } from "@/lib/records"
import { reason as said } from "@/lib/task-move"

/** The page column (1040px) the cards sit in; the board alone breaks out to the canvas. */
function Column({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid w-[min(1040px,100%)] gap-4 max-[800px]:gap-3.5">{children}</div>
  )
}

/**
 * A project (DESIGN.md §3): the stage bar, scope and success criteria, the access tracker, tasks
 * and decisions.
 */
export function ProjectPage({ scope }: { scope: ProjectScope }) {
  const queryClient = useQueryClient()
  const project = useQuery(queries.project(scope))
  const me = useQuery(queries.me())
  // The FDE's part at the company comes with their list of companies, already read for the sidebar.
  const companies = useQuery(queries.companies())
  const [editing, setEditing] = useState(false)
  const checklist = useQuery(queries.stageChecklist(scope))
  const scopeCard = useRef<ScopeCardHandle>(null)
  const criteriaCard = useRef<CriteriaCardHandle>(null)
  const accessCard = useRef<HTMLElement>(null)
  const accessHandle = useRef<AccessCardHandle>(null)
  const notesHandle = useRef<NotesHandle>(null)
  const move = useMutation({
    mutationFn: ({ to, reason }: { to: Stage; reason?: string }) =>
      api.moveStage(scope, to, reason),
    onSuccess: async (moved: ProjectOut) => {
      // A read sent before the move would land after it with the old stage.
      await queryClient.cancelQueries({ queryKey: queries.project(scope).queryKey })
      queryClient.setQueryData(
        queries.project(scope).queryKey,
        (old) => old && { ...old, stage: moved.stage, updated_at: moved.updated_at },
      )
      // Stages show on the company, Home and Jump to, and the checklist is the new stage's.
      void queryClient.invalidateQueries({ queryKey: ["companies"], exact: false })
    },
  })

  /** The stage bar's move: how the API refused, or null once it has moved. */
  async function moveTo(to: Stage, reason?: string): Promise<MoveRefusal | null> {
    try {
      await move.mutateAsync({ to, reason })
      return null
    } catch (error) {
      if (error instanceof ChecklistOpenError) {
        // The page's view of the checklist was stale: read it again, and show what the API found.
        void queryClient.invalidateQueries({ queryKey: queries.stageChecklist(scope).queryKey })
        return { open: error.open }
      }
      return { error: said(error, "project") }
    }
  }

  /** Goes to where a checklist item is put right on this page. */
  function fix(to: Exclude<Fix, "add-stakeholder">) {
    if (to === "sign-off") scopeCard.current?.signOff()
    else if (to === "add-in-scope") scopeCard.current?.add("in")
    else if (to === "add-out-of-scope") scopeCard.current?.add("out")
    else if (to === "add-criterion") criteriaCard.current?.add()
    else if (to === "criteria") criteriaCard.current?.show()
    else if (to === "request-access") accessHandle.current?.request()
    else if (to === "write-note") notesHandle.current?.write()
    else accessHandle.current?.show()
  }

  if (project.isPending)
    return (
      <Page>
        <Loading>Loading the project…</Loading>
      </Page>
    )
  if (isNotFound(project.error)) return <NotFound what="project" />
  if (project.isError)
    return (
      <Page>
        <Failed
          title="We couldn't load this project."
          error={project.error}
          onRetry={() => void project.refetch()}
        />
      </Page>
    )

  const p = project.data
  const role = companies.data?.companies.find((c) => c.id === p.company.id)?.role
  // Its team needs `manage` on the company; its name and summary need only `work`, which anyone who
  // can read the project has. The API still decides.
  const manage = canManage(me.data, role)
  // A project nobody has written anything in yet: say what to do first.
  const fresh =
    p.scope.items.length === 0 &&
    p.scope.criteria.length === 0 &&
    p.tasks.length === 0 &&
    p.access.length === 0 &&
    p.decisions.length === 0
  const current = checklist.data?.stage === p.stage ? checklist.data : undefined

  return (
    <Page full>
      <Column>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Link
              to="/companies/$companyId"
              params={{ companyId: p.company.id }}
              className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft size={14} strokeWidth={1.7} aria-hidden="true" />
              {p.company.name}
            </Link>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit project
            </Button>
          </div>
          {p.summary && <p className="text-xs leading-relaxed text-soft">{p.summary}</p>}
          {fresh && (
            <div className="rounded-[14px] border border-dashed border-strong px-5 py-3.5 max-[800px]:p-4">
              <strong className="text-[13px] font-semibold">A new project. Start here.</strong>
              <Quiet className="mt-1">
                Name who you work with at {p.company.name} on the company page, then agree the scope
                with them. Add tasks to the board as the work takes shape.
              </Quiet>
            </div>
          )}
        </div>

        <StageBar
          stage={p.stage}
          // The checklist is read for the stage it names: one still on the way from the last stage says nothing.
          open={current ? current.items.filter((item) => !item.met) : []}
          onMove={moveTo}
        />

        {current ? (
          <StageChecklist project={p} checklist={current} onFix={fix} />
        ) : checklist.isError ? (
          <p role="alert" className="flex items-center gap-2 text-xs text-muted-foreground">
            We couldn't read what this stage needs.
            <Button variant="ghost" size="sm" onClick={() => void checklist.refetch()}>
              Try again
            </Button>
          </p>
        ) : (
          <Loading>Reading what this stage needs…</Loading>
        )}
      </Column>

      <Board scope={scope} project={p} />

      <Column>
        <div className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
          <ScopeCard handle={scopeCard} scope={scope} project={p} me={me.data?.user.id} />
          <CriteriaCard
            handle={criteriaCard}
            scope={scope}
            criteria={p.scope.criteria}
            signedOff={p.scope.signed_off}
          />
        </div>

        <AccessCard card={accessCard} handle={accessHandle} scope={scope} project={p} />

        <RunsCard scope={scope} />

        <NotesCard handle={notesHandle} place={scope} people={p.stakeholders} project={p} />

        <DecisionsCard scope={scope} project={p} me={me.data?.user.name} />

        <AssigneesCard scope={scope} me={me.data?.user.id} manage={manage} />
      </Column>

      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && (
          <ProjectDialog company={p.company.id} project={p} onClose={() => setEditing(false)} />
        )}
      </Dialog>
    </Page>
  )
}

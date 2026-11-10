import { useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { FormDialog, TextArea, TextField } from "./form-dialog"
import { Card, Quiet, Row, Rows } from "./page"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { api, queries } from "@/lib/api/client"
import {
  DECISION_FIELD,
  blankDecision,
  decisionBody,
  decisionProblem,
  newestFirst,
  subjectOf,
} from "@/lib/access"
import type { DecisionOut, Project, ProjectScope } from "@/lib/api/schemas"
import { attemptAt } from "@/lib/records"
import { dayOf, localDay, shortDate } from "@/lib/time"

// The project's decisions log (DESIGN.md §3): what was decided, why, by whom and when. The API's log is
// append-only: a decision is logged and read, never edited or removed, so the form says so before it saves.

export function DecisionsCard({
  scope,
  project,
  me,
}: {
  scope: ProjectScope
  project: Project
  /** The signed-in FDE's name, offered as one who may have decided. */
  me: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const log = useRef<HTMLButtonElement>(null)
  // Where a decision came from: a discussion that was promoted to it. Quiet when it cannot be read.
  const threads = useQuery(queries.threads(scope))
  const promoted = new Map(
    (threads.data ?? []).flatMap((t) => (t.decision ? [[t.decision as string, t] as const] : [])),
  )
  const close = () => {
    setOpen(false)
    setTimeout(() => log.current?.focus(), 0)
  }
  const decisions = newestFirst(project.decisions)

  return (
    <Card
      title="Decisions"
      aside={
        <Button ref={log} variant="outline" size="sm" onClick={() => setOpen(true)}>
          Log a decision
        </Button>
      }
    >
      {decisions.length === 0 ? (
        <Quiet>
          No decisions logged yet. Log what was agreed and why, so it is not argued twice.
        </Quiet>
      ) : (
        <Rows>
          {decisions.map((decision) => {
            const from = promoted.get(decision.id)
            return (
              <Row key={decision.id}>
                <p className="text-xs [overflow-wrap:anywhere]">{decision.title}</p>
                <p className="mt-0.5 text-xs [overflow-wrap:anywhere] whitespace-pre-line text-soft">
                  {decision.rationale}
                </p>
                <Quiet>
                  {decision.decided_by}, {shortDate(dayOf(decision.decided_at))}
                </Quiet>
                {from && (
                  <Quiet className="[overflow-wrap:anywhere]">
                    Promoted from a discussion about {subjectOf(from.subject, project)}
                  </Quiet>
                )}
              </Row>
            )
          })}
        </Rows>
      )}
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        {open && <DecisionDialog scope={scope} project={project} me={me} onClose={close} />}
      </Dialog>
    </Card>
  )
}

/** Logs a decision. `title` starts it (a line of a meeting note); `onLogged` hears of it once the API confirms. */
export function DecisionDialog({
  scope,
  project,
  me,
  title: startWith,
  onLogged,
  onClose,
}: {
  scope: ProjectScope
  project: Project
  me: string | undefined
  title?: string
  onLogged?: (decision: DecisionOut) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const today = localDay()
  const [fields, setFields] = useState({ ...blankDecision(today), title: startWith ?? "" })
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })
  // Who may have decided: the customer's people, and the FDE. Anyone else can be typed.
  const suggestions = [
    ...new Set([...project.stakeholders.map((s) => s.name), ...(me ? [me] : [])]),
  ]

  const save = () =>
    attemptAt(
      async () => {
        const saved = await api.addDecision(scope, decisionBody(fields, today))
        // Reads sent before the write would land after it without the decision.
        await client.cancelQueries({ queryKey: queries.project(scope).queryKey })
        client.setQueryData(
          queries.project(scope).queryKey,
          (old) => old && { ...old, decisions: [...old.decisions, saved] },
        )
        onLogged?.(saved)
      },
      "decision",
      DECISION_FIELD,
    )

  return (
    <FormDialog
      title="Log a decision"
      description="Record what was decided, why, who decided and when."
      save="Log decision"
      validate={() => decisionProblem(fields, today)}
      onSubmit={save}
      onClose={onClose}
    >
      <TextField
        autoFocus
        name="title"
        label="What was decided"
        value={fields.title}
        onChange={(title) => set({ title })}
      />
      <TextArea
        name="rationale"
        label="Why"
        value={fields.rationale}
        onChange={(rationale) => set({ rationale })}
        hint="The reason, so the next person does not reopen it."
      />
      <div className="grid grid-cols-2 items-start gap-2 max-[560px]:grid-cols-1">
        <TextField
          name="decidedBy"
          label="Who decided"
          value={fields.decidedBy}
          onChange={(decidedBy) => set({ decidedBy })}
          list="decided-by"
          hint="Often someone at the customer."
        />
        <TextField
          name="decidedOn"
          type="date"
          max={today}
          label="Decided on"
          value={fields.decidedOn}
          onChange={(decidedOn) => set({ decidedOn })}
        />
      </div>
      <datalist id="decided-by">
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Quiet>
        The log is append-only: a decision cannot be edited or removed once it is logged, so check
        the words first.
      </Quiet>
    </FormDialog>
  )
}

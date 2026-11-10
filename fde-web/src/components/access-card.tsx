import { useImperativeHandle, useRef, useState } from "react"
import type { Ref } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Check, Ellipsis } from "lucide-react"
import { useAccessMover } from "./access-move"
import { FormDialog, SelectField, TextArea } from "./form-dialog"
import { StaleNotice, useVersionedForm } from "./versioned-form"
import { Card, Quiet, Row, Rows } from "./page"
import { RefusalNote } from "./refusal-note"
import type { Note } from "./refusal-note"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu"
import { api } from "@/lib/api/client"
import {
  ACCESS_FIELD,
  ACCESS_LABELS,
  accessBody,
  accessChanged,
  accessEditBody,
  accessFields,
  accessProblem,
  blockedBy,
  chaseOrder,
  clip,
  commitAccess,
  glance,
  heldUpBy,
  LONG_WAIT_DAYS,
  spanOf,
  waitOf,
} from "@/lib/access"
import type { AccessRequestOut, Project, ProjectScope } from "@/lib/api/schemas"
import { dayOf, shortDate } from "@/lib/time"
import { ACCESS_LABEL, accessActions } from "@/lib/today"
import type { AccessAction } from "@/lib/today"
import { cn } from "@/lib/utils"

// The project's access requests (DESIGN.md §3, Access): where engagements stall, so the card answers
// three things first: what is still not granted, who at the customer holds it up, and for how long.
// A row moves through the same statuses Today offers (one shared mover) and opens its form to change
// what was asked, from whom and for which system. The API has no way to remove a request.

/** What the stage checklist does on this card. */
export type AccessCardHandle = {
  /** Opens the blank request form. */
  request: () => void
  /** Scrolls the card into view and focuses it. */
  show: () => void
}

/** Puts focus back where a dialog came from: the row that opened it, or else the card's own button. */
function returnFocus(id: string | undefined, fallback: { current: HTMLElement | null }) {
  setTimeout(() => {
    const row = id ? document.querySelector<HTMLElement>(`[data-row="${id}"]`) : null
    ;(row ?? fallback.current)?.focus()
  }, 0)
}

export function AccessCard({
  scope,
  project,
  handle,
  card,
}: {
  scope: ProjectScope
  project: Project
  handle?: Ref<AccessCardHandle>
  /** The card's own element, for the checklist's "Go to Access". */
  card: Ref<HTMLElement>
}) {
  // A request to edit, "new" for a blank form, or nothing. It is a copy taken when the form opened.
  const [open, setOpen] = useState<AccessRequestOut | "new" | null>(null)
  const request = useRef<HTMLButtonElement>(null)
  const element = useRef<HTMLElement | null>(null)
  const mover = useAccessMover({
    onSaved: (saved) => {
      // The row has moved to where its new status sorts: keep the keyboard on it.
      setTimeout(() => {
        const active = document.activeElement
        const row = document.querySelector<HTMLElement>(`[data-row="${saved.id}"]`)
        if (row && (!active || active === document.body || row.contains(active))) row.focus()
      }, 0)
    },
  })
  useImperativeHandle(handle, () => ({
    request: () => setOpen("new"),
    show: () => {
      const el = element.current
      if (!el) return
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" })
      el.focus({ preventScroll: true })
    },
  }))
  const close = () => {
    if (open) returnFocus(open === "new" ? undefined : open.id, request)
    setOpen(null)
  }

  const people = new Map(project.stakeholders.map((s) => [s.id as string, s.name]))
  const systems = new Map(project.systems.map((s) => [s.id as string, s.name]))
  const person = (id: string) => people.get(id) ?? "a stakeholder no longer listed"
  const rows = chaseOrder(project.access)
  const g = glance(project.access, person)
  const lost = mover.refusal
  // A refusal whose row has gone (settled or removed elsewhere) is said above the rows instead.
  const lostHere = lost && !project.access.some((a) => a.id === lost.access.id)
  const lostNote = lostHere ? mover.note(clip(lost.access.description)) : null

  return (
    <Card
      ref={(el) => {
        element.current = el
        if (typeof card === "function") card(el)
        else if (card) card.current = el
      }}
      title="Access"
      aside={
        <Button ref={request} variant="outline" size="sm" onClick={() => setOpen("new")}>
          Request access
        </Button>
      }
    >
      <p role="status" className="sr-only">
        {mover.announcement}
      </p>
      {lostNote && (
        <RefusalNote note={lostNote} onDismiss={mover.dismiss} className="mb-3 text-xs" />
      )}
      {rows.length === 0 ? (
        <Quiet>
          No access requested yet. Ask for what the work needs: a system to read, a role, a key held
          by someone at {project.company.name}.
        </Quiet>
      ) : (
        <>
          <Glance g={g} />
          <Rows label="Access requests">
            {rows.map((a) => (
              <AccessRow
                key={a.id}
                a={a}
                owner={a.owner ? person(a.owner) : null}
                system={a.system ? (systems.get(a.system) ?? "a system no longer listed") : null}
                blocking={blockedBy(a.id, project.tasks)}
                moving={mover.saving[a.id]}
                refused={lost && lost.access.id === a.id ? mover.note(null) : null}
                onMove={(action) => {
                  mover.dismiss()
                  void mover.move(scope, a, action.to)
                }}
                onEdit={() => setOpen(a)}
                onDismiss={mover.dismiss}
              />
            ))}
          </Rows>
        </>
      )}
      <Dialog open={open !== null} onOpenChange={(next) => !next && close()}>
        {open && (
          <AccessDialog
            key={open === "new" ? "new" : open.id}
            scope={scope}
            project={project}
            request={open === "new" ? undefined : open}
            onClose={close}
          />
        )}
      </Dialog>
    </Card>
  )
}

/** What is not granted, who holds it up and for how long, before the list. */
function Glance({ g }: { g: ReturnType<typeof glance> }) {
  if (g.notGranted === 0)
    return (
      <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Check size={14} strokeWidth={2} aria-hidden="true" className="flex-none text-success" />
        {g.total === 1 ? "The request is granted." : `All ${g.total} requests are granted.`}
      </p>
    )
  const long = g.longest !== null && g.longest >= LONG_WAIT_DAYS
  return (
    <dl
      aria-label="Access at a glance"
      className="mb-3 grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-8 gap-y-2 rounded-xl border bg-raised px-3.5 py-2.5 max-[800px]:grid-cols-2 max-[560px]:grid-cols-1"
    >
      <div>
        <dt className="text-[11px] text-muted-foreground">Not granted</dt>
        <dd className="text-xs">
          {g.notGranted} of {g.total}
        </dd>
      </div>
      <div className="min-w-0 min-[561px]:max-[800px]:order-last min-[561px]:max-[800px]:col-span-2">
        <dt className="text-[11px] text-muted-foreground">Held up by</dt>
        <dd className="text-xs [overflow-wrap:anywhere]">{heldUpBy(g.heldUp)}</dd>
      </div>
      <div>
        <dt className="text-[11px] text-muted-foreground">Longest wait</dt>
        <dd className="flex items-center gap-1.5 text-xs">
          {long && (
            <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-attention" />
          )}
          {g.longest === null ? "Nothing open" : spanOf(g.longest)}
        </dd>
      </div>
    </dl>
  )
}

function AccessRow({
  a,
  owner,
  system,
  blocking,
  moving,
  refused,
  onMove,
  onEdit,
  onDismiss,
}: {
  a: AccessRequestOut
  owner: string | null
  system: string | null
  blocking: Array<{ id: string; title: string }>
  /** Where it is on its way to, while the API has not answered. */
  moving: AccessRequestOut["status"] | undefined
  refused: Note | null
  onMove: (action: AccessAction) => void
  onEdit: () => void
  onDismiss: () => void
}) {
  const busy = moving !== undefined
  const wait = waitOf(a)
  const { primary, rest } = accessActions(a.status)
  // A granted request is not pressed by accident: its moves are in the menu only.
  const menu = a.status === "granted" ? [primary, ...rest] : rest
  const shown = blocking.slice(0, 3).map((t) => `“${clip(t.title, 50)}”`)
  const more = blocking.length - shown.length
  return (
    <Row>
      <div
        data-row={a.id}
        tabIndex={-1}
        aria-busy={busy}
        className={cn(
          "-mx-2 rounded-lg px-2 py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
          busy && "opacity-60",
        )}
      >
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-xs leading-snug [overflow-wrap:anywhere] whitespace-pre-line">
              {a.description}
            </p>
            <p className="mt-0.5 text-[11px] leading-normal [overflow-wrap:anywhere] text-soft">
              {owner ? `Owner: ${owner}` : "No one at the customer is named to grant it"}
            </p>
            <Quiet className="[overflow-wrap:anywhere]">
              {[system, `Requested ${shortDate(dayOf(a.requested_at))}`]
                .filter(Boolean)
                .join(" · ")}
            </Quiet>
            <span className="mt-0.5 flex items-start gap-1.5 text-[11px] leading-normal text-soft">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-[5px] size-1.5 shrink-0 rounded-full",
                  wait.tone === "attention" && "bg-attention",
                  wait.tone === "success" && "bg-success",
                  wait.tone === "neutral" && "bg-strong",
                )}
              />
              {busy ? `Moving to ${ACCESS_LABEL[moving]}…` : wait.text}
            </span>
            {blocking.length > 0 && (
              <Quiet className="mt-0.5 [overflow-wrap:anywhere]">
                {blocking.length === 1 ? "Blocks 1 task: " : `Blocks ${blocking.length} tasks: `}
                {shown.join(", ")}
                {more > 0 ? ` and ${more} more` : ""}
              </Quiet>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {a.status !== "granted" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`${primary.label}: ${clip(a.description, 60)}`}
                onClick={() => onMove(primary)}
                className="bg-raised max-[800px]:h-9 pointer-coarse:h-9"
              >
                {primary.label}
              </Button>
            )}
            <Menu>
              <MenuTrigger
                disabled={busy}
                aria-label={`Actions for ${clip(a.description, 60)}`}
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-selected hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-45 data-popup-open:bg-selected max-[800px]:size-9 pointer-coarse:size-9"
              >
                <Ellipsis size={15} strokeWidth={1.7} aria-hidden="true" />
              </MenuTrigger>
              <MenuContent label={`Actions for ${clip(a.description, 60)}`}>
                {menu.map((action) => (
                  <MenuItem key={action.label} onClick={() => onMove(action)}>
                    {action.label}
                  </MenuItem>
                ))}
                {menu.length > 0 && <MenuSeparator />}
                <MenuItem onClick={onEdit}>Edit request</MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        {refused && (
          <RefusalNote note={refused} onDismiss={onDismiss} className="mt-1.5 text-[11px]" />
        )}
      </div>
    </Row>
  )
}

/** Asks for access, or changes a request: what, which system, and who at the customer owns it. */
function AccessDialog({
  scope,
  project,
  request,
  onClose,
}: {
  scope: ProjectScope
  project: Project
  request?: AccessRequestOut
  onClose: () => void
}) {
  const client = useQueryClient()
  // A new request is a create and sends no version. An edit is based on the copy the form opened on:
  // all four fields come from the form, and its version goes with them.
  const form = useVersionedForm({
    record: request,
    snapshot: accessFields,
    initial: accessFields(request),
    labels: ACCESS_LABELS,
    // Nothing changed: nothing is sent, so the request's status and clock are not touched.
    changed: accessChanged,
    send: async (base, f) => {
      if (!base) return commitAccess(client, scope, await api.addAccess(scope, accessBody(f)))
      const saved = await api.updateAccess(scope, base.id, accessEditBody(f), base.version)
      return commitAccess(client, scope, saved, base.status)
    },
    adopt: (current) => commitAccess(client, scope, current, current.status),
    what: "request",
    fieldOf: ACCESS_FIELD,
  })
  const { fields, set } = form
  const { stakeholders, systems } = project

  const ownerListed = fields.owner === null || stakeholders.some((s) => s.id === fields.owner)
  const systemListed = fields.system === null || systems.some((s) => s.id === fields.system)

  return (
    <FormDialog
      title={request ? "Edit access request" : "Request access"}
      description={
        request
          ? "Change what was asked, from which system, or who owns it."
          : "Ask the customer for access to a system."
      }
      save={form.save(request ? "Save" : "Request access")}
      validate={() => accessProblem(fields)}
      onSubmit={form.submit}
      notice={<StaleNotice stale={form.stale} noun="request" />}
      onClose={onClose}
    >
      <TextArea
        autoFocus
        name="description"
        label="What access is needed"
        value={fields.description}
        onChange={(description) => set({ description })}
        hint="What, and at what level: for example, read-only access to the planning database."
      />
      <div className="grid grid-cols-2 items-start gap-2 max-[560px]:grid-cols-1">
        <SelectField
          name="system"
          label="Which system"
          value={fields.system ?? ""}
          onChange={(system) => set({ system: system || null })}
        >
          <option value="">No particular system</option>
          {!systemListed && <option value={fields.system!}>A system no longer listed</option>}
          {systems.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          name="owner"
          label="Who at the customer owns it"
          value={fields.owner ?? ""}
          onChange={(owner) => set({ owner: owner || null })}
          hint={
            stakeholders.length === 0
              ? "No one is named at the customer yet. Add stakeholders on the company page."
              : "The person who can grant it."
          }
        >
          <option value="">No one named yet</option>
          {!ownerListed && <option value={fields.owner!}>A stakeholder no longer listed</option>}
          {stakeholders.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ? `${s.name}, ${s.title}` : s.name}
            </option>
          ))}
        </SelectField>
      </div>
      {request ? (
        <Quiet>Change its status from the row: mark it granted, denied or in progress.</Quiet>
      ) : (
        <Quiet>
          It starts as requested. Mark it in progress, granted or denied as the customer answers.
        </Quiet>
      )}
    </FormDialog>
  )
}

import { useImperativeHandle, useRef, useState } from "react"
import type { Ref, RefObject } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FormDialog, TextArea, TextField, useFieldProblem } from "./form-dialog"
import { Card, Quiet, Rows, Status, reveal } from "./page"
import { EditRow } from "./records-cards"
import { FIELD, Labelled } from "./task-move"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { StaleNotice, useVersionedForm } from "./versioned-form"
import { ApiError, StaleSaveError, api } from "@/lib/api/client"
import type {
  CriterionOut,
  Project,
  ProjectScope,
  ScopeItemOut,
  ScopeOut,
  StakeholderId,
} from "@/lib/api/schemas"
import { HELD, PART_LABEL, at, attempt, problemOf } from "@/lib/records"
import {
  COMPARATOR_LABEL,
  CRITERION_LABELS,
  ITEM_LABELS,
  KIND_LABEL,
  adoptCriterion,
  adoptItem,
  cannotSignOff,
  changesSince,
  commitCriterion,
  commitCriterionGone,
  commitFreshScope,
  commitItem,
  commitItemGone,
  commitSignOff,
  criterionBody,
  criterionChanged,
  criterionFields,
  criterionProblem,
  itemBody,
  itemChanged,
  itemFields,
  itemProblem,
  measure,
  scopeChanges,
  signOffState,
  signers,
  targetOf,
} from "@/lib/scope"
import type { Comparator, ItemKind, ScopeChange } from "@/lib/scope"
import { dayOf, shortDate } from "@/lib/time"

// The scope and its success criteria (DESIGN.md §3): what the FDE and the customer agree "done"
// means. Each item and each criterion opens in a dialog of its own, because the API saves each one
// on its own, a long item needs room, and a dialog shows its refusal beside what was typed.
// Everything here needs only `work` on the project, which anyone who can read it has.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text)

/**
 * Puts focus back where a dialog came from once it has gone: the row that opened it, or, when that
 * row is gone (a removed record), the next place that is still there. Without it focus falls to the page.
 */
function returnFocus(id: string | undefined, ...fallbacks: Array<RefObject<HTMLElement | null>>) {
  setTimeout(() => {
    const row = id ? document.querySelector<HTMLElement>(`[data-row="${id}"]`) : null
    const target = row ?? fallbacks.map((ref) => ref.current).find(Boolean)
    target?.focus()
  }, 0)
}

/** A signed-off scope that is about to change: it keeps its sign-off on record, but no longer covers it. */
function NeedsSignOff() {
  return (
    <p role="note" className="flex items-start gap-2 rounded-xl border bg-raised px-3.5 py-2.5">
      <span aria-hidden="true" className="mt-1 size-1.5 flex-none rounded-full bg-attention" />
      This scope is signed off. Saving a change means it needs signing off again.
    </p>
  )
}

type Open = { kind: "item"; item?: ScopeItemOut; side: ItemKind } | { kind: "signoff" }

/** What the stage checklist does on the scope card: open the dialog that fixes an item. */
export type ScopeCardHandle = {
  signOff: () => void
  add: (side: ItemKind) => void
}

export function ScopeCard({
  scope,
  project,
  me,
  handle,
}: {
  scope: ProjectScope
  project: Project
  /** The signed-in user's id: a sign-off says whether they recorded it. */
  me: string | undefined
  handle?: Ref<ScopeCardHandle>
}) {
  const s = project.scope
  const state = signOffState(s)
  const [open, setOpen] = useState<Open | null>(null)
  const addIn = useRef<HTMLButtonElement>(null)
  const addOut = useRef<HTMLButtonElement>(null)
  const sign = useRef<HTMLButtonElement>(null)
  // What a sign-off leaves behind when its button goes: the sentence that says the new state.
  const agreement = useRef<HTMLDivElement>(null)
  useImperativeHandle(handle, () => ({
    signOff: () => setOpen({ kind: "signoff" }),
    add: (side) => setOpen({ kind: "item", side }),
  }))
  const close = () => {
    if (open?.kind === "signoff") returnFocus(undefined, sign, agreement)
    else if (open) returnFocus(open.item?.id, open.side === "in" ? addIn : addOut)
    setOpen(null)
  }
  const people = new Map(project.stakeholders.map((p) => [p.id as string, p.name]))
  const by = s.sign_off
    ? (people.get(s.sign_off.stakeholder) ?? "a stakeholder no longer listed")
    : ""
  const when = s.sign_off ? shortDate(dayOf(s.sign_off.signed_at)) : ""
  const blocked = cannotSignOff(project.stakeholders.length)
  const empty = s.items.length === 0 && s.criteria.length === 0

  const sections = [
    {
      kind: "in",
      add: addIn,
      none: "Start with the outcome: what the customer has when this is done.",
    },
    { kind: "out", add: addOut, none: "Say what is not included, so it is never assumed." },
  ] as const

  return (
    <Card
      title="Scope"
      aside={
        // As tall as the button beside it in the next card, so the two headings line up.
        <span className="flex min-h-7 items-center">
          {state === "signed" ? (
            <Status tone="success">
              Signed off by {by}, {when}
            </Status>
          ) : state === "changed" ? (
            <Status tone="attention">Changed since sign-off</Status>
          ) : (
            <Status tone="neutral">Not signed off</Status>
          )}
        </span>
      }
    >
      <div className="grid gap-3.5 text-xs">
        {sections.map(({ kind, add, none }) => {
          const items = s.items.filter((item) => item.kind === kind)
          return (
            <div key={kind}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] text-muted-foreground">{KIND_LABEL[kind]}</h3>
                <Button
                  ref={add}
                  variant="ghost"
                  size="sm"
                  // The button's own padding would pull its word in from the card's edge.
                  className="-mr-3 max-[800px]:h-9"
                  aria-label={`Add ${KIND_LABEL[kind].toLowerCase()}`}
                  onClick={() => setOpen({ kind: "item", side: kind })}
                >
                  Add
                </Button>
              </div>
              {items.length === 0 ? (
                <Quiet>{none}</Quiet>
              ) : (
                <Rows label={KIND_LABEL[kind]}>
                  {items.map((item) => (
                    <EditRow
                      key={item.id}
                      id={item.id}
                      label={`Edit: ${clip(item.description)}`}
                      onOpen={() => setOpen({ kind: "item", item, side: item.kind })}
                    >
                      <p className="text-xs whitespace-pre-line">{item.description}</p>
                    </EditRow>
                  ))}
                </Rows>
              )}
            </div>
          )
        })}

        {!empty && (
          <div
            ref={agreement}
            tabIndex={-1}
            className="grid gap-2 rounded-xl border bg-raised px-3.5 py-2.5 outline-none"
          >
            {state === "signed" && s.sign_off && (
              <p>
                {by} agreed to this scope on {when}. Recorded by{" "}
                {s.sign_off.recorded_by === me ? "you" : "a teammate"}. A change to the scope will
                need signing off again.
              </p>
            )}
            {state === "changed" && s.sign_off && (
              <p>
                {by} signed off an earlier version on {when}. The scope has had{" "}
                {plural(changesSince(s), "change")} since, so it needs signing off again.
              </p>
            )}
            {state === "none" && (
              <p>
                Not signed off. When {project.company.name} agrees to this scope, record who signed
                it off.
              </p>
            )}
            {state !== "signed" &&
              (blocked ? (
                <Quiet>{blocked}</Quiet>
              ) : (
                <div>
                  <Button
                    ref={sign}
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen({ kind: "signoff" })}
                  >
                    {state === "changed" ? "Sign off again" : "Record sign-off"}
                  </Button>
                </div>
              ))}
          </div>
        )}
      </div>

      <Dialog open={open !== null} onOpenChange={(next) => !next && close()}>
        {open?.kind === "item" && (
          <ItemDialog
            key={open.item?.id ?? `new-${open.side}`}
            scope={scope}
            item={open.item}
            side={open.side}
            signedOff={s.signed_off}
            onClose={close}
          />
        )}
        {open?.kind === "signoff" && (
          <SignOffDialog
            scope={scope}
            project={project}
            again={state === "changed"}
            onClose={close}
          />
        )}
      </Dialog>
    </Card>
  )
}

function ItemDialog({
  scope,
  item,
  side,
  signedOff,
  onClose,
}: {
  scope: ProjectScope
  item?: ScopeItemOut
  side: ItemKind
  signedOff: boolean
  onClose: () => void
}) {
  const client = useQueryClient()
  // The form is based on the item as it was when it opened, and sends that copy's version. The API
  // answers an unchanged save with the item as it is, but nothing is sent when nothing changed.
  const form = useVersionedForm({
    record: item,
    snapshot: (r) => itemFields(r),
    initial: itemFields(item, side),
    labels: ITEM_LABELS,
    changed: itemChanged,
    send: async (base, f) => {
      const body = itemBody(f)
      const saved = base
        ? await api.updateScopeItem(scope, base.id, body, base.version)
        : await api.addScopeItem(scope, body)
      await commitItem(client, scope, saved)
    },
    adopt: (current) => adoptItem(client, scope, current),
    what: "scope item",
  })
  const { fields, set } = form

  return (
    <FormDialog
      title={item ? "Edit scope item" : "Add to scope"}
      description={item ? "Change this item, or remove it." : "Add something in or out of scope."}
      save={form.save(item ? "Save" : "Add")}
      validate={() => itemProblem(fields)}
      onSubmit={form.submit}
      notice={<StaleNotice stale={form.stale} noun="item" />}
      remove={
        item && {
          label: "Remove item",
          ask: `Remove this from the scope? This cannot be undone.${signedOff ? " The scope will need signing off again." : ""}`,
          group: "Confirm the removal",
          confirm: "Remove",
          run: () =>
            attempt(async () => {
              await api.removeScopeItem(scope, item.id)
              await commitItemGone(client, scope, item.id)
            }, "scope item"),
        }
      }
      onClose={onClose}
    >
      <Labelled label="Listed as">
        <select
          className={FIELD}
          value={fields.kind}
          onChange={(e) => set({ kind: e.target.value as ItemKind })}
        >
          <option value="in">{KIND_LABEL.in}</option>
          <option value="out">{KIND_LABEL.out}</option>
        </select>
      </Labelled>
      <TextArea
        autoFocus
        tall
        label="Description"
        value={fields.description}
        onChange={(description) => set({ description })}
        hint={
          fields.kind === "in"
            ? "One thing the work delivers, specific enough that you could check it."
            : "One thing the work will not do, so nobody assumes it."
        }
      />
      {signedOff && <NeedsSignOff />}
    </FormDialog>
  )
}

/** What the stage checklist does on the criteria card. */
export type CriteriaCardHandle = {
  add: () => void
  /** Scrolls the card into view and focuses it. */
  show: () => void
}

export function CriteriaCard({
  scope,
  criteria,
  signedOff,
  handle,
}: {
  scope: ProjectScope
  criteria: Array<CriterionOut>
  signedOff: boolean
  handle?: Ref<CriteriaCardHandle>
}) {
  // A criterion to edit, "new" for a blank form, or nothing.
  const [open, setOpen] = useState<CriterionOut | "new" | null>(null)
  const add = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement>(null)
  useImperativeHandle(handle, () => ({
    add: () => setOpen("new"),
    show: () => reveal(card.current),
  }))
  const close = () => {
    if (open) returnFocus(open === "new" ? undefined : open.id, add)
    setOpen(null)
  }
  return (
    <Card
      ref={card}
      title="Success criteria"
      aside={
        <Button ref={add} variant="outline" size="sm" onClick={() => setOpen("new")}>
          Add criterion
        </Button>
      }
    >
      {criteria.length === 0 ? (
        // A criterion is written in the customer's terms (#193), even while an eval's share is compared as written.
        <Quiet>
          Say how done is measured: one target the customer can check, such as plans accepted
          unchanged, at least 70%.
        </Quiet>
      ) : (
        <Rows>
          {criteria.map((criterion) => (
            <EditRow
              key={criterion.id}
              id={criterion.id}
              label={`Edit: ${clip(criterion.description)}`}
              onOpen={() => setOpen(criterion)}
            >
              <p className="text-xs whitespace-pre-line">{criterion.description}</p>
              <Quiet>Met when {measure(criterion)}.</Quiet>
            </EditRow>
          ))}
        </Rows>
      )}
      <Dialog open={open !== null} onOpenChange={(next) => !next && close()}>
        {open && (
          <CriterionDialog
            key={open === "new" ? "new" : open.id}
            scope={scope}
            criterion={open === "new" ? undefined : open}
            signedOff={signedOff}
            onClose={close}
          />
        )}
      </Dialog>
    </Card>
  )
}

function CriterionDialog({
  scope,
  criterion,
  signedOff,
  onClose,
}: {
  scope: ProjectScope
  criterion?: CriterionOut
  signedOff: boolean
  onClose: () => void
}) {
  const client = useQueryClient()
  // Every field goes back on an edit (the API's PUT replaces the criterion), from the copy the form
  // opened on with that copy's version; nothing is sent when none changed.
  const form = useVersionedForm({
    record: criterion,
    snapshot: criterionFields,
    initial: criterionFields(criterion),
    labels: CRITERION_LABELS,
    changed: criterionChanged,
    send: async (base, f) => {
      const body = criterionBody(f)
      const saved = base
        ? await api.updateCriterion(scope, base.id, body, base.version)
        : await api.addCriterion(scope, body)
      await commitCriterion(client, scope, saved)
    },
    adopt: (current) => adoptCriterion(client, scope, current),
    what: "criterion",
  })
  const { fields, set } = form

  const number = targetOf(fields.target)
  // The agreement, as the customer will read it, once there is enough to read.
  const reads =
    fields.metric.trim() && number !== null
      ? measure({
          metric: fields.metric.trim(),
          comparator: fields.comparator,
          target: number,
          unit: fields.unit.trim() || null,
        })
      : null

  return (
    <FormDialog
      title={criterion ? "Edit success criterion" : "Add success criterion"}
      description={criterion ? "Change this criterion, or remove it." : "Say how done is measured."}
      save={form.save(criterion ? "Save" : "Add criterion")}
      validate={() => criterionProblem(fields)}
      onSubmit={form.submit}
      notice={<StaleNotice stale={form.stale} noun="criterion" />}
      remove={
        criterion && {
          label: "Remove criterion",
          ask: `Remove this criterion? This cannot be undone.${signedOff ? " The scope will need signing off again." : ""}`,
          group: "Confirm the removal",
          confirm: "Remove",
          run: () =>
            attempt(async () => {
              await api.removeCriterion(scope, criterion.id)
              await commitCriterionGone(client, scope, criterion.id)
            }, "criterion"),
        }
      }
      onClose={onClose}
    >
      <TextArea
        autoFocus
        tall
        label="What must be true"
        value={fields.description}
        onChange={(description) => set({ description })}
        hint="A sentence the customer would agree to."
      />
      <TextField
        label="What is measured"
        value={fields.metric}
        onChange={(metric) => set({ metric })}
        hint="Such as plans accepted unchanged."
      />
      <div className="grid grid-cols-3 items-start gap-2 max-[560px]:grid-cols-1">
        <Labelled label="Passes when it is">
          <select
            className={FIELD}
            value={fields.comparator}
            onChange={(e) => set({ comparator: e.target.value as Comparator })}
          >
            {(Object.keys(COMPARATOR_LABEL) as Array<Comparator>).map((c) => (
              <option key={c} value={c}>
                {COMPARATOR_LABEL[c]}
              </option>
            ))}
          </select>
        </Labelled>
        <TextField
          label="Target"
          inputMode="decimal"
          value={fields.target}
          onChange={(target) => set({ target })}
        />
        <TextField
          label="Unit"
          value={fields.unit}
          onChange={(unit) => set({ unit })}
          hint="Such as % or min."
        />
      </div>
      {reads && (
        <p className="rounded-xl border bg-raised px-3.5 py-2.5">
          <span className="text-[11px] text-muted-foreground">It will read</span>
          <br />
          Met when {reads}.
        </p>
      )}
      {signedOff && <NeedsSignOff />}
    </FormDialog>
  )
}

function SignOffDialog({
  scope,
  project,
  again,
  onClose,
}: {
  scope: ProjectScope
  project: Project
  again: boolean
  onClose: () => void
}) {
  const client = useQueryClient()
  // The scope as the person read it: it is what they are signing, and its version is what the sign-off
  // sends. If the scope has moved on by Save, this becomes the scope as it stands, and they read it again.
  const [read, setRead] = useState(project.scope)
  const [changes, setChanges] = useState<Array<ScopeChange> | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const people = signers(project.stakeholders)
  const sponsors = people.filter((p) => p.role === "sponsor")
  // Who signed before, if still listed; else the sponsor, if there is only one; else no one yet.
  const first =
    (again && people.find((p) => p.id === read.sign_off?.stakeholder)?.id) ||
    (sponsors.length === 1 ? sponsors[0]!.id : "")
  const [who, setWho] = useState<string>(first)
  const inside = read.items.filter((i) => i.kind === "in").length
  const outside = read.items.length - inside

  /** The scope is not the one that was read: nothing is signed, the page shows the scope now, and the person reads it again. */
  async function held(now: ScopeOut) {
    await commitFreshScope(client, scope, now)
    setChanges(scopeChanges(read, now))
    setRead(now)
    setConfirmed(false)
    return HELD
  }

  const save = async () => {
    try {
      // A courtesy: the version below is what protects the scope, and this tells a scope that moved
      // while the dialog was open before a sign-off is attempted at all.
      const now = await api.scope(scope)
      if (now.version !== read.version) return await held(now)
      const signed = await api.signOffScope(scope, who as StakeholderId, read.version)
      await commitSignOff(client, scope, signed)
      return null
    } catch (error) {
      // A teammate changed the scope between that look and the sign-off.
      if (error instanceof StaleSaveError) return await held(error.current as ScopeOut)
      // This version was signed a moment ago by someone else: read the scope, so the card says
      // by whom instead of staying on "Not signed off" until a reload.
      if (error instanceof ApiError && error.status === 409 && error.code === "conflict")
        await api
          .scope(scope)
          .then((fresh) => commitFreshScope(client, scope, fresh))
          .catch(() => undefined)
      return problemOf(error, "project", {})
    }
  }

  const notes = [
    outside === 0 && "Nothing is listed as out of scope.",
    read.criteria.length === 0 && "No success criteria are written yet.",
  ].filter((note): note is string => Boolean(note))

  return (
    <FormDialog
      title={again ? "Sign off again" : "Record sign-off"}
      description="Record who at the customer agreed to the scope as it is now."
      save="Record sign-off"
      validate={() =>
        !who
          ? "Choose who signed off."
          : changes && !confirmed
            ? at("confirm", "Read the scope as it is now and confirm it first.")
            : null
      }
      onSubmit={save}
      notice={
        changes && (
          <ScopeMoved
            changes={changes}
            scope={read}
            company={project.company.name}
            confirmed={confirmed}
            onConfirm={setConfirmed}
          />
        )
      }
      onClose={onClose}
    >
      <p>
        Record that {project.company.name} agreed to this scope as it stands: {inside} in scope,{" "}
        {outside} out of scope,{" "}
        {plural(read.criteria.length, "success criterion", "success criteria")}.
      </p>
      <Labelled label="Signed off by">
        <select className={FIELD} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Choose a stakeholder</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}, {PART_LABEL[p.role]}
            </option>
          ))}
        </select>
      </Labelled>
      <Quiet>
        The person at {project.company.name} who agreed to it, usually the sponsor. You are
        recording their agreement.
      </Quiet>
      {notes.length > 0 && (
        <ul className="grid gap-1 rounded-xl border bg-raised px-3.5 py-2.5">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </FormDialog>
  )
}

/**
 * What a sign-off that was held back says: the scope changed after it was read, so nothing was signed.
 * It shows what changed and the scope as it is now, and asks the person to confirm they have read it.
 */
function ScopeMoved({
  changes,
  scope,
  company,
  confirmed,
  onConfirm,
}: {
  changes: Array<ScopeChange>
  scope: ScopeOut
  company: string
  confirmed: boolean
  onConfirm: (confirmed: boolean) => void
}) {
  const problem = useFieldProblem("confirm")
  const group = (kind: ItemKind) => scope.items.filter((i) => i.kind === kind)
  return (
    <div role="alert" data-stale className="grid gap-2.5 rounded-xl border bg-raised px-3.5 py-2.5">
      <p className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-1 size-1.5 flex-none rounded-full bg-attention" />
        The scope changed while this was open, so nothing was signed. It is shown below as it is
        now.
      </p>
      {changes.length > 0 && (
        <ul className="grid gap-0.5 pl-3.5 text-muted-foreground">
          {changes.map((c) => (
            <li key={`${c.change}-${c.text}`} className="[overflow-wrap:anywhere]">
              {CHANGE_LABEL[c.change]}: {c.text}
            </li>
          ))}
        </ul>
      )}
      <div className="grid max-h-56 gap-2 overflow-y-auto rounded-lg border bg-card px-3 py-2">
        {(["in", "out"] as const).map((kind) => (
          <div key={kind}>
            <p className="text-[11px] text-muted-foreground">{KIND_LABEL[kind]}</p>
            {group(kind).length === 0 ? (
              <Quiet>Nothing.</Quiet>
            ) : (
              <ul className="grid gap-1">
                {group(kind).map((i) => (
                  <li key={i.id} className="[overflow-wrap:anywhere] whitespace-pre-line">
                    {i.description}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <div>
          <p className="text-[11px] text-muted-foreground">Success criteria</p>
          {scope.criteria.length === 0 ? (
            <Quiet>None.</Quiet>
          ) : (
            <ul className="grid gap-1">
              {scope.criteria.map((c) => (
                <li key={c.id} className="[overflow-wrap:anywhere]">
                  {c.description} <Quiet className="inline">Met when {measure(c)}.</Quiet>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-field="confirm"
          className="mt-0.5"
          checked={confirmed}
          onChange={(e) => onConfirm(e.target.checked)}
          {...problem}
        />
        I have read the scope as it is now, and {company} agreed to this version.
      </label>
    </div>
  )
}

const CHANGE_LABEL: Record<ScopeChange["change"], string> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
}

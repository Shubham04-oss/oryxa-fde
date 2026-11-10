import type { QueryClient } from "@tanstack/react-query"
import { queries } from "./api/client"
import type { components } from "./api/fde-api.gen"
import type {
  AccessRequestOut,
  AccessState,
  DecisionOut,
  Project,
  ProjectScope,
  TaskOut,
  ThreadOut,
} from "./api/schemas"
import { at, checkName, checkText } from "./records"
import type { Problem } from "./records"
import { dayOf, localDay, shortDate, waitingLabel } from "./time"
import { ACCESS_LABEL } from "./today"
import type { Tone } from "@/components/page"

// What the Access and Decisions cards say and send (DESIGN.md §3): what is still not granted, who at
// the customer holds it up and for how long; the whole-record bodies the API takes; and how a saved
// request reaches the page, Today and the stage checklist. Today's row actions share `commitAccess`.

export type AccessBody = components["schemas"]["AccessRequestBody"]
export type DecisionBody = components["schemas"]["DecisionBody"]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** Requested or in progress: the customer has not answered. */
export const isOpen = (status: AccessState) => status === "requested" || status === "in_progress"

export const ACCESS_TONE: Record<AccessState, Tone> = {
  requested: "neutral",
  in_progress: "neutral",
  granted: "success",
  denied: "attention",
  revoked: "attention",
}

/** An open request this old is a long wait: amber, so it is found before it stalls the engagement. */
export const LONG_WAIT_DAYS = 7

// ── The form ───────────────────────────────────────────────────────────────

export type AccessFields = {
  description: string
  /** A system id of the company, or none. */
  system: string | null
  /** A stakeholder id of the company, or none. */
  owner: string | null
}

export const accessFields = (a?: AccessRequestOut): AccessFields => ({
  description: a?.description ?? "",
  system: a?.system ?? null,
  owner: a?.owner ?? null,
})

export const accessProblem = (f: AccessFields): Problem | null =>
  at(
    "description",
    f.description.trim()
      ? checkText(f.description, "invalid_description")
      : "Say what access is needed.",
  )

/** The API's code for a refusal, and the field it is about. */
export const ACCESS_FIELD: Record<string, string> = {
  invalid_description: "description",
  invalid_system: "system",
  invalid_owner: "owner",
}

/** A new request: the API takes it as requested or in progress, and it starts as requested. */
export const accessBody = (f: AccessFields): AccessBody => ({
  description: f.description.trim(),
  system: f.system,
  owner: f.owner,
  status: "requested",
})

/** Whether the form holds something other than the request it was opened on. */
export function accessChanged(opened: AccessRequestOut, f: AccessFields) {
  const was = accessFields(opened)
  return (
    f.description.trim() !== was.description || f.system !== was.system || f.owner !== was.owner
  )
}

/**
 * An edit's body, every field, because the API's `PUT` replaces the request. What the form
 * changed (against the copy taken when it opened) is the form's; everything else, the status
 * included, is the request as it is now (`now`), so a status moved while the form was open is
 * not undone by saving it.
 */
export function accessEditBody(
  opened: AccessRequestOut,
  now: AccessRequestOut | undefined,
  f: AccessFields,
): AccessBody {
  const was = accessFields(opened)
  const live = now ?? opened
  return {
    description: f.description.trim() !== was.description ? f.description.trim() : live.description,
    system: f.system !== was.system ? f.system : (live.system ?? null),
    owner: f.owner !== was.owner ? f.owner : (live.owner ?? null),
    status: live.status,
  }
}

// ── The card ───────────────────────────────────────────────────────────────

/** Denied or revoked first (the customer said no), then open ones, then granted; the oldest request first in each. */
export function chaseOrder(requests: ReadonlyArray<AccessRequestOut>): Array<AccessRequestOut> {
  const rank = (s: AccessState) => (s === "granted" ? 2 : isOpen(s) ? 1 : 0)
  return [...requests].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      Date.parse(a.requested_at) - Date.parse(b.requested_at) ||
      a.id.localeCompare(b.id),
  )
}

export type Glance = {
  /** Requests not granted: open, denied or revoked. */
  notGranted: number
  total: number
  /** Who at the customer holds them up, most first; `who` is null for requests no one owns. */
  heldUp: Array<{ who: string | null; count: number }>
  /** The longest an open request has waited, in days; null when none is open. */
  longest: number | null
}

/** The three things the card answers at a glance. `name` turns a stakeholder id into who they are. */
export function glance(
  requests: ReadonlyArray<AccessRequestOut>,
  name: (id: string) => string,
): Glance {
  const stuck = requests.filter((r) => r.status !== "granted")
  const by = new Map<string | null, number>()
  for (const r of stuck) {
    const who = r.owner ? name(r.owner) : null
    by.set(who, (by.get(who) ?? 0) + 1)
  }
  const open = stuck.filter((r) => isOpen(r.status))
  return {
    notGranted: stuck.length,
    total: requests.length,
    heldUp: [...by]
      .map(([who, count]) => ({ who, count }))
      .sort(
        (a, b) =>
          // Named people first, then no one; the most requests first.
          Number(a.who === null) - Number(b.who === null) ||
          b.count - a.count ||
          (a.who ?? "").localeCompare(b.who ?? ""),
      ),
    longest: open.length === 0 ? null : Math.max(...open.map((r) => r.days_waiting)),
  }
}

/** "3 days", "less than a day". */
export const spanOf = (days: number) => (days <= 0 ? "less than a day" : plural(days, "day"))

/** Who holds the requests up, as a sentence: "Tomas Becker (2), Ines Moreau and no one named (1)". */
export function heldUpBy(held: Glance["heldUp"], shown = 3): string {
  const part = ({ who, count }: Glance["heldUp"][number]) =>
    `${who ?? "No one named"}${count > 1 ? ` (${count})` : ""}`
  const first = held.slice(0, shown).map(part)
  const more = held.length - first.length
  if (more > 0) first.push(`${more} more`)
  return first.length > 1
    ? `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}`
    : (first[0] ?? "")
}

/**
 * A request's state in one line, with how long it waited: "In progress, waiting 6 days", or when it
 * was answered and how long that took. Amber for denied, revoked and a long wait; green for granted.
 */
export function waitOf(r: AccessRequestOut): { text: string; tone: Tone } {
  const settled = shortDate(dayOf(r.status_changed_at))
  const after = r.days_waiting <= 0 ? "the same day" : `after ${plural(r.days_waiting, "day")}`
  const label = ACCESS_LABEL[r.status]
  if (isOpen(r.status))
    return {
      text: `${label}, ${waitingLabel(r.days_waiting, null).toLowerCase()}`,
      tone: r.days_waiting >= LONG_WAIT_DAYS ? "attention" : "neutral",
    }
  // For a request that was granted and then revoked, the API counts the days to the grant, not to
  // the revocation: say that, rather than "revoked after 3 days" for something revoked a month on.
  if (r.status === "revoked" && r.granted_at)
    return {
      text: `${label} ${settled}. It had been granted ${shortDate(dayOf(r.granted_at))}, ${after}.`,
      tone: ACCESS_TONE[r.status],
    }
  return { text: `${label} ${settled}, ${after}`, tone: ACCESS_TONE[r.status] }
}

/** The tasks that name this request as what blocks them. Granted, the API puts them back to do. */
export const blockedBy = (id: string, tasks: ReadonlyArray<TaskOut>) =>
  tasks.filter((t) => t.status === "blocked" && t.blocked_by === id)

/** What a blocked task can name as its blocker: any request not granted, and the one it names now. */
export function blockers(
  requests: ReadonlyArray<AccessRequestOut>,
  current: string | null,
): Array<AccessRequestOut> {
  return chaseOrder(requests).filter((r) => r.status !== "granted" || r.id === current)
}

// ── Reaching the views ─────────────────────────────────────────────────────

/** How long after a grant the tasks it unblocks are read again: the API moves them by an event. */
export const UNBLOCK_REREAD_MS = 3000

/**
 * A request the API has saved, in the project, Today and the stage checklist. Reads sent before the
 * write are dropped (they would land after it with the old request). `before` is its status until
 * now; a new request has none.
 */
export async function commitAccess(
  client: QueryClient,
  scope: ProjectScope,
  saved: AccessRequestOut,
  before?: AccessState,
) {
  await Promise.all([
    client.cancelQueries({ queryKey: queries.project(scope).queryKey }),
    client.cancelQueries({ queryKey: queries.today().queryKey }),
  ])
  client.setQueryData(
    queries.project(scope).queryKey,
    (old) =>
      old && {
        ...old,
        access: old.access.some((a) => a.id === saved.id)
          ? old.access.map((a) => (a.id === saved.id ? saved : a))
          : [...old.access, saved],
      },
  )
  client.setQueryData(
    queries.today().queryKey,
    (old) =>
      old && {
        ...old,
        items: old.items.map((item) =>
          item.kind === "access_request" && item.access.id === saved.id
            ? { ...item, access: saved }
            : item,
        ),
      },
  )
  void client.invalidateQueries({ queryKey: queries.today().queryKey })
  // "Every access request granted" is a checklist item of the Access stage.
  void client.invalidateQueries({ queryKey: queries.stageChecklist(scope).queryKey })
  // ponytail: the API puts the tasks blocked on a granted request back to do a moment later, by an
  // event. One more read after a few seconds shows it; a push from the API would replace this.
  if (saved.status === "granted" && before !== "granted")
    setTimeout(() => {
      void client.invalidateQueries({ queryKey: queries.project(scope).queryKey })
      void client.invalidateQueries({ queryKey: queries.today().queryKey })
    }, UNBLOCK_REREAD_MS)
}

// ── Decisions ──────────────────────────────────────────────────────────────

export type DecisionFields = {
  title: string
  rationale: string
  decidedBy: string
  /** `YYYY-MM-DD`. */
  decidedOn: string
}

export const blankDecision = (today = localDay()): DecisionFields => ({
  title: "",
  rationale: "",
  decidedBy: "",
  decidedOn: today,
})

export const DECISION_FIELD: Record<string, string> = {
  invalid_title: "title",
  invalid_rationale: "rationale",
  invalid_decided_by: "decidedBy",
  invalid_decided_at: "decidedOn",
}

/** What the API would refuse, in its own words, in the order the form reads. */
export function decisionProblem(f: DecisionFields, today = localDay()): Problem | null {
  if (!f.title.trim()) return at("title", "Say what was decided.")
  const title = checkName(f.title, "invalid_title", true)
  if (title) return at("title", title)
  if (!f.rationale.trim()) return at("rationale", "Say why.")
  const why = checkText(f.rationale, "invalid_rationale")
  if (why) return at("rationale", why)
  if (!f.decidedBy.trim()) return at("decidedBy", "Say who decided.")
  const who = checkName(f.decidedBy, "invalid_decided_by", true)
  if (who) return at("decidedBy", who)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.decidedOn) || f.decidedOn > today)
    return at("decidedOn", "Pick the day it was decided: today, or a day that has passed.")
  return null
}

/** A decision made today is stamped by the API with the moment it is logged; an earlier day is noon where the FDE is. */
export function decisionBody(f: DecisionFields, today = localDay()): DecisionBody {
  const [y, m, d] = f.decidedOn.split("-").map(Number)
  return {
    title: f.title.trim(),
    rationale: f.rationale.trim(),
    decided_by: f.decidedBy.trim(),
    decided_at: f.decidedOn === today ? null : new Date(y!, m! - 1, d, 12).toISOString(),
  }
}

/** The log as the API lists it: the newest decision first. */
export const newestFirst = (list: ReadonlyArray<DecisionOut>) =>
  [...list].sort(
    (a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at) || a.id.localeCompare(b.id),
  )

export const clip = (text: string, max = 80) => {
  const t = text.trim().replace(/\s+/g, " ")
  return [...t].length > max ? `${[...t].slice(0, max - 1).join("")}…` : t
}

/** What a discussion was about, in words, from what the page knows of the project's records. */
export function subjectOf(subject: ThreadOut["subject"], p: Project): string {
  const find = <T extends { id: string }>(list: ReadonlyArray<T>) =>
    list.find((r) => r.id === subject.id)
  switch (subject.kind) {
    case "access_request": {
      const r = find(p.access)
      return r ? `the access request “${clip(r.description)}”` : "an access request"
    }
    case "task": {
      const r = find(p.tasks)
      return r ? `the task “${clip(r.title)}”` : "a task"
    }
    case "stakeholder": {
      const r = find(p.stakeholders)
      return r ? r.name : "a stakeholder"
    }
    case "system": {
      const r = find(p.systems)
      return r ? r.name : "a system"
    }
    case "scope_item": {
      const r = find(p.scope.items)
      return r ? `the scope item “${clip(r.description)}”` : "a scope item"
    }
    case "criterion": {
      const r = find(p.scope.criteria)
      return r ? `the criterion “${clip(r.description)}”` : "a success criterion"
    }
    case "decision":
      return "another decision"
    case "document":
      return "a document"
    case "meeting_note":
      return "a meeting note"
    case "shape":
      return "a shape on the canvas"
  }
}

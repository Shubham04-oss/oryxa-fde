import type { QueryClient } from "@tanstack/react-query"
import { SAFE_TEXT, queries } from "./api/client"
import type { components } from "./api/fde-api.gen"
import type {
  CompanyId,
  CompanyOut,
  CompanyRole,
  Me,
  ProjectOut,
  ProjectScope,
  StakeholderOut,
  StakeholderPart,
  SystemOut,
} from "./api/schemas"
import { reason } from "./task-move"

// What the company and project forms share (DESIGN.md §3): what each form holds and sends, the
// checks the API makes (so a mistake is caught before the wire, in the API's own words), who may
// do what, and how a saved record reaches every cached view of it.

export type CompanyBody = components["schemas"]["CompanyBody"]
export type CompanyPatch = components["schemas"]["CompanyPatch"]
export type ProjectBody = components["schemas"]["ProjectBody"]
export type ProjectPatch = components["schemas"]["ProjectPatch"]
export type StakeholderBody = components["schemas"]["StakeholderBody"]
export type SystemBody = components["schemas"]["SystemBody"]

export const MAX_NAME = 200
export const MAX_TEXT = 4000

// eslint-disable-next-line no-control-regex
const NAME_CONTROL = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

const length = (value: string) => [...value].length
export const say = (code: string) => SAFE_TEXT[code] ?? "Check what you typed."

/** A name: one line. A blank optional one is fine and is left out or cleared. */
export function checkName(value: string, code: string, required: boolean) {
  const v = value.trim()
  if (!v) return required ? say("invalid_name") : null
  return length(v) > MAX_NAME || NAME_CONTROL.test(v) ? say(code) : null
}

/** Text: several lines, up to the limit. */
export function checkText(value: string, code: string) {
  const v = value.trim()
  return length(v) > MAX_TEXT || TEXT_CONTROL.test(v) ? say(code) : null
}

// The API's address rule, in short: one @, up to 64 characters before it, a dotted domain after it,
// no spaces, 254 characters at most.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/
const checkEmail = (value: string) => {
  const v = value.trim()
  return !v || (v.length <= 254 && EMAIL.test(v)) ? null : say("invalid_email")
}

/** A form's blank is "not set", which the API stores as null. */
const clean = (value: string) => value.trim() || null

/** `noun` finishes the empty-name message: "Name the company." */
const named = (value: string, noun: string, code = "invalid_name") =>
  value.trim() ? checkName(value, code, true) : `Name the ${noun}.`

// ── Company ────────────────────────────────────────────────────────────────

export type CompanyFields = { name: string; industry: string; region: string; summary: string }

export const companyFields = (c?: CompanyOut): CompanyFields => ({
  name: c?.name ?? "",
  industry: c?.industry ?? "",
  region: c?.region ?? "",
  summary: c?.summary ?? "",
})

export const companyProblem = (f: CompanyFields) =>
  named(f.name, "company") ??
  checkName(f.industry, "invalid_industry", false) ??
  checkName(f.region, "invalid_region", false) ??
  checkText(f.summary, "invalid_summary")

/** A new company: what is blank is left out. */
export function companyBody(f: CompanyFields): CompanyBody {
  return {
    name: f.name.trim(),
    industry: clean(f.industry),
    region: clean(f.region),
    summary: clean(f.summary),
  }
}

/** The fields that changed, and only those: a PATCH leaves the rest as they are, so an edit cannot undo a teammate's. */
export function companyPatch(before: CompanyOut, f: CompanyFields): CompanyPatch {
  const was = companyFields(before)
  const patch: CompanyPatch = {}
  if (f.name.trim() !== was.name) patch.name = f.name.trim()
  if (f.industry.trim() !== was.industry) patch.industry = clean(f.industry)
  if (f.region.trim() !== was.region) patch.region = clean(f.region)
  if (f.summary.trim() !== was.summary) patch.summary = clean(f.summary)
  return patch
}

// ── Project ────────────────────────────────────────────────────────────────

export type ProjectFields = { name: string; summary: string }

export type ProjectRecord = Pick<ProjectOut, "id" | "name" | "summary">

export const projectFields = (p?: ProjectRecord): ProjectFields => ({
  name: p?.name ?? "",
  summary: p?.summary ?? "",
})

export const projectProblem = (f: ProjectFields) =>
  named(f.name, "project") ?? checkText(f.summary, "invalid_summary")

export const projectBody = (f: ProjectFields): ProjectBody => ({
  name: f.name.trim(),
  summary: clean(f.summary),
})

export function projectPatch(before: ProjectRecord, f: ProjectFields): ProjectPatch {
  const was = projectFields(before)
  const patch: ProjectPatch = {}
  if (f.name.trim() !== was.name) patch.name = f.name.trim()
  if (f.summary.trim() !== was.summary) patch.summary = clean(f.summary)
  return patch
}

// ── Stakeholder and system ─────────────────────────────────────────────────

export const PART_LABEL: Record<StakeholderPart, string> = {
  sponsor: "Sponsor",
  champion: "Champion",
  user: "User",
  it: "IT",
  security: "Security",
  other: "Other",
}

export type StakeholderFields = {
  name: string
  role: StakeholderPart
  title: string
  email: string
}

export const stakeholderFields = (s?: StakeholderOut): StakeholderFields => ({
  name: s?.name ?? "",
  role: s?.role ?? "other",
  title: s?.title ?? "",
  email: s?.email ?? "",
})

export const stakeholderProblem = (f: StakeholderFields) =>
  named(f.name, "stakeholder") ?? checkName(f.title, "invalid_title", false) ?? checkEmail(f.email)

/** Every field, for the API's whole-record `PUT`: what the form does not change goes back as it was. */
export const stakeholderBody = (f: StakeholderFields): StakeholderBody => ({
  name: f.name.trim(),
  role: f.role,
  title: clean(f.title),
  email: clean(f.email),
})

export type SystemFields = { name: string; kind: string; description: string }

export const systemFields = (s?: SystemOut): SystemFields => ({
  name: s?.name ?? "",
  kind: s?.kind ?? "",
  description: s?.description ?? "",
})

export const systemProblem = (f: SystemFields) =>
  named(f.name, "system") ??
  checkName(f.kind, "invalid_kind", false) ??
  checkText(f.description, "invalid_description")

export const systemBody = (f: SystemFields): SystemBody => ({
  name: f.name.trim(),
  kind: clean(f.kind),
  description: clean(f.description),
})

// ── Who may do what ────────────────────────────────────────────────────────

/**
 * Changing a company, its projects and its members needs `manage`: its lead, or an organisation
 * admin (schema/fde.zed). The API still decides; this only decides what is offered.
 */
export const canManage = (me: Me | undefined, role: CompanyRole | null | undefined) =>
  me?.role === "admin" || role === "lead"

// ── Saving ─────────────────────────────────────────────────────────────────

/** What a dialog's Save does: null when the API confirmed it, or why it did not, in words. */
export async function attempt(work: () => Promise<unknown>, what: string) {
  try {
    await work()
    return null
  } catch (e) {
    return reason(e, what)
  }
}

const COMPANIES = ["companies"] as const

/**
 * Drops the reads of companies and projects sent before a write: they would land after it with
 * the old record, and bring it back.
 */
function settle(client: QueryClient) {
  return client.cancelQueries({ queryKey: COMPANIES })
}

/** Reads again what a rename or a new record reaches: every company and project view, Today and runs. */
function refresh(client: QueryClient) {
  for (const key of [COMPANIES, ["today"], ["runs", "active"]])
    void client.invalidateQueries({ queryKey: key })
}

/** A company the API has created: in the list (so the sidebar and Jump to have it) and ready to open. */
export async function commitCompanyCreated(client: QueryClient, created: CompanyOut) {
  await settle(client)
  const lead: CompanyRole = "lead"
  client.setQueryData(queries.companies().queryKey, (old) =>
    old ? { companies: [...old.companies, { ...created, role: lead, projects: [] }] } : old,
  )
  client.setQueryData(queries.company(created.id).queryKey, {
    ...created,
    role: lead,
    projects: [],
    stakeholders: [],
    systems: [],
  })
  refresh(client)
}

/** A company the API has changed. */
export async function commitCompanyChanged(client: QueryClient, saved: CompanyOut) {
  await settle(client)
  client.setQueryData(queries.company(saved.id).queryKey, (old) => old && { ...old, ...saved })
  client.setQueryData(
    queries.companies().queryKey,
    (old) =>
      old && {
        companies: old.companies.map((c) => (c.id === saved.id ? { ...c, ...saved } : c)),
      },
  )
  refresh(client)
}

/** A project the API has created, in its company's page and list. */
export async function commitProjectCreated(client: QueryClient, created: ProjectOut) {
  await settle(client)
  client.setQueryData(
    queries.company(created.company).queryKey,
    (old) => old && { ...old, projects: [...old.projects, created] },
  )
  const summary = { id: created.id, name: created.name, stage: created.stage }
  client.setQueryData(
    queries.companies().queryKey,
    (old) =>
      old && {
        companies: old.companies.map((c) =>
          c.id === created.company ? { ...c, projects: [...c.projects, summary] } : c,
        ),
      },
  )
  refresh(client)
}

/** A project the API has changed (its name or summary). */
export async function commitProjectChanged(
  client: QueryClient,
  scope: ProjectScope,
  saved: ProjectOut,
) {
  await settle(client)
  const { name, summary, updated_at } = saved
  client.setQueryData(
    queries.project(scope).queryKey,
    (old) => old && { ...old, name, summary, updated_at },
  )
  client.setQueryData(
    queries.company(scope.company).queryKey,
    (old) =>
      old && {
        ...old,
        projects: old.projects.map((p) => (p.id === saved.id ? { ...p, name, summary } : p)),
      },
  )
  client.setQueryData(
    queries.companies().queryKey,
    (old) =>
      old && {
        companies: old.companies.map((c) =>
          c.id === scope.company
            ? { ...c, projects: c.projects.map((p) => (p.id === saved.id ? { ...p, name } : p)) }
            : c,
        ),
      },
  )
  refresh(client)
}

/**
 * A stakeholder or system the API has saved (`record`) or removed (`gone`, its id), in the
 * company's page. Other views of the company's people (a project's board) read again.
 */
export async function commitRecord(
  client: QueryClient,
  company: CompanyId,
  key: "stakeholders" | "systems",
  change: { saved: StakeholderOut | SystemOut } | { gone: string },
) {
  await settle(client)
  client.setQueryData(queries.company(company).queryKey, (old) => {
    if (!old) return old
    const list: Array<{ id: string }> = old[key]
    const next =
      "gone" in change
        ? list.filter((r) => r.id !== change.gone)
        : list.some((r) => r.id === change.saved.id)
          ? list.map((r) => (r.id === change.saved.id ? change.saved : r))
          : [...list, change.saved]
    return { ...old, [key]: next }
  })
  // A removed stakeholder also leaves the access owners and waiting tasks that named them.
  refresh(client)
}

/** A change to who is on a company or a project: read again where it shows. */
export async function commitPeople(client: QueryClient) {
  await settle(client)
  refresh(client)
}

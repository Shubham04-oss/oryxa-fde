import type { QueryClient } from "@tanstack/react-query"
import { queries } from "./api/client"
import type { components } from "./api/fde-api.gen"
import type {
  CriterionOut,
  ProjectScope,
  ScopeItemOut,
  ScopeOut,
  SignOffOut,
  StakeholderOut,
} from "./api/schemas"
import { checkName, checkText, say } from "./records"
import type { Labels } from "./stale"

// What the scope forms hold and send, the checks the API makes, and how a saved change reaches the
// project page (DESIGN.md §3, Scope and Success criteria). The API takes each item and criterion
// on its own; every change to one bumps the scope's version, which is what "changed since sign-off"
// is: the latest sign-off covers one version, and the scope has moved on.

export type ScopeItemBody = Omit<components["schemas"]["ScopeItemBody"], "version">
export type CriterionBody = Omit<components["schemas"]["CriterionBody"], "version">
/**
 * What every criterion save sends: the API's `PUT` clears a field it is not sent, so each optional one
 * is always there (null to clear it), and a save can never drop a baseline or a proof by leaving it out.
 */
export type CriterionSave = CriterionBody &
  Required<Pick<CriterionBody, "unit" | "baseline" | "proof">>

export type ItemKind = ScopeItemOut["kind"]
export type Comparator = CriterionOut["comparator"]

export const KIND_LABEL: Record<ItemKind, string> = { in: "In scope", out: "Out of scope" }
export const COMPARATOR_LABEL: Record<Comparator, string> = {
  at_least: "At least",
  at_most: "At most",
}

// ── Items ──────────────────────────────────────────────────────────────────

export type ItemFields = { kind: ItemKind; description: string }

export const itemFields = (item?: ScopeItemOut, kind: ItemKind = "in"): ItemFields => ({
  kind: item?.kind ?? kind,
  description: item?.description ?? "",
})

/** Each field's name in a sentence, when a stale save says which differ (`lib/stale.ts`). */
export const ITEM_LABELS: Labels<ItemFields> = {
  kind: "side it is listed on",
  description: "description",
}

export const itemProblem = (f: ItemFields) =>
  f.description.trim()
    ? checkText(f.description, "invalid_description")
    : f.kind === "in"
      ? "Write what is in scope."
      : "Write what is out of scope."

export const itemBody = (f: ItemFields): ScopeItemBody => ({
  kind: f.kind,
  description: f.description.trim(),
})

/**
 * Whether saving would change anything. The API counts every save as a change to the scope, even
 * one that says the same thing, and a signed-off scope would then need signing again for nothing.
 */
export const itemChanged = (before: ScopeItemOut, f: ItemFields) =>
  before.kind !== f.kind || before.description.trim() !== f.description.trim()

// ── Criteria ───────────────────────────────────────────────────────────────

export type CriterionFields = {
  description: string
  metric: string
  comparator: Comparator
  /** Typed as text and read as a number, so what is in the box is what is checked. */
  target: string
  unit: string
  /** The value measured before the work, in the target's unit; typed as text, blank for none. */
  baseline: string
  /** How it will be proven, in a few words; blank for not said. */
  proof: string
}

/** A number as the box shows it: always decimal (`String` writes 1e-7), so the box reads it back the same. */
function decimalText(n: number) {
  const text = String(n)
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text)
  if (!m) return text
  const [, sign, lead, rest = "", exp] = m
  const digits = `${lead}${rest}`
  // Where the point goes among the digits.
  const point = 1 + Number(exp)
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`
  const whole = digits.padEnd(point, "0")
  return point < digits.length
    ? `${sign}${whole.slice(0, point)}.${digits.slice(point)}`
    : `${sign}${whole}`
}

export const criterionFields = (c?: CriterionOut): CriterionFields => ({
  description: c?.description ?? "",
  metric: c?.metric ?? "",
  comparator: c?.comparator ?? "at_least",
  target: c ? decimalText(c.target) : "",
  unit: c?.unit ?? "",
  baseline: c?.baseline == null ? "" : decimalText(c.baseline),
  proof: c?.proof ?? "",
})

/** The API's limit on how a criterion will be proven. */
export const MAX_PROOF = 500
// Newlines and tabs only: Rust's `char::is_control` is C0, DEL and C1.
// eslint-disable-next-line no-control-regex
const PROOF_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

/** A decimal number as a person types it: digits, a point, a sign. No `0x10`, `1e3` or `Infinity`. */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/

/** The number in a number box (the target, the baseline), or null when it is not a decimal one. */
export function targetOf(text: string): number | null {
  const v = text.trim()
  if (!DECIMAL.test(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Why a number box cannot be read, or null: a comma is said plainly, never read as something else. */
export function numberProblem(text: string, code: "invalid_target" | "invalid_baseline") {
  if (targetOf(text) !== null) return null
  return text.includes(",") ? "Use a point for decimals, such as 1.5, and no commas." : say(code)
}

export function criterionProblem(f: CriterionFields) {
  if (!f.description.trim()) return "Say what must be true."
  const said = checkText(f.description, "invalid_description")
  if (said) return said
  if (!f.metric.trim()) return "Say what is measured."
  const proof = f.proof.trim()
  return (
    checkName(f.metric, "invalid_metric", true) ??
    numberProblem(f.target, "invalid_target") ??
    checkName(f.unit, "invalid_unit", false) ??
    (f.baseline.trim() ? numberProblem(f.baseline, "invalid_baseline") : null) ??
    ([...proof].length > MAX_PROOF || PROOF_CONTROL.test(proof) ? say("invalid_proof") : null)
  )
}

/** The API's body: every field, as `PUT` replaces the criterion. A blank unit, baseline or proof is none. */
export function criterionBody(f: CriterionFields): CriterionSave {
  return {
    description: f.description.trim(),
    metric: f.metric.trim(),
    comparator: f.comparator,
    target: targetOf(f.target) ?? 0,
    unit: f.unit.trim() || null,
    baseline: targetOf(f.baseline),
    proof: f.proof.trim() || null,
  }
}

export const CRITERION_LABELS: Labels<CriterionFields> = {
  description: "sentence",
  metric: "measure",
  comparator: "comparison",
  target: "target",
  unit: "unit",
  baseline: "baseline",
  proof: "how it will be proven",
}

export const criterionChanged = (before: CriterionOut, f: CriterionFields) => {
  const was = criterionFields(before)
  return (
    was.description.trim() !== f.description.trim() ||
    was.metric.trim() !== f.metric.trim() ||
    was.comparator !== f.comparator ||
    before.target !== targetOf(f.target) ||
    was.unit.trim() !== f.unit.trim() ||
    proofChanged(before, f)
  )
}

/** Whether the baseline or how it will be proven would change: both are part of what is signed off. */
export const proofChanged = (before: CriterionOut | undefined, f: CriterionFields) =>
  (before?.baseline ?? null) !== targetOf(f.baseline) ||
  (before?.proof ?? "").trim() !== f.proof.trim()

/** "70%", "2 min", "0.7": a number in a criterion's unit. */
export function inUnit(n: number, unit: string | null | undefined) {
  return `${n}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`
}

/** "plans accepted unchanged is at least 70%": what a criterion measures and how far it must go. */
export function measure(c: Pick<CriterionOut, "metric" | "comparator" | "target" | "unit">) {
  return `${c.metric} is ${COMPARATOR_LABEL[c.comparator].toLowerCase()} ${inUnit(c.target, c.unit)}`
}

// ── Sign-off ───────────────────────────────────────────────────────────────

/** Never signed, signed for the scope as it is, or signed before it changed. */
export type SignOffState = "none" | "signed" | "changed"

export const signOffState = (s: Pick<ScopeOut, "sign_off" | "signed_off">): SignOffState =>
  !s.sign_off ? "none" : s.signed_off ? "signed" : "changed"

/** Changes saved since the sign-off: the version moves by one for each. */
export const changesSince = (s: Pick<ScopeOut, "version" | "sign_off">) =>
  s.sign_off ? Math.max(0, s.version - s.sign_off.version) : 0

/** One change to the scope since it was read: a record added, changed or removed. */
export type ScopeChange = { change: "added" | "changed" | "removed"; text: string }

const clip = (text: string, max = 80) => {
  const t = text.trim().replace(/\s+/g, " ")
  return [...t].length > max ? `${[...t].slice(0, max - 1).join("")}…` : t
}

/**
 * What changed between the scope a person read (`read`) and the scope as it stands (`now`), record
 * by record: a record whose version moved, or that was not there, or that is gone. It is how a stale
 * sign-off tells them what they had not read.
 */
export function scopeChanges(read: ScopeOut, now: ScopeOut): Array<ScopeChange> {
  const describe = (r: ScopeItemOut | CriterionOut) =>
    "kind" in r
      ? `${KIND_LABEL[r.kind]}: ${clip(r.description)}`
      : `Criterion: ${clip(r.description)}`
  const diff = (before: ReadonlyArray<ScopeItemOut | CriterionOut>, after: typeof before) => {
    const was = new Map(before.map((r) => [r.id, r]))
    const out: Array<ScopeChange> = []
    for (const r of after) {
      const old = was.get(r.id)
      if (!old) out.push({ change: "added", text: describe(r) })
      else if (old.version !== r.version) out.push({ change: "changed", text: describe(r) })
    }
    for (const r of before)
      if (!after.some((x) => x.id === r.id)) out.push({ change: "removed", text: describe(r) })
    return out
  }
  return [...diff(read.items, now.items), ...diff(read.criteria, now.criteria)]
}

/** Sponsors first, then the rest by name: the person who signs is usually the sponsor. */
export const signers = (people: ReadonlyArray<StakeholderOut>) =>
  [...people].sort(
    (a, b) =>
      Number(b.role === "sponsor") - Number(a.role === "sponsor") || a.name.localeCompare(b.name),
  )

/** Why no one can be chosen to sign off, or null. (The API also refuses an empty scope, with a 409.) */
export const cannotSignOff = (people: number) =>
  people === 0 ? "Add the person who signs off to the company's stakeholders first." : null

// ── Saving ─────────────────────────────────────────────────────────────────

const projectKey = (scope: ProjectScope) => queries.project(scope).queryKey

/**
 * Puts a change the API confirmed into the project's scope, then reads it again. Any change moves
 * the version on and leaves the last sign-off behind, so a signed-off scope is no longer signed off.
 */
export async function commitScope(
  client: QueryClient,
  scope: ProjectScope,
  edit: (old: ScopeOut) => Pick<ScopeOut, "items" | "criteria">,
) {
  // A read sent before the write would land after it with the old scope and bring it back.
  await client.cancelQueries({ queryKey: projectKey(scope) })
  client.setQueryData(
    projectKey(scope),
    (old) =>
      old && {
        ...old,
        scope: {
          ...old.scope,
          ...edit(old.scope),
          version: old.scope.version + 1,
          signed_off: false,
        },
      },
  )
  void client.invalidateQueries({ queryKey: projectKey(scope) })
}

const upsert = <T extends { id: string }>(list: Array<T>, saved: T) =>
  list.some((x) => x.id === saved.id)
    ? list.map((x) => (x.id === saved.id ? saved : x))
    : [...list, saved]

/**
 * A record the API answered a stale save with, in the project's scope. It is the record as it stands,
 * not a change of ours, so the scope's version is not moved on here: the project is read again for it.
 */
async function adopt(
  client: QueryClient,
  scope: ProjectScope,
  edit: (old: ScopeOut) => Pick<ScopeOut, "items" | "criteria">,
) {
  await client.cancelQueries({ queryKey: projectKey(scope) })
  client.setQueryData(
    projectKey(scope),
    (old) => old && { ...old, scope: { ...old.scope, ...edit(old.scope) } },
  )
  void client.invalidateQueries({ queryKey: projectKey(scope) })
}

export const adoptItem = (client: QueryClient, scope: ProjectScope, current: ScopeItemOut) =>
  adopt(client, scope, (s) => ({ items: upsert(s.items, current), criteria: s.criteria }))

export const adoptCriterion = (client: QueryClient, scope: ProjectScope, current: CriterionOut) =>
  adopt(client, scope, (s) => ({ items: s.items, criteria: upsert(s.criteria, current) }))

export const commitItem = (client: QueryClient, scope: ProjectScope, saved: ScopeItemOut) =>
  commitScope(client, scope, (s) => ({ items: upsert(s.items, saved), criteria: s.criteria }))

export const commitItemGone = (client: QueryClient, scope: ProjectScope, id: string) =>
  commitScope(client, scope, (s) => ({
    items: s.items.filter((x) => x.id !== id),
    criteria: s.criteria,
  }))

export const commitCriterion = (client: QueryClient, scope: ProjectScope, saved: CriterionOut) =>
  commitScope(client, scope, (s) => ({ items: s.items, criteria: upsert(s.criteria, saved) }))

export const commitCriterionGone = (client: QueryClient, scope: ProjectScope, id: string) =>
  commitScope(client, scope, (s) => ({
    items: s.items,
    criteria: s.criteria.filter((x) => x.id !== id),
  }))

/** A sign-off the API recorded: it covers the scope only if the version is still the one it signed. */
export async function commitSignOff(client: QueryClient, scope: ProjectScope, signed: SignOffOut) {
  await client.cancelQueries({ queryKey: projectKey(scope) })
  client.setQueryData(
    projectKey(scope),
    (old) =>
      old && {
        ...old,
        scope: { ...old.scope, sign_off: signed, signed_off: signed.version === old.scope.version },
      },
  )
  void client.invalidateQueries({ queryKey: projectKey(scope) })
}

/** A scope read afresh (the sign-off found it had moved): what the page shows from now on. */
export async function commitFreshScope(client: QueryClient, scope: ProjectScope, fresh: ScopeOut) {
  await client.cancelQueries({ queryKey: projectKey(scope) })
  client.setQueryData(projectKey(scope), (old) => old && { ...old, scope: fresh })
  // The checklist judges the scope too: a sign-off found there changes what is open.
  void client.invalidateQueries({ queryKey: queries.stageChecklist(scope).queryKey })
}

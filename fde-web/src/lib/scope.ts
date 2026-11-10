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

// What the scope forms hold and send, the checks the API makes, and how a saved change reaches the
// project page (DESIGN.md §3, Scope and Success criteria). The API takes each item and criterion
// on its own; every change to one bumps the scope's version, which is what "changed since sign-off"
// is: the latest sign-off covers one version, and the scope has moved on.

export type ScopeItemBody = components["schemas"]["ScopeItemBody"]
export type CriterionBody = components["schemas"]["CriterionBody"]

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
}

export const criterionFields = (c?: CriterionOut): CriterionFields => ({
  description: c?.description ?? "",
  metric: c?.metric ?? "",
  comparator: c?.comparator ?? "at_least",
  target: c ? String(c.target) : "",
  unit: c?.unit ?? "",
})

/** The number in the target box, or null when it is not a finite one. */
export function targetOf(text: string): number | null {
  const v = text.trim()
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function criterionProblem(f: CriterionFields) {
  if (!f.description.trim()) return "Say what must be true."
  const said = checkText(f.description, "invalid_description")
  if (said) return said
  if (!f.metric.trim()) return "Say what is measured."
  return (
    checkName(f.metric, "invalid_metric", true) ??
    (targetOf(f.target) === null ? say("invalid_target") : null) ??
    checkName(f.unit, "invalid_unit", false)
  )
}

/** The API's body: every field, as `PUT` replaces the criterion. A blank unit is none. */
export function criterionBody(f: CriterionFields): CriterionBody {
  return {
    description: f.description.trim(),
    metric: f.metric.trim(),
    comparator: f.comparator,
    target: targetOf(f.target) ?? 0,
    unit: f.unit.trim() || null,
  }
}

export const criterionChanged = (before: CriterionOut, f: CriterionFields) => {
  const was = criterionFields(before)
  return (
    was.description.trim() !== f.description.trim() ||
    was.metric.trim() !== f.metric.trim() ||
    was.comparator !== f.comparator ||
    before.target !== targetOf(f.target) ||
    was.unit.trim() !== f.unit.trim()
  )
}

/** "plans accepted unchanged is at least 70%": what a criterion measures and how far it must go. */
export function measure(c: Pick<CriterionOut, "metric" | "comparator" | "target" | "unit">) {
  const unit = c.unit ? (c.unit === "%" ? "%" : ` ${c.unit}`) : ""
  return `${c.metric} is ${COMPARATOR_LABEL[c.comparator].toLowerCase()} ${c.target}${unit}`
}

// ── Sign-off ───────────────────────────────────────────────────────────────

/** Never signed, signed for the scope as it is, or signed before it changed. */
export type SignOffState = "none" | "signed" | "changed"

export const signOffState = (s: Pick<ScopeOut, "sign_off" | "signed_off">): SignOffState =>
  !s.sign_off ? "none" : s.signed_off ? "signed" : "changed"

/** Changes saved since the sign-off: the version moves by one for each. */
export const changesSince = (s: Pick<ScopeOut, "version" | "sign_off">) =>
  s.sign_off ? Math.max(0, s.version - s.sign_off.version) : 0

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

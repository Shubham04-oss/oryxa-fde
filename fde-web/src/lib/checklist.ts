import type { QueryClient } from "@tanstack/react-query"
import { queries } from "./api/client"
import type { ChecklistItem, Project, ProjectScope } from "./api/schemas"
import { STAGE_LABEL } from "./stage"

// What the stage checklist says on the project page (DESIGN.md §3): for each item the API names,
// what is missing in plain words and where on this page (or the company's) it is put right. The
// API sends a stable key and a label; the words and the places are the page's.

/** Where an open item is fixed. Each is a thing the project page can do. */
export type Fix =
  /** The company page, with Add stakeholder open. */
  | "add-stakeholder"
  | "add-in-scope"
  | "add-out-of-scope"
  | "sign-off"
  | "add-criterion"
  /** Scroll to the Success criteria card and focus it. */
  | "criteria"
  /** Scroll to the Access card and focus it. */
  | "access"

export type Hint = {
  /** What is missing, in a sentence. */
  missing: string
  /** The button that goes to where it is fixed, and where it goes; none when this page has no way yet. */
  fix?: { do: Fix; label: string }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** `undefined` for a key this page does not know: it shows the API's label and nothing to press. */
export function hintFor(key: string, p: Project): Hint | undefined {
  const customer = p.company.name
  const s = p.scope
  const people = p.stakeholders.length
  const criteria = s.criteria.length
  switch (key) {
    case "stakeholders_named":
      return {
        missing: `No one is named at ${customer} yet.`,
        fix: { do: "add-stakeholder", label: "Add stakeholder" },
      }
    case "discovery_notes":
      // ponytail: meeting notes have no screen yet, so there is nowhere on this page to write one.
      return { missing: "No meeting note is on the project yet. Notes are not written here yet." }
    case "scope_signed_off": {
      if (people === 0)
        return {
          missing: `No one is named at ${customer} to sign it off.`,
          fix: { do: "add-stakeholder", label: "Add stakeholder" },
        }
      if (s.items.length === 0 && criteria === 0)
        return {
          missing: "The scope is empty, so there is nothing to sign off.",
          fix: { do: "add-in-scope", label: "Add to scope" },
        }
      return {
        missing: s.sign_off
          ? "The scope changed after it was signed off, so it needs signing off again."
          : `${customer} has not signed off the scope.`,
        fix: { do: "sign-off", label: s.sign_off ? "Sign off again" : "Record sign-off" },
      }
    }
    case "out_of_scope_listed":
      return {
        missing: "Nothing is listed as out of scope.",
        fix: { do: "add-out-of-scope", label: "Add out of scope" },
      }
    case "criteria_have_targets":
      return {
        missing: "There are no success criteria yet. Each needs a target.",
        fix: { do: "add-criterion", label: "Add criterion" },
      }
    case "access_granted": {
      const waiting = p.access.filter((a) => a.status !== "granted").length
      return {
        missing:
          waiting === 0
            ? "An access request is not granted yet."
            : `${plural(waiting, "access request")} not granted yet.`,
        fix: { do: "access", label: "Go to Access" },
      }
    }
    case "criteria_have_evals":
      return criteria === 0
        ? {
            missing: "There are no success criteria for an eval suite to measure.",
            fix: { do: "add-criterion", label: "Add criterion" },
          }
        : {
            missing: "Some success criteria have no eval suite measuring them yet.",
            fix: { do: "criteria", label: "Go to criteria" },
          }
    case "criteria_met":
      return criteria === 0
        ? {
            missing: "There are no success criteria to meet.",
            fix: { do: "add-criterion", label: "Add criterion" },
          }
        : {
            missing: "Not every criterion has a result that meets its target yet.",
            fix: { do: "criteria", label: "Go to criteria" },
          }
    default:
      return undefined
  }
}

/** "Scope has 1 item open." for a heading; empty when none is. */
export const openCount = (items: ReadonlyArray<ChecklistItem>) =>
  items.filter((item) => !item.met).length

/** The count a heading shows: "1 of 3 met". */
export const metSummary = (items: ReadonlyArray<ChecklistItem>) =>
  `${items.length - openCount(items)} of ${items.length} met`

export const checklistTitle = (stage: keyof typeof STAGE_LABEL) => `To leave ${STAGE_LABEL[stage]}`

const checklistKey = (scope: ProjectScope) => queries.stageChecklist(scope).queryKey

/**
 * The checklist reads again after a record it depends on changed on this page. A read sent before
 * the write would land after it with the old answer, so those are dropped first.
 */
export async function refreshChecklist(client: QueryClient, scope: ProjectScope) {
  await client.cancelQueries({ queryKey: checklistKey(scope) })
  void client.invalidateQueries({ queryKey: checklistKey(scope) })
}

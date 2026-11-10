import type { ChecklistItem, Project } from "./api/schemas"

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
  /** Scroll to the Proof card and focus it. */
  | "proof"
  /** Scroll to the Access card and focus it. */
  | "access"
  /** The Access card's blank request form. */
  | "request-access"
  /** The Notes card's blank note. */
  | "write-note"

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
      // The API counts a note on the project only: one written on the company does not meet it.
      return {
        missing: "No meeting note is on the project yet. A note on the company does not count.",
        fix: { do: "write-note", label: "Write a note" },
      }
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
      // The API counts no requests as met, so this is for a view that has not caught up with a request removed or not yet read.
      if (p.access.length === 0)
        return {
          missing: "No access has been requested yet.",
          fix: { do: "request-access", label: "Request access" },
        }
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
            fix: { do: "proof", label: "Go to proof" },
          }
    case "criteria_met":
      return criteria === 0
        ? {
            missing: "There are no success criteria to meet.",
            fix: { do: "add-criterion", label: "Add criterion" },
          }
        : {
            missing: "Not every criterion has a result that meets its target yet.",
            fix: { do: "proof", label: "Go to proof" },
          }
    default:
      return undefined
  }
}

/** How many items are still open. */
export const openCount = (items: ReadonlyArray<ChecklistItem>) =>
  items.filter((item) => !item.met).length

/** The count a heading shows: "1 of 3 met". */
export const metSummary = (items: ReadonlyArray<ChecklistItem>) =>
  `${items.length - openCount(items)} of ${items.length} met`

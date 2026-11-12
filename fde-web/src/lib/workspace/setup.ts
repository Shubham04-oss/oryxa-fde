import { readyToCreate } from "./new-company"
import type { Answers, StepId } from "./new-company"
import { ApiError, SAFE_TEXT } from "@/lib/api/client"
import type { SetupBody, SetupRequest } from "@/lib/api/client"
import { checkName, companyBody, projectBody } from "@/lib/records"
import { criterionBody } from "@/lib/scope"

// The new-company conversation, saved in one call (issue #249, `POST /v1/companies/setup`). One
// typed function maps the answers to the API's body; an answer the API has no field for (rules for
// agents, invitations, who a step is with) is left out, never squeezed into another field, and the
// review says so. Nothing here sends anything: the review's Create company does, once.

/**
 * Everything the conversation confirmed, as the API takes it, or null while a required answer is
 * missing. The plan's steps are tasks in order, each on its stage, and the one criterion is linked
 * by its place in `criteria`. What is delivered is the first project's summary.
 */
export function setupBody(answers: Answers): SetupBody | null {
  const c = answers.company
  const start = answers.start
  if (!c || !start || !answers.plan || !readyToCreate(answers)) return null
  const contact = start.contact.trim()
  const criteria = start.criterion.description.trim() ? [criterionBody(start.criterion)] : []
  return {
    company: companyBody({ ...c, summary: "" }),
    project: projectBody({ name: c.project, summary: c.summary }),
    stakeholders: contact ? [{ name: contact }] : [],
    main_contact: contact ? 0 : null,
    // The conversation asks for no scope items yet.
    scope_items: [],
    criteria,
    plan: answers.plan.map((step) => ({
      title: step.title.trim(),
      stage: step.stage,
      criterion: step.criterion && criteria.length > 0 ? 0 : null,
    })),
  }
}

/** One key for a retry: what the API's `Idempotency-Key` takes (1 to 128 of `A-Za-z0-9-_`). */
export const newKey = () => `setup-${crypto.randomUUID()}`

/**
 * The request to send: the same key and the same bytes as `earlier` when the body is identical (a
 * double click, or Try again), and a new key for a body that changed. The API hashes the raw bytes,
 * so the serialized body is kept and sent as it is, never rebuilt.
 */
export function prepare(
  body: SetupBody,
  earlier: SetupRequest | null,
  key: () => string = newKey,
): SetupRequest {
  const json = JSON.stringify(body)
  return earlier?.json === json ? earlier : { key: key(), body, json }
}

/** A part of the setup the review lists, and the step where it is changed. */
export type Part = "company" | "project" | "contact" | "criterion" | "plan"

export const STEP_OF: Record<Part, StepId> = {
  company: "company",
  project: "company",
  contact: "start",
  criterion: "start",
  plan: "plan",
}

/** The API's `invalid_*` codes that name one part. `invalid_name` names three, so it is worked out. */
const PART_OF: Record<string, Part> = {
  invalid_industry: "company",
  invalid_region: "company",
  // The company's summary is never sent: what is delivered is the project's.
  invalid_summary: "project",
  invalid_stakeholders: "contact",
  invalid_main_contact: "contact",
  invalid_email: "contact",
  invalid_role: "contact",
  // A stakeholder's title is never sent, so a title is a step's.
  invalid_title: "plan",
  invalid_criteria: "criterion",
  invalid_description: "criterion",
  invalid_metric: "criterion",
  invalid_comparator: "criterion",
  invalid_target: "criterion",
  invalid_unit: "criterion",
  invalid_baseline: "criterion",
  invalid_proof: "criterion",
  invalid_plan: "plan",
  invalid_due_on: "plan",
  invalid_criterion: "plan",
}

/** Words for this call's refusals where the shared ones would mislead. */
const SETUP_TEXT: Record<string, string> = {
  invalid_name: "A name is one line, 1 to 200 characters.",
  invalid_title: "Each step's title is one line, up to 200 characters.",
  invalid_plan: "A plan has at most 30 steps.",
  invalid_criterion: "A step works towards a criterion that is not in this setup.",
  invalid_criteria: "A setup has at most 20 success criteria.",
  invalid_stakeholders: "A setup names at most 20 people at the customer.",
  invalid_main_contact: "The main contact must be one of the people named.",
  invalid_summary: "What you deliver is plain text, up to 4000 characters.",
}

/** What went wrong with a setup, and what the person can do about it. */
export type SetupProblem =
  /** One part is wrong: changing it makes a new body, and so a new key. */
  | { kind: "part"; part: Part; message: string }
  /** Nothing is wrong with the answers: `retry` keeps the same key and bytes, `fresh` drops them. */
  | { kind: "general"; message: string; key: "retry" | "fresh" }

/** The part an `invalid_name` is about: the first name, in the API's order, that its rule refuses. */
function namedPart(body: SetupBody): Part | null {
  const bad = (name: string) => checkName(name, "invalid_name", true) !== null
  if (body.stakeholders?.some((s) => bad(s.name))) return "contact"
  if (bad(body.company.name)) return "company"
  if (bad(body.project.name)) return "project"
  return null
}

/** A failed setup in words, tied to the part it is about when the API's code says which. */
export function setupProblem(error: unknown, body: SetupBody): SetupProblem {
  if (!(error instanceof ApiError))
    return {
      kind: "general",
      message:
        "We could not reach the workspace, so it may or may not have been saved. Try again: it will not make a second company.",
      key: "retry",
    }
  const { status, code } = error
  if (status === 400 && code.startsWith("invalid_")) {
    const part = code === "invalid_name" ? namedPart(body) : (PART_OF[code] ?? null)
    const message = SETUP_TEXT[code] ?? SAFE_TEXT[code] ?? "Check this part and try again."
    if (part) return { kind: "part", part, message }
    return {
      kind: "general",
      message: "The workspace could not read this setup. Nothing was saved. Try again.",
      key: "fresh",
    }
  }
  if (status === 401)
    return {
      kind: "general",
      message:
        "You have been signed out. Sign in again in another tab, then try again here: your answers are kept.",
      key: "retry",
    }
  if (status === 403)
    return {
      kind: "general",
      message:
        "You are not allowed to set up a company here. Ask an organisation admin, then try again.",
      key: "retry",
    }
  if (status === 409)
    return {
      kind: "general",
      message:
        "This setup was already sent with other answers, and nothing new was saved. Check your companies before you create it again.",
      key: "fresh",
    }
  // The API was reached but could not finish: the same key is safe to send again.
  return {
    kind: "general",
    message:
      "The workspace could not save it just now. Try again: it will not make a second company.",
    key: "retry",
  }
}

import { STAGES } from "./api/schemas"
import type { Stage } from "./api/schemas"

export const STAGE_LABEL: Record<Stage, string> = {
  discover: "Discover",
  scope: "Scope",
  access: "Access",
  build: "Build",
  evaluate: "Evaluate",
  deploy: "Deploy",
  handoff: "Handoff",
  operate: "Operate",
}

const index = (stage: Stage) => STAGES.indexOf(stage)

/**
 * Whether a project in `from` may move to `to`, as `oryxa_fde_core::Stage::transition` decides:
 * forward by exactly one, or back to any earlier stage for rework; never a skip or a no-op.
 */
export function canMove(from: Stage, to: Stage): boolean {
  return index(to) < index(from) || index(to) === index(from) + 1
}

/** The API's limit on the reason for moving on with checklist items open. */
export const MAX_REASON = 500

// The API allows newlines and tabs and no other control character (Rust's `char::is_control`, C0 and C1).
// eslint-disable-next-line no-control-regex
const REASON_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

/** How many characters the API will count: it trims, and counts Unicode scalar values. */
export const reasonLength = (value: string) => [...value.trim()].length

/** What is wrong with a reason before it is sent, in words, or null. The API checks again. */
export function reasonProblem(value: string): string | null {
  const n = reasonLength(value)
  if (n === 0) return "Say why you are moving on with items open."
  if (n > MAX_REASON) return `Keep the reason to ${MAX_REASON} characters or fewer.`
  // Judged once trimmed, as the API does: a trailing carriage return is trimmed, not refused.
  if (REASON_CONTROL.test(value.trim())) return "Use plain text: no control characters."
  return null
}

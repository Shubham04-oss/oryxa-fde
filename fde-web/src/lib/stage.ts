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

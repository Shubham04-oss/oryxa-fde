import { describe, expect, it } from "vitest"
import { applyEvent } from "./use-conversation"
import type { WorkspaceTurn } from "./use-conversation"
import { MAX_READ_STEPS } from "@/lib/workspace/wire"
import type { Step, WireEvent } from "@/lib/workspace/wire"

const empty: WorkspaceTurn = {
  id: 2,
  who: "workspace",
  text: "",
  blocks: [],
  proposals: [],
  steps: [],
  notice: null,
  streaming: true,
}
const step = (s: Step): WireEvent => ({ v: 1, type: "step", step: s })

describe("a reply's steps", () => {
  it("start, then end once: a finished step stays finished and keeps its tool", () => {
    let turn = applyEvent(empty, step({ id: "s_1", tool: "read_today", state: "running" }))
    expect(turn.steps).toEqual([{ id: "s_1", tool: "read_today", state: "running" }])
    turn = applyEvent(turn, step({ id: "s_1", tool: "read_today", state: "done", count: 2 }))
    expect(turn.steps).toEqual([{ id: "s_1", tool: "read_today", state: "done", count: 2 }])
    // Neither a second end nor another tool under the same id changes it.
    expect(applyEvent(turn, step({ id: "s_1", tool: "read_today", state: "failed" }))).toBe(turn)
    const other = applyEvent(
      applyEvent(empty, step({ id: "s_1", tool: "read_today", state: "running" })),
      step({ id: "s_1", tool: "list_companies", state: "done" }),
    )
    expect(other.steps).toEqual([{ id: "s_1", tool: "read_today", state: "running" }])
  })

  it("hold no more than a turn may read", () => {
    let turn = empty
    for (let i = 0; i <= MAX_READ_STEPS; i++)
      turn = applyEvent(turn, step({ id: `s_${i}`, tool: "list_companies", state: "running" }))
    expect(turn.steps).toHaveLength(MAX_READ_STEPS)
  })
})

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openConversation } from "./assistant"
import { applyChatEvent, endTurn } from "./chat"
import type { ChatTurn } from "./chat"
import {
  listConversations,
  readConversation,
  sendChatTurn,
  startConversation,
  stopTurn,
} from "./chat-client"
import { resetMockApi } from "@/dev/mock-api"

// The prototype's client against the dev mock's scripted assistant (issue #263): the same reader as the
// welcome screen, so caps, resume and the deadline are tested there; here, what the prototype adds.

const flags = globalThis as Record<string, unknown>
const fresh = (): ChatTurn => ({
  key: "k",
  turn: null,
  said: "",
  status: "streaming",
  parts: [],
  notice: null,
})
const textOf = (turn: ChatTurn) =>
  turn.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")

async function run(id: string, said: string) {
  let turn = fresh()
  const ended = await sendChatTurn(id, said, (event) => (turn = applyChatEvent(turn, event)))
  return { ended, turn }
}

beforeEach(() => resetMockApi())
afterEach(() => {
  for (const flag of ["Hold", "Drop", "Fail", "Notice"])
    flags[`__fdeMockAssistant${flag}`] = undefined
})

describe("the prototype's conversation", () => {
  it("starts one bound to its scope, lists it once it has a turn, and reads it back", async () => {
    const id = await startConversation({
      kind: "project",
      company: "cmp_kestrel",
      project: "prj_kestrel_dispatch",
    })
    expect(id).toMatch(/^c_/)
    expect((await listConversations())?.some((c) => c.id === id)).toBe(false)
    const { ended, turn } = await run(id!, "What is blocked right now?")
    expect(ended).toEqual({ kind: "done" })
    expect(turn.parts.filter((p) => p.type.startsWith("tool-")).map((p) => p.type)).toEqual([
      "tool-project",
      "tool-tasks",
      "tool-team",
    ])
    const listed = await listConversations()
    expect(listed?.find((c) => c.id === id)).toMatchObject({
      title: "What is blocked right now?",
      scope: { kind: "project", company: "cmp_kestrel" },
    })
    const [back] = (await readConversation(id!))!
    expect(textOf(back!)).toBe(textOf(turn))
    expect(back!.parts.filter((p) => p.type.startsWith("tool-"))).toHaveLength(3)
  })

  it("resumes a dropped connection from the last event, without saying anything twice", async () => {
    const id = (await startConversation({ kind: "company", company: "cmp_kestrel" }))!
    const whole = await run(id, "What is blocked right now?")
    flags.__fdeMockAssistantDrop = 6
    const resumed = await run(id, "What is blocked right now?")
    expect(resumed.ended).toEqual({ kind: "done" })
    expect(textOf(resumed.turn)).toBe(textOf(whole.turn))
    expect(resumed.turn.parts.filter((p) => p.type === "data-block")).toHaveLength(1)
  })

  it("ends a turn on stop, and keeps what it had said", async () => {
    const id = (await startConversation({ kind: "home" }))!
    flags.__fdeMockAssistantHold = 4
    let turn = fresh()
    const sent = sendChatTurn(
      id,
      "What needs me today?",
      (event) => (turn = applyChatEvent(turn, event)),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turn.turn).not.toBeNull()
    turn = endTurn(turn, "stopped")
    expect(await stopTurn(id, turn.turn!)).toBe(true)
    expect(await sent).toEqual({ kind: "done" })
    const [back] = (await readConversation(id))!
    expect(back!.status).toBe("done")
  })

  it("ends a failed turn as failed, and one with a notice with that notice", async () => {
    const id = (await startConversation({ kind: "home" }))!
    flags.__fdeMockAssistantFail = true
    expect((await run(id, "What needs me today?")).ended).toEqual({ kind: "failed" })
    flags.__fdeMockAssistantNotice = "tool_limit"
    const limited = await run(id, "What needs me today?")
    expect(limited.ended).toEqual({ kind: "done" })
    expect(limited.turn.notice).toBe("tool_limit")
  })

  it("refuses a second turn while one runs, and a scope it cannot read", async () => {
    const id = (await startConversation({ kind: "home" }))!
    flags.__fdeMockAssistantHold = 2
    void sendChatTurn(id, "What needs me today?", () => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await run(id, "Again")).ended).toEqual({ kind: "refused", refusal: "busy" })
    expect(await startConversation({ kind: "company", company: "cmp k" } as never)).toBeNull()
  })

  it("leaves the welcome screen's own conversation without an assistant, as before", async () => {
    expect(await openConversation("c_welcome0123")).toEqual({ kind: "off" })
  })
})

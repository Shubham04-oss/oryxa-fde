import { describe, expect, it } from "vitest"
import {
  ONE_AT_A_TIME,
  applyChatEvent,
  atBottom,
  composerIntent,
  composerKey,
  confirmable,
  endTurn,
  limitHint,
  nextPhase,
  onGrew,
  onScrolled,
  parseChatEvent,
  parseChatView,
  scopeFromParam,
  scopeParam,
  sentencesToAnnounce,
  sourcesOf,
  stepFound,
  stepLabel,
  stepsSummary,
  todoState,
  withProposal,
} from "./chat"
import type { ChatEvent, ChatProposal, ChatTurn, ProposalView } from "./chat"

const v = 1 as const
const fresh = (): ChatTurn => ({
  key: "k1",
  turn: null,
  said: "Plan it",
  status: "streaming",
  parts: [],
  notice: null,
})
const apply = (turn: ChatTurn, ...events: Array<ChatEvent>) =>
  events.reduce((t, e, i) => applyChatEvent(t, e, 1000 + i * 100), turn)
const step = (id: string, tool: string, state: string, count?: number) =>
  parseChatEvent({
    v,
    type: "step",
    step: count === undefined ? { id, tool, state } : { id, tool, state, count },
  })!
const create = (id: string, name: string): ChatProposal => ({
  id,
  action: "create_company",
  args: { name },
})

describe("parseChatEvent", () => {
  it("takes the wire's own events first", () => {
    expect(parseChatEvent({ v, type: "text", delta: "Hi" })).toEqual({
      v,
      type: "text",
      delta: "Hi",
    })
  })

  it("takes the proposed step, todo and set_member events", () => {
    expect(step("r1", "tasks", "done", 4)).toEqual({
      v,
      type: "step",
      step: { id: "r1", tool: "tasks", state: "done", count: 4 },
    })
    expect(
      parseChatEvent({
        v,
        type: "todo",
        items: [{ id: "t1", label: "Read it", link: { by: "reply" } }],
      }),
    ).not.toBeNull()
    expect(
      parseChatEvent({
        v,
        type: "proposal",
        proposal: {
          id: "p1",
          action: "set_member",
          args: { company: "cmp_a", user: "usr_b", role: "engineer" },
        },
      }),
    ).not.toBeNull()
  })

  it("drops a step that carries arguments or output, or names a tool not in the list", () => {
    expect(
      parseChatEvent({
        v,
        type: "step",
        step: { id: "r1", tool: "tasks", state: "done", output: [{ id: 1 }] },
      }),
    ).toBeNull()
    expect(
      parseChatEvent({ v, type: "step", step: { id: "r1", tool: "fetch_url", state: "running" } }),
    ).toBeNull()
    expect(
      parseChatEvent({
        v,
        type: "step",
        step: { id: "r1", tool: "tasks", state: "done", count: -1 },
      }),
    ).toBeNull()
  })

  it("drops unknown events, unknown actions and a set_member with an unsafe id", () => {
    expect(parseChatEvent({ v, type: "html", html: "<b>hi</b>" })).toBeNull()
    expect(
      parseChatEvent({
        v,
        type: "proposal",
        proposal: { id: "p", action: "delete_company", args: {} },
      }),
    ).toBeNull()
    expect(
      parseChatEvent({
        v,
        type: "proposal",
        proposal: {
          id: "p",
          action: "set_member",
          args: { company: "cmp a'--", user: "u", role: "engineer" },
        },
      }),
    ).toBeNull()
    expect(
      parseChatEvent({
        v,
        type: "proposal",
        proposal: {
          id: "p",
          action: "set_member",
          args: { company: "c", user: "u", role: "owner" },
        },
      }),
    ).toBeNull()
  })
})

describe("applyChatEvent", () => {
  it("joins streamed text into one part, and keeps the turn's id", () => {
    const turn = apply(
      fresh(),
      { v, type: "turn", turn: "t_1", said: "Plan it" },
      { v, type: "text", delta: "One " },
      { v, type: "text", delta: "two." },
    )
    expect(turn.turn).toBe("t_1")
    expect(turn.parts).toEqual([{ type: "text", text: "One two." }])
  })

  it("follows a step from running to done, timed, and keeps a finished step finished", () => {
    let turn = apply(fresh(), step("r1", "tasks", "running"), step("r1", "tasks", "done", 9))
    expect(turn.parts).toEqual([
      {
        type: "tool-tasks",
        toolCallId: "r1",
        state: "output-available",
        count: 9,
        startedAt: 1000,
        endedAt: 1100,
      },
    ])
    turn = applyChatEvent(turn, step("r1", "tasks", "failed"))
    expect(turn.parts[0]).toMatchObject({ state: "output-available" })
    // A step id cannot change its tool.
    turn = applyChatEvent(turn, step("r1", "team", "running"))
    expect(turn.parts).toHaveLength(1)
  })

  it("shows a proposal once, however often it is sent", () => {
    const p = { v, type: "proposal", proposal: create("p1", "Orion Rail") } as ChatEvent
    expect(apply(fresh(), p, p).parts.filter((x) => x.type === "data-proposal")).toHaveLength(1)
  })

  it("replaces the todo as a whole and keeps it first", () => {
    const todo = (label: string): ChatEvent => ({
      v,
      type: "todo",
      items: [{ id: "t1", label, link: { by: "reply" } }],
    })
    const turn = apply(fresh(), todo("First"), { v, type: "text", delta: "x" }, todo("Second"))
    expect(turn.parts[0]).toMatchObject({ type: "data-todo", data: [{ label: "Second" }] })
    expect(turn.parts.filter((p) => p.type === "data-todo")).toHaveLength(1)
  })

  it("takes nothing more once stopped: what it said is kept", () => {
    const said = apply(fresh(), { v, type: "text", delta: "Kept." })
    const stopped = endTurn(said, "stopped")
    expect(applyChatEvent(stopped, { v, type: "text", delta: " More" })).toBe(stopped)
    expect(stopped.parts).toEqual([{ type: "text", text: "Kept." }])
  })
})

describe("endTurn", () => {
  it("marks a read still running as one that could not finish", () => {
    const turn = endTurn(apply(fresh(), step("r1", "project", "running")), "failed", 5000)
    expect(turn.status).toBe("failed")
    expect(turn.parts[0]).toMatchObject({ state: "output-error", endedAt: 5000 })
  })

  it("leaves a turn that already ended as it was", () => {
    const done = endTurn(fresh(), "done")
    expect(endTurn(done, "failed")).toBe(done)
  })
})

describe("proposals", () => {
  const view = (phase: ProposalView["phase"]): ProposalView => ({
    proposal: create("p1", "Orion"),
    phase,
  })

  it("confirms only one that is waiting", () => {
    expect(nextPhase(view("waiting"), { type: "confirm" })?.phase).toBe("confirming")
    for (const phase of ["confirming", "done", "refused", "dismissed"] as const)
      expect(nextPhase(view(phase), { type: "confirm" })).toBeNull()
  })

  it("settles a confirm as done with its record, or refused with the API's reason", () => {
    const record = { screen: "companies" } as const
    expect(nextPhase(view("confirming"), { type: "succeeded", record })).toMatchObject({
      phase: "done",
      record,
    })
    expect(nextPhase(view("confirming"), { type: "refused", reason: "No." })).toMatchObject({
      phase: "refused",
      reason: "No.",
    })
    expect(nextPhase(view("waiting"), { type: "succeeded" })).toBeNull()
  })

  it("puts away one waiting or refused, never one done or being confirmed", () => {
    expect(nextPhase(view("waiting"), { type: "dismiss" })?.phase).toBe("dismissed")
    expect(nextPhase(view("refused"), { type: "dismiss" })?.phase).toBe("dismissed")
    expect(nextPhase(view("done"), { type: "dismiss" })).toBeNull()
    expect(nextPhase(view("confirming"), { type: "dismiss" })).toBeNull()
  })

  it("lets one be confirmed at a time across the conversation", () => {
    const turn = apply(
      fresh(),
      { v, type: "proposal", proposal: create("p1", "Orion Rail") } as ChatEvent,
      { v, type: "proposal", proposal: create("p2", "Halden Water") } as ChatEvent,
    )
    expect(confirmable([turn], "p2")).toEqual({ ok: true })
    const busy = withProposal(turn, "p1", (p) => nextPhase(p, { type: "confirm" })!)
    expect(confirmable([busy], "p2")).toMatchObject({ ok: false })
    expect(confirmable([busy], "p1")).toMatchObject({ ok: false })
    expect(confirmable([busy], "nope")).toMatchObject({ ok: false })
  })

  it("marks giving a person a role as one confirmed on its own", () => {
    expect(ONE_AT_A_TIME.has("set_member")).toBe(true)
    expect(ONE_AT_A_TIME.has("create_company")).toBe(false)
  })
})

describe("todoState", () => {
  it("reads each item from what it is tied to, never from a claim", () => {
    let turn = apply(fresh(), step("r1", "tasks", "running"))
    expect(todoState(turn, { by: "step", id: "r1" })).toBe("active")
    expect(todoState(turn, { by: "step", id: "r2" })).toBe("pending")
    expect(todoState(turn, { by: "reply" })).toBe("pending")
    turn = apply(turn, step("r1", "tasks", "done"), { v, type: "text", delta: "x" })
    expect(todoState(turn, { by: "step", id: "r1" })).toBe("done")
    expect(todoState(turn, { by: "reply" })).toBe("active")
    turn = apply(turn, { v, type: "proposal", proposal: create("p1", "Orion") } as ChatEvent)
    expect(todoState(turn, { by: "proposal", id: "p1" })).toBe("waiting_on_you")
    turn = endTurn(turn, "done")
    expect(todoState(turn, { by: "reply" })).toBe("done")
    expect(todoState(turn, { by: "step", id: "r2" })).toBe("skipped")
    expect(
      todoState(
        withProposal(turn, "p1", (p) => ({ ...p, phase: "done" })),
        { by: "proposal", id: "p1" },
      ),
    ).toBe("done")
    expect(todoState(endTurn(fresh(), "failed"), { by: "reply" })).toBe("failed")
  })
})

describe("steps in words", () => {
  const names = { company: "Kestrel Freight", project: "Dispatch copilot" }

  it("words each tool by its state, with the names read through the API", () => {
    expect(stepLabel("companies", "input-available", {})).toBe("Reading your companies")
    expect(stepLabel("tasks", "output-available", names)).toBe("Read Dispatch copilot's tasks")
    expect(stepLabel("team", "output-error", { company: "Brightwater Clinics" })).toBe(
      "Could not read Brightwater Clinics' team",
    )
    expect(stepLabel("project", "output-available", {})).toBe("Read this project")
  })

  it("says what came back as a count only", () => {
    expect(stepFound("tasks", "output-available", 14)).toBe("14 tasks.")
    expect(stepFound("team", "output-available", 1)).toBe("1 person.")
    expect(stepFound("tasks", "output-available", undefined)).toBe("Read.")
    expect(stepFound("tasks", "output-error", 3)).toMatch(/^Nothing came back/)
  })

  it("folds the steps into one line, and says what could not be read", () => {
    const turn = apply(
      fresh(),
      step("a", "project", "done"),
      step("b", "tasks", "done"),
      step("c", "team", "failed"),
    )
    expect(stepsSummary(turn.parts)).toBe("Read 2 things, 1 could not be read")
    expect(stepsSummary(apply(fresh(), step("a", "project", "done")).parts)).toBe("Read 1 thing")
  })

  it("gives as sources only our own routes for what was read and read well", () => {
    const turn = apply(
      fresh(),
      step("a", "project", "done"),
      step("b", "tasks", "done"),
      step("c", "team", "failed"),
    )
    expect(sourcesOf(turn.parts, { kind: "project", company: "cmp_k", project: "prj_d" })).toEqual([
      { screen: "project", company: "cmp_k", project: "prj_d" },
    ])
    expect(
      sourcesOf(apply(fresh(), step("a", "companies", "done")).parts, { kind: "home" }),
    ).toEqual([{ screen: "companies" }])
  })
})

describe("scroll", () => {
  it("counts the last few pixels as the bottom", () => {
    expect(atBottom({ scrollTop: 570, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
    expect(atBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
  })

  it("follows new text only while stuck to the bottom, and otherwise says something is below", () => {
    expect(onGrew({ stuck: true, unseen: false })).toEqual({
      stick: { stuck: true, unseen: false },
      follow: true,
    })
    expect(onGrew({ stuck: false, unseen: false })).toEqual({
      stick: { stuck: false, unseen: true },
      follow: false,
    })
  })

  it("sticks again once the person scrolls back down, and then nothing is unseen", () => {
    expect(onScrolled({ stuck: true, unseen: false }, false)).toEqual({
      stuck: false,
      unseen: false,
    })
    expect(onScrolled({ stuck: false, unseen: true }, false)).toEqual({
      stuck: false,
      unseen: true,
    })
    expect(onScrolled({ stuck: false, unseen: true }, true)).toEqual({ stuck: true, unseen: false })
  })
})

describe("composer", () => {
  it("sends on Enter, and leaves Shift+Enter, Alt+Enter and an IME composing alone", () => {
    expect(composerKey({ key: "Enter", shiftKey: false })).toBe("send")
    expect(composerKey({ key: "Enter", shiftKey: true })).toBe("default")
    expect(composerKey({ key: "Enter", shiftKey: false, altKey: true })).toBe("default")
    expect(composerKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe("default")
    expect(composerKey({ key: "a", shiftKey: false })).toBe("default")
  })

  it("sends when idle, queues one behind a running turn, and says why it cannot", () => {
    expect(composerIntent({ text: " hi ", running: false, queued: false })).toEqual({
      kind: "send",
    })
    expect(composerIntent({ text: "hi", running: true, queued: false })).toEqual({ kind: "queue" })
    expect(composerIntent({ text: "hi", running: true, queued: true })).toMatchObject({
      kind: "none",
    })
    expect(composerIntent({ text: "   ", running: false, queued: false })).toMatchObject({
      kind: "none",
    })
    expect(composerIntent({ text: "x".repeat(2001), running: false, queued: false })).toMatchObject(
      { kind: "none" },
    )
  })

  it("shows the count only near the limit, counting characters as a person does", () => {
    expect(limitHint("x".repeat(1799))).toBeNull()
    expect(limitHint("x".repeat(1800))).toBe("1,800 / 2,000")
    expect(limitHint("😀".repeat(1800))).toBe("1,800 / 2,000")
  })
})

describe("the live region", () => {
  it("announces whole sentences while streaming, and the rest at the end", () => {
    expect(sentencesToAnnounce("One thing holds it up", 0, false)).toEqual({ say: "", upTo: 0 })
    const first = sentencesToAnnounce("One thing. Then two", 0, false)
    expect(first).toEqual({ say: "One thing.", upTo: 10 })
    expect(sentencesToAnnounce("One thing. Then two", first.upTo, true)).toEqual({
      say: "Then two",
      upTo: 19,
    })
  })
})

describe("scope", () => {
  it("reads ?new= as Home, a company or a project, and nothing else", () => {
    expect(scopeFromParam("home")).toEqual({ kind: "home" })
    expect(scopeFromParam("cmp_k")).toEqual({ kind: "company", company: "cmp_k" })
    expect(scopeFromParam("cmp_k/prj_d")).toEqual({
      kind: "project",
      company: "cmp_k",
      project: "prj_d",
    })
    for (const bad of ["", "cmp_k/prj_d/x", "../etc", "cmp k", "cmp_k/", 3, undefined])
      expect(scopeFromParam(bad)).toBeNull()
    expect(scopeParam({ kind: "project", company: "cmp_k", project: "prj_d" })).toBe("cmp_k/prj_d")
  })
})

describe("parseChatView", () => {
  const turn = (extra: Record<string, unknown> = {}) => ({
    id: "t_1",
    said: "Plan it",
    state: "done",
    text: "Here.",
    blocks: [
      { type: "checklist", items: [{ label: "A", done: true }] },
      { type: "chart", svg: "<svg/>" },
    ],
    proposals: [
      { proposal: create("p1", "Orion"), state: "confirmed" },
      {
        proposal: {
          id: "p2",
          action: "set_member",
          args: { company: "cmp_k", user: "usr_s", role: "engineer" },
        },
        state: "waiting",
      },
      { proposal: { id: "p3", action: "drop_table", args: {} }, state: "waiting" },
    ],
    notice: null,
    ...extra,
  })

  it("keeps what passes, drops the unknown block and action, and reads the proposed steps", () => {
    const [t] = parseChatView({
      v: 1,
      turns: [turn({ steps: [{ id: "r1", tool: "tasks", state: "done", count: 3 }] })],
    })!
    expect(t!.status).toBe("done")
    expect(t!.parts.map((p) => p.type)).toEqual([
      "tool-tasks",
      "text",
      "data-block",
      "data-proposal",
      "data-proposal",
    ])
    const proposals = t!.parts.flatMap((p) => (p.type === "data-proposal" ? [p.data] : []))
    expect(proposals.map((p) => [p.proposal.id, p.phase])).toEqual([
      ["p1", "done"],
      ["p2", "waiting"],
    ])
  })

  it("is null for an answer that is not a conversation, and starts a live turn empty", () => {
    expect(parseChatView({ v: 2, turns: [] })).toBeNull()
    expect(parseChatView("nope")).toBeNull()
    const [live] = parseChatView({ v: 1, turns: [turn({ state: "live" })] })!
    expect(live!.status).toBe("streaming")
    expect(live!.parts).toEqual([])
  })
})

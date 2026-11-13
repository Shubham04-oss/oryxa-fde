import { z } from "zod"
import { Destination, PartId, line } from "./blocks"
import type { Block } from "./blocks"
import { MAX_SAID, Proposal, ProposalState, WIRE_VERSION, parseEvent, parseView } from "./wire"
import type { WireEvent, Notice } from "./wire"

// The conversation prototype (issue #263, DESIGN.md "Round 2: conversation"). Everything the wire of
// issue #236 does not carry yet is written here as a PROPOSED addition, parsed with its own schema, so
// wire.ts (copied into the assistant Worker) is unchanged:
// - a `step` event for a tool read in flight: a fixed tool, its state, and at most a count;
// - a `todo` event, the turn's own checklist, each item tied to a step, a proposal or the reply;
// - a `set_member` proposal (give a person a role on a company), the first kind ADR 0008 confirms one
//   at a time;
// - the conversation list, a conversation's scope, and a stop route (src/dev/mock-assistant.ts).
// The Worker changes are tracked separately; until then only the dev mock sends any of this.

// ── Proposed wire additions ────────────────────────────────────────────────

/** The reads the assistant may make, each a fixed label here: the stream never names one in words. */
export const TOOLS = ["companies", "company", "project", "tasks", "checklist", "team"] as const
export const Tool = z.enum(TOOLS)
export type Tool = z.infer<typeof Tool>

export const STEP_STATES = ["running", "done", "failed"] as const

/** PROPOSED: a tool read in flight. No arguments, no output: at most how many records came back. */
export const StepEvent = z.strictObject({
  v: z.literal(WIRE_VERSION),
  type: z.literal("step"),
  step: z.strictObject({
    id: PartId,
    tool: Tool,
    state: z.enum(STEP_STATES),
    count: z.number().int().min(0).max(10_000).optional(),
  }),
})

/** What a todo item follows: its state is read from that, never claimed by the stream. */
const TodoLink = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("step"), id: PartId }),
  z.strictObject({ by: z.literal("proposal"), id: PartId }),
  z.strictObject({ by: z.literal("reply") }),
])
export type TodoLink = z.infer<typeof TodoLink>

/** PROPOSED: the turn's plan of work, sent whole each time it changes, as coding agents keep a todo list. */
export const TodoEvent = z.strictObject({
  v: z.literal(WIRE_VERSION),
  type: z.literal("todo"),
  items: z
    .array(z.strictObject({ id: PartId, label: line(120), link: TodoLink }))
    .min(1)
    .max(8),
})
export type TodoItem = z.infer<typeof TodoEvent>["items"][number]

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/** PROPOSED for the action catalogue: give a person a role on a company (`PUT .../members/<user>`). */
export const SetMember = z.strictObject({
  id: PartId,
  action: z.literal("set_member"),
  args: z.strictObject({
    company: Id.brand<"CompanyId">(),
    user: Id.brand<"UserId">(),
    role: z.enum(["lead", "engineer"]),
  }),
})

/** A proposal from the catalogue, or the one proposed here. */
export const ChatProposal = z.union([Proposal, SetMember])
export type ChatProposal = z.infer<typeof ChatProposal>

const ProposedProposalEvent = z.strictObject({
  v: z.literal(WIRE_VERSION),
  type: z.literal("proposal"),
  proposal: SetMember,
})

export type StepEvent = z.infer<typeof StepEvent>
export type TodoEvent = z.infer<typeof TodoEvent>
export type ChatEvent = WireEvent | StepEvent | TodoEvent | z.infer<typeof ProposedProposalEvent>

/** One event: the wire's own first, then the proposed ones; null when it is none of them. */
export function parseChatEvent(input: unknown): ChatEvent | null {
  const wired = parseEvent(input)
  if (wired) return wired
  for (const schema of [StepEvent, TodoEvent, ProposedProposalEvent]) {
    const parsed = schema.safeParse(input)
    if (parsed.success) return parsed.data
  }
  return null
}

// ── Scope and the conversation list (PROPOSED routes) ──────────────────────

/** What a conversation is bound to when it starts (ADR 0008). It never changes. */
export const Scope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("home") }),
  z.strictObject({ kind: z.literal("company"), company: Id }),
  z.strictObject({ kind: z.literal("project"), company: Id, project: Id }),
])
export type Scope = z.infer<typeof Scope>

export const ConversationId = z.string().regex(/^c_[A-Za-z0-9_-]{1,126}$/)

export const ConversationList = z.strictObject({
  v: z.literal(WIRE_VERSION),
  conversations: z
    .array(
      z.strictObject({
        id: ConversationId,
        scope: Scope,
        /** What the person first said, cut to one line: their own words, shown as text. */
        title: line(120),
        updated_at: z.iso.datetime(),
      }),
    )
    .max(200),
})
export type ConversationSummary = z.infer<typeof ConversationList>["conversations"][number]

/** `?new=` as the route takes it: `home`, a company id, or `company/project`. Anything else is null. */
export function scopeFromParam(value: unknown): Scope | null {
  if (typeof value !== "string") return null
  if (value === "home") return { kind: "home" }
  const [company, project, more] = value.split("/")
  const ok = (v: string | undefined) => v !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(v)
  if (more !== undefined || !ok(company)) return null
  if (project === undefined) return { kind: "company", company: company! }
  return ok(project) ? { kind: "project", company: company!, project } : null
}

export const scopeParam = (scope: Scope) =>
  scope.kind === "home"
    ? "home"
    : scope.kind === "company"
      ? scope.company
      : `${scope.company}/${scope.project}`

/** Where a company-bound conversation's records are, as one of our own routes. */
export function scopeDestination(scope: Scope): Destination {
  if (scope.kind === "home") return { screen: "companies" }
  if (scope.kind === "company")
    return Destination.parse({ screen: "company", company: scope.company })
  return Destination.parse({ screen: "project", company: scope.company, project: scope.project })
}

// ── A turn as the screen holds it: AI SDK shaped parts (a view model; the wire is unchanged) ──

/** The tool states of the AI SDK's `ToolUIPart` that a read can be in. */
export type ToolState = "input-available" | "output-available" | "output-error"

export type ProposalPhase = "waiting" | "confirming" | "done" | "refused" | "dismissed"
export type ProposalView = {
  proposal: ChatProposal
  phase: ProposalPhase
  /** Why the API refused it, in its own fixed words. */
  reason?: string
  /** The record a done proposal made or changed, to open it. */
  record?: Destination
}

export type Part =
  | { type: "text"; text: string }
  | {
      type: `tool-${Tool}`
      toolCallId: string
      state: ToolState
      count?: number
      startedAt: number
      endedAt?: number
    }
  | { type: "data-todo"; id: "todo"; data: Array<TodoItem> }
  | { type: "data-block"; id: string; data: Block }
  | { type: "data-proposal"; id: string; data: ProposalView }

export type TurnStatus = "streaming" | "done" | "failed" | "timed_out" | "stopped" | "refused"

export type ChatTurn = {
  /** The screen's own key, stable from the moment the person sends. */
  key: string
  /** The assistant's id, once the stream says it. */
  turn: string | null
  said: string
  status: TurnStatus
  parts: Array<Part>
  notice: Notice | null
  /** Why the turn never started, as a code the screen words. */
  refusal?: string
  /** A failed turn the person tried again: its Try again is gone. */
  retried?: boolean
}

export const TOOL_STATE: Record<(typeof STEP_STATES)[number], ToolState> = {
  running: "input-available",
  done: "output-available",
  failed: "output-error",
}

export const toolOf = (part: Part): Tool | null =>
  part.type.startsWith("tool-") ? (part.type.slice(5) as Tool) : null

type ToolPart = Extract<Part, { toolCallId: string }>
export const isTool = (part: Part): part is ToolPart => toolOf(part) !== null

/** A turn with one more event applied. A stopped turn takes nothing more: what it said is kept. */
export function applyChatEvent(turn: ChatTurn, event: ChatEvent, now = Date.now()): ChatTurn {
  if (turn.status === "stopped") return turn
  const parts = turn.parts
  switch (event.type) {
    case "turn":
      return { ...turn, turn: event.turn }
    case "text": {
      const last = parts.at(-1)
      if (last?.type === "text")
        return {
          ...turn,
          parts: [...parts.slice(0, -1), { ...last, text: last.text + event.delta }],
        }
      return { ...turn, parts: [...parts, { type: "text", text: event.delta }] }
    }
    case "block":
      return {
        ...turn,
        parts: [...parts, { type: "data-block", id: `b${parts.length}`, data: event.block }],
      }
    case "proposal":
      // One proposal id once: a repeat is dropped, never shown twice.
      if (parts.some((p) => p.type === "data-proposal" && p.id === event.proposal.id)) return turn
      return {
        ...turn,
        parts: [
          ...parts,
          {
            type: "data-proposal",
            id: event.proposal.id,
            data: { proposal: event.proposal, phase: "waiting" },
          },
        ],
      }
    case "notice":
      return { ...turn, notice: event.notice }
    case "todo": {
      const rest = parts.filter((p) => p.type !== "data-todo")
      return { ...turn, parts: [{ type: "data-todo", id: "todo", data: event.items }, ...rest] }
    }
    case "step": {
      const { id, tool, state, count } = event.step
      const at = parts.findIndex((p) => isTool(p) && p.toolCallId === id)
      if (at < 0)
        return {
          ...turn,
          parts: [
            ...parts,
            {
              type: `tool-${tool}`,
              toolCallId: id,
              state: TOOL_STATE[state],
              count,
              startedAt: now,
            },
          ],
        }
      const old = parts[at] as ToolPart
      // A step's tool never changes, and a finished step stays finished.
      if (old.type !== `tool-${tool}` || old.state !== "input-available") return turn
      const next: ToolPart = {
        ...old,
        state: TOOL_STATE[state],
        count: count ?? old.count,
        endedAt: state === "running" ? undefined : now,
      }
      return { ...turn, parts: parts.map((p, i) => (i === at ? next : p)) }
    }
  }
}

/** A turn whose stream has ended; any read still running when it ended could not finish. */
export function endTurn(
  turn: ChatTurn,
  status: Exclude<TurnStatus, "streaming">,
  now = Date.now(),
): ChatTurn {
  if (turn.status !== "streaming") return turn
  return {
    ...turn,
    status,
    parts: turn.parts.map((p) =>
      isTool(p) && p.state === "input-available"
        ? { ...p, state: "output-error", endedAt: now }
        : p,
    ),
  }
}

/**
 * A conversation's history (`GET /assistant/conversations/<c>`), as wire.ts reads it, plus the
 * PROPOSED record of each finished turn's steps and todo. Null when the answer itself is malformed.
 */
export function parseChatView(input: unknown): Array<ChatTurn> | null {
  if (typeof input !== "object" || input === null) return null
  const raw = input as { turns?: unknown }
  if (!Array.isArray(raw.turns)) return null
  const extras = raw.turns.map((t: unknown) => {
    const { steps, todo, ...rest } = (typeof t === "object" && t !== null ? t : {}) as Record<
      string,
      unknown
    >
    return { rest, steps, todo }
  })
  const turns = parseView({ ...raw, turns: extras.map((e) => e.rest) })
  if (turns === null) return null
  return turns.map((t, i) => {
    let turn: ChatTurn = {
      key: t.id,
      turn: t.id,
      said: t.said,
      status: "streaming",
      parts: [],
      notice: null,
    }
    if (t.state === "live") return turn
    const extra = extras[i]!
    const todo = TodoEvent.shape.items.safeParse(extra.todo)
    if (todo.success) turn = applyChatEvent(turn, { v: 1, type: "todo", items: todo.data })
    const steps = z.array(StepEvent.shape.step).max(12).safeParse(extra.steps)
    for (const step of steps.success ? steps.data : [])
      turn = applyChatEvent(turn, { v: 1, type: "step", step }, 0)
    if (t.text) turn = applyChatEvent(turn, { v: 1, type: "text", delta: t.text })
    for (const block of t.blocks) turn = applyChatEvent(turn, { v: 1, type: "block", block })
    // The proposed kind is read from the raw history, as the wire's parser drops it.
    const proposals = z
      .array(z.object({ proposal: z.unknown(), state: ProposalState }))
      .safeParse((extra.rest as { proposals?: unknown }).proposals)
    for (const { proposal, state } of proposals.success ? proposals.data : []) {
      const checked = ChatProposal.safeParse(proposal)
      if (!checked.success) continue
      turn = applyChatEvent(turn, { v: 1, type: "proposal", proposal: checked.data } as ChatEvent)
      if (state !== "waiting")
        turn = withProposal(turn, checked.data.id, (p) => ({
          ...p,
          phase: state === "confirmed" ? "done" : "dismissed",
        }))
    }
    turn = { ...turn, notice: t.notice }
    return endTurn(turn, t.state === "failed" ? "failed" : "done", 0)
  })
}

export function withProposal(
  turn: ChatTurn,
  id: string,
  change: (view: ProposalView) => ProposalView,
): ChatTurn {
  return {
    ...turn,
    parts: turn.parts.map((p) =>
      p.type === "data-proposal" && p.id === id ? { ...p, data: change(p.data) } : p,
    ),
  }
}

// ── Proposals: confirmed one at a time ─────────────────────────────────────

export type ProposalAction =
  | { type: "confirm" }
  | { type: "succeeded"; record?: Destination }
  | { type: "refused"; reason: string }
  | { type: "dismiss" }

/**
 * The next phase, or null when the action is not allowed from here. A confirm is refused unless the
 * proposal is still waiting; a refused one may only be put away; done and dismissed are final.
 */
export function nextPhase(view: ProposalView, action: ProposalAction): ProposalView | null {
  switch (action.type) {
    case "confirm":
      return view.phase === "waiting" ? { ...view, phase: "confirming", reason: undefined } : null
    case "succeeded":
      return view.phase === "confirming" ? { ...view, phase: "done", record: action.record } : null
    case "refused":
      return view.phase === "confirming"
        ? { ...view, phase: "refused", reason: action.reason }
        : null
    case "dismiss":
      return view.phase === "waiting" || view.phase === "refused"
        ? { ...view, phase: "dismissed" }
        : null
  }
}

/** Every proposal in the conversation, in order. */
export const proposalsOf = (turns: ReadonlyArray<ChatTurn>) =>
  turns.flatMap((t) =>
    t.parts.flatMap((p) => (p.type === "data-proposal" ? [{ turn: t.key, view: p.data }] : [])),
  )

/**
 * Whether `id` may be confirmed now, and if not, why: it must be waiting, and no other proposal may
 * be confirming, so several are confirmed one at a time.
 */
export function confirmable(
  turns: ReadonlyArray<ChatTurn>,
  id: string,
): { ok: true } | { ok: false; why: string } {
  const all = proposalsOf(turns)
  const own = all.find((p) => p.view.proposal.id === id)
  if (!own || own.view.phase !== "waiting") return { ok: false, why: "This is no longer waiting." }
  if (all.some((p) => p.view.phase === "confirming"))
    return { ok: false, why: "One change at a time: wait for the one being confirmed." }
  return { ok: true }
}

/** The proposal kinds ADR 0008 confirms one at a time, never as part of "approve all". */
export const ONE_AT_A_TIME: ReadonlySet<ChatProposal["action"]> = new Set(["set_member"])

// ── The turn's todo: each item's state read from what it is tied to ────────

export type TodoState = "pending" | "active" | "done" | "waiting_on_you" | "skipped" | "failed"

export function todoState(turn: ChatTurn, link: TodoLink): TodoState {
  if (link.by === "reply") {
    if (turn.status === "streaming")
      return turn.parts.some((p) => p.type === "text") ? "active" : "pending"
    return turn.status === "done" ? "done" : turn.status === "stopped" ? "skipped" : "failed"
  }
  if (link.by === "step") {
    const step = turn.parts.find((p) => isTool(p) && p.toolCallId === link.id)
    if (!step || !isTool(step)) return turn.status === "streaming" ? "pending" : "skipped"
    return step.state === "input-available"
      ? "active"
      : step.state === "output-available"
        ? "done"
        : "failed"
  }
  const proposal = turn.parts.find((p) => p.type === "data-proposal" && p.id === link.id)
  if (!proposal || proposal.type !== "data-proposal")
    return turn.status === "streaming" ? "pending" : "skipped"
  const phase = proposal.data.phase
  return phase === "done"
    ? "done"
    : phase === "dismissed"
      ? "skipped"
      : phase === "refused"
        ? "failed"
        : phase === "confirming"
          ? "active"
          : "waiting_on_you"
}

// ── Steps: what a read says, in fixed words ────────────────────────────────

/** The names a step is worded with: read through the API for this conversation's scope. */
export type Names = { company?: string; project?: string }

export const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`)

/** What the read is, by its state: "Reading your companies", "Read Dispatch copilot's tasks". */
export function stepLabel(tool: Tool, state: ToolState, names: Names) {
  const company = names.company ?? "this company"
  const project = names.project ?? "this project"
  const what: Record<Tool, string> = {
    companies: "your companies",
    company,
    project,
    tasks: `${possessive(project)} tasks`,
    checklist: `${possessive(project)} stage checklist`,
    team: `${possessive(company)} team`,
  }
  const verb =
    state === "input-available"
      ? "Reading"
      : state === "output-available"
        ? "Read"
        : "Could not read"
  return `${verb} ${what[tool]}`
}

/** What was asked for, in a fixed sentence per tool. */
export function stepAsked(tool: Tool, names: Names) {
  const company = names.company ?? "this company"
  const project = names.project ?? "this project"
  const asked: Record<Tool, string> = {
    companies: "The list of your companies: names, stages and next steps.",
    company: `${possessive(company)} record: its projects, contacts and systems.`,
    project: `${possessive(project)} stage, next step and success criteria.`,
    tasks: `Every task on ${project}, with its stage and state.`,
    checklist: `The checklist of ${possessive(project)} current stage.`,
    team: `Who works on ${company}, and their roles.`,
  }
  return asked[tool]
}

const NOUN: Record<Tool, [string, string]> = {
  companies: ["company", "companies"],
  company: ["project", "projects"],
  project: ["criterion", "criteria"],
  tasks: ["task", "tasks"],
  checklist: ["item", "items"],
  team: ["person", "people"],
}

/** What came back: a count at most, never the records themselves. */
export function stepFound(tool: Tool, state: ToolState, count: number | undefined) {
  if (state === "input-available") return "Still reading."
  if (state === "output-error") return "Nothing came back. The answer does not use it."
  if (count === undefined) return "Read."
  const [one, many] = NOUN[tool]
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}.`
}

/** A duration as a person reads it: "0.4s", "12s". */
export function seconds(ms: number) {
  const s = Math.max(0, ms) / 1000
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

/** The steps strip, folded once the turn ends: "Read 3 things", and any that could not be read. */
export function stepsSummary(parts: ReadonlyArray<Part>) {
  const tools = parts.filter(isTool)
  const done = tools.filter((t) => t.state === "output-available").length
  const failed = tools.filter((t) => t.state === "output-error").length
  const read = done === 1 ? "Read 1 thing" : `Read ${done} things`
  return failed === 0 ? read : `${read}, ${failed} could not be read`
}

/** Where a turn's reads were, as our own routes: the sources its blocks are checked against. */
export function sourcesOf(parts: ReadonlyArray<Part>, scope: Scope): Array<Destination> {
  const seen = new Map<string, Destination>()
  for (const part of parts) {
    const tool = toolOf(part)
    if (!tool || !isTool(part) || part.state !== "output-available") continue
    let to: Destination | null = null
    if (tool === "companies") to = { screen: "companies" }
    else if (scope.kind !== "home" && (tool === "company" || tool === "team"))
      to = scopeDestination({ kind: "company", company: scope.company })
    else if (scope.kind === "project") to = scopeDestination(scope)
    if (to) seen.set(JSON.stringify(to), to)
  }
  return [...seen.values()]
}

// ── Scroll that sticks to the bottom only while the person is there ────────

export type Stick = { stuck: boolean; unseen: boolean }

/** Within `slack` pixels of the end counts as at the end. */
export const atBottom = (
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = 32,
) => m.scrollHeight - m.scrollTop - m.clientHeight <= slack

/** The person scrolled: stuck again at the bottom, and then nothing is unseen. */
export const onScrolled = (s: Stick, bottom: boolean): Stick =>
  bottom ? { stuck: true, unseen: false } : { stuck: false, unseen: s.unseen }

/** The thread grew: follow it while stuck, or mark that there is something new below. */
export const onGrew = (s: Stick): { stick: Stick; follow: boolean } =>
  s.stuck ? { stick: s, follow: true } : { stick: { ...s, unseen: true }, follow: false }

// ── Composer ───────────────────────────────────────────────────────────────

/** What a key in the composer does: Enter sends, Shift+Enter (or an IME composing) is left alone. */
export function composerKey(e: {
  key: string
  shiftKey: boolean
  isComposing?: boolean
  altKey?: boolean
}): "send" | "default" {
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing) return "default"
  return "send"
}

/** What sending does now: send, queue behind the running turn, or nothing, and why. */
export function composerIntent(s: {
  text: string
  running: boolean
  queued: boolean
}): { kind: "send" | "queue" } | { kind: "none"; why: string } {
  const text = s.text.trim()
  if (!text) return { kind: "none", why: "Write something first." }
  if ([...text].length > MAX_SAID) return { kind: "none", why: "That is over the limit." }
  if (!s.running) return { kind: "send" }
  if (s.queued) return { kind: "none", why: "One message is already queued. Remove it, or wait." }
  return { kind: "queue" }
}

/** The character count, shown only near the limit: "1,850 / 2,000". */
export function limitHint(text: string, max = MAX_SAID) {
  const n = [...text].length
  if (n < max * 0.9) return null
  return `${n.toLocaleString("en-GB")} / ${max.toLocaleString("en-GB")}`
}

/**
 * Text for a polite live region: whole sentences only, so a screen reader is not read every few
 * words. Answers what to announce and how far the text has been announced.
 */
export function sentencesToAnnounce(text: string, from: number, final: boolean) {
  const rest = text.slice(from)
  if (final) return { say: rest.trim(), upTo: text.length }
  const end = Math.max(rest.lastIndexOf(". "), rest.lastIndexOf(".\n"), rest.lastIndexOf("\n\n"))
  if (end < 0) return { say: "", upTo: from }
  return { say: rest.slice(0, end + 1).trim(), upTo: from + end + 1 }
}

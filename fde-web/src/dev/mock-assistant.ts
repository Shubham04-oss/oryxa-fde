// The assistant, scripted, for the conversation prototype (issue #263) on `pnpm dev:mock` and in tests.
// No model: each turn is a fixed script picked by what the person said and where the conversation is
// bound, streamed as the Worker streams (SSE frames with ids, resumed from `Last-Event-ID`). It answers
// only conversations it holds, so the welcome screen's own conversation still finds no assistant here
// and keeps its scripted reply. Sample data only.
//
// Routes, under `/assistant/conversations`:
//   GET    ''                         PROPOSED: the person's conversations, newest first
//   POST   ''                         PROPOSED: a new conversation, bound to `{ scope }`
//   GET    /<c>                       the conversation (wire.ts), with each finished turn's steps and todo (PROPOSED)
//   POST   /<c>/turns                 a turn, answered with its stream
//   GET    /<c>/turns/<t>/events      the turn's stream again, after `Last-Event-ID`
//   POST   /<c>/turns/<t>/stop        PROPOSED: ends the turn; what it said is kept
//   POST   /<c>/proposals/<p>         the person's answer to a proposal
//
// Dev and test only, set on `globalThis` (like the API mock's flags):
//   __fdeMockAssistantHold = n | "r2"   the next turn sends n events, or until step "r2" starts, then waits
//   __fdeMockAssistantDrop = n     the next turn's first connection drops after n events; it resumes
//   __fdeMockAssistantFail = true  the next turn fails part way
//   __fdeMockAssistantNotice = "tool_limit" | "reply_limit" | "timed_out"   the next turn ends with it

const encoder = new TextEncoder()
const TEST = import.meta.env.MODE === "test"
const flags = globalThis as Record<string, unknown>

type Scope =
  | { kind: "home" }
  | { kind: "company"; company: string }
  | { kind: "project"; company: string; project: string }

type Event = Record<string, unknown>
/** One scripted event and the pause before it, in ms. */
type Beat = { wait: number; event: Event | "done" | "error" }

type Turn = {
  id: string
  said: string
  events: Array<Event>
  ended: "done" | "error" | null
  stopped: boolean
  /** Who is waiting for the next event. */
  listeners: Set<() => void>
}

type Conversation = {
  id: string
  scope: Scope
  updated: number
  turns: Array<Turn>
  settled: Map<string, "confirmed" | "dismissed">
}

let conversations = new Map<string, Conversation>()
let count = 0

const ev = (type: string, rest: Record<string, unknown>): Event => ({ v: 1, type, ...rest })
const step = (id: string, tool: string, state: string, n?: number) =>
  ev("step", { step: n === undefined ? { id, tool, state } : { id, tool, state, count: n } })

/** Text in small pieces, as a model streams it. */
function words(text: string, wait = 28): Array<Beat> {
  const pieces = text.match(/\S+\s*|\s+/g) ?? []
  const beats: Array<Beat> = []
  for (let i = 0; i < pieces.length; i += 3)
    beats.push({ wait, event: ev("text", { delta: pieces.slice(i, i + 3).join("") }) })
  return beats
}
const at = (wait: number, event: Event | "done" | "error"): Beat => ({ wait, event })

// ── Scripts ────────────────────────────────────────────────────────────────

const PLAN_BLOCK = {
  type: "plan",
  steps: [
    {
      id: "s1",
      title: "Replay last month's orders through the planner",
      stage: "evaluate",
      criterion: {
        name: "Planner drafts within 5% of dispatcher cost",
        proof: "Replay eval on March orders, against the dispatchers' own plans",
      },
    },
    {
      id: "s2",
      title: "Shadow the north depot for one week",
      stage: "evaluate",
      with: "Marta Silva",
    },
    { id: "s3", title: "Agree the go-live checklist with the depot leads", stage: "deploy" },
    {
      id: "s4",
      title: "Roll out to the north depot crews",
      stage: "deploy",
      criterion: {
        name: "Dispatchers accept 80% of drafted plans",
        proof: "Acceptance rate from the planner's own log, two weeks after go-live",
      },
    },
    { id: "s5", title: "Hand the runbook to Kestrel's ops team", stage: "handoff" },
  ],
}

const BUILD_CHECKLIST = {
  type: "checklist",
  items: [
    { label: "Planner runs on sample orders", done: true },
    { label: "Depot rules loaded for all three depots", done: true },
    { label: "Driver-hours export agreed with the customer", done: false },
    { label: "Replay eval suite written", done: false },
    { label: "Dispatcher walkthrough recorded", done: false, optional: true },
  ],
}

const NEW_COMPANIES_CHECKLIST = {
  type: "checklist",
  items: [
    { label: "Name the company", done: true },
    { label: "Its first project and what is delivered", done: false },
    { label: "The main contact", done: false },
    { label: "A success criterion and how it is proven", done: false },
  ],
}

function planTurn(): Array<Beat> {
  return [
    at(
      150,
      ev("todo", {
        items: [
          { id: "t1", label: "Read where Dispatch copilot stands", link: { by: "step", id: "r1" } },
          {
            id: "t2",
            label: "Read its tasks and the Build checklist",
            link: { by: "step", id: "r2" },
          },
          { id: "t3", label: "Draft the rollout plan", link: { by: "reply" } },
          {
            id: "t4",
            label: "Give Sam Okafor access, if you agree",
            link: { by: "proposal", id: "p_member" },
          },
        ],
      }),
    ),
    at(120, step("r1", "project", "running")),
    at(700, step("r1", "project", "done", 2)),
    at(80, step("r2", "tasks", "running")),
    at(900, step("r2", "tasks", "done", 14)),
    at(60, step("r3", "checklist", "running")),
    at(500, step("r3", "checklist", "done", 5)),
    ...words(
      "Dispatch copilot is in Build with two of five checklist items done. The driver-hours export is still open with the customer, so the plan starts with a replay on sample orders, which needs nothing from them.\n\nHere is a rollout in five steps. Two of them prove a success criterion.",
    ),
    at(200, ev("block", { block: PLAN_BLOCK })),
    at(150, ev("block", { block: BUILD_CHECKLIST })),
    ...words(
      " Sam Okafor built the depot rules, so I suggest adding them to the team before the shadow week.",
    ),
    at(
      200,
      ev("proposal", {
        proposal: {
          id: "p_member",
          action: "set_member",
          args: { company: "cmp_kestrel", user: "usr_sam", role: "engineer" },
        },
      }),
    ),
    at(
      150,
      ev("proposal", {
        proposal: {
          id: "p_open",
          action: "open_route",
          args: {
            to: { screen: "project", company: "cmp_kestrel", project: "prj_kestrel_dispatch" },
          },
        },
      }),
    ),
  ]
}

function blockedTurn(): Array<Beat> {
  return [
    at(150, step("r1", "project", "running")),
    at(600, step("r1", "project", "done", 2)),
    ...words("One thing holds Dispatch copilot up, and it is outside the team. "),
    at(100, step("r2", "tasks", "running")),
    at(1200, step("r2", "tasks", "done", 14)),
    at(80, step("r3", "team", "running")),
    at(600, step("r3", "team", "done", 2)),
    ...words(
      "The driver-hours export has waited on the customer's security team for nine days. Two tasks depend on it: the replay eval and the north depot rollout. Everything else in Build is moving.",
    ),
    at(150, ev("block", { block: BUILD_CHECKLIST })),
  ]
}

function newCompaniesTurn(): Array<Beat> {
  return [
    at(
      150,
      ev("todo", {
        items: [
          {
            id: "t1",
            label: "Check neither is already one of your companies",
            link: { by: "step", id: "r1" },
          },
          { id: "t2", label: "Create Orion Rail", link: { by: "proposal", id: "p_orion" } },
          { id: "t3", label: "Create Halden Water", link: { by: "proposal", id: "p_halden" } },
        ],
      }),
    ),
    at(120, step("r1", "companies", "running")),
    at(800, step("r1", "companies", "done", 6)),
    ...words(
      "Neither Orion Rail nor Halden Water is one of your companies yet. I can create both, each on its own: confirm the first, then the second. Each starts with only its name; the rest is set up in its own conversation.",
    ),
    at(200, ev("block", { block: NEW_COMPANIES_CHECKLIST })),
    at(
      150,
      ev("proposal", {
        proposal: { id: "p_orion", action: "create_company", args: { name: "Orion Rail" } },
      }),
    ),
    at(
      120,
      ev("proposal", {
        proposal: { id: "p_halden", action: "create_company", args: { name: "Halden Water" } },
      }),
    ),
  ]
}

function todayTurn(): Array<Beat> {
  return [
    at(150, step("r1", "companies", "running")),
    at(700, step("r1", "companies", "done", 6)),
    ...words(
      "Two projects need you today. Dispatch copilot at Kestrel Freight is waiting on an export from the customer, and Store demand forecasts at Lumen has had no next step for a week.",
    ),
    at(
      150,
      ev("block", {
        block: {
          type: "suggestion",
          id: "g1",
          context: "Kestrel Freight · Dispatch copilot",
          title: "Chase the driver-hours export",
          detail: "Waiting on the customer's security team for 9 days.",
          approve: {
            label: "Open project",
            to: { screen: "project", company: "cmp_kestrel", project: "prj_kestrel_dispatch" },
          },
        },
      }),
    ),
  ]
}

function teamTurn(scope: Scope): Array<Beat> {
  const company = scope.kind === "home" ? "cmp_kestrel" : scope.company
  return [
    at(150, step("r1", "team", "running")),
    at(600, step("r1", "team", "done", 2)),
    ...words(
      "Two people work on it today. Sam Okafor asked to join for the referral work; adding them gives Sam access to every record here.",
    ),
    at(
      200,
      ev("proposal", {
        proposal: {
          id: "p_member",
          action: "set_member",
          args: { company, user: "usr_sam", role: "engineer" },
        },
      }),
    ),
  ]
}

function fallback(scope: Scope): Array<Beat> {
  const text =
    scope.kind === "home"
      ? "From here I read only your companies' list: names, stages and next steps. I can open a company's conversation or set up a new company. This prototype answers a few prompts only; try one of the suggestions."
      : "I read this company's records as you, and propose changes you confirm one at a time. This prototype answers a few prompts only; try one of the suggestions."
  return [
    at(150, step("r1", scope.kind === "home" ? "companies" : "company", "running")),
    at(
      500,
      step(
        "r1",
        scope.kind === "home" ? "companies" : "company",
        "done",
        scope.kind === "home" ? 6 : 2,
      ),
    ),
    ...words(text),
  ]
}

function scriptFor(said: string, scope: Scope): Array<Beat> {
  const s = said.toLowerCase()
  if (/\bplan\b/.test(s) && scope.kind !== "home") return planTurn()
  if (/block|stuck|holding/.test(s) && scope.kind !== "home") return blockedTurn()
  if (/team|add sam|who works/.test(s) && scope.kind !== "home") return teamTurn(scope)
  if (/set up|new compan|orion/.test(s) && scope.kind === "home") return newCompaniesTurn()
  if (/today|needs me/.test(s) && scope.kind === "home") return todayTurn()
  return fallback(scope)
}

/** The flags change the next turn only. */
function shaped(beats: Array<Beat>): Array<Beat> {
  const notice = flags.__fdeMockAssistantNotice
  if (flags.__fdeMockAssistantFail === true) {
    flags.__fdeMockAssistantFail = false
    const cut = beats.findIndex((b) => typeof b.event === "object" && b.event.type === "text")
    return [...beats.slice(0, Math.max(cut, 0) + 6), at(300, "error")]
  }
  if (notice === "tool_limit" || notice === "reply_limit" || notice === "timed_out") {
    flags.__fdeMockAssistantNotice = undefined
    const cut = beats.findIndex((b) => typeof b.event === "object" && b.event.type === "text")
    return [
      ...beats.slice(0, Math.max(cut, 0) + 8),
      at(100, ev("notice", { notice })),
      at(50, "done"),
    ]
  }
  return [...beats, at(80, "done")]
}

// ── Seeded history (sample data) ───────────────────────────────────────────

function finished(id: string, said: string, beats: Array<Beat>): Turn {
  const events = beats.flatMap((b) => (typeof b.event === "object" ? [b.event] : []))
  return {
    id,
    said,
    events: [ev("turn", { turn: id, said }), ...events],
    ended: "done",
    stopped: false,
    listeners: new Set(),
  }
}

function seed() {
  const now = Date.now()
  const hour = 3_600_000
  const list: Array<Conversation> = [
    {
      id: "c_kestrel_pilot",
      scope: { kind: "project", company: "cmp_kestrel", project: "prj_kestrel_dispatch" },
      updated: now - 2 * hour,
      turns: [finished("t_seed_plan", "Plan the pilot rollout for the north depot", planTurn())],
      settled: new Map(),
    },
    {
      id: "c_bright_team",
      scope: { kind: "company", company: "cmp_brightwater" },
      updated: now - 5 * hour,
      turns: [
        finished(
          "t_seed_team",
          "Who works on this, and can Sam Okafor join?",
          teamTurn({ kind: "company", company: "cmp_brightwater" }),
        ),
      ],
      settled: new Map(),
    },
    {
      id: "c_home_today",
      scope: { kind: "home" },
      updated: now - 26 * hour,
      turns: [finished("t_seed_today", "What needs me today?", todayTurn())],
      settled: new Map(),
    },
    {
      id: "c_kestrel_blocked",
      scope: { kind: "company", company: "cmp_kestrel" },
      updated: now - 3 * 24 * hour,
      turns: [finished("t_seed_blocked", "What is blocked right now?", blockedTurn())],
      settled: new Map(),
    },
    {
      id: "c_atlas_status",
      scope: { kind: "company", company: "cmp_atlas" },
      updated: now - 6 * 24 * hour,
      turns: [
        finished(
          "t_seed_atlas",
          "Where does the pilot stand?",
          fallback({ kind: "company", company: "cmp_atlas" }),
        ),
      ],
      settled: new Map(),
    },
  ]
  conversations = new Map(list.map((c) => [c.id, c]))
}

export function resetMockAssistant() {
  count = 0
  seed()
}
seed()

// ── Streaming ──────────────────────────────────────────────────────────────

function frame(id: number, event: Event) {
  return encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`)
}
const END = {
  done: encoder.encode("event: done\ndata: {}\n\n"),
  error: encoder.encode("event: error\ndata: {}\n\n"),
}

/** Plays the script into the turn, whoever is listening. */
function play(turn: Turn, beats: Array<Beat>) {
  const hold = flags.__fdeMockAssistantHold
  flags.__fdeMockAssistantHold = undefined
  const wake = () => turn.listeners.forEach((l) => l())
  // Held after this many events, or once the step with this id has started.
  const held = () => {
    if (typeof hold === "number") return turn.events.length >= hold
    if (typeof hold !== "string") return false
    const last = turn.events.at(-1)
    const s = last?.type === "step" ? (last.step as { id: string; state: string }) : null
    return s?.id === hold && s.state === "running"
  }
  void (async () => {
    for (const beat of beats) {
      if (held()) return
      if (!TEST && beat.wait) await new Promise((r) => setTimeout(r, beat.wait))
      else await Promise.resolve()
      if (turn.stopped || turn.ended) return
      if (beat.event === "done" || beat.event === "error") turn.ended = beat.event
      else turn.events.push(beat.event)
      wake()
    }
  })()
}

/** A turn's stream from after `after` (an event id, 1 for the first). `dropAfter` closes it early. */
function stream(turn: Turn, after: number, dropAfter: number | null) {
  let sent = after
  let wake: (() => void) | null = null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (dropAfter !== null && sent >= dropAfter) return controller.close()
        if (sent < turn.events.length) {
          sent++
          controller.enqueue(frame(sent, turn.events[sent - 1]!))
          return
        }
        if (turn.ended) {
          controller.enqueue(END[turn.ended])
          return controller.close()
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          turn.listeners.add(resolve)
        })
        if (wake) turn.listeners.delete(wake)
      }
    },
    cancel() {
      if (wake) turn.listeners.delete(wake)
    },
  })
}

const sse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
const json = (body: unknown, status = 200) => Response.json(body, { status })
const refuse = (status: number, error: string) => Response.json({ error }, { status })

const SCOPE_ID = /^[A-Za-z0-9_-]{1,128}$/
function scopeOf(raw: unknown): Scope | null {
  if (typeof raw !== "object" || raw === null) return null
  const s = raw as Record<string, unknown>
  if (s.kind === "home") return { kind: "home" }
  if (typeof s.company !== "string" || !SCOPE_ID.test(s.company)) return null
  if (s.kind === "company") return { kind: "company", company: s.company }
  if (s.kind === "project" && typeof s.project === "string" && SCOPE_ID.test(s.project))
    return { kind: "project", company: s.company, project: s.project }
  return null
}

function view(c: Conversation) {
  return {
    v: 1,
    turns: c.turns.map((t) => {
      const of = (type: string) => t.events.filter((e) => e.type === type)
      const live = t.ended === null && !t.stopped
      const steps = new Map<string, unknown>()
      for (const e of of("step")) steps.set((e.step as { id: string }).id, e.step)
      return {
        id: t.id,
        said: t.said,
        state: live ? "live" : t.ended === "error" ? "failed" : "done",
        text: of("text")
          .map((e) => e.delta)
          .join(""),
        blocks: of("block").map((e) => e.block),
        proposals: of("proposal").map((e) => {
          const id = (e.proposal as { id: string }).id
          return { proposal: e.proposal, state: c.settled.get(id) ?? "waiting" }
        }),
        notice: (of("notice")[0]?.notice as string | undefined) ?? null,
        steps: [...steps.values()],
        todo: of("todo").at(-1)?.items,
      }
    }),
  }
}

/** Answers `/assistant/conversations…`, or null for anything else. */
export async function assistantRoutes(
  pathname: string,
  method: string,
  request: Request,
): Promise<Response | null> {
  const prefix = "/assistant/conversations"
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null
  const [id, kind, part, action] = pathname.slice(prefix.length + 1).split("/")
  if (!id) {
    if (method === "GET")
      return json({
        v: 1,
        conversations: [...conversations.values()]
          .filter((c) => c.turns.length > 0)
          .sort((a, b) => b.updated - a.updated)
          .map((c) => ({
            id: c.id,
            scope: c.scope,
            title: c.turns[0]!.said.split("\n")[0]!.slice(0, 120),
            updated_at: new Date(c.updated).toISOString(),
          })),
      })
    if (method !== "POST") return refuse(405, "method_not_allowed")
    const body = (await request.json().catch(() => null)) as { scope?: unknown } | null
    const scope = scopeOf(body?.scope)
    if (!scope) return refuse(400, "invalid_scope")
    const created: Conversation = {
      id: `c_proto${++count}`,
      scope,
      updated: Date.now(),
      turns: [],
      settled: new Map(),
    }
    conversations.set(created.id, created)
    return json({ id: created.id }, 201)
  }
  const c = conversations.get(id)
  // Not one of this mock's: the welcome screen's own conversation finds no assistant, as before.
  if (!c) return refuse(404, "not_found")
  if (kind === undefined && method === "GET") return json(view(c))
  if (kind === "turns" && part === undefined && method === "POST") {
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null
    const said = typeof body?.text === "string" ? body.text.trim() : ""
    if (!said) return refuse(400, "invalid_text")
    if ([...said].length > 2000) return refuse(400, "too_long")
    if (c.turns.some((t) => t.ended === null && !t.stopped)) return refuse(409, "busy")
    const turn: Turn = {
      id: `t_proto${++count}`,
      said,
      events: [],
      ended: null,
      stopped: false,
      listeners: new Set(),
    }
    turn.events.push(ev("turn", { turn: turn.id, said }))
    c.turns.push(turn)
    c.updated = Date.now()
    const drop =
      typeof flags.__fdeMockAssistantDrop === "number" ? flags.__fdeMockAssistantDrop : null
    flags.__fdeMockAssistantDrop = undefined
    play(turn, shaped(scriptFor(said, c.scope)))
    return sse(stream(turn, 0, drop))
  }
  const turn = kind === "turns" ? c.turns.find((t) => t.id === part) : undefined
  if (kind === "turns" && action === "events" && method === "GET") {
    if (!turn) return refuse(404, "no_turn")
    const last = Number(request.headers.get("Last-Event-ID") ?? "0")
    return sse(stream(turn, Number.isSafeInteger(last) && last > 0 ? last : 0, null))
  }
  if (kind === "turns" && action === "stop" && method === "POST") {
    if (!turn) return refuse(404, "no_turn")
    if (!turn.ended) {
      turn.stopped = true
      turn.ended = "done"
      turn.listeners.forEach((l) => l())
    }
    return new Response(null, { status: 204 })
  }
  if (kind === "proposals" && part && action === undefined && method === "POST") {
    const body = (await request.json().catch(() => null)) as { outcome?: unknown } | null
    if (body?.outcome !== "confirmed" && body?.outcome !== "dismissed")
      return refuse(400, "invalid_outcome")
    c.settled.set(part, body.outcome)
    return new Response(null, { status: 204 })
  }
  return refuse(404, "not_found")
}

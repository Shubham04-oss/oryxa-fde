import { HEADERS, selected } from "@/lib/api/client"
import { MAX_BLOCKS, MAX_PROPOSALS, MAX_REPLY, REFUSALS, parseEvent, parseView } from "./wire"
import type { ProposalState, Refusal, Turn, WireEvent } from "./wire"

// The welcome screen's side of the assistant (issue #236): a small client of our own over this app's
// `/assistant/*` routes (src/assistant.ts), rather than the AI SDK's chat hook, so every event is checked
// with the shared wire schemas before it is used and an unknown or malformed one is dropped, not thrown.
// Where the assistant is not configured, or on the dev mock, it answers "off" and the screen keeps its
// scripted answers.

/** How many times a dropped turn reconnects before it gives up. */
const RECONNECTS = 3
/**
 * How long the screen waits on a turn, reconnects included: the Worker's own limit (90 seconds,
 * `TURN_TIMEOUT_MS` in assistant/src/limits.ts) and some room, so its plain notice usually comes first.
 */
export const TURN_DEADLINE_MS = 120_000
/** How long one read may hear nothing at all. The Worker sends a heartbeat every 15 seconds. */
export const READ_IDLE_MS = 45_000
/** The most of a frame held while it waits for its end: well over the Worker's largest event (64 KiB). */
export const MAX_PENDING = 256 * 1024

const path = (conversation: string, rest = "") => `/assistant/conversations/${conversation}${rest}`

async function send(target: string, init: RequestInit = {}): Promise<Response> {
  const transport = await selected()
  return transport.fetch(new Request(`${globalThis.location.origin}${target}`, init))
}

/** The error code of a JSON refusal, or null. */
async function codeOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    const error =
      typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null
    return typeof error === "string" ? error : null
  } catch {
    return null
  }
}

/** A new conversation's id: random, so it cannot be guessed, and checked by the platform's id rule. */
export const newConversation = () => `c_${crypto.randomUUID().replaceAll("-", "")}`

export type Opened =
  /** No assistant here: the scripted answers stand in. */
  | { kind: "off" }
  | { kind: "on"; turns: Array<Turn> }
  /** The conversation belongs to someone else (another sign-in on this browser): start a new one. */
  | { kind: "not_yours" }

/** The conversation so far, and whether the assistant answers here at all. */
export async function openConversation(conversation: string): Promise<Opened> {
  let response: Response
  try {
    response = await send(path(conversation))
  } catch {
    return { kind: "off" }
  }
  if (response.status === 200) {
    const turns = parseView(await response.json().catch(() => null))
    return turns === null ? { kind: "off" } : { kind: "on", turns }
  }
  const code = await codeOf(response)
  if (response.status === 404 && code === "no_conversation") return { kind: "on", turns: [] }
  if (response.status === 403 && code === "not_your_conversation") return { kind: "not_yours" }
  return { kind: "off" }
}

export type Ended =
  | { kind: "done" }
  | { kind: "failed" }
  /** The turn ran past `TURN_DEADLINE_MS`; the screen says so plainly. */
  | { kind: "timed_out" }
  /** The turn never started; `refusal` says why, in a code the screen puts in words. */
  | { kind: "refused"; refusal: Refusal | "unknown" }
  | { kind: "off" }

type Frame = { id: number | null; event: string | null; data: string | null }

function frameOf(block: string): Frame | null {
  if (block.startsWith(":")) return null
  const frame: Frame = { id: null, event: null, data: null }
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) frame.id = Number(line.slice(4))
    else if (line.startsWith("event: ")) frame.event = line.slice(7)
    else if (line.startsWith("data: ")) frame.data = line.slice(6)
  }
  return frame
}

/**
 * What one turn may still take, and what it has carried so far. It is shared by every connection the
 * turn makes, so a reconnect neither starts the caps again nor moves the deadline.
 */
export type Budget = {
  text: number
  blocks: number
  proposals: number
  /** When the screen gives up on the turn (ms since the epoch). */
  until: number
  /** How long one read may hear nothing. */
  idleMs: number
}

export const budget = (now = Date.now()): Budget => ({
  text: 0,
  blocks: 0,
  proposals: 0,
  until: now + TURN_DEADLINE_MS,
  idleMs: READ_IDLE_MS,
})

/** Counts `event` against the reply's caps; false once it would pass one (the Worker keeps to them). */
function within(given: Budget, event: WireEvent): boolean {
  if (event.type === "text") return (given.text += [...event.delta].length) <= MAX_REPLY
  if (event.type === "block") return ++given.blocks <= MAX_BLOCKS
  if (event.type === "proposal") return ++given.proposals <= MAX_PROPOSALS
  return true
}

/** The next read, or why there is none in time: nothing heard for `idleMs`, or the deadline. */
async function nextRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  given: Budget,
): Promise<ReadableStreamReadResult<Uint8Array> | "idle" | "late"> {
  const left = given.until - Date.now()
  if (left <= 0) return "late"
  const late = left <= given.idleMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<"idle" | "late">((resolve) => {
    timer = setTimeout(() => resolve(late ? "late" : "idle"), late ? left : given.idleMs)
  })
  try {
    return await Promise.race([reader.read(), waited])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reads one turn's stream, handing each checked event to `onEvent`. Answers how it ended: done,
 * failed, dropped part way (with the last event it had), cut off for passing a cap, or timed out.
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: WireEvent) => void,
  given: Budget = budget(),
): Promise<{
  ended: "done" | "failed" | "dropped" | "cut" | "timed_out"
  last: number | null
  turn: string | null
}> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let last: number | null = null
  let turn: string | null = null
  // Stops reading; the connection is let go, so nothing more of it is held.
  const stop = (ended: "dropped" | "cut" | "timed_out") => {
    void reader.cancel().catch(() => {})
    return { ended, last, turn }
  }
  try {
    for (;;) {
      const read = await nextRead(reader, given)
      if (read === "idle") return stop("dropped")
      if (read === "late") return stop("timed_out")
      if (read.done) return { ended: "dropped", last, turn }
      buffer += decoder.decode(read.value, { stream: true })
      const blocks = buffer.split("\n\n")
      buffer = blocks.pop() ?? ""
      for (const frame of blocks.map(frameOf)) {
        if (frame === null) continue
        if (frame.event === "done") return { ended: "done", last, turn }
        if (frame.event === "error") return { ended: "failed", last, turn }
        if (frame.event !== null || frame.data === null) continue
        let raw: unknown
        try {
          raw = JSON.parse(frame.data)
        } catch {
          raw = null
        }
        const event = parseEvent(raw)
        if (event !== null && !within(given, event)) return stop("cut")
        if (frame.id !== null && Number.isSafeInteger(frame.id)) last = frame.id
        if (event === null) continue
        if (event.type === "turn") turn = event.turn
        onEvent(event)
      }
      if (buffer.length > MAX_PENDING) return stop("cut")
    }
  } catch {
    return { ended: "dropped", last, turn }
  } finally {
    reader.releaseLock()
  }
}

/** Follows a turn's stream from after `last` (or from the start), reconnecting a few times if it drops. */
export async function followTurn(
  conversation: string,
  turn: string,
  last: number | null,
  onEvent: (event: WireEvent) => void,
  given: Budget = budget(),
): Promise<"done" | "failed" | "timed_out"> {
  let from = last
  for (let attempt = 0; attempt < RECONNECTS; attempt++) {
    if (Date.now() >= given.until) return "timed_out"
    let response: Response
    try {
      response = await send(path(conversation, `/turns/${turn}/events`), {
        headers: from === null ? {} : { "Last-Event-ID": String(from) },
      })
    } catch {
      continue
    }
    if (response.status !== 200 || !response.body) return "failed"
    const read = await readStream(response.body, onEvent, given)
    if (read.ended === "cut") return "failed"
    if (read.ended !== "dropped") return read.ended
    from = read.last ?? from
  }
  return "failed"
}

/** Says `text`: the turn's events go to `onEvent` as they arrive, and a dropped connection resumes. */
export async function sendTurn(
  conversation: string,
  text: string,
  onEvent: (event: WireEvent) => void,
  given: Budget = budget(),
): Promise<Ended> {
  let response: Response
  try {
    response = await send(path(conversation, "/turns"), {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
  } catch {
    return { kind: "off" }
  }
  if (response.status !== 200 || !response.body) {
    const code = await codeOf(response)
    if ((REFUSALS as ReadonlyArray<string>).includes(code ?? ""))
      return { kind: "refused", refusal: code as Refusal }
    // The dev mock and an unconfigured server answer with codes of their own: no assistant here.
    if (code === "assistant_not_configured" || code === "not_found") return { kind: "off" }
    return { kind: "refused", refusal: "unknown" }
  }
  const read = await readStream(response.body, onEvent, given)
  // A stream that passed a cap is not followed again: it would only send the same again.
  if (read.ended === "cut") return { kind: "failed" }
  if (read.ended !== "dropped") return { kind: read.ended }
  if (read.turn === null) return { kind: "failed" }
  return { kind: await followTurn(conversation, read.turn, read.last, onEvent, given) }
}

/** Tells the assistant the person has answered a proposal; the action itself was the API's. */
export async function settleProposal(
  conversation: string,
  proposal: string,
  outcome: Exclude<ProposalState, "waiting">,
): Promise<boolean> {
  try {
    const response = await send(path(conversation, `/proposals/${proposal}`), {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    })
    return response.status === 204
  } catch {
    return false
  }
}

/** What a refusal says, plainly. */
export const REFUSAL_TEXT: Record<Refusal | "unknown", string> = {
  too_long: "That message is too long for me. Keep it under 2,000 characters.",
  rate_limited: "You've sent several messages in the last minute. Wait a moment, then try again.",
  turn_limit: "This conversation is full. Start a new one to keep going.",
  busy: "I'm still answering your last message.",
  model_unavailable: "I can't answer right now: no model is switched on for the workspace.",
  unknown: "I couldn't answer that. Try again in a moment.",
}

/** What a notice says, plainly. */
export const NOTICE_TEXT = {
  tool_limit: "I stopped looking things up: one message may take only a few lookups.",
  reply_limit: "I stopped there: that reply reached its length limit.",
  timed_out:
    "I ran out of time on that one, so this answer is incomplete. Try again, or ask for less at once.",
  failed: "Something went wrong part way through, so this answer is incomplete.",
} as const

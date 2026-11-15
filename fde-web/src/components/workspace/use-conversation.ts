import { useEffect, useRef, useState } from "react"
import type { Block } from "@/lib/workspace/blocks"
import {
  CONVERSATION_ID,
  CONVERSATION_TEXT,
  HOME_KEY,
  NOTICE_TEXT,
  REFUSAL_TEXT,
  WAITING_PREFIX,
  createConversation,
  followTurn,
  openConversation,
  sendTurn,
  settleProposal,
  stopTurn,
} from "@/lib/workspace/assistant"
import { MAX_READ_STEPS, MAX_SAID } from "@/lib/workspace/wire"
import type { Notice, Proposal, ProposalState, Step, Turn, WireEvent } from "@/lib/workspace/wire"
import type { Reply } from "@/lib/workspace/welcome"

// The welcome screen's conversation (issue #236): with the assistant where it is configured, and the
// scripted answers where it is not. The API makes the conversation, as the person, before its first
// message (issue #273), and its id is kept in this browser, so a second tab, or the same one after a
// reload, shows the same conversation; this app's server asks the API it is this person's on every call.
// While a turn runs the person can stop it (issue #264), and a message typed meanwhile waits, one at
// most, until the turn ends: it is sent then, or handed back to edit if the turn was stopped or failed.

// A short pause before a scripted reply, so it reads as an answer; none in tests.
const THINK_MS = import.meta.env.MODE === "test" ? 0 : 450

export type Proposed = { proposal: Proposal; state: ProposalState }
export type YouTurn = { id: number; who: "you"; text: string }
export type WorkspaceTurn = {
  id: number
  who: "workspace"
  text: string
  blocks: Array<Block>
  proposals: Array<Proposed>
  /** The reads made for this reply, each shown as one quiet line. */
  steps: Array<Step>
  /** Said plainly under the reply when it stopped short. */
  notice: string | null
  streaming: boolean
}
export type ThreadTurn = YouTurn | WorkspaceTurn

const workspace = (id: number, streaming: boolean): WorkspaceTurn => ({
  id,
  who: "workspace",
  text: "",
  blocks: [],
  proposals: [],
  steps: [],
  notice: null,
  streaming,
})

/** A turn with one more event of its stream applied. */
export function applyEvent(turn: WorkspaceTurn, event: WireEvent): WorkspaceTurn {
  switch (event.type) {
    case "text":
      return { ...turn, text: turn.text + event.delta }
    case "block":
      return { ...turn, blocks: [...turn.blocks, event.block] }
    case "proposal":
      return {
        ...turn,
        proposals: [...turn.proposals, { proposal: event.proposal, state: "waiting" }],
      }
    case "notice":
      return { ...turn, notice: NOTICE_TEXT[event.notice] }
    case "step": {
      const at = turn.steps.findIndex((s) => s.id === event.step.id)
      if (at < 0)
        return turn.steps.length >= MAX_READ_STEPS
          ? turn
          : { ...turn, steps: [...turn.steps, event.step] }
      // A step's tool never changes, and a finished step stays finished.
      const old = turn.steps[at]!
      if (old.tool !== event.step.tool || old.state !== "running") return turn
      return { ...turn, steps: turn.steps.map((s, i) => (i === at ? event.step : s)) }
    }
    case "turn":
      return turn
  }
}

/** A turn whose stream has ended: it stops streaming, and says plainly if it stopped short. */
function finished(turn: WorkspaceTurn, ended: "done" | "failed" | "timed_out"): WorkspaceTurn {
  // A notice the Worker sent says it best; the screen's own words are for when it sent none.
  const notice = ended === "done" ? turn.notice : (turn.notice ?? NOTICE_TEXT[ended])
  // A read the reply no longer waits on is not still going.
  const steps = turn.steps.map((s): Step => (s.state === "running" ? { ...s, state: "failed" } : s))
  return { ...turn, notice, steps, streaming: false }
}

/** How a turn ended, for a message waiting on it: sent on after "done", handed back otherwise. */
type How = "done" | "stopped" | "failed"

/** A message handed back to the box: queued while a turn ran that was then stopped or failed, or taken back to edit. */
export type Returned = {
  text: string
  /**
   * `reload`: it was waiting when the page reloaded, and is never sent without the person. `gone` and
   * `unstarted`: it never reached a conversation, and the reply says why.
   */
  why: "stopped" | "failed" | "edit" | "reload" | "gone" | "unstarted"
  at: number
}

/** Where this tab keeps a waiting message, per conversation, so a reload does not lose it. */
const waitingKey = (conversation: string) => `${WAITING_PREFIX}${conversation}`

/** Keeps `text` for this tab, cut to a message's own limit, or forgets it; without storage it lasts as long as the page. */
function keepWaiting(conversation: string, text: string | null) {
  if (!conversation) return
  try {
    if (text === null) window.sessionStorage.removeItem(waitingKey(conversation))
    else
      window.sessionStorage.setItem(waitingKey(conversation), [...text].slice(0, MAX_SAID).join(""))
  } catch {
    // Kept in memory only.
  }
}

/** The message that was waiting in this tab, once: it is taken out of storage as it is read. */
function takeWaiting(conversation: string): string | null {
  try {
    const text = window.sessionStorage.getItem(waitingKey(conversation))
    window.sessionStorage.removeItem(waitingKey(conversation))
    const kept = text === null ? "" : [...text].slice(0, MAX_SAID).join("").trim()
    return kept === "" ? null : kept
  } catch {
    return null
  }
}

function readStored() {
  try {
    const id = window.localStorage.getItem(HOME_KEY)
    if (id !== null && CONVERSATION_ID.test(id)) return id
    // An id from before the API made them (`c_...`), or anything else: never used, so not kept.
    if (id !== null) window.localStorage.removeItem(HOME_KEY)
    return null
  } catch {
    return null
  }
}

function store(id: string | null) {
  try {
    if (id === null) window.localStorage.removeItem(HOME_KEY)
    else window.localStorage.setItem(HOME_KEY, id)
  } catch {
    // Without storage the conversation lasts as long as the tab.
  }
}

export function useConversation(scripted: (said: string) => Reply) {
  const [turns, setTurns] = useState<Array<ThreadTurn>>([])
  const [thinking, setThinking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [queued, setQueued] = useState<string | null>(null)
  const [returned, setReturned] = useState<Returned | null>(null)
  /** The person pressed Enter while a message was already waiting: the screen says why nothing happened. */
  const [full, setFull] = useState(false)
  const mode = useRef<Promise<"on" | "off"> | null>(null)
  const conversation = useRef("")
  const next = useRef(0)
  // Set at once, unlike state, so a second message in the same moment is queued, not sent.
  const busy = useRef(false)
  const waiting = useRef<string | null>(null)
  /** The running turn's id once its stream names it, and whether the person asked to stop it. */
  const live = useRef<{ turn: string | null; stop: boolean }>({ turn: null, stop: false })

  /** Sets the waiting message, here and in this tab's storage. */
  const hold = (text: string | null) => {
    waiting.current = text
    setQueued(text)
    setFull(false)
    keepWaiting(conversation.current, text)
  }

  /**
   * Sends the stop for `turn`. If the assistant did not take it (refused, or unreachable), the turn is not
   * stopping after all: the flag clears and Stop can be pressed again.
   */
  const askStop = (turn: string) => {
    void stopTurn(conversation.current, turn).then((taken) => {
      if (taken || live.current.turn !== turn) return
      live.current.stop = false
      setStopping(false)
    })
  }

  const update = (id: number, change: (turn: WorkspaceTurn) => WorkspaceTurn) =>
    setTurns((all) => all.map((t) => (t.id === id && t.who === "workspace" ? change(t) : t)))

  const begin = (turn: string | null) => {
    busy.current = true
    live.current = { turn, stop: false }
    setThinking(true)
  }

  /** Learns the turn's id from its stream, and sends a stop asked for before it was known. */
  const heard = (event: WireEvent) => {
    if (event.type !== "turn" || live.current.turn !== null) return
    live.current.turn = event.turn
    if (live.current.stop && conversation.current) askStop(event.turn)
  }

  /**
   * The turn is over: the waiting message goes now if the turn finished, and back to the box if it was stopped
   * or failed. How it ended decides, not whether Stop was pressed: a stop refused or too slow left it to finish.
   */
  const end = (how: How) => {
    busy.current = false
    live.current = { turn: null, stop: false }
    setThinking(false)
    setStopping(false)
    const message = waiting.current
    hold(null)
    if (message === null) return
    if (how === "done") void run(message)
    else setReturned({ text: message, why: how, at: Date.now() })
  }

  /**
   * The message never reached the assistant: `line` says why in the reply, and the message goes back in the box,
   * with one that was waiting after it, for the person to send again; it is never resent by itself.
   */
  const handBack = (reply: number, text: string, line: string, why: "gone" | "unstarted") => {
    update(reply, (t) => ({ ...t, text: line, streaming: false }))
    const held = waiting.current
    hold(null)
    end("failed")
    setReturned({ text: held === null ? text : `${text}\n${held}`, why, at: Date.now() })
  }

  // Whether the assistant answers here, and the conversation so far, with a live turn followed.
  useEffect(() => {
    const mounted = { current: true }
    mode.current = (async () => {
      const id = readStored()
      // None yet: the API makes one at the first message, which also finds out if the assistant is here.
      if (id === null) return "on"
      const opened = await openConversation(id)
      if (opened.kind === "off") return "off"
      if (opened.kind === "gone") {
        // Not this person's, or not there: neither it nor a message kept waiting on it is used again.
        keepWaiting(id, null)
        store(null)
        return "on"
      }
      conversation.current = id
      store(id)
      if (!mounted.current) return "on"
      const shown = opened.turns.flatMap((t) => fromView(t, (next.current += 2)))
      setTurns(shown)
      // A message that was waiting when the page reloaded goes back in the box; it is never sent by itself.
      const kept = takeWaiting(id)
      if (kept !== null) setReturned({ text: kept, why: "reload", at: Date.now() })
      const running = opened.turns.find((t) => t.state === "live")
      const liveTurn = shown.at(-1)
      if (running && liveTurn?.who === "workspace" && !busy.current) {
        // A turn still running from before a reload: it can be stopped, and holds a new message back.
        begin(running.id)
        let notice: Notice | null = null
        void followTurn(id, running.id, null, (event) => {
          if (event.type === "notice") notice = event.notice
          update(liveTurn.id, (t) => applyEvent(t, event))
        }).then((ended) => {
          update(liveTurn.id, (t) => finished(t, ended))
          end(howEnded(ended, notice))
        })
      }
      return "on"
    })()
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Says `text`, or, while a turn runs, keeps it to send when that turn ends. Answers false when one is
   * already waiting: the person keeps what they typed.
   */
  function say(text: string): boolean {
    if (!busy.current) {
      void run(text)
      return true
    }
    if (waiting.current !== null) {
      setFull(true)
      return false
    }
    hold(text)
    return true
  }

  /** Takes the waiting message back, to edit it in the box. */
  function unqueue() {
    const message = waiting.current
    if (message === null) return
    hold(null)
    setReturned({ text: message, why: "edit", at: Date.now() })
  }

  /** Stops the running turn. What it said stays; it ends with a plain notice from the assistant. */
  function stop() {
    if (!busy.current || live.current.stop) return
    live.current.stop = true
    setStopping(true)
    const turn = live.current.turn
    if (turn !== null && conversation.current) askStop(turn)
  }

  async function run(text: string) {
    const you = ++next.current
    const reply = ++next.current
    setReturned(null)
    setTurns((all) => [...all, { id: you, who: "you", text }])
    begin(null)
    const on = (await (mode.current ?? Promise.resolve("off"))) === "on"
    /** Answers from the script, and says how that ended. */
    const answerScripted = async (): Promise<How> => {
      if (THINK_MS) await new Promise((resolve) => setTimeout(resolve, THINK_MS))
      // Stopped before the script answered: nothing was said, and it says so.
      const stopped = live.current.stop
      const replied = stopped
        ? { text: "", blocks: [], notice: NOTICE_TEXT.stopped }
        : scripted(text)
      setTurns((all) => [
        ...all.filter((t) => t.id !== reply),
        { ...workspace(reply, false), ...replied },
      ])
      return stopped ? "stopped" : "done"
    }
    if (!on) {
      end(await answerScripted())
      return
    }
    setTurns((all) => [...all, workspace(reply, true)])
    if (!conversation.current) {
      const made = await createConversation()
      if (made.kind === "off") {
        mode.current = Promise.resolve("off")
        end(await answerScripted())
        return
      }
      if (made.kind === "refused") {
        handBack(reply, text, CONVERSATION_TEXT.unstarted, "unstarted")
        return
      }
      conversation.current = made.id
      store(made.id)
    }
    let notice: Notice | null = null
    const ended = await sendTurn(conversation.current, text, (event) => {
      heard(event)
      if (event.type === "notice") notice = event.notice
      update(reply, (t) => applyEvent(t, event))
    })
    if (ended.kind === "gone") {
      // No longer this person's (another sign-in, or access lost): it and what waited on it are dropped, and
      // the next message starts a new one.
      const gone = conversation.current
      handBack(reply, text, CONVERSATION_TEXT.gone, "gone")
      conversation.current = ""
      store(null)
      keepWaiting(gone, null)
      return
    }
    let how: How = "failed"
    if (ended.kind === "off") how = await answerScripted()
    else if (ended.kind === "refused")
      update(reply, (t) => ({ ...t, text: REFUSAL_TEXT[ended.refusal] }))
    if (ended.kind !== "off" && ended.kind !== "refused") {
      update(reply, (t) => finished(t, ended.kind))
      how = howEnded(ended.kind, notice)
    } else update(reply, (t) => ({ ...t, streaming: false }))
    end(how)
  }

  /** Records the person's answer to a proposal, here and with the assistant; the action itself is the caller's. */
  function settle(turn: number, proposal: string, outcome: "confirmed" | "dismissed") {
    update(turn, (t) => ({
      ...t,
      proposals: t.proposals.map((p) =>
        p.proposal.id === proposal ? { ...p, state: outcome } : p,
      ),
    }))
    if (conversation.current) void settleProposal(conversation.current, proposal, outcome)
  }

  return { turns, thinking, stopping, queued, full, returned, say, stop, unqueue, settle }
}

/** Whether a reply ended so that a message typed meanwhile should not go on as if it had answered. */
const stoppedShort = (notice: Notice | null) =>
  notice === "stopped" || notice === "failed" || notice === "timed_out"

/** How a turn from the assistant ended: stopped only when it says so, done only when it finished whole. */
function howEnded(ended: "done" | "failed" | "timed_out", notice: Notice | null): How {
  if (notice === "stopped") return "stopped"
  return ended === "done" && !stoppedShort(notice) ? "done" : "failed"
}

/** A turn the assistant holds, as the thread shows it: what the person said, then the reply. */
function fromView(turn: Turn, id: number): Array<ThreadTurn> {
  return [
    { id: id - 1, who: "you", text: turn.said },
    {
      id,
      who: "workspace",
      // A live turn is replayed from its stream, so it starts empty.
      text: turn.state === "live" ? "" : turn.text,
      blocks: turn.state === "live" ? [] : turn.blocks,
      proposals: turn.state === "live" ? [] : turn.proposals,
      // Steps are not kept with a finished turn; a live one replays them from its stream.
      steps: [],
      notice:
        turn.state === "failed"
          ? NOTICE_TEXT.failed
          : turn.notice
            ? NOTICE_TEXT[turn.notice]
            : null,
      streaming: turn.state === "live",
    },
  ]
}

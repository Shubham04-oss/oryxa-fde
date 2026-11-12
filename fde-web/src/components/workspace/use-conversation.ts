import { useEffect, useRef, useState } from "react"
import type { Block } from "@/lib/workspace/blocks"
import {
  NOTICE_TEXT,
  REFUSAL_TEXT,
  followTurn,
  newConversation,
  openConversation,
  sendTurn,
  settleProposal,
} from "@/lib/workspace/assistant"
import type { Proposal, ProposalState, Turn, WireEvent } from "@/lib/workspace/wire"
import type { Reply } from "@/lib/workspace/welcome"

// The welcome screen's conversation (issue #236): with the assistant where it is configured, and the
// scripted answers where it is not. The conversation's id is kept in this browser, so a second tab, or
// the same one after a reload, shows the same conversation; the assistant checks it is this person's.

/** Where this browser keeps the home conversation's id. Not a secret: the assistant checks whose it is. */
const STORED = "fde.assistant.home"
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
    case "turn":
      return turn
  }
}

function readStored() {
  try {
    const id = window.localStorage.getItem(STORED)
    return id && /^c_[A-Za-z0-9_-]{1,126}$/.test(id) ? id : null
  } catch {
    return null
  }
}

function store(id: string) {
  try {
    window.localStorage.setItem(STORED, id)
  } catch {
    // Without storage the conversation lasts as long as the tab.
  }
}

export function useConversation(scripted: (said: string) => Reply) {
  const [turns, setTurns] = useState<Array<ThreadTurn>>([])
  const [thinking, setThinking] = useState(false)
  const mode = useRef<Promise<"on" | "off"> | null>(null)
  const conversation = useRef("")
  const next = useRef(0)

  const update = (id: number, change: (turn: WorkspaceTurn) => WorkspaceTurn) =>
    setTurns((all) => all.map((t) => (t.id === id && t.who === "workspace" ? change(t) : t)))

  // Whether the assistant answers here, and the conversation so far, with a live turn followed.
  useEffect(() => {
    const mounted = { current: true }
    mode.current = (async () => {
      let id = readStored() ?? newConversation()
      let opened = await openConversation(id)
      if (opened.kind === "not_yours") {
        id = newConversation()
        opened = { kind: "on", turns: [] }
      }
      if (opened.kind === "off") return "off"
      conversation.current = id
      store(id)
      if (!mounted.current) return "on"
      const shown = opened.turns.flatMap((t) => fromView(t, (next.current += 2)))
      setTurns(shown)
      const live = opened.turns.find((t) => t.state === "live")
      const liveTurn = shown.at(-1)
      if (live && liveTurn?.who === "workspace") {
        void followTurn(id, live.id, null, (event) =>
          update(liveTurn.id, (t) => applyEvent(t, event)),
        ).then(() => update(liveTurn.id, (t) => ({ ...t, streaming: false })))
      }
      return "on"
    })()
    return () => {
      mounted.current = false
    }
  }, [])

  async function say(text: string) {
    const you = ++next.current
    const reply = ++next.current
    setTurns((all) => [...all, { id: you, who: "you", text }])
    setThinking(true)
    const on = (await (mode.current ?? Promise.resolve("off"))) === "on"
    const answerScripted = async () => {
      if (THINK_MS) await new Promise((resolve) => setTimeout(resolve, THINK_MS))
      const replied = scripted(text)
      setTurns((all) => [
        ...all.filter((t) => t.id !== reply),
        { ...workspace(reply, false), ...replied },
      ])
    }
    if (!on) {
      await answerScripted()
      setThinking(false)
      return
    }
    setTurns((all) => [...all, workspace(reply, true)])
    const ended = await sendTurn(conversation.current, text, (event) =>
      update(reply, (t) => applyEvent(t, event)),
    )
    if (ended.kind === "off") await answerScripted()
    else if (ended.kind === "refused")
      update(reply, (t) => ({ ...t, text: REFUSAL_TEXT[ended.refusal] }))
    else if (ended.kind === "failed")
      update(reply, (t) => ({ ...t, notice: t.notice ?? NOTICE_TEXT.failed }))
    update(reply, (t) => ({ ...t, streaming: false }))
    setThinking(false)
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

  return { turns, thinking, say, settle }
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

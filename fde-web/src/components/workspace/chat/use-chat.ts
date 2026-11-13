import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useGo } from "../blocks"
import { api } from "@/lib/api/client"
import { commitCompanyCreated, companyBody } from "@/lib/records"
import { reason } from "@/lib/task-move"
import { settleProposal } from "@/lib/workspace/assistant"
import { applyChatEvent, confirmable, endTurn, nextPhase, withProposal } from "@/lib/workspace/chat"
import type { ChatProposal, ChatTurn, ProposalAction, Scope } from "@/lib/workspace/chat"
import {
  followChatTurn,
  readConversation,
  sendChatTurn,
  startConversation,
  stopTurn,
} from "@/lib/workspace/chat-client"
import type { Destination } from "@/lib/workspace/blocks"

// One conversation of the prototype (issue #263): its turns, the turn in flight, a message queued
// behind it, and the person's answers to proposals. A proposal's action is an ordinary API call made
// here with the person's session; the assistant only hears the outcome (ADR 0008).

export type Opening = "loading" | "ready" | "missing"

let local = 0

export function useChat({
  conversation,
  scope,
  onStarted,
  onChanged,
}: {
  /** The conversation's id, or null for a new one not yet started. */
  conversation: string | null
  scope: Scope
  /** A new conversation was made on the first message: the route takes its id. */
  onStarted: (id: string) => void
  /** A turn ended: the conversation list may have changed. */
  onChanged: () => void
}) {
  const client = useQueryClient()
  const go = useGo()
  const [turns, setTurns] = useState<Array<ChatTurn>>([])
  const [opening, setOpening] = useState<Opening>(conversation ? "loading" : "ready")
  const [queued, setQueued] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const id = useRef<string | null>(conversation)
  // The conversation this hook started itself: its turns are already here, so it is not read again.
  const startedHere = useRef<string | null>(null)
  // The turns as they are now, for the callbacks of a stream that outlives a render.
  const current = useRef(turns)
  current.current = turns

  const update = (key: string, change: (turn: ChatTurn) => ChatTurn) =>
    setTurns((all) => all.map((t) => (t.key === key ? change(t) : t)))

  useEffect(() => {
    if (conversation !== null && conversation === startedHere.current) return
    id.current = conversation
    setTurns([])
    setQueued(null)
    setProblem(null)
    if (conversation === null) {
      setOpening("ready")
      return
    }
    setOpening("loading")
    let live = true
    void readConversation(conversation).then((read) => {
      if (!live) return
      if (read === null) return setOpening("missing")
      setTurns(read)
      setOpening("ready")
      // A turn still running when the page opened is followed from its start: its parts start empty.
      const running = read.find((t) => t.status === "streaming")
      if (running?.turn)
        void followChatTurn(conversation, running.turn, (event) =>
          update(running.key, (t) => applyChatEvent(t, event)),
        ).then((ended) => update(running.key, (t) => endTurn(t, ended)))
    })
    return () => {
      live = false
    }
  }, [conversation])

  const running = turns.some((t) => t.status === "streaming")

  async function send(text: string) {
    setProblem(null)
    let target = id.current
    if (target === null) {
      target = await startConversation(scope)
      if (target === null) {
        setProblem("This conversation could not be started. Try again in a moment.")
        return
      }
      id.current = target
      startedHere.current = target
      onStarted(target)
    }
    const key = `k${++local}`
    setTurns((all) => [
      ...all,
      { key, turn: null, said: text, status: "streaming", parts: [], notice: null },
    ])
    const ended = await sendChatTurn(target, text, (event) =>
      update(key, (t) => applyChatEvent(t, event)),
    )
    if (ended.kind === "refused" || ended.kind === "off")
      update(key, (t) => ({
        ...endTurn(t, "refused"),
        refusal: ended.kind === "refused" ? ended.refusal : "unknown",
      }))
    else update(key, (t) => endTurn(t, ended.kind))
    onChanged()
    return ended.kind
  }

  // A queued message goes once the turn before it has ended well; after a failure it waits for the person.
  const last = turns.at(-1)
  useEffect(() => {
    if (queued === null || running || !last) return
    if (last.status !== "done" && last.status !== "stopped") return
    const text = queued
    setQueued(null)
    void send(text)
  }, [queued, running, last?.status])

  function say(text: string) {
    if (running) setQueued(text)
    else void send(text)
  }

  function stop() {
    const turn = current.current.find((t) => t.status === "streaming")
    if (!turn) return
    update(turn.key, (t) => endTurn(t, "stopped"))
    if (id.current && turn.turn) void stopTurn(id.current, turn.turn)
  }

  function retry(key: string) {
    const turn = current.current.find((t) => t.key === key)
    if (!turn || running) return
    update(key, (t) => ({ ...t, retried: true }))
    void send(turn.said)
  }

  function move(key: string, proposal: string, action: ProposalAction) {
    let moved = false
    update(key, (t) =>
      withProposal(t, proposal, (view) => {
        const next = nextPhase(view, action)
        moved = next !== null
        return next ?? view
      }),
    )
    return moved
  }

  async function run(p: ChatProposal): Promise<Destination | undefined> {
    switch (p.action) {
      case "create_company": {
        const created = await api.createCompany(
          companyBody({ name: p.args.name, industry: "", region: "", summary: "" }),
        )
        await commitCompanyCreated(client, created)
        const to: Destination = { screen: "company", company: created.id }
        return to
      }
      case "set_member": {
        await api.setMember(p.args.company, p.args.user, p.args.role)
        void client.invalidateQueries({ queryKey: ["companies", p.args.company, "members"] })
        const team: Destination = { screen: "company", company: p.args.company }
        return team
      }
      case "open_route":
        await go(p.args.to)
        return p.args.to
    }
  }

  async function confirm(key: string, proposal: ChatProposal) {
    // Checked against the turns as they are now: a confirm is refused unless it is still waiting,
    // and one at a time.
    if (!confirmable(current.current, proposal.id).ok) return
    if (!move(key, proposal.id, { type: "confirm" })) return
    try {
      const record = await run(proposal)
      move(key, proposal.id, { type: "succeeded", record })
      if (id.current) void settleProposal(id.current, proposal.id, "confirmed")
    } catch (error) {
      move(key, proposal.id, { type: "refused", reason: reason(error, "record") })
    }
  }

  function dismiss(key: string, proposal: string) {
    if (move(key, proposal, { type: "dismiss" }) && id.current)
      void settleProposal(id.current, proposal, "dismissed")
  }

  return {
    turns,
    opening,
    running,
    queued,
    problem,
    say,
    stop,
    retry,
    confirm,
    dismiss,
    unqueue: () => setQueued(null),
  }
}

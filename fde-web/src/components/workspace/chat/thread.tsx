import { useEffect, useRef, useState } from "react"
import { Bubble, BubbleContent } from "../../ai/bubble"
import { Marker, MarkerContent, MarkerIcon } from "../../ai/marker"
import { Message, MessageContent, MessageFooter } from "../../ai/message"
import { Shimmer } from "../../ai/shimmer"
import { Button } from "../../ui/button"
import { Icon } from "../../ui/icon"
import { Tip } from "../../ui/tooltip"
import { BlockCard } from "./block-card"
import { ConfirmCard } from "./confirm-card"
import { StepsStrip, TurnTodo } from "./steps"
import { NOTICE_TEXT, REFUSAL_TEXT } from "@/lib/workspace/assistant"
import {
  confirmable,
  isTool,
  proposalsOf,
  sentencesToAnnounce,
  sourcesOf,
  stepLabel,
  toolOf,
} from "@/lib/workspace/chat"
import type { ChatProposal, ChatTurn, Names, Scope } from "@/lib/workspace/chat"
import type { Refusal } from "@/lib/workspace/wire"
import { cn } from "@/lib/utils"

// The thread (issue #263): what the person said as a quiet bubble on the right, the reply as plain text
// across the column, with its steps, its checklist, its blocks as cards and its proposals as confirm
// cards. Model text is a text node with `white-space: pre-wrap`: never markdown, never HTML.

export type Opened = { turn: string; index: number }

/** A refusal's fixed words; a code this screen does not know reads as the general one. */
const refusalText = (code: string | undefined) =>
  code && code in REFUSAL_TEXT ? REFUSAL_TEXT[code as Refusal] : REFUSAL_TEXT.unknown

const RATINGS = "fde.proto.ratings"

/**
 * A quiet thumbs up or down on an answer. The prototype keeps it in this browser by the turn's id only;
 * it will go to the API as a labelled turn for `oryxa-fde-evals` (ADR 0008, "It is measured").
 */
function useRating(turn: string | null) {
  const [rating, setRating] = useState<"up" | "down" | null>(null)
  useEffect(() => {
    if (!turn) return
    try {
      const all = JSON.parse(localStorage.getItem(RATINGS) ?? "{}") as Record<string, unknown>
      const r = all[turn]
      setRating(r === "up" || r === "down" ? r : null)
    } catch {
      setRating(null)
    }
  }, [turn])
  function rate(next: "up" | "down") {
    if (!turn) return
    const value = rating === next ? null : next
    setRating(value)
    try {
      const all = JSON.parse(localStorage.getItem(RATINGS) ?? "{}") as Record<string, unknown>
      if (value) all[turn] = value
      else delete all[turn]
      localStorage.setItem(RATINGS, JSON.stringify(all))
    } catch {
      // Without storage the rating lasts as long as the page.
    }
  }
  return { rating, rate }
}

function Rating({ turn }: { turn: string | null }) {
  const { rating, rate } = useRating(turn)
  if (!turn) return null
  return (
    <MessageFooter className="-ml-1.5 gap-0.5">
      {(["up", "down"] as const).map((r) => (
        <Tip key={r} label={r === "up" ? "Good answer" : "Not a good answer"}>
          <button
            type="button"
            aria-label={r === "up" ? "Good answer" : "Not a good answer"}
            aria-pressed={rating === r}
            onClick={() => rate(r)}
            className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-selected hover:text-foreground aria-pressed:text-foreground"
          >
            <Icon name={r === "up" ? "thumb-up" : "thumb-down"} size={14} />
          </button>
        </Tip>
      ))}
      {rating && <span className="pl-1 text-micro">Noted. It stays in this browser for now.</span>}
    </MessageFooter>
  )
}

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] rounded-full bg-tint motion-safe:animate-pulse"
    />
  )
}

function Reply({
  turn,
  scope,
  names,
  opened,
  onOpen,
  leadProposal,
  blockedWhy,
  onConfirm,
  onDismiss,
  onRetry,
}: {
  turn: ChatTurn
  scope: Scope
  names: Names
  opened: Opened | null
  onOpen: (o: Opened) => void
  leadProposal: string | null
  blockedWhy: (proposal: string) => string | null
  onConfirm: (p: ChatProposal) => void
  onDismiss: (p: string) => void
  onRetry: () => void
}) {
  const streaming = turn.status === "streaming"
  const sources = sourcesOf(turn.parts, scope)
  const lastText = [...turn.parts].reverse().find((p) => p.type === "text")
  const nothingYet = streaming && turn.parts.length === 0
  return (
    <Message aria-label="The workspace's answer">
      <MessageContent>
        {nothingYet && (
          <p className="text-meta">
            <Shimmer>Starting…</Shimmer>
          </p>
        )}
        <StepsStrip turn={turn} names={names} />
        <TurnTodo turn={turn} />
        {turn.parts.map((part, i) => {
          if (part.type === "text")
            return (
              <p key={i} className="text-body break-words whitespace-pre-wrap text-foreground">
                {part.text}
                {streaming && part === lastText && i === turn.parts.length - 1 && <Caret />}
              </p>
            )
          if (part.type === "data-block")
            return (
              <BlockCard
                key={part.id}
                block={part.data}
                sources={sources}
                names={names}
                open={opened?.turn === turn.key && opened.index === i}
                onOpen={() => onOpen({ turn: turn.key, index: i })}
              />
            )
          if (part.type === "data-proposal")
            return (
              <ConfirmCard
                key={part.id}
                view={part.data}
                lead={leadProposal === part.id}
                blocked={blockedWhy(part.id)}
                onConfirm={() => onConfirm(part.data.proposal)}
                onDismiss={() => onDismiss(part.id)}
              />
            )
          return null
        })}
        {turn.notice && turn.notice !== "failed" && turn.notice !== "timed_out" && (
          <Marker tone="attention">
            <MarkerIcon>
              <Icon name="alert" size={14} />
            </MarkerIcon>
            <MarkerContent>{NOTICE_TEXT[turn.notice]}</MarkerContent>
          </Marker>
        )}
        <Ending turn={turn} onRetry={onRetry} />
        {(turn.status === "done" || turn.status === "stopped") && <Rating turn={turn.turn} />}
      </MessageContent>
    </Message>
  )
}

/** How a turn ended, when it did not end well: one plain line, and Try again where it helps. */
function Ending({ turn, onRetry }: { turn: ChatTurn; onRetry: () => void }) {
  const failed = turn.status === "failed" || turn.status === "timed_out" || turn.notice === "failed"
  if (turn.status === "stopped")
    return (
      <Marker>
        <MarkerIcon>
          <span className="size-2 rounded-[2px] bg-current" />
        </MarkerIcon>
        <MarkerContent>You stopped this answer. What it said is kept.</MarkerContent>
      </Marker>
    )
  if (turn.status === "refused")
    return (
      <Marker tone="attention" role="alert">
        <MarkerIcon>
          <Icon name="alert" size={14} />
        </MarkerIcon>
        <MarkerContent>{refusalText(turn.refusal)}</MarkerContent>
      </Marker>
    )
  if (!failed) return null
  const text =
    turn.status === "timed_out" || turn.notice === "timed_out"
      ? NOTICE_TEXT.timed_out
      : NOTICE_TEXT.failed
  return (
    <Marker tone="error" role="alert" className="items-center">
      <MarkerIcon>
        <Icon name="alert" size={14} />
      </MarkerIcon>
      <MarkerContent className="flex-1">{text}</MarkerContent>
      {!turn.retried && (
        <Button variant="outline" size="sm" onClick={onRetry} className="flex-none">
          <Icon name="retry" size={13} />
          Try again
        </Button>
      )}
    </Marker>
  )
}

export function Thread({
  turns,
  scope,
  names,
  opened,
  onOpen,
  onConfirm,
  onDismiss,
  onRetry,
}: {
  turns: Array<ChatTurn>
  scope: Scope
  names: Names
  opened: Opened | null
  onOpen: (o: Opened) => void
  onConfirm: (turn: string, p: ChatProposal) => void
  onDismiss: (turn: string, p: string) => void
  onRetry: (turn: string) => void
}) {
  // One primary in the view: the first proposal still waiting.
  const lead = proposalsOf(turns).find((p) => p.view.phase === "waiting")?.view.proposal.id ?? null
  const blockedWhy = (id: string) => {
    const check = confirmable(turns, id)
    return check.ok
      ? null
      : proposalsOf(turns).some((p) => p.view.phase === "confirming" && p.view.proposal.id !== id)
        ? check.why
        : null
  }
  return (
    <div role="log" aria-label="Conversation" className="grid gap-8">
      {turns.map((turn) => (
        <div key={turn.key} className="grid gap-4 motion-safe:animate-rise">
          <Message align="end" aria-label="You said">
            <MessageContent>
              <Bubble align="end">
                <BubbleContent>{turn.said}</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
          <Reply
            turn={turn}
            scope={scope}
            names={names}
            opened={opened}
            onOpen={onOpen}
            leadProposal={lead}
            blockedWhy={blockedWhy}
            onConfirm={(p) => onConfirm(turn.key, p)}
            onDismiss={(p) => onDismiss(turn.key, p)}
            onRetry={() => onRetry(turn.key)}
          />
        </div>
      ))}
      <Announcer turns={turns} names={names} />
    </div>
  )
}

/** A polite live region: each read as it starts, and the reply in whole sentences. */
function Announcer({ turns, names }: { turns: Array<ChatTurn>; names: Names }) {
  const [said, setSaid] = useState("")
  const progress = useRef<{ key: string; upTo: number; steps: Set<string> }>({
    key: "",
    upTo: 0,
    steps: new Set(),
  })
  const turn = turns.at(-1)
  const text = turn?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? ""
  useEffect(() => {
    if (!turn) return
    const p = progress.current
    if (p.key !== turn.key) progress.current = { key: turn.key, upTo: 0, steps: new Set() }
    const out: Array<string> = []
    for (const part of turn.parts)
      if (
        isTool(part) &&
        !progress.current.steps.has(part.toolCallId) &&
        part.state === "input-available"
      ) {
        progress.current.steps.add(part.toolCallId)
        out.push(`${stepLabel(toolOf(part)!, part.state, names)}.`)
      }
    const { say, upTo } = sentencesToAnnounce(
      text,
      progress.current.upTo,
      turn.status !== "streaming",
    )
    progress.current.upTo = upTo
    if (say) out.push(say)
    if (out.length) setSaid(out.join(" "))
  }, [turn, text, names])
  return (
    <div aria-live="polite" aria-atomic="true" className={cn("sr-only")}>
      {said}
    </div>
  )
}

import { useEffect, useId, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Button } from "../ui/button"
import { Icon } from "../ui/icon"
import { Suggestion } from "./blocks"
import { queries } from "@/lib/api/client"
import type { CompanySummary } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"
import { localDay } from "@/lib/time"
import type { SuggestionBlock } from "@/lib/workspace/blocks"
import { NEW_COMPANY, replyTo, suggestionsFrom } from "@/lib/workspace/welcome"
import type { Reply } from "@/lib/workspace/welcome"
import { cn } from "@/lib/utils"

// The welcome screen (issue #209, DESIGN.md "The workspace"): a greeting, the conversation box as
// the one main thing, what the workspace suggests next, and the companies, compact.

/** The longest message the box takes. */
const MAX_SAID = 2000
// A short pause before the scripted reply, so it reads as an answer; none in tests.
const THINK_MS = import.meta.env.MODE === "test" ? 0 : 450

export function greeting(now: Date) {
  const hour = now.getHours()
  return hour < 5
    ? "Good evening"
    : hour < 12
      ? "Good morning"
      : hour < 18
        ? "Good afternoon"
        : "Good evening"
}

const dateLine = (now: Date) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(now)

type Turn =
  ({ id: number; who: "you" } & { text: string }) | ({ id: number; who: "workspace" } & Reply)

export function Welcome({ now = new Date() }: { now?: Date }) {
  const me = useQuery(queries.me())
  const companies = useQuery(queries.companies())
  const today = useQuery(queries.today())
  const [dismissed, setDismissed] = useState<Array<SuggestionBlock>>([])
  const [turns, setTurns] = useState<Array<Turn>>([])
  const [thinking, setThinking] = useState(false)
  const turnId = useRef(0)
  const first = me.data?.user.name.trim().split(/\s+/)[0]

  const all =
    companies.isSuccess && companies.data.companies.length === 0
      ? [NEW_COMPANY]
      : today.isSuccess && companies.isSuccess
        ? suggestionsFrom(today.data.items, companies.data.companies, localDay(now))
        : []
  const shown = all.filter((s) => !dismissed.some((d) => d.id === s.id))
  const lastDismissed = dismissed.at(-1)

  function say(text: string) {
    setTurns((t) => [...t, { id: ++turnId.current, who: "you", text }])
    setThinking(true)
    window.setTimeout(() => {
      setTurns((t) => [...t, { id: ++turnId.current, who: "workspace", ...replyTo(text, shown) }])
      setThinking(false)
    }, THINK_MS)
  }

  return (
    <div className="mx-auto grid w-[min(680px,calc(100%-48px))] gap-14 pt-[clamp(32px,11vh,120px)] pb-20 text-body max-[800px]:w-[calc(100%-32px)] max-[800px]:gap-10">
      <section aria-labelledby="welcome-title" className="grid gap-6">
        <hgroup className="grid gap-1.5 motion-safe:animate-rise">
          <p className="text-meta text-muted-foreground">{dateLine(now)}</p>
          <h2
            id="welcome-title"
            className="text-display font-semibold text-balance max-[800px]:text-[26px] max-[800px]:leading-[32px]"
          >
            {greeting(now)}
            {first ? `, ${first}` : ""}.
          </h2>
        </hgroup>

        {turns.length > 0 && <Thread turns={turns} thinking={thinking} />}

        <div className="grid gap-3">
          <Composer onSend={say} busy={thinking} />
          <div className="flex flex-wrap gap-2">
            <Chip to="/new-company" icon="plus">
              Set up a new company
            </Chip>
            <button
              type="button"
              disabled={thinking}
              onClick={() => say("What needs me today?")}
              className={CHIP}
            >
              <Icon name="calendar-check" size={14} className="text-muted-foreground" />
              What needs me today?
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="suggested-title" className="grid gap-3">
        <h2
          id="suggested-title"
          className="flex items-center gap-2 text-meta font-medium text-soft"
        >
          <Icon name="sparkle" size={15} className="text-tint" />
          Suggested next
        </h2>
        {companies.isPending || today.isPending ? (
          <Skeleton rows={2} label="Reading your day…" />
        ) : companies.isError || today.isError ? (
          <Problem
            text="We couldn't read your day, so there is nothing to suggest yet."
            onRetry={() => {
              void companies.refetch()
              void today.refetch()
            }}
          />
        ) : shown.length === 0 ? (
          <div className="rounded-card border border-dashed px-5 py-6 text-meta text-muted-foreground">
            Nothing needs you right now. I will suggest the next step when something changes.
          </div>
        ) : (
          <ul className="divide-y overflow-hidden rounded-card border bg-canvas">
            {shown.map((block) => (
              <li key={block.id} className="motion-safe:animate-rise">
                <Suggestion block={block} onDismiss={() => setDismissed((d) => [...d, block])} />
              </li>
            ))}
          </ul>
        )}
        <p role="status" className="min-h-5 text-meta text-muted-foreground">
          {lastDismissed && (
            <>
              Put away: {lastDismissed.title}.{" "}
              <button
                type="button"
                onClick={() => setDismissed((d) => d.slice(0, -1))}
                className="rounded-sm font-medium text-soft underline decoration-strong underline-offset-4 hover:text-foreground"
              >
                Undo
              </button>
            </>
          )}
        </p>
      </section>

      <Companies />
    </div>
  )
}

const CHIP =
  "inline-flex h-8 items-center gap-1.5 rounded-full border bg-transparent px-3 text-meta text-soft transition-colors hover:border-strong hover:bg-selected hover:text-foreground disabled:opacity-45 motion-safe:active:scale-[0.97]"

function Chip({ to, icon, children }: { to: "/new-company"; icon: "plus"; children: string }) {
  return (
    <Link to={to} className={CHIP}>
      <Icon name={icon} size={14} className="text-muted-foreground" />
      {children}
    </Link>
  )
}

/** The conversation box: Enter sends, Shift and Enter starts a new line. What is typed is text. */
export function Composer({ onSend, busy }: { onSend: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState("")
  const box = useRef<HTMLTextAreaElement>(null)
  const label = useId()
  const said = text.trim()

  // Grows with what is typed, up to a few lines, then scrolls.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  function send(event?: FormEvent) {
    event?.preventDefault()
    if (!said || busy) return
    onSend(said)
    setText("")
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event)
  }

  return (
    <form
      onSubmit={send}
      className="group relative rounded-[22px] border bg-canvas shadow-lift transition-[border-color,box-shadow] duration-200 focus-within:border-tint/50 focus-within:ring-4 focus-within:ring-tint/10 hover:border-strong"
    >
      <label htmlFor={label} className="sr-only">
        What do you want to work on?
      </label>
      <textarea
        id={label}
        ref={box}
        rows={2}
        value={text}
        maxLength={MAX_SAID}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="What do you want to work on?"
        // The box shows its own focus: the ring is on the form around it.
        className="block min-h-[88px] w-full resize-none bg-transparent px-5 pt-4 pb-[60px] text-lead text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <div className="absolute right-3 bottom-3 left-5 flex items-center justify-between gap-3">
        <button
          type="submit"
          aria-label="Send"
          disabled={!said || busy}
          className="ml-auto grid size-9 place-items-center rounded-full bg-primary text-primary-foreground transition-[background-color,opacity,transform] duration-150 hover:bg-primary/85 disabled:bg-selected disabled:text-muted-foreground motion-safe:active:scale-[0.94]"
        >
          <Icon name="arrow-up" size={17} strokeWidth={2} />
        </button>
      </div>
    </form>
  )
}

function Thread({ turns, thinking }: { turns: Array<Turn>; thinking: boolean }) {
  return (
    <div role="log" aria-label="Conversation" className="grid gap-5">
      {turns.map((turn) =>
        turn.who === "you" ? (
          <p
            key={turn.id}
            className="ml-auto max-w-[85%] rounded-[18px] rounded-br-md border bg-card px-4 py-2.5 break-words whitespace-pre-wrap motion-safe:animate-rise"
          >
            <span className="sr-only">You said: </span>
            {turn.text}
          </p>
        ) : (
          <div key={turn.id} className="grid gap-3 motion-safe:animate-rise">
            <p className="flex items-start gap-2.5">
              <Voice />
              <span className="pt-0.5">
                <span className="sr-only">The workspace said: </span>
                {turn.text}
              </span>
            </p>
            {turn.blocks.length > 0 && (
              <ul className="ml-8 divide-y overflow-hidden rounded-card border bg-canvas">
                {turn.blocks.map((block) =>
                  block.type === "suggestion" ? (
                    <li key={block.id}>
                      <Suggestion block={block} />
                    </li>
                  ) : null,
                )}
              </ul>
            )}
          </div>
        ),
      )}
      {thinking && (
        <p role="status" className="flex items-center gap-2.5 text-muted-foreground">
          <Voice />
          <span className="sr-only">The workspace is answering</span>
          <span aria-hidden="true" className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1.5 rounded-full bg-strong motion-safe:animate-pulse"
                style={{ animationDelay: `${i * 160}ms` }}
              />
            ))}
          </span>
        </p>
      )}
    </div>
  )
}

/** The workspace's mark beside what it says. */
export function Voice() {
  return (
    <span
      aria-hidden="true"
      className="grid size-6 flex-none place-items-center rounded-full bg-tint-soft text-tint"
    >
      <Icon name="sparkle" size={14} />
    </span>
  )
}

function Companies() {
  // The same read as the rest of the screen: the cache answers it once.
  const query = useQuery(queries.companies())
  return (
    <section aria-labelledby="companies-title" className="grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="companies-title" className="text-meta font-medium text-soft">
          Companies
        </h2>
        {query.isSuccess && query.data.companies.length > 0 && (
          <Link
            to="/companies"
            className="rounded-sm text-meta text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            See all {query.data.companies.length}
          </Link>
        )}
      </div>
      {query.isPending ? (
        <Skeleton rows={2} label="Loading your companies…" />
      ) : query.isError ? (
        <Problem text="We couldn't load your companies." onRetry={() => void query.refetch()} />
      ) : query.data.companies.length === 0 ? (
        <p className="text-meta text-muted-foreground">None yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
          {query.data.companies.slice(0, 4).map((company) => (
            <li key={company.id} className="min-w-0">
              <Link
                to="/companies/$companyId"
                params={{ companyId: company.id }}
                className="flex items-center gap-3 rounded-[14px] px-2.5 py-2 transition-colors hover:bg-selected"
              >
                <Monogram name={company.name} />
                <span className="grid min-w-0">
                  <span className="truncate text-meta font-medium">{company.name}</span>
                  <span className="truncate text-micro text-muted-foreground">
                    {described(company)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function described(company: CompanySummary) {
  const n = company.projects.length
  if (n === 0) return "No projects yet"
  const stage = n === 1 ? ` · ${STAGE_LABEL[company.projects[0]!.stage]}` : ""
  return `${n} ${n === 1 ? "project" : "projects"}${stage}`
}

/** A company's first letter on a quiet tile: no logos, no colour per company. */
function Monogram({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 flex-none place-items-center rounded-[10px] border bg-card text-meta font-semibold text-soft"
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

function Skeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" className="grid gap-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={cn(
            "h-[72px] rounded-card bg-card motion-safe:animate-pulse",
            i > 0 && "opacity-60",
          )}
        />
      ))}
    </div>
  )
}

function Problem({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed px-5 py-4 text-meta"
    >
      <span className="text-soft">{text}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

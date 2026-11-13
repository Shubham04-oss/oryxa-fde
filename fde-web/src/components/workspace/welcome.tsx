import { useEffect, useId, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent } from "react"
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Button } from "../ui/button"
import { Icon } from "../ui/icon"
import { BlockView, Suggestion } from "./blocks"
import { ProposalCard } from "./proposal"
import { useConversation } from "./use-conversation"
import type { ThreadTurn } from "./use-conversation"
import { ApiError, api, queries } from "@/lib/api/client"
import type { CompanySummary } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"
import { NEW_COMPANY, replyTo, suggestionsFromHome } from "@/lib/workspace/welcome"
import type { HomeSuggestion } from "@/lib/workspace/welcome"
import { MAX_SAID } from "@/lib/workspace/wire"
import { cn } from "@/lib/utils"

// The welcome screen (issue #209, DESIGN.md "The workspace"): a greeting, the conversation box as
// the one main thing, what the workspace suggests next, and the companies, compact. The box talks
// to the assistant where it is configured (issue #236), and answers from a script where it is not.
// Suggested next is the API's home (`GET /v1/home`, issue #256), worded here from fixed templates.

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

export function Welcome({ now = new Date() }: { now?: Date }) {
  const me = useQuery(queries.me())
  const companies = useQuery(queries.companies())
  const home = useQuery(queries.home())
  const dismiss = useDismiss()
  const first = me.data?.user.name.trim().split(/\s+/)[0]

  const noCompany = companies.isSuccess && companies.data.companies.length === 0
  const shown: Array<HomeSuggestion> = home.isSuccess
    ? suggestionsFromHome(home.data.suggestions).filter((s) => !dismiss.hidden.has(s.id))
    : []
  const list = useRef<HTMLUListElement>(null)
  // Where focus goes once a dismissed row has left: the next row's Not now, or the section's heading.
  const [focusTo, setFocusTo] = useState<{ id: string | null } | null>(null)
  useEffect(() => {
    if (!focusTo) return
    const row = [
      ...(list.current?.querySelectorAll<HTMLElement>("li[data-suggestion]") ?? []),
    ].find((li) => li.dataset.suggestion === focusTo.id)
    const target = row?.querySelector<HTMLElement>('button[aria-label^="Not now:"]')
    ;(target ?? document.getElementById("suggested-title"))?.focus()
    setFocusTo(null)
  }, [focusTo])
  // Until the API has answered, the scripted reply knows nothing of the day, so it never claims an all clear.
  const { turns, thinking, say, settle } = useConversation((text) =>
    replyTo(text, home.isSuccess ? shown.map((s) => s.block) : null),
  )

  return (
    // One rhythm: 24 inside the opening, 48 between sections (40 on a phone).
    <div className="mx-auto grid w-[min(680px,calc(100%-48px))] gap-12 pt-[clamp(32px,9vh,96px)] pb-20 text-body max-[800px]:w-[calc(100%-32px)] max-[800px]:gap-10 max-[800px]:pt-8">
      <section aria-labelledby="welcome-title" className="grid gap-6">
        <hgroup className="grid gap-2 motion-safe:animate-rise">
          <p className="text-meta text-muted-foreground">{dateLine(now)}</p>
          <h2
            id="welcome-title"
            className="text-display font-semibold text-balance max-[800px]:text-[26px] max-[800px]:leading-[32px]"
          >
            {greeting(now)}
            {first ? `, ${first}` : ""}.
          </h2>
        </hgroup>

        {turns.length > 0 && <Thread turns={turns} thinking={thinking} onSettle={settle} />}

        <div className="grid gap-3">
          <Composer onSend={(text) => void say(text)} busy={thinking} />
          {/* One row; on a phone each takes the full width, so they never wrap unevenly. */}
          <div className="flex gap-2 max-[560px]:grid">
            <Chip to="/new-company" icon="plus">
              Set up a new company
            </Chip>
            <button
              type="button"
              disabled={thinking}
              onClick={() => void say("What needs me today?")}
              className={CHIP}
            >
              <Icon name="calendar-check" size={14} className="flex-none text-muted-foreground" />
              <span className="truncate">What needs me today?</span>
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="suggested-title" className="grid">
        <SectionHead id="suggested-title" title="Suggested next" focusable />
        {noCompany ? (
          <ul className="overflow-hidden rounded-card border bg-canvas">
            <li className="motion-safe:animate-rise">
              <Suggestion block={NEW_COMPANY} lead={turns.length === 0} />
            </li>
          </ul>
        ) : home.isPending ? (
          <Skeleton rows={2} label="Reading your day…" />
        ) : home.isError ? (
          <Problem
            text="We couldn't read your day, so there is nothing to suggest yet."
            onRetry={() => void home.refetch()}
          />
        ) : shown.length === 0 ? (
          <div className="rounded-card border border-dashed px-5 py-6 text-meta text-muted-foreground">
            {/* An all clear only when the API itself had nothing: what was put away or skipped may still need the person. */}
            {home.data.received === 0
              ? "Nothing needs you right now. I will suggest the next step when something changes."
              : "Nothing new to suggest right now."}
          </div>
        ) : (
          <ul ref={list} className="divide-y overflow-hidden rounded-card border bg-canvas">
            {shown.map(({ id, block }, i) => (
              <li key={id} data-suggestion={id} className="motion-safe:animate-rise">
                <Suggestion
                  block={block}
                  // Once there is a reply, its own first action is the primary one instead.
                  lead={i === 0 && turns.length === 0}
                  onDismiss={() => {
                    setFocusTo({ id: (shown[i + 1] ?? shown[i - 1])?.id ?? null })
                    dismiss.put({
                      id,
                      name: block.context ? `${block.title}, ${block.context}` : block.title,
                    })
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {/* Takes no room until something is put away, so the gap to Companies stays the rhythm's. */}
        <p role="status" className="mt-3 grid gap-1 text-meta text-muted-foreground empty:mt-0">
          {/* Only while the API still sends it: once it has gone, its refusal is moot. */}
          {dismiss.failed
            .filter((f) => shown.some((x) => x.id === f.id))
            .map((f) => (
              <span key={f.id}>
                We couldn't put away {f.name}, so it is back. Try again in a moment.
              </span>
            ))}
          {dismiss.done && (
            <span>Put away: {dismiss.done.name}. It comes back if something changes.</span>
          )}
        </p>
      </section>

      <Companies />
    </div>
  )
}

const DISMISS = ["home", "dismiss"]
type HomeData = Awaited<ReturnType<typeof api.home>>
/** One suggestion being put away: the API's id, and how the screen names it. */
type Dismissal = { id: string; name: string }

/**
 * Puts a suggestion away for this person until its facts change. It leaves the list at once and comes
 * back if the API refuses; it changes nothing anyone else sees. Nothing is taken out of the cached
 * home before the API confirms it: a row is hidden while its dismissal is on its way, and once
 * confirmed it leaves the cache and stays hidden until a read of the home asked for after that lands.
 * The home is read again once no other dismissal is pending (after a failure too), so a read cannot
 * bring back one still on its way, a failure brings back only its own row, and one the API sends
 * again (its facts changed) comes back.
 */
function useDismiss() {
  const client = useQueryClient()
  const key = queries.home().queryKey
  // Confirmed, with when, until a later read of the home shows the API's own answer.
  const [gone, setGone] = useState<ReadonlyMap<string, number>>(new Map())
  const [failed, setFailed] = useState<Array<Dismissal>>([])
  const [done, setDone] = useState<Dismissal | null>(null)
  const pending = useMutationState({
    filters: { mutationKey: DISMISS, status: "pending" },
    select: (m) => (m.state.variables as Dismissal).id,
  })
  const mutation = useMutation({
    mutationKey: DISMISS,
    mutationFn: async ({ id }: Dismissal) => {
      try {
        await api.dismissHome(id)
      } catch (error) {
        // The API no longer has it (its facts changed): it is gone, as asked.
        if (error instanceof ApiError && error.status === 404) return
        throw error
      }
    },
    onMutate: ({ id }) => setFailed((f) => f.filter((x) => x.id !== id)),
    onSuccess: (_data, put) => {
      // Taken here, not in the updater: React runs that later, after the read below is asked for.
      const at = Date.now()
      setGone((g) => new Map(g).set(put.id, at))
      setDone(put)
      // Confirmed, so safe to take out of the cached home: leaving and coming back does not show it.
      client.setQueryData<HomeData>(
        key,
        (home) => home && { ...home, suggestions: home.suggestions.filter((x) => x.id !== put.id) },
      )
    },
    onError: (_error, put) => setFailed((f) => [...f.filter((x) => x.id !== put.id), put]),
    onSettled: () => {
      // This one still counts as pending here, so 1 means no other is on its way. A failure reads too,
      // so a success that skipped its read for this one is not hidden for good. Not awaited: awaiting
      // would keep this one pending, and a success meanwhile would skip its own read.
      if (client.isMutating({ mutationKey: DISMISS }) > 1) return
      const asked = Date.now()
      void client
        .invalidateQueries({ queryKey: key })
        .then(() => setGone((g) => new Map([...g].filter(([, at]) => at > asked))))
    },
  })
  return {
    hidden: new Set([...pending, ...gone.keys()]),
    failed,
    done,
    put: mutation.mutate,
  }
}

const CHIP =
  "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-full border bg-transparent px-3 text-meta max-[560px]:px-2 text-soft transition-colors hover:border-strong hover:bg-selected hover:text-foreground disabled:opacity-45 motion-safe:active:scale-[0.97]"

function Chip({ to, icon, children }: { to: "/new-company"; icon: "plus"; children: string }) {
  return (
    <Link to={to} className={CHIP}>
      <Icon name={icon} size={14} className="flex-none text-muted-foreground" />
      <span className="truncate">{children}</span>
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
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
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
      className="group relative rounded-[24px] border bg-canvas shadow-lift transition-[border-color,box-shadow] duration-200 focus-within:border-tint/50 focus-within:ring-4 focus-within:ring-tint/10 hover:border-strong"
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
        className="block min-h-[128px] w-full resize-none bg-transparent px-6 pt-5 pb-[64px] text-lead text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <div className="absolute right-3.5 bottom-3.5 left-6 flex items-center justify-between gap-3">
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

function Thread({
  turns,
  thinking,
  onSettle,
}: {
  turns: Array<ThreadTurn>
  thinking: boolean
  onSettle: (turn: number, proposal: string, outcome: "confirmed" | "dismissed") => void
}) {
  // A reply still waiting for its first words shows as the dots below, not as an empty turn.
  const answering = turns.some(
    (t) =>
      t.who === "workspace" && t.streaming && !t.text && !t.blocks.length && !t.proposals.length,
  )
  return (
    <div role="log" aria-label="Conversation" className="grid gap-5">
      {turns.map((turn, t) =>
        turn.who === "workspace" &&
        !turn.text &&
        !turn.blocks.length &&
        !turn.proposals.length &&
        !turn.notice ? null : turn.who === "you" ? (
          <p
            key={turn.id}
            className="ml-auto max-w-[85%] rounded-[18px] rounded-br-md border bg-card px-4 py-2.5 break-words whitespace-pre-wrap motion-safe:animate-rise"
          >
            <span className="sr-only">You said: </span>
            {turn.text}
          </p>
        ) : (
          <div key={turn.id} className="grid gap-3 motion-safe:animate-rise">
            {turn.text && (
              <p className="flex items-start gap-2.5">
                <Voice />
                <span className="pt-0.5 break-words whitespace-pre-wrap">
                  <span className="sr-only">The workspace said: </span>
                  {turn.text}
                </span>
              </p>
            )}
            {turn.blocks.length > 0 && (
              <ul className="ml-8 divide-y overflow-hidden rounded-card border bg-canvas">
                {turn.blocks.map((block, i) => (
                  <li
                    key={block.type === "suggestion" ? block.id : `${block.type}-${i}`}
                    className={block.type === "suggestion" ? undefined : "px-5 py-4"}
                  >
                    {block.type === "suggestion" ? (
                      <Suggestion block={block} lead={i === 0 && t === turns.length - 1} />
                    ) : (
                      <BlockView block={block} />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {turn.proposals.length > 0 && (
              <ul className="ml-8 divide-y overflow-hidden rounded-card border bg-canvas">
                {turn.proposals.map(({ proposal, state }) => (
                  <li key={proposal.id}>
                    <ProposalCard
                      proposal={proposal}
                      state={state}
                      onSettle={(outcome) => onSettle(turn.id, proposal.id, outcome)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {turn.notice && <p className="ml-8 text-meta text-muted-foreground">{turn.notice}</p>}
          </div>
        ),
      )}
      {thinking && (answering || !turns.some((t) => t.who === "workspace" && t.streaming)) && (
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
    <section aria-labelledby="companies-title" className="grid">
      <SectionHead id="companies-title" title="Companies">
        {query.isSuccess && query.data.companies.length > 0 && (
          <Link
            to="/companies"
            className="rounded-sm text-meta text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            See all {query.data.companies.length}
          </Link>
        )}
      </SectionHead>
      {query.isPending ? (
        <Skeleton rows={2} label="Loading your companies…" />
      ) : query.isError ? (
        <Problem text="We couldn't load your companies." onRetry={() => void query.refetch()} />
      ) : query.data.companies.length === 0 ? (
        <p className="text-meta text-muted-foreground">None yet.</p>
      ) : (
        // The rows' own padding sits outside the column, so each tile lines up with the cards above.
        <ul className="-mx-2.5 grid grid-cols-2 gap-x-4 gap-y-1 max-[560px]:grid-cols-1">
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

/** A section's heading, the same for each, with what it links to on the right. */
function SectionHead({
  id,
  title,
  focusable,
  children,
}: {
  id: string
  title: string
  /** Takes focus from script, when what had it has gone. */
  focusable?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex h-5 items-baseline justify-between gap-3">
      <h2
        id={id}
        tabIndex={focusable ? -1 : undefined}
        className="rounded-sm text-meta font-medium text-soft"
      >
        {title}
      </h2>
      {children}
    </div>
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

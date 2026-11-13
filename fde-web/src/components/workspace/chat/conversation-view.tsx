import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  Artifact,
  ArtifactClose,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
} from "../../ai/artifact"
import { Icon } from "../../ui/icon"
import type { IconName } from "../../ui/icon"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "../../ui/menu"
import { Tip, TooltipProvider } from "../../ui/tooltip"
import { BlockFull, blockSummary, blockTitle } from "./block-card"
import { Composer } from "./composer"
import { Thread } from "./thread"
import type { Opened } from "./thread"
import { useChat } from "./use-chat"
import { useStick } from "./use-stick"
import { queries } from "@/lib/api/client"
import type { CompanySummary } from "@/lib/api/schemas"
import { scopeParam } from "@/lib/workspace/chat"
import type { ConversationSummary, Names, Scope } from "@/lib/workspace/chat"
import { listConversations } from "@/lib/workspace/chat-client"
import { cn } from "@/lib/utils"

// The conversation prototype's screen (issue #263, DESIGN.md "Round 2: conversation"): the person's
// conversations on the left, grouped by Home and company; the thread at a reading width; and, when a
// block is opened, that block at full size on the right. On a phone the thread is alone, and the list
// and the block are sheets.

const LIST_KEY = ["assistant", "conversations"] as const

export function namesOf(scope: Scope, companies: Array<CompanySummary> | undefined): Names {
  if (scope.kind === "home") return {}
  const company = companies?.find((c) => c.id === scope.company)
  return {
    company: company?.name,
    project:
      scope.kind === "project"
        ? company?.projects.find((p) => p.id === scope.project)?.name
        : undefined,
  }
}

const scopeLabel = (scope: Scope, names: Names) =>
  scope.kind === "home"
    ? "Home"
    : scope.kind === "company"
      ? (names.company ?? "A company")
      : `${names.company ?? "A company"} · ${names.project ?? "a project"}`

/** What the assistant can do here, said before anything is asked. */
function whatItDoes(scope: Scope, names: Names) {
  if (scope.kind === "home")
    return {
      title: "Ask across your companies",
      line: "From Home I read only your companies' list: names, stages and next steps. I can open a company's conversation or set up a new company, and nothing changes until you confirm it.",
    }
  const where =
    scope.kind === "project" ? (names.project ?? "this project") : (names.company ?? "this company")
  return {
    title: `Ask about ${where}`,
    line: `I read ${names.company ?? "this company"}'s records as you, and nothing from any other company. I propose changes; each one happens only when you confirm it.`,
  }
}

const STARTERS: Record<"home" | "company", Array<{ text: string; icon: IconName }>> = {
  home: [
    { text: "What needs me today?", icon: "calendar-check" },
    { text: "Set up Orion Rail and Halden Water", icon: "plus" },
    { text: "Which projects have no next step?", icon: "search" },
  ],
  company: [
    { text: "Plan the pilot rollout", icon: "calendar-check" },
    { text: "What is blocked right now?", icon: "alert" },
    { text: "Who works on this, and can Sam Okafor join?", icon: "user-plus" },
  ],
}

function ago(iso: string, now = Date.now()) {
  const m = Math.round((now - Date.parse(iso)) / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return d < 7
    ? `${d}d`
    : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(1200)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function usePhone() {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const media = window.matchMedia("(max-width: 800px)")
    const sync = () => setPhone(media.matches)
    sync()
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])
  return phone
}

export function ConversationView({
  conversation,
  draft,
}: {
  conversation: string | null
  draft: Scope | null
}) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const companies = useQuery(queries.companies())
  const list = useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const read = await listConversations()
      if (read === null) throw new Error("The conversations could not be read.")
      return read
    },
  })
  // Conversations started on this page: their scope and the screen they started on, kept while the
  // list is read again, so the screen is not remounted and its turns stay.
  const [started, setStarted] = useState<ReadonlyMap<string, { scope: Scope; key: string }>>(
    new Map(),
  )
  const mine = conversation ? started.get(conversation) : undefined
  const summary = conversation ? list.data?.find((c) => c.id === conversation) : undefined
  // A conversation's scope is the one it started with; a new one's is the one asked for, Home by default.
  const scope: Scope | null = conversation
    ? (summary?.scope ?? mine?.scope ?? null)
    : (draft ?? { kind: "home" })
  if (conversation && list.isSuccess && !summary && !mine) return <Missing />
  if (!scope)
    return (
      <div role="status" className="grid h-full place-items-center text-meta text-muted-foreground">
        Opening the conversation…
      </div>
    )
  return (
    <TooltipProvider>
      <Screen
        key={mine?.key ?? conversation ?? `new:${scopeParam(scope)}`}
        conversation={conversation}
        scope={scope}
        list={list.data}
        listFailed={list.isError}
        companies={companies.data?.companies}
        title={summary?.title ?? null}
        onChanged={() => void client.invalidateQueries({ queryKey: LIST_KEY })}
        onStarted={(id) => {
          setStarted((all) => new Map(all).set(id, { scope, key: `new:${scopeParam(scope)}` }))
          void client.invalidateQueries({ queryKey: LIST_KEY })
          void navigate({ to: "/conversations", search: { c: id }, replace: true })
        }}
      />
    </TooltipProvider>
  )
}

function Missing() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="grid max-w-sm justify-items-center gap-3 text-center">
        <p className="text-body font-medium">This conversation isn't one of yours, or it's gone.</p>
        <Link
          to="/conversations"
          search={{ new: "home" }}
          className="text-meta text-soft underline underline-offset-4"
        >
          Start a new conversation
        </Link>
      </div>
    </div>
  )
}

function Screen({
  conversation,
  scope,
  list,
  listFailed,
  companies,
  title,
  onStarted,
  onChanged,
}: {
  conversation: string | null
  scope: Scope
  list: Array<ConversationSummary> | undefined
  listFailed: boolean
  companies: Array<CompanySummary> | undefined
  title: string | null
  onStarted: (id: string) => void
  onChanged: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const width = useWidth(root)
  const phone = usePhone()
  const chat = useChat({ conversation, scope, onStarted, onChanged })
  const names = namesOf(scope, companies)
  const { viewport, content, stick, jump } = useStick()
  const composer = useRef<HTMLTextAreaElement>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [listOpen, setListOpen] = useState(true)
  const [sheet, setSheet] = useState(false)
  const openedPart = opened
    ? chat.turns.find((t) => t.key === opened.turn)?.parts[opened.index]
    : undefined
  const block = openedPart?.type === "data-block" ? openedPart.data : null
  const panelShown = block !== null
  const panelColumn = panelShown && !phone && width >= 900
  // The list gives way to the panel when both would squeeze the thread.
  const listShown = !phone && listOpen && width >= (panelColumn ? 1180 : 760)

  // Escape closes the panel first, before the composer's own Escape (which stops an answer).
  const returnTo = useRef<HTMLElement | null>(null)
  function close() {
    setOpened(null)
    returnTo.current?.focus()
  }
  useEffect(() => {
    if (!panelColumn) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  })

  const empty = chat.opening === "ready" && chat.turns.length === 0
  const about = whatItDoes(scope, names)
  const head = title ?? chat.turns[0]?.said.split("\n")[0] ?? "New conversation"

  const panel = block && (
    <Artifact aria-label={blockTitle(block)} className="h-full">
      <ArtifactHeader>
        <div className="grid min-w-0 gap-0.5">
          <h2 className="text-body font-semibold">{blockTitle(block)}</h2>
          <ArtifactDescription className="tabular-nums">{blockSummary(block)}</ArtifactDescription>
        </div>
        <ArtifactClose label="Close the panel" onClick={close} />
      </ArtifactHeader>
      <ArtifactContent>
        <BlockFull block={block} />
      </ArtifactContent>
    </Artifact>
  )

  const listView = (
    <ConversationList
      list={list}
      failed={listFailed}
      companies={companies}
      current={conversation}
      onPick={() => setSheet(false)}
    />
  )

  return (
    <div ref={root} className="absolute inset-0 flex min-h-0">
      {listShown && (
        <aside
          aria-label="Conversations"
          className="flex w-[248px] flex-none flex-col border-r bg-card/60"
        >
          {listView}
        </aside>
      )}

      <section aria-label={head} className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 flex-none items-center gap-2 border-b px-3">
          {!listShown && (
            <Tip label="Show conversations">
              <button
                type="button"
                aria-label="Show conversations"
                onClick={() => (phone || width < 760 ? setSheet(true) : setListOpen(true))}
                className="grid size-8 flex-none place-items-center rounded-full text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
              >
                <Icon name="chat" size={16} />
              </button>
            </Tip>
          )}
          {listShown && (
            <Tip label="Hide conversations">
              <button
                type="button"
                aria-label="Hide conversations"
                onClick={() => setListOpen(false)}
                className="grid size-8 flex-none place-items-center rounded-full text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
              >
                <Icon name="sidebar" size={16} />
              </button>
            </Tip>
          )}
          <h2 className="min-w-0 flex-1 truncate text-body font-medium">{head}</h2>
          <ScopeChip scope={scope} names={names} />
        </header>

        <div ref={viewport} className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto">
          <div
            ref={content}
            className="mx-auto w-full max-w-[720px] px-6 pt-8 pb-6 max-[560px]:px-4 max-[560px]:pt-6"
          >
            {chat.opening === "loading" ? (
              <div role="status" className="grid gap-3">
                <span className="sr-only">Reading the conversation…</span>
                <div className="ml-auto h-10 w-2/5 rounded-[14px] bg-card motion-safe:animate-pulse" />
                <div className="h-20 rounded-[14px] bg-card opacity-70 motion-safe:animate-pulse" />
              </div>
            ) : chat.opening === "missing" ? (
              <p className="text-meta text-muted-foreground">
                This conversation could not be read. Reload the page to try again.
              </p>
            ) : empty ? (
              <div className="grid gap-3 pt-[min(14vh,120px)] motion-safe:animate-rise max-[560px]:pt-6">
                <span
                  aria-hidden="true"
                  className="grid size-9 place-items-center rounded-full bg-tint-soft text-tint"
                >
                  <Icon name="sparkle" size={18} />
                </span>
                <h3 className="text-title font-semibold text-balance">{about.title}</h3>
                <p className="max-w-[560px] text-body text-soft">{about.line}</p>
              </div>
            ) : (
              <Thread
                turns={chat.turns}
                scope={scope}
                names={names}
                opened={opened}
                onOpen={(o) => {
                  returnTo.current = document.activeElement as HTMLElement | null
                  setOpened(opened?.turn === o.turn && opened.index === o.index ? null : o)
                }}
                onConfirm={(turn, p) => void chat.confirm(turn, p)}
                onDismiss={chat.dismiss}
                onRetry={chat.retry}
              />
            )}
          </div>
        </div>

        <div className="relative flex-none">
          {stick.unseen && !stick.stuck && (
            <button
              type="button"
              onClick={jump}
              className="absolute -top-12 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-canvas px-3 text-micro font-medium text-soft shadow-overlay transition-colors hover:text-foreground motion-safe:animate-rise"
            >
              <Icon name="arrow-down" size={13} />
              Jump to latest
            </button>
          )}
          <div className="mx-auto w-full max-w-[720px] px-6 pb-4 max-[560px]:px-3 max-[560px]:pb-3">
            {chat.problem && (
              <p role="alert" className="mb-2 text-meta text-destructive">
                {chat.problem}
              </p>
            )}
            <Composer
              ref={composer}
              placeholder={
                scope.kind === "home"
                  ? "Ask across your companies"
                  : `Ask about ${names.project ?? names.company ?? "this company"}`
              }
              running={chat.running}
              queued={chat.queued}
              starters={empty ? STARTERS[scope.kind === "home" ? "home" : "company"] : null}
              onSay={chat.say}
              onStop={chat.stop}
              onUnqueue={chat.unqueue}
            />
          </div>
        </div>
      </section>

      {panelColumn && (
        <aside className="flex w-[400px] flex-none flex-col border-l motion-safe:animate-settle max-[1100px]:w-[360px]">
          {panel}
        </aside>
      )}

      <Sheet
        open={panelShown && !panelColumn}
        onClose={close}
        side="bottom"
        title={block ? blockTitle(block) : ""}
      >
        {panel}
      </Sheet>
      <Sheet open={sheet} onClose={() => setSheet(false)} side="left" title="Conversations">
        {listView}
      </Sheet>
    </div>
  )
}

function Sheet({
  open,
  onClose,
  side,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  side: "left" | "bottom"
  title: string
  children: ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <DialogPrimitive.Popup
          aria-label={title}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-canvas shadow-overlay transition-transform duration-300 ease-[var(--ease-calm)] outline-none motion-reduce:transition-none",
            side === "bottom"
              ? "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-[24px] border-t pb-[env(safe-area-inset-bottom)] data-ending-style:translate-y-full data-starting-style:translate-y-full"
              : "inset-y-0 left-0 w-[min(320px,calc(100vw-48px))] border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
          )}
        >
          {side === "bottom" && (
            <div
              className="mx-auto mt-2 h-1 w-10 flex-none rounded-full bg-selected"
              aria-hidden="true"
            />
          )}
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function ScopeChip({ scope, names }: { scope: Scope; names: Names }) {
  const label = scopeLabel(scope, names)
  const tip =
    scope.kind === "home"
      ? "Home reads only your companies' list. A conversation keeps the scope it started in."
      : `Bound to ${label}. It reads only this company's records, and that can't change.`
  return (
    <Tip label={tip} side="bottom">
      <span
        tabIndex={0}
        aria-label={`Scope: ${label}. ${tip}`}
        className="inline-flex h-7 max-w-[45%] flex-none items-center gap-1.5 rounded-full border bg-card px-2.5 text-micro font-medium text-soft max-[560px]:max-w-[52%]"
      >
        <Icon
          name={scope.kind === "home" ? "home" : "lock"}
          size={12}
          className="flex-none text-muted-foreground"
        />
        <span className="truncate max-[560px]:hidden">{label}</span>
        {/* A phone shows the narrowest name; the full scope is in the label and the tooltip. */}
        <span className="hidden truncate max-[560px]:inline">
          {scope.kind === "project" ? (names.project ?? label) : label}
        </span>
      </span>
    </Tip>
  )
}

function ConversationList({
  list,
  failed,
  companies,
  current,
  onPick,
}: {
  list: Array<ConversationSummary> | undefined
  failed: boolean
  companies: Array<CompanySummary> | undefined
  current: string | null
  onPick: () => void
}) {
  const navigate = useNavigate()
  // Home first, then each company in the order its latest conversation was used.
  const groups = new Map<string, { label: string; items: Array<ConversationSummary> }>()
  groups.set("home", { label: "Home", items: [] })
  for (const c of list ?? []) {
    const key = c.scope.kind === "home" ? "home" : c.scope.company
    const label =
      c.scope.kind === "home" ? "Home" : (companies?.find((x) => x.id === key)?.name ?? "A company")
    if (!groups.has(key)) groups.set(key, { label, items: [] })
    groups.get(key)!.items.push(c)
  }
  const start = (scope: Scope) => {
    onPick()
    void navigate({ to: "/conversations", search: { new: scopeParam(scope) } })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 flex-none items-center border-b px-2.5">
        <Menu>
          <MenuTrigger className="inline-flex h-8 w-full items-center gap-2 rounded-lg px-2 text-meta font-medium text-soft transition-colors hover:bg-selected hover:text-foreground data-popup-open:bg-selected">
            <Icon name="plus" size={14} />
            New conversation
            <Icon name="chevron-down" size={13} className="ml-auto text-muted-foreground" />
          </MenuTrigger>
          <MenuContent label="New conversation in">
            <MenuLabel>New conversation in</MenuLabel>
            <MenuItem onClick={() => start({ kind: "home" })}>
              <Icon name="home" size={14} className="text-muted-foreground" />
              Home
            </MenuItem>
            <MenuSeparator />
            {(companies ?? []).map((c) => (
              <MenuItem key={c.id} onClick={() => start({ kind: "company", company: c.id })}>
                <Icon name="building" size={14} className="text-muted-foreground" />
                <span className="truncate">{c.name}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>
      <nav
        aria-label="Your conversations"
        className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-2 py-3"
      >
        {failed ? (
          <p className="px-2 text-meta text-muted-foreground">
            Your conversations could not be read.
          </p>
        ) : !list ? (
          <div role="status" className="grid gap-2 px-2">
            <span className="sr-only">Loading your conversations…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 rounded-lg bg-selected/60 motion-safe:animate-pulse" />
            ))}
          </div>
        ) : (
          [...groups.entries()].map(([key, group]) => (
            <section
              key={key}
              aria-label={group.label}
              className="mb-4 grid grid-cols-[minmax(0,1fr)] gap-0.5"
            >
              <h3 className="flex items-center justify-between px-2 pb-1 text-micro font-medium text-muted-foreground">
                <span className="truncate">{group.label}</span>
              </h3>
              {group.items.length === 0 && (
                <p className="px-2 py-1 text-micro text-muted-foreground">No conversations yet.</p>
              )}
              {group.items.map((c) => (
                <Link
                  key={c.id}
                  to="/conversations"
                  search={{ c: c.id }}
                  onClick={onPick}
                  aria-current={c.id === current ? "page" : undefined}
                  className="flex h-8 items-center gap-2 rounded-lg px-2 text-meta text-soft transition-colors hover:bg-selected hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="flex-none text-micro text-muted-foreground tabular-nums">
                    {ago(c.updated_at)}
                  </span>
                </Link>
              ))}
            </section>
          ))
        )}
      </nav>
    </div>
  )
}

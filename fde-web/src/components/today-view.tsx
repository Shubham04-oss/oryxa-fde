import { useEffect, useRef, useState } from "react"
import { skipToken, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Card, Failed, Loading, Page, Quiet, Rows } from "./page"
import { ActiveRunsCard } from "./runs"
import { RefusalNote } from "./refusal-note"
import type { Note } from "./refusal-note"
import { MoveAsk, useTaskMover } from "./task-move"
import { useAccessMover } from "./access-move"
import { Key, TodayRow } from "./today-row"
import { queries } from "@/lib/api/client"
import type { ProjectScope, TodayItem } from "@/lib/api/schemas"
import { STATUS_LABEL } from "@/lib/board"
import { localDay } from "@/lib/time"
import { ACCESS_LABEL, TODAY_GROUPS, groupToday, itemKey, summaryLine } from "@/lib/today"
import type { RowAction } from "@/lib/today"
import { refusalNote } from "@/lib/task-move"

const scopeOf = (item: TodayItem): ProjectScope => ({
  company: item.company.id,
  project: item.project.id,
})

/** A field, or anything else that takes the keys a person types. */
function typingIn(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
}

/**
 * Today (DESIGN.md §3): what needs the FDE across every company, as an inbox of three groups
 * where a row acts in place. It says "all clear" only once the API has answered.
 */
export function TodayView({ today = localDay() }: { today?: string }) {
  const items = useQuery(queries.today())
  const navigate = useNavigate()
  const list = useRef<HTMLDivElement>(null)
  // The row the keyboard is on; Tab lands there. Null until a row is focused.
  const [cursor, setCursor] = useState<string | null>(null)
  // Where focus goes once an action is confirmed: the row after the one acted on.
  const after = useRef<{ from: string; to: string | null } | null>(null)
  const [confirmed, setConfirmed] = useState(0)

  const mover = useTaskMover({ onSaved: () => setConfirmed((n) => n + 1) })
  const access = useAccessMover({ onSaved: () => setConfirmed((n) => n + 1) })
  // The people a task can wait on, read when its prompt opens.
  const ask = mover.ask
  const people = useQuery(
    ask?.to === "waiting_on_customer"
      ? queries.projectStakeholders(ask.scope)
      : { queryKey: ["none"], queryFn: skipToken },
  )

  // The access requests a blocked task can name, read when that prompt opens.
  const requests = useQuery(
    ask?.to === "blocked"
      ? queries.projectAccess(ask.scope)
      : { queryKey: ["none"], queryFn: skipToken },
  )

  const rows = () => Array.from(list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])
  const rowOf = (key: string) => rows().find((row) => row.dataset.row === key)

  // After an action is confirmed, focus moves to the next row, so the keyboard can work down the
  // list. It waits for a prompt to close (which returns focus to the row) and does not take
  // focus from someone who has gone elsewhere.
  useEffect(() => {
    const plan = after.current
    if (!plan || confirmed === 0 || ask) return
    const timer = setTimeout(() => {
      const active = document.activeElement
      const stayed = !active || active === document.body || rowOf(plan.from)?.contains(active)
      after.current = null
      if (!stayed) return
      const next = (plan.to && rowOf(plan.to)) || rows()[0]
      next?.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [confirmed, ask])

  // J and K (and the arrows, once a row is focused) move between rows, E does the row's main
  // action and M opens its menu. Nothing here fires while a field, dialog or menu has the keys.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.shiftKey || typingIn(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      const root = list.current
      if (!root) return
      const inList = event.target instanceof Node && root.contains(event.target)
      if (!inList && event.target !== document.body) return
      const all = rows()
      if (all.length === 0) return
      const at = all.findIndex((row) => row.contains(document.activeElement))

      const go = (to: number) => {
        event.preventDefault()
        // From nowhere, the first press lands on the row Tab would, rather than skipping it.
        const first = all.find((row) => row.tabIndex === 0) ?? all[0]
        const target = at < 0 ? first : all[Math.max(0, Math.min(all.length - 1, to))]
        target?.focus()
      }
      const row = all[at]
      switch (event.key) {
        case "j":
          return go(at + 1)
        case "k":
          return go(at - 1)
        case "ArrowDown":
          return inList ? go(at + 1) : undefined
        case "ArrowUp":
          return inList ? go(at - 1) : undefined
        case "e":
        case "m": {
          if (!row || event.repeat) return
          event.preventDefault()
          row
            .querySelector<HTMLElement>(event.key === "e" ? "[data-primary]" : "[data-menu]")
            ?.click()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (items.isPending)
    return (
      <Page>
        <Loading>Gathering what needs you today…</Loading>
      </Page>
    )
  if (items.isError)
    return (
      <Page>
        <Failed
          title="We couldn't load Today."
          error={items.error}
          onRetry={() => void items.refetch()}
        />
      </Page>
    )

  const groups = groupToday(items.data.items, today)
  const keys = TODAY_GROUPS.flatMap(({ key }) => groups[key].map(itemKey))
  const current = cursor && keys.includes(cursor) ? cursor : keys[0]
  // A refusal whose row has left (deleted or settled elsewhere) is said above the groups instead.
  const { refusal: lostTask } = mover
  const { refusal: lostAccess } = access
  const lost: Array<Note> = []
  if (lostTask && !keys.includes(`task:${lostTask.task.id}`))
    lost.push(refusalNote(lostTask, true, mover.again))
  if (lostAccess && !keys.includes(`access:${lostAccess.access.id}`))
    lost.push(access.note(lostAccess.access.description)!)

  function act(item: TodayItem, action: RowAction) {
    const from = itemKey(item)
    const order = rows().map((row) => row.dataset.row)
    const at = order.indexOf(from)
    after.current = { from, to: order[at + 1] ?? order[at - 1] ?? null }
    mover.dismiss()
    access.dismiss()
    if (item.kind === "task" && action.kind === "task")
      mover.request(scopeOf(item), item.task, action.to)
    else if (item.kind === "access_request" && action.kind === "access")
      void access.move(scopeOf(item), item.access, action.to)
  }

  const open = (item: TodayItem) =>
    void navigate({
      to: "/companies/$companyId/projects/$projectId",
      params: { companyId: item.company.id, projectId: item.project.id },
    })

  /** What a row says while its change is on the wire, and why the last one was refused. */
  function status(item: TodayItem) {
    if (item.kind === "task") {
      const to = mover.saving[item.task.id]
      const r = mover.refusal?.task.id === item.task.id ? mover.refusal : null
      return {
        moving: to && `Moving to ${STATUS_LABEL[to]}…`,
        refused: r && refusalNote(r, false, mover.again),
      }
    }
    const to = access.saving[item.access.id]
    const r = access.refusal?.access.id === item.access.id
    return {
      moving: to && `Changing to ${ACCESS_LABEL[to]}…`,
      refused: r ? access.note(null) : null,
    }
  }

  return (
    <Page>
      <div className="grid gap-1">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {summaryLine(groups)}
        </p>
        {keys.length > 0 && (
          <Quiet className="flex flex-wrap items-center gap-x-3 gap-y-1 pointer-coarse:hidden">
            <span className="inline-flex items-center gap-1">
              <Key>J</Key>
              <Key>K</Key> move
            </span>
            <span className="inline-flex items-center gap-1">
              <Key>E</Key> main action
            </span>
            <span className="inline-flex items-center gap-1">
              <Key>M</Key> more
            </span>
            <span className="inline-flex items-center gap-1">
              <Key>Enter</Key> open the project
            </span>
          </Quiet>
        )}
      </div>
      <p role="status" className="sr-only">
        {mover.announcement || access.announcement}
      </p>
      {lost.map((note) => (
        <RefusalNote
          key={note.text}
          note={note}
          className="text-xs"
          onDismiss={() => {
            mover.dismiss()
            access.dismiss()
          }}
        />
      ))}
      <div
        ref={list}
        className="grid gap-4 max-[800px]:gap-3.5"
        onFocus={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row]")
          if (row?.dataset.row) setCursor(row.dataset.row)
        }}
      >
        {TODAY_GROUPS.map(({ key, title, empty }) => (
          <Card
            key={key}
            title={title}
            aside={<span className="text-[11px] text-muted-foreground">{groups[key].length}</span>}
          >
            {groups[key].length === 0 ? (
              <Quiet>{empty}</Quiet>
            ) : (
              <Rows>
                {groups[key].map((item) => {
                  const { moving, refused } = status(item)
                  return (
                    <TodayRow
                      key={itemKey(item)}
                      item={item}
                      group={key}
                      today={today}
                      current={itemKey(item) === current}
                      moving={moving}
                      refused={refused}
                      onAct={(action) => act(item, action)}
                      onOpen={() => open(item)}
                      onDismiss={() => {
                        mover.dismiss()
                        access.dismiss()
                      }}
                    />
                  )
                })}
              </Rows>
            )}
          </Card>
        ))}
      </div>
      <ActiveRunsCard />
      <MoveAsk
        mover={mover}
        people={people.data ?? []}
        peopleNote={
          people.isPending && ask?.to === "waiting_on_customer"
            ? "Loading the people at this company…"
            : people.isError
              ? "The people at this company could not be loaded, so only no one in particular is offered."
              : undefined
        }
        requests={requests.data ?? []}
        requestsNote={
          requests.isPending && ask?.to === "blocked"
            ? "Loading this project's access requests…"
            : requests.isError
              ? "This project's access requests could not be loaded, so none can be chosen."
              : undefined
        }
      />
    </Page>
  )
}

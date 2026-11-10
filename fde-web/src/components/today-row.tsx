import type { KeyboardEvent } from "react"
import { Link } from "@tanstack/react-router"
import { Ellipsis } from "lucide-react"
import { Button } from "./ui/button"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu"
import type { Tone } from "./page"
import type { TodayItem } from "@/lib/api/schemas"
import { dayOf, daysBetween, dueLabel, waitingLabel } from "@/lib/time"
import { actionsOf, itemKey } from "@/lib/today"
import type { RowAction, TodayGroup } from "@/lib/today"
import { cn } from "@/lib/utils"

/** What an item is, in a few words. */
export function itemTitle(item: TodayItem) {
  return item.kind === "task" ? item.task.title : `Access: ${item.access.description}`
}

/** Why it is in its group, and how urgent: the reason a row is there. */
function reason(item: TodayItem, group: TodayGroup, today: string): { text: string; tone: Tone } {
  if (item.kind === "access_request") {
    const { access } = item
    const owner = item.owner ?? null
    const by = owner ? ` by ${owner}` : ""
    if (access.status === "denied") return { text: `Denied${by}`, tone: "attention" }
    if (access.status === "revoked") return { text: `Revoked${by}`, tone: "attention" }
    return { text: waitingLabel(access.days_waiting, owner), tone: "neutral" }
  }
  const { task } = item
  if (group === "blocked") return { text: task.blocker || "Blocked", tone: "attention" }
  if (group === "waiting") {
    const since = dayOf(task.waiting_since ?? task.updated_at)
    return { text: waitingLabel(daysBetween(since, today), null), tone: "neutral" }
  }
  const due = task.due_on ?? today
  return { text: dueLabel(due, today), tone: daysBetween(today, due) < 0 ? "attention" : "neutral" }
}

/** A keyboard key, shown quietly. */
export function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded-sm border border-border px-1 font-sans text-[10px] leading-4 text-muted-foreground">
      {children}
    </kbd>
  )
}

/**
 * One item on Today (DESIGN.md §3): what it is, where, why it is here, one obvious action and a
 * menu for the rest. The row is one stop for Tab, and the list's keys move between rows. The
 * whole row opens the project, except the buttons.
 */
export function TodayRow({
  item,
  group,
  today,
  current,
  moving,
  refused,
  onAct,
  onOpen,
  onDismiss,
}: {
  item: TodayItem
  group: TodayGroup
  today: string
  /** The row Tab lands on; every other row's controls are skipped, the arrow keys reach them. */
  current: boolean
  /** The words for where it is on its way to, while the API has not answered. */
  moving: string | undefined
  /** Why the API refused the last action on this row. */
  refused: string | null
  onAct: (action: RowAction) => void
  onOpen: () => void
  onDismiss: () => void
}) {
  const why = reason(item, group, today)
  const { primary, rest } = actionsOf(item, group)
  const title = itemTitle(item)
  const tab = current ? 0 : -1
  const busy = moving !== undefined

  function key(event: KeyboardEvent) {
    // Only the row itself: Enter on a button or the link inside does what that control does.
    if (event.target !== event.currentTarget || event.key !== "Enter") return
    event.preventDefault()
    onOpen()
  }

  return (
    <li
      data-row={itemKey(item)}
      tabIndex={tab}
      aria-busy={busy}
      onKeyDown={key}
      className={cn(
        "group/row relative py-2 outline-none",
        // The highlight bleeds into the card's padding without touching the lines between rows.
        "before:pointer-events-none before:absolute before:-inset-x-2 before:inset-y-0.5 before:rounded-lg before:bg-selected before:opacity-0",
        "hover:before:opacity-100 focus-visible:before:opacity-100 focus-visible:before:ring-1 focus-visible:before:ring-ring",
        busy && "opacity-60",
      )}
    >
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-40">
          <Link
            to="/companies/$companyId/projects/$projectId"
            params={{ companyId: item.company.id, projectId: item.project.id }}
            tabIndex={tab}
            // Stretched over the row, so a click anywhere but on a button opens the project.
            className="block text-xs leading-snug [overflow-wrap:anywhere] outline-none after:absolute after:inset-0 hover:underline hover:underline-offset-2 focus-visible:underline focus-visible:underline-offset-2"
          >
            {title}
          </Link>
          <span className="block text-[11px] text-muted-foreground">
            {item.company.name} · {item.project.name}
          </span>
          <span className="mt-0.5 flex items-start gap-1.5 text-[11px] leading-normal [overflow-wrap:anywhere] text-soft">
            <span
              aria-hidden="true"
              className={cn(
                "mt-[5px] size-1.5 shrink-0 rounded-full",
                why.tone === "attention" ? "bg-attention" : "bg-strong",
              )}
            />
            {busy ? moving : why.text}
          </span>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            data-primary
            tabIndex={tab}
            disabled={busy}
            aria-keyshortcuts="E"
            aria-label={`${primary.label}: ${title}`}
            onClick={() => onAct(primary)}
            className="bg-raised max-[800px]:h-9 pointer-coarse:h-9"
          >
            {primary.label}
            <span
              aria-hidden="true"
              className="hidden pointer-fine:group-focus-within/row:inline-flex"
            >
              <Key>E</Key>
            </span>
          </Button>
          <Menu>
            <MenuTrigger
              data-menu
              tabIndex={tab}
              disabled={busy}
              aria-keyshortcuts="M"
              aria-label={`Actions for ${title}`}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-selected hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-45 data-popup-open:bg-selected max-[800px]:size-9 pointer-coarse:size-9"
            >
              <Ellipsis size={15} strokeWidth={1.7} aria-hidden="true" />
            </MenuTrigger>
            <MenuContent label={`Actions for ${title}`}>
              {rest.map((action) => (
                <MenuItem key={action.label} onClick={() => onAct(action)}>
                  {action.label}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onClick={onOpen}>Open project</MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
      {refused && (
        <p
          role="alert"
          className="relative z-10 mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-destructive"
        >
          {refused}
          <button type="button" className="text-muted-foreground underline" onClick={onDismiss}>
            Dismiss
          </button>
        </p>
      )}
    </li>
  )
}

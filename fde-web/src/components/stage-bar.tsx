import { useEffect, useId, useRef, useState } from "react"
import { Button } from "./ui/button"
import { FIELD, Labelled } from "./task-move"
import { STAGES } from "@/lib/api/schemas"
import type { ChecklistItem, Stage } from "@/lib/api/schemas"
import { MAX_REASON, STAGE_LABEL, canMove, reasonLength, reasonProblem } from "@/lib/stage"
import { cn } from "@/lib/utils"

/**
 * How the API answered a move that did not happen: the checklist had items open it was not told a
 * reason for (`open`, what it found), or something else went wrong (`error`, in words).
 */
export type MoveRefusal = { open: Array<ChecklistItem> } | { error: string }

/**
 * The project's stage, and the moves it allows (DESIGN.md §3): the next stage, or back to any
 * earlier one for rework. Later stages are shown but cannot be chosen. A move asks first, and a
 * forward move with checklist items open asks for a reason too: a checklist guides, it does not
 * trap.
 */
export function StageBar({
  stage,
  open,
  onMove,
}: {
  stage: Stage
  /** What the page knows is open on this stage's checklist; none while it is unread. */
  open: ReadonlyArray<ChecklistItem>
  /** Moves; null when the API confirmed it, or how it refused. `reason` goes only with a forward move that needs one. */
  onMove: (to: Stage, reason?: string) => Promise<MoveRefusal | null>
}) {
  const [target, setTarget] = useState<Stage | null>(null)
  const [reason, setReason] = useState("")
  // Items the API found open when the page believed none were (the view was stale).
  const [found, setFound] = useState<Array<ChecklistItem> | null>(null)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What a screen reader hears of the count: once typing pauses, not on every key.
  const [heard, setHeard] = useState("")
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(pause.current), [])
  const ids = useId()
  const at = STAGES.indexOf(stage)
  const back = target !== null && STAGES.indexOf(target) < at
  // Moving back never asks for a reason.
  const items = target === null || back ? [] : (found ?? [...open])
  // `found` can be empty if the API refused for an open item it did not name: still ask.
  const asking = target !== null && !back && (found !== null || items.length > 0)
  const problem = asking ? reasonProblem(reason) : null

  function choose(to: Stage | null) {
    setTarget(to)
    setReason("")
    clearTimeout(pause.current)
    setHeard("")
    setFound(null)
    setTried(false)
    setError(null)
  }

  function write(value: string) {
    setReason(value)
    clearTimeout(pause.current)
    pause.current = setTimeout(
      () => setHeard(`${reasonLength(value)} of ${MAX_REASON} characters`),
      600,
    )
  }

  const shown = (tried && problem) || error

  async function confirm() {
    if (target === null) return
    if (problem) return setTried(true)
    setBusy(true)
    setError(null)
    const refused = await onMove(target, asking ? reason.trim() : undefined)
    setBusy(false)
    if (!refused) return choose(null)
    if ("open" in refused) {
      // The checklist had changed under the page: show what is open now, and ask.
      setFound(refused.open)
      setTried(false)
    } else setError(refused.error)
  }

  return (
    <section aria-label="Stage" className="min-w-0">
      <ol className="grid grid-cols-8 gap-1 max-[800px]:grid-cols-4 max-[800px]:gap-y-2.5">
        {STAGES.map((step, i) => {
          const bar = cn(
            "block h-1 rounded-full",
            i < at && "bg-soft",
            i === at && "bg-foreground",
            i > at && "bg-border",
          )
          const label = (
            <>
              <span aria-hidden="true" className={bar} />
              <span className="mt-1.5 block truncate text-[11px]">
                <span className="text-muted-foreground tabular-nums">{i + 1} </span>
                {STAGE_LABEL[step]}
              </span>
            </>
          )
          if (step === stage)
            return (
              <li key={step}>
                <span aria-current="step" className="block px-1 py-1 font-semibold">
                  {label}
                </span>
              </li>
            )
          const allowed = canMove(stage, step)
          return (
            <li key={step}>
              <button
                type="button"
                disabled={!allowed || busy}
                aria-label={
                  allowed
                    ? `${i < at ? "Move back to" : "Move to"} ${STAGE_LABEL[step]}`
                    : `${STAGE_LABEL[step]}, not yet: stages advance one at a time`
                }
                aria-pressed={target === step}
                onClick={() => choose(step)}
                className={cn(
                  "block w-full rounded-md px-1 py-1 text-left text-soft",
                  allowed
                    ? "hover:bg-selected hover:text-foreground aria-pressed:bg-selected"
                    : "text-muted-foreground disabled:cursor-default",
                )}
              >
                {label}
              </button>
            </li>
          )
        })}
      </ol>
      {target && (
        <form
          aria-label="Confirm the move"
          role="group"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void confirm()
          }}
          className="mt-3 grid gap-2.5 rounded-xl border bg-raised px-3.5 py-2.5 text-xs"
        >
          <p>
            {back
              ? `Move this project back to ${STAGE_LABEL[target]} for rework?`
              : `Move this project to ${STAGE_LABEL[target]}?`}
          </p>
          {asking && (
            <>
              <div className="grid gap-1">
                <p className="flex items-start gap-2">
                  {/* A move that is held up is attention; an open item on its own is only information. */}
                  <span
                    aria-hidden="true"
                    className="mt-1 size-1.5 flex-none rounded-full bg-attention"
                  />
                  {items.length === 0
                    ? `Items are still open on ${STAGE_LABEL[stage]}.`
                    : items.length === 1
                      ? `1 item is still open on ${STAGE_LABEL[stage]}:`
                      : `${items.length} items are still open on ${STAGE_LABEL[stage]}:`}
                </p>
                {items.length > 0 && (
                  <ul className="ml-3.5 list-disc pl-3 text-soft">
                    {items.map((item) => (
                      <li key={item.key}>{item.label}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="grid gap-1">
                <Labelled label="Why are you moving on with these open?">
                  <textarea
                    autoFocus
                    required
                    className={`${FIELD} min-h-20`}
                    value={reason}
                    onChange={(e) => write(e.target.value)}
                    aria-describedby={shown ? `${ids}-note ${ids}-error` : `${ids}-note`}
                    aria-invalid={tried && problem ? true : undefined}
                  />
                </Labelled>
                <p
                  id={`${ids}-note`}
                  className="flex flex-wrap justify-between gap-x-3 text-[11px] text-muted-foreground"
                >
                  <span>Your reason is recorded in the audit log, with the items left open.</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      reasonLength(reason) > MAX_REASON && "text-destructive",
                    )}
                  >
                    {reasonLength(reason)} / {MAX_REASON}
                  </span>
                </p>
                <span aria-live="polite" className="sr-only">
                  {heard}
                </span>
              </div>
            </>
          )}
          {shown && (
            <p id={`${ids}-error`} role="alert" className="text-destructive">
              {shown}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => choose(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Moving…" : back ? "Move back" : asking ? "Move with items open" : "Move"}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

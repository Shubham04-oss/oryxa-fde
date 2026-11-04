import { useState } from "react"
import { Button } from "./ui/button"
import { STAGES } from "@/lib/api/schemas"
import type { Stage } from "@/lib/api/schemas"
import { STAGE_LABEL, canMove } from "@/lib/stage"
import { cn } from "@/lib/utils"

/**
 * The project's stage, and the moves it allows (DESIGN.md §3): the next stage, or back to any
 * earlier one for rework. Later stages are shown but cannot be chosen. A move asks first.
 */
export function StageBar({
  stage,
  onMove,
  moving,
  error,
}: {
  stage: Stage
  onMove: (to: Stage) => void
  moving: boolean
  error: string | null
}) {
  const [target, setTarget] = useState<Stage | null>(null)
  const at = STAGES.indexOf(stage)
  const back = target !== null && STAGES.indexOf(target) < at

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
                disabled={!allowed || moving}
                aria-label={
                  allowed
                    ? `${i < at ? "Move back to" : "Move to"} ${STAGE_LABEL[step]}`
                    : `${STAGE_LABEL[step]}, not yet: stages advance one at a time`
                }
                aria-pressed={target === step}
                onClick={() => setTarget(step)}
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
        <div
          role="group"
          aria-label="Confirm the move"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border bg-raised px-3.5 py-2.5"
        >
          <p className="mr-auto text-xs">
            {back
              ? `Move this project back to ${STAGE_LABEL[target]} for rework?`
              : `Move this project to ${STAGE_LABEL[target]}?`}
          </p>
          <Button variant="ghost" onClick={() => setTarget(null)}>
            Cancel
          </Button>
          <Button
            disabled={moving}
            onClick={() => {
              onMove(target)
              setTarget(null)
            }}
          >
            {back ? "Move back" : "Move"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

import { Icon } from "@/components/ui/icon"
import { STAGES } from "@/lib/api/schemas"
import type { Stage } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"
import { cn } from "@/lib/utils"

/**
 * The eight stages as a labelled stepper: stages behind are ticked, the current one is the accent and
 * named in full, the rest are outlined. A list, so a screen reader hears each and which is current. On
 * a phone the labels give way to "Stage 4 of 8, Build".
 */
export function Stepper({ stage }: { stage: Stage }) {
  const here = STAGES.indexOf(stage)
  return (
    <div className="grid gap-2">
      <p className="hidden text-r2-meta text-muted-foreground max-[640px]:block">
        Stage <span className="tabular-nums">{here + 1}</span> of{" "}
        <span className="tabular-nums">{STAGES.length}</span>
        <span className="font-semibold text-foreground">, {STAGE_LABEL[stage]}</span>
      </p>
      <ol aria-label="Stages" className="grid grid-cols-8 gap-0">
        {STAGES.map((s, i) => {
          const done = i < here
          const current = i === here
          return (
            <li
              key={s}
              aria-current={current ? "step" : undefined}
              className="relative grid justify-items-center gap-1.5"
            >
              {/* The line to the next stage. */}
              {i < STAGES.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-[11px] left-[calc(50%+14px)] h-px w-[calc(100%-28px)]",
                    i < here ? "bg-brand" : "bg-border",
                  )}
                />
              )}
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-[22px] place-items-center rounded-r2-node border text-[11px] font-semibold tabular-nums",
                  done && "border-brand bg-tint-soft text-brand",
                  current && "border-brand bg-brand text-brand-ink ring-4 ring-brand/15",
                  !done && !current && "border-strong bg-canvas text-muted-foreground",
                )}
              >
                {done ? <Icon name="check" size={12} strokeWidth={2.4} /> : i + 1}
              </span>
              <span
                className={cn(
                  "text-r2-meta max-[640px]:sr-only",
                  current ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="sr-only">{done ? "Done: " : current ? "Current: " : ""}</span>
                {STAGE_LABEL[s]}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

import { cn } from "@/lib/utils"
import { sparkPoints } from "@/lib/round2"
import type { Track } from "@/lib/round2"
import type { Tone } from "./ui"

// Data as pictures (DESIGN.md "Round 2"). Each is hidden from screen readers: the block around it
// says the same in words.

const DOT: Record<Tone, string> = {
  success: "bg-success",
  attention: "bg-attention",
  neutral: "bg-foreground",
}

/**
 * Baseline to target on one line, better to the right: the zone past the target is shaded, the way
 * from the baseline to now is filled, now is a dot in its status colour, and the target a tick.
 */
export function TrackBar({
  track,
  tone,
  thin,
}: {
  track: Track
  tone: Tone
  /** The small version, for the overview's rail. */
  thin?: boolean
}) {
  const { baseline, current, target } = track
  const from = baseline ?? current
  return (
    <div aria-hidden="true" className={cn("relative w-full", thin ? "h-3" : "h-5")}>
      <div
        className={cn(
          "absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-selected",
          thin ? "h-1" : "h-1.5",
        )}
      >
        {/* Where the criterion is met: the zone past the target. */}
        <div className="absolute inset-y-0 right-0 bg-success/20" style={{ left: `${target}%` }} />
        {from !== null && current !== null && (
          <div
            className="absolute inset-y-0 bg-foreground/20"
            style={{ left: `${Math.min(from, current)}%`, width: `${Math.abs(current - from)}%` }}
          />
        )}
      </div>
      {baseline !== null && (
        <span
          className={cn(
            "absolute top-1/2 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground",
            thin ? "h-2" : "h-3",
          )}
          style={{ left: `${baseline}%` }}
        />
      )}
      <span
        className={cn(
          "absolute top-1/2 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground",
          thin ? "h-3" : "h-5",
        )}
        style={{ left: `${target}%` }}
      />
      {current !== null && (
        <span
          className={cn(
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-canvas",
            DOT[tone],
            thin ? "size-2" : "size-3",
          )}
          style={{ left: `${current}%` }}
        />
      )}
    </div>
  )
}

/** Recent pass rates as a small line, oldest first, with the target as a dashed rule where it is a rate. */
export function Spark({
  rates,
  target,
  width = 112,
  height = 28,
}: {
  rates: ReadonlyArray<number>
  /** A target between 0 and 1, drawn as a rule; anything else is not on this scale and is left out. */
  target?: number
  width?: number
  height?: number
}) {
  const points = sparkPoints(rates, width, height)
  const last = points.at(-1)
  const rule =
    target !== undefined && target >= 0 && target <= 1
      ? sparkPoints([target], width, height)[0]
      : null
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
    >
      {rule && (
        <line
          x1={0}
          x2={width}
          y1={rule.y}
          y2={rule.y}
          stroke="var(--border-strong)"
          strokeDasharray="2 3"
          strokeWidth={1}
        />
      )}
      {points.length > 1 && (
        <polyline
          points={points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke="var(--text-soft)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {last && <circle cx={last.x} cy={last.y} r={2.5} fill="var(--text)" />}
    </svg>
  )
}

/** How long a request has waited, against the week after which a wait is long. */
export function WaitBar({ days, scale, long }: { days: number; scale: number; long: number }) {
  return (
    <div aria-hidden="true" className="relative h-1.5 w-full rounded-full bg-selected">
      <div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          days >= long ? "bg-attention" : "bg-soft/60",
        )}
        style={{ width: `${Math.min(100, (Math.max(days, 0.3) / scale) * 100)}%` }}
      />
      <span
        className="absolute -top-1 -bottom-1 w-px bg-strong"
        style={{ left: `${Math.min(100, (long / scale) * 100)}%` }}
      />
    </div>
  )
}

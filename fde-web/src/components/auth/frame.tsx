import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { onMock } from "@/lib/api/client"
import { STAGES } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"
import { cn } from "@/lib/utils"

// Each stage a little stronger than the last, drawn in --text: the screen's one expressive touch.
const FADE = [
  "opacity-20",
  "opacity-30",
  "opacity-40",
  "opacity-50",
  "opacity-60",
  "opacity-70",
  "opacity-80",
  "opacity-90",
]

/**
 * Every sign-in screen's frame (DESIGN.md §3): the full canvas, a compact card inset right, and the
 * eight stages beside it. Restyling the sign-in screens starts here and in `fields.tsx`.
 *
 * `focusTitle` moves focus to the heading when the screen opens, so a screen reader announces a new
 * step; the first screen leaves focus where the browser put it.
 */
export function AuthFrame({
  title,
  lead,
  focusTitle = false,
  children,
  mockNote,
}: {
  title: string
  lead?: ReactNode
  focusTitle?: boolean
  children: ReactNode
  /** What the dev mock accepts on this screen, shown only on the mock. */
  mockNote?: ReactNode
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusTitle) heading.current?.focus()
  }, [focusTitle, title])

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-[clamp(16px,5vw,80px)] py-6 text-foreground">
      <div className="grid w-[min(100%,1100px)] grid-cols-[minmax(0,1fr)_minmax(320px,420px)] items-center gap-[clamp(36px,7vw,112px)] max-[800px]:grid-cols-1">
        <ol aria-hidden="true" className="grid gap-2.5 max-[800px]:hidden">
          {STAGES.map((stage, i) => (
            <li key={stage} className={cn("flex items-center gap-3", FADE[i])}>
              <span className="size-2.5 rounded-full bg-foreground" />
              <span className="text-[clamp(20px,2.6vw,28px)] font-semibold tracking-[-0.03em]">
                {STAGE_LABEL[stage]}
              </span>
            </li>
          ))}
        </ol>
        <section
          aria-labelledby="auth-title"
          className="min-w-0 rounded-[20px] border bg-card p-[34px] max-[800px]:p-6"
        >
          <h1
            id="auth-title"
            ref={heading}
            tabIndex={-1}
            className="text-[clamp(24px,6vw,30px)] leading-[1.12] font-[650] tracking-[-0.05em] outline-none"
          >
            {title}
          </h1>
          {lead && (
            <div className="mt-2.5 text-[13px] leading-normal text-muted-foreground">{lead}</div>
          )}
          <div className="mt-6">{children}</div>
          {onMock && mockNote && (
            <p className="mt-5 border-t pt-4 text-[11px] leading-normal text-muted-foreground">
              Mock API, sample data. {mockNote}
            </p>
          )}
        </section>
      </div>
    </main>
  )
}

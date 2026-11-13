import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"
import type { ReactNode } from "react"
import { useId } from "react"
import { useQuery } from "@tanstack/react-query"
import { queries } from "@/lib/api/client"
import type { Person } from "@/lib/people"
import { Icon } from "@/components/ui/icon"
import type { IconName } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

// The prototype's own pieces (DESIGN.md "Round 2"). Every size, radius and colour is a token, so the
// same markup draws both looks.

/** Three levels: one primary per view, secondary for the rest, quiet for actions inside a row. */
export const r2Button = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-r2-control font-medium whitespace-nowrap transition-[background-color,color,border-color,transform] duration-150 select-none disabled:pointer-events-none disabled:opacity-45 motion-safe:active:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      level: {
        primary: "bg-brand text-brand-ink hover:bg-brand/90 active:bg-brand/80",
        secondary: "border bg-canvas text-foreground hover:border-strong hover:bg-selected",
        quiet: "text-foreground underline-offset-4 hover:bg-selected",
      },
      size: {
        md: "h-9 px-4 text-r2-meta",
        sm: "h-8 px-3 text-r2-meta",
      },
    },
    defaultVariants: { level: "secondary", size: "md" },
  },
)

type R2ButtonProps = Omit<ButtonPrimitive.Props, "className"> &
  VariantProps<typeof r2Button> & { className?: string }

export function R2Button({ className, level, size, ...props }: R2ButtonProps) {
  return <ButtonPrimitive className={cn(r2Button({ level, size }), className)} {...props} />
}

/** A block of the page: a soft card in look a, a hairline box in look b. */
export function Block({
  title,
  aside,
  children,
  className,
  flush,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
  /** Rows run to the block's edges (a list); otherwise the content is padded. */
  flush?: boolean
}) {
  const heading = useId()
  return (
    <section
      aria-labelledby={heading}
      className={cn(
        "min-w-0 overflow-hidden rounded-r2 border bg-r2-card shadow-r2 motion-safe:animate-settle",
        className,
      )}
    >
      <header className="flex min-h-(--r2-row) flex-wrap items-center justify-between gap-x-3 gap-y-2 px-(--r2-pad) py-2">
        <h2 id={heading} className="r2-section">
          {title}
        </h2>
        {aside}
      </header>
      <div className={flush ? undefined : "px-(--r2-pad) pb-(--r2-pad)"}>{children}</div>
    </section>
  )
}

export type Tone = "success" | "attention" | "neutral"

const TONE_ICON: Record<Tone, IconName> = {
  success: "check-circle",
  attention: "alert",
  neutral: "minus-circle",
}

/** A status: an icon and words, never colour alone. */
export function StatusMark({
  tone,
  children,
  icon,
  className,
}: {
  tone: Tone
  children: ReactNode
  icon?: IconName
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-r2-meta whitespace-nowrap",
        tone === "success" && "text-success",
        tone === "attention" && "text-attention",
        tone === "neutral" && "text-muted-foreground",
        className,
      )}
    >
      <Icon name={icon ?? TONE_ICON[tone]} size={14} strokeWidth={1.9} />
      {children}
    </span>
  )
}

/** A number, as a column of numbers reads it: tabular and to the right. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-right tabular-nums", className)}>{children}</span>
}

/** A person's initials in a small circle. */
export function Initials({ name, className }: { name: string; className?: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("")
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-7 flex-none place-items-center rounded-full border bg-raised text-[11px] font-semibold text-soft",
        className,
      )}
    >
      {letters || <Icon name="person" size={14} />}
    </span>
  )
}

/** A loading block: quiet bars where the rows will be, and words for a screen reader. */
export function Skeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" className="grid gap-2 px-(--r2-pad) py-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="h-4 rounded bg-selected motion-safe:animate-pulse"
          style={{ width: `${86 - i * 14}%` }}
        />
      ))}
    </div>
  )
}

/** The name to take initials from: "You" is the signed-in person's own name. */
export function useInitialsOf() {
  const me = useQuery(queries.me())
  return (person: Person) => (person.you && me.data ? me.data.user.name : person.label)
}

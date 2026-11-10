import { useId } from "react"
import type { ReactNode, Ref } from "react"
import { Button } from "./ui/button"
import { ApiError } from "@/lib/api/client"
import { cn } from "@/lib/utils"

// What every screen in the canvas is made of (DESIGN.md §3): a centered column of quiet cards,
// and the loading, empty and error states each one shows.

/** `wide` is the page column's larger size; `full` takes the whole canvas, for a screen that holds a page-wide card (the board). */
export function Page({
  children,
  wide,
  full,
}: {
  children: ReactNode
  wide?: boolean
  full?: boolean
}) {
  return (
    <div
      className={cn(
        "mx-auto grid gap-4 py-7 text-[13px] max-[800px]:w-[calc(100%-32px)] max-[800px]:gap-3.5 max-[800px]:py-5",
        full
          ? "w-[calc(100%-48px)]"
          : wide
            ? "w-[min(1040px,calc(100%-48px))]"
            : "w-[min(880px,calc(100%-48px))]",
      )}
    >
      {children}
    </div>
  )
}

/** A quiet card with a heading; `aside` sits at the heading's right. */
export function Card({
  title,
  aside,
  children,
  className,
  ref,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
  /** Gives the card a ref and makes it a place focus can be sent to (the checklist does), not a tab stop. */
  ref?: Ref<HTMLElement>
}) {
  const heading = useId()
  return (
    <section
      ref={ref}
      tabIndex={ref ? -1 : undefined}
      aria-labelledby={heading}
      className={cn(
        "min-w-0 rounded-[14px] border bg-card px-5 py-[18px] max-[800px]:p-4",
        ref && "outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={heading} className="text-[13px] font-semibold">
          {title}
        </h2>
        {aside}
      </header>
      <div className="mt-2.5">{children}</div>
    </section>
  )
}

/** Scrolls a card into view and moves focus to it, so the canvas does not jump a second time. */
export function reveal(card: HTMLElement | null) {
  if (!card) return
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  card.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" })
  card.focus({ preventScroll: true })
}

/** Rows in a card, with a quiet line between them. */
export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {children}
    </ul>
  )
}

export function Row({ children }: { children: ReactNode }) {
  return <li className="min-w-0 py-2 first:pt-0 last:pb-0">{children}</li>
}

/** Text a person reads second: metadata and hints. */
export function Quiet({
  children,
  className,
  id,
}: {
  children: ReactNode
  className?: string
  /** For a control that it describes. */
  id?: string
}) {
  return (
    <p id={id} className={cn("text-[11px] leading-normal text-muted-foreground", className)}>
      {children}
    </p>
  )
}

export type Tone = "success" | "attention" | "neutral"

/** A status: a dot and its words, so colour is never the only signal. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-soft">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          tone === "success" && "bg-success",
          tone === "attention" && "bg-attention",
          tone === "neutral" && "bg-strong",
        )}
      />
      {children}
    </span>
  )
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {children}
    </p>
  )
}

/** A failed read: what failed, why when the API says, and Try again unless it cannot help. */
export function Failed({
  title,
  error,
  onRetry,
}: {
  title: string
  error: unknown
  onRetry: () => void
}) {
  const said = error instanceof ApiError && error.message !== error.code ? error.message : null
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-[15px] border border-dashed border-strong p-5"
    >
      <strong className="text-[13px] font-semibold text-destructive">{title}</strong>
      <p className="text-xs text-muted-foreground">
        {said ?? "Check your connection and try again."}
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

/** A company or project that is not the FDE's, or does not exist: one answer for both. */
export function NotFound({ what }: { what: "company" | "project" | "run" }) {
  return (
    <Page>
      <div className="rounded-[15px] border border-dashed border-strong p-5">
        <strong className="text-[13px] font-semibold">This {what} is not available.</strong>
        <p className="mt-1 text-xs text-muted-foreground">
          It does not exist, or you are not on it. Use Jump to (Ctrl K) to find yours.
        </p>
      </div>
    </Page>
  )
}

/** The API answers 403 for a company or project not the FDE's, and 404 for a missing record. */
export const isNotFound = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)

import { useEffect, useRef } from "react"
import type { ReactNode, Ref } from "react"
import { Icon } from "../ui/icon"
import { onMock } from "@/lib/api/client"

/** The product's mark: the workspace's voice, as on the welcome screen, and its name. */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5 text-meta font-semibold tracking-[-0.01em]">
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-[9px] bg-tint-soft text-tint"
      >
        <Icon name="sparkle" size={16} />
      </span>
      Oryxa FDE
    </span>
  )
}

/**
 * The page every signed-out screen sits on (DESIGN.md §3): the paper surround, the mark at the top
 * and one card in the middle, in the same look as the signed-in workspace. Look only: what is in
 * the card, and how it behaves, belongs to the screen.
 */
export function AuthPage({
  children,
  label,
  labelledBy,
}: {
  children: ReactNode
  /** What the card is called to a screen reader, when its heading does not name it. */
  label?: string
  labelledBy?: string
}) {
  // No background of its own: the body is the paper surround (--base).
  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr_auto] text-foreground">
      <header className="px-8 py-6 max-[560px]:px-5 max-[560px]:py-5">
        <Wordmark />
      </header>
      <div className="grid place-items-center px-4 pb-6">
        <section
          aria-label={label}
          aria-labelledby={labelledBy}
          className="w-[min(100%,420px)] min-w-0 rounded-[24px] border bg-canvas p-9 shadow-lift motion-safe:animate-settle max-[560px]:p-6"
        >
          {children}
        </section>
      </div>
      {/* As tall as the header, so the card sits in the true middle. */}
      <div aria-hidden="true" className="h-[76px] max-[560px]:h-6" />
    </main>
  )
}

/** A signed-out screen's title and the line under it. */
export function AuthTitle({
  id,
  ref,
  focusable,
  children,
  lead,
}: {
  id?: string
  ref?: Ref<HTMLHeadingElement>
  focusable?: boolean
  children: ReactNode
  lead?: ReactNode
}) {
  return (
    <>
      <h1
        id={id}
        ref={ref}
        tabIndex={focusable ? -1 : undefined}
        className="text-[28px] leading-[34px] font-semibold tracking-[-0.025em] text-balance outline-none max-[560px]:text-[24px] max-[560px]:leading-[30px]"
      >
        {children}
      </h1>
      {lead && <div className="mt-2 text-body text-muted-foreground">{lead}</div>}
    </>
  )
}

/** The dev mock's note at the foot of a card, shown only on the mock. */
export function MockNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-7 border-t pt-4 text-micro text-muted-foreground">
      Mock API, sample data. {children}
    </p>
  )
}

/**
 * Every sign-in screen's frame (DESIGN.md §3): the signed-out page and its one card. Restyling the
 * sign-in screens starts here and in `fields.tsx`.
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
    <AuthPage labelledBy="auth-title">
      <AuthTitle id="auth-title" ref={heading} focusable lead={lead}>
        {title}
      </AuthTitle>
      <div className="mt-8">{children}</div>
      {/* `import.meta.env.DEV` is false in a production build, which drops this note. */}
      {import.meta.env.DEV && onMock && mockNote && <MockNote>{mockNote}</MockNote>}
    </AuthPage>
  )
}

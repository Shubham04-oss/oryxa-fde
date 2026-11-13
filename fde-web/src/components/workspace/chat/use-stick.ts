import { useCallback, useEffect, useRef, useState } from "react"
import { atBottom, onGrew, onScrolled } from "@/lib/workspace/chat"
import type { Stick } from "@/lib/workspace/chat"

// The thread follows new text only while the person is at the bottom; scrolled up, it stays put and
// offers "Jump to latest" (the rules are in chat.ts and tested there). Written here rather than taken
// from shadcn's MessageScroller, which needs the `@shadcn/react` runtime package.

const reduced = () =>
  typeof globalThis.matchMedia === "function" &&
  globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches

export function useStick() {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const state = useRef<Stick>({ stuck: true, unseen: false })
  const [stick, setStick] = useState<Stick>(state.current)
  // While a smooth jump runs, its own scroll events say nothing about where the person is.
  const jumping = useRef(false)

  const set = (next: Stick) => {
    state.current = next
    setStick(next)
  }

  useEffect(() => {
    const el = viewport.current
    const inner = content.current
    if (!el || !inner) return
    const onScroll = () => {
      const bottom = atBottom(el)
      if (jumping.current) {
        if (bottom) jumping.current = false
        return
      }
      const next = onScrolled(state.current, bottom)
      if (next.stuck !== state.current.stuck || next.unseen !== state.current.unseen) set(next)
    }
    const grew = new ResizeObserver(() => {
      if (atBottom(el, 1) && state.current.stuck) return
      const { stick: next, follow } = onGrew(state.current)
      if (follow) el.scrollTop = el.scrollHeight
      else if (next.unseen !== state.current.unseen) set(next)
    })
    el.addEventListener("scroll", onScroll, { passive: true })
    grew.observe(inner)
    return () => {
      el.removeEventListener("scroll", onScroll)
      grew.disconnect()
    }
  }, [])

  const jump = useCallback(() => {
    const el = viewport.current
    if (!el) return
    set({ stuck: true, unseen: false })
    jumping.current = !reduced()
    el.scrollTo({ top: el.scrollHeight, behavior: reduced() ? "auto" : "smooth" })
  }, [])

  return { viewport, content, stick, jump }
}

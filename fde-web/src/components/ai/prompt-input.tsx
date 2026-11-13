// From Vercel AI Elements' `prompt-input.tsx` (vercel/ai-elements at ca8be60), Apache-2.0,
// LICENSE-ai-elements.txt. Kept: the form, the textarea's Enter and Shift+Enter handling (an IME
// composing is left alone, and a disabled submit is never bypassed), and the submit that becomes Stop
// during a turn. Changed: no attachments, model or tool menus, or controller; our tokens and icons; the
// textarea grows with its text up to a limit; the key rule is `composerKey` in chat.ts, tested there.
import { useLayoutEffect, useRef } from "react"
import type { ComponentProps, KeyboardEvent } from "react"
import { Icon } from "../ui/icon"
import { Tip } from "../ui/tooltip"
import { composerKey } from "@/lib/workspace/chat"
import { cn } from "@/lib/utils"

export const PromptInput = ({ className, ...props }: ComponentProps<"form">) => (
  <form
    className={cn(
      "relative rounded-[20px] border bg-canvas shadow-lift transition-[border-color,box-shadow] duration-150 focus-within:border-strong focus-within:ring-4 focus-within:ring-tint/12",
      className,
    )}
    {...props}
  />
)

/** The tallest the box grows before it scrolls. */
const MAX_HEIGHT = 216

export function PromptInputTextarea({
  className,
  onKeyDown,
  value,
  ref,
  ...props
}: ComponentProps<"textarea"> & { value: string }) {
  const box = useRef<HTMLTextAreaElement | null>(null)
  // Ours, to grow the box, and the caller's, to focus it.
  const both = (el: HTMLTextAreaElement | null) => {
    box.current = el
    if (typeof ref === "function") ref(el)
    else if (ref) ref.current = el
  }
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    if (
      composerKey({
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
      }) !== "send"
    )
      return
    e.preventDefault()
    e.currentTarget.form?.requestSubmit()
  }

  return (
    <textarea
      ref={both}
      rows={1}
      value={value}
      onKeyDown={handleKeyDown}
      className={cn(
        "block max-h-[216px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  )
}

export const PromptInputFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("flex min-h-12 items-center gap-2 px-2.5 pb-2.5 pl-3", className)}
    {...props}
  />
)

export function PromptInputSubmit({
  status,
  onStop,
  disabled,
  why,
}: {
  status: "ready" | "streaming"
  onStop: () => void
  disabled?: boolean
  /** Why it cannot send now, for the tooltip. */
  why?: string
}) {
  const streaming = status === "streaming"
  return (
    <Tip
      label={streaming ? "Stop" : (why ?? "Send")}
      keys={streaming ? ["Esc"] : why ? undefined : ["Enter"]}
    >
      <button
        type={streaming ? "button" : "submit"}
        aria-label={streaming ? "Stop the answer" : "Send"}
        aria-disabled={!streaming && disabled ? true : undefined}
        onClick={(e) => {
          if (streaming) {
            e.preventDefault()
            onStop()
          } else if (disabled) e.preventDefault()
        }}
        className={cn(
          "ml-auto grid size-8 flex-none place-items-center rounded-full bg-primary text-primary-foreground transition-[background-color,color,transform] duration-150 hover:bg-primary/85 motion-safe:active:scale-[0.94]",
          !streaming && disabled && "bg-selected text-muted-foreground hover:bg-selected",
        )}
      >
        {streaming ? (
          <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-current" />
        ) : (
          <Icon name="arrow-up" size={16} strokeWidth={2} />
        )}
      </button>
    </Tip>
  )
}

import { useId, useState } from "react"
import { cn } from "@/lib/utils"

/** Text from a case, a model or an imported file is long and not ours: how much shows before it is folded. */
const FOLD_CHARS = 240
const FOLD_LINES = 5

/** Whether `text` is long enough to fold, and what shows of it while folded. */
export function folded(text: string): { long: boolean; head: string } {
  const lines = text.split("\n")
  const long = text.length > FOLD_CHARS || lines.length > FOLD_LINES
  if (!long) return { long, head: text }
  let head = lines.slice(0, FOLD_LINES).join("\n")
  if (head.length > FOLD_CHARS) head = head.slice(0, FOLD_CHARS)
  return { long, head: `${head.trimEnd()}…` }
}

/**
 * Untrusted text, shown as text and nothing else: never HTML or Markdown, its lines and spaces kept. A long one is
 * folded to a few lines with a button that opens all of it (in a box that scrolls, so a 64 KB output cannot take over
 * the page) and folds it again.
 */
export function LongText({
  text,
  label,
  className,
}: {
  text: string
  /** What it is, for the button and for a screen reader: "output". */
  label: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const { long, head } = folded(text)
  if (text === "") return <p className="text-[11px] text-muted-foreground">Empty.</p>
  return (
    <div className="grid gap-1">
      <pre
        id={id}
        className={cn(
          "min-w-0 rounded-lg border bg-raised px-2.5 py-1.5 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground",
          open && "max-h-72 overflow-auto",
          className,
        )}
      >
        {open || !long ? text : head}
      </pre>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="w-fit text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {open
            ? `Fold the ${label}`
            : `Show the whole ${label} (${text.length.toLocaleString("en-GB")} characters)`}
        </button>
      )}
    </div>
  )
}

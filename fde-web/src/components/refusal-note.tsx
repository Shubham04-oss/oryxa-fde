import { cn } from "@/lib/utils"

/**
 * What a move that did not happen says, in the place it was made (DESIGN.md §3, A stale save). A
 * refusal is red. A move held back because the record had changed is not an error: it has the
 * amber dot and normal text, and may offer the move again on the record as it now stands.
 */
export type Note = {
  text: string
  /** Held back because the record had changed, not refused. */
  held: boolean
  again?: { label: string; run: () => void }
}

export function RefusalNote({
  note,
  onDismiss,
  className,
}: {
  note: Note
  onDismiss: () => void
  className?: string
}) {
  return (
    <p
      role="alert"
      className={cn(
        "flex flex-wrap items-baseline gap-x-3 gap-y-0.5",
        note.held ? "text-foreground" : "text-destructive",
        className,
      )}
    >
      <span className="[overflow-wrap:anywhere]">
        {note.held && (
          <span
            aria-hidden="true"
            className="mr-1.5 inline-block size-1.5 rounded-full bg-attention align-middle"
          />
        )}
        {note.text}
      </span>
      {note.again && (
        <button type="button" className="font-medium underline" onClick={note.again.run}>
          {note.again.label}
        </button>
      )}
      <button type="button" className="text-muted-foreground underline" onClick={onDismiss}>
        Dismiss
      </button>
    </p>
  )
}

import { useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { Button } from "./ui/button"
import { DialogContent, DialogDescription, DialogTitle } from "./ui/dialog"
import { FIELD, Footer, Labelled } from "./task-move"

// The form every create and edit in the workspace opens (DESIGN.md §2, Dialogs): a centred dialog
// with its fields, the API's answer to Save, and, on an edit, a delete that asks first. Nothing is
// closed or shown as saved until the API confirms it; a refusal stays in the dialog with its reason
// and what was typed. The board's task form, the company and project forms and the stakeholder
// and system forms are all this.

export type Removal = {
  /** The button that starts it: "Delete task". */
  label: string
  /** The question, once asked: "Delete this task? This cannot be undone." */
  ask: string
  /** What the confirmation is called to a screen reader: "Confirm the delete". */
  group: string
  /** The button that does it: "Delete" or "Remove". */
  confirm: string
  /** Null when the API confirmed it, or why it did not. */
  run: () => Promise<string | null>
}

export function FormDialog({
  title,
  description,
  save,
  validate,
  onSubmit,
  remove,
  onClose,
  children,
}: {
  title: string
  /** Read by a screen reader only. */
  description: string
  /** The Save button's words. */
  save: string
  /** What is wrong before anything is sent, in words, or null. The API checks again. */
  validate?: () => string | null
  /** Null when the API confirmed the save, or why it did not. */
  onSubmit: () => Promise<string | null>
  remove?: Removal
  onClose: () => void
  children: ReactNode
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function run(work: () => Promise<string | null>) {
    setBusy(true)
    const failed = await work()
    setBusy(false)
    if (failed) setError(failed)
    else onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const bad = validate?.() ?? null
    if (bad) return setError(bad)
    void run(onSubmit)
  }

  return (
    <DialogContent placement="center" className="p-5">
      <form noValidate onSubmit={submit} className="grid gap-3.5 text-xs">
        <DialogTitle className="text-[13px] font-semibold">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {children}
        {remove && deleting ? (
          <div
            role="group"
            aria-label={remove.group}
            className="flex flex-wrap items-center gap-2 rounded-xl border bg-raised px-3.5 py-2.5"
          >
            <p className="mr-auto">{remove.ask}</p>
            <Button type="button" variant="ghost" onClick={() => setDeleting(false)}>
              Keep it
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(remove.run)}>
              {remove.confirm}
            </Button>
          </div>
        ) : null}
        <Footer
          busy={busy}
          error={error}
          save={save}
          onClose={onClose}
          extra={
            remove &&
            !deleting && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive"
                onClick={() => setDeleting(true)}
              >
                {remove.label}
              </Button>
            )
          }
        />
      </form>
    </DialogContent>
  )
}

/** A one-line field. `hint` says what it is for, under it. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  autoFocus,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  autoFocus?: boolean
  type?: "text" | "email"
}) {
  return (
    <div className="grid gap-1">
      <Labelled label={label}>
        <input
          autoFocus={autoFocus}
          type={type}
          className={FIELD}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          // The API checks an address itself, in its own words; the browser's would double it.
          {...(type === "email" ? { spellCheck: false } : {})}
        />
      </Labelled>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A several-line field. */
export function TextArea({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <div className="grid gap-1">
      <Labelled label={label}>
        <textarea
          className={`${FIELD} min-h-20`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Labelled>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

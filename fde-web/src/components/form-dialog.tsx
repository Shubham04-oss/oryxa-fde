import { createContext, useContext, useId, useRef, useState } from "react"
import type { FormEvent, ReactNode, Ref } from "react"
import { Button } from "./ui/button"
import { DialogContent, DialogDescription, DialogTitle } from "./ui/dialog"
import { FIELD, Footer, Labelled } from "./task-move"
import { isHeld } from "@/lib/records"
import type { HELD, Problem } from "@/lib/records"

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

/** The form's current problem and where a field finds it: a field it is about is marked and described by it. */
const FormProblem = createContext<{ field?: string; id: string }>({ id: "" })

/** What a field says about itself to a screen reader when the form's problem is about it. */
function problemOf(
  name: string | undefined,
  current: { field?: string; id: string },
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  const about = name !== undefined && current.field === name
  return about ? { "aria-invalid": true, "aria-describedby": current.id } : {}
}

/** What a field of your own says about itself to a screen reader when the form's problem is about it. */
export function useFieldProblem(name: string) {
  return problemOf(name, useContext(FormProblem))
}

export function FormDialog({
  title,
  description,
  save,
  validate,
  onSubmit,
  remove,
  onClose,
  onCancel,
  wide,
  after,
  notice,
  children,
}: {
  title: string
  /** Read by a screen reader only. */
  description: string
  /** The Save button's words. */
  save: string
  /** What is wrong before anything is sent, in words, or null. The API checks again. */
  validate?: () => Problem | null
  /**
   * Null when the API confirmed the save, or why it did not. A problem that names a field marks it.
   * `HELD` when nothing was saved and the form (`notice`) says why.
   */
  onSubmit: () => Promise<Problem | typeof HELD | null>
  remove?: Removal
  /** Closes the dialog: after a save the API confirmed, and by default for Cancel. */
  onClose: () => void
  /** What Cancel does, when it should ask first (a note with words in it). */
  onCancel?: () => void
  /** A page-wide form, for writing: 720px instead of 560px. */
  wide?: boolean
  /**
   * Dialogs this one opens, kept inside it so the browser treats them as nested: the first stays
   * where it is, with everything typed in it, and Escape closes the top one only. Outside the
   * `<form>`, because a submit in a nested form would otherwise reach this one.
   */
  after?: ReactNode
  /** Said above the buttons, in the form: a save the API held back because the record moved on. */
  notice?: ReactNode
  children: ReactNode
}) {
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const errorId = useId()

  /** Shows a problem; one about a field takes focus to it, so the keyboard and a screen reader land where it is. */
  function show(problem: Problem) {
    const next = typeof problem === "string" ? { message: problem } : problem
    setError(next)
    if ("field" in next && next.field) {
      const field = next.field
      requestAnimationFrame(() =>
        form.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)?.focus(),
      )
    }
  }

  async function run(work: () => Promise<Problem | typeof HELD | null>) {
    setBusy(true)
    const failed = await work()
    setBusy(false)
    if (isHeld(failed)) setError(null)
    else if (failed) show(failed)
    else onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const bad = validate?.() ?? null
    if (bad) return show(bad)
    void run(onSubmit)
  }

  return (
    <DialogContent
      placement="center"
      className={wide ? "w-[min(720px,calc(100vw-32px))] p-5" : "p-5"}
    >
      <form ref={form} noValidate onSubmit={submit} className="grid gap-3.5 text-xs">
        <DialogTitle className="text-[13px] font-semibold">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {/* The notice is in the problem's reach too: a sign-off's confirmation is a field in it. */}
        <FormProblem value={{ field: error?.field, id: errorId }}>
          {children}
          {notice}
        </FormProblem>
        {remove && deleting ? (
          <div
            role="group"
            aria-label={remove.group}
            className="flex flex-wrap items-center gap-2 rounded-xl border bg-raised px-3.5 py-2.5"
          >
            <p className="mr-auto">{remove.ask}</p>
            {/* The button that asked is gone: focus lands on the safe answer. */}
            <Button type="button" variant="ghost" autoFocus onClick={() => setDeleting(false)}>
              Keep it
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(remove.run)}>
              {remove.confirm}
            </Button>
          </div>
        ) : null}
        <Footer
          busy={busy}
          error={error?.message ?? null}
          errorId={errorId}
          save={save}
          onClose={onCancel ?? onClose}
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
      {after}
    </DialogContent>
  )
}

/** A one-line field. `hint` says what it is for, under it. `name` is what a problem about it is called. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  autoFocus,
  name,
  type = "text",
  inputMode,
  max,
  list,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  autoFocus?: boolean
  name?: string
  type?: "text" | "email" | "date"
  /** The keyboard a phone shows, for a number typed as text so the API's own check reads it. */
  inputMode?: "decimal"
  /** The latest a date can be, `YYYY-MM-DD`. */
  max?: string
  /** The id of a `<datalist>` of suggestions. */
  list?: string
}) {
  const problem = problemOf(name, useContext(FormProblem))
  const hintId = useId()
  return (
    <div className="grid gap-1">
      <Labelled label={label}>
        <input
          autoFocus={autoFocus}
          type={type}
          inputMode={inputMode}
          max={max}
          list={list}
          data-field={name}
          className={FIELD}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          // The API checks an address itself, in its own words; the browser's would double it.
          {...(type === "email" ? { spellCheck: false } : {})}
          {...problem}
          aria-describedby={describedBy(problem, hint && hintId)}
        />
      </Labelled>
      {hint && (
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

/** A several-line field. */
export function TextArea({
  label,
  value,
  onChange,
  hint,
  autoFocus,
  tall,
  large,
  name,
  inputRef,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  autoFocus?: boolean
  /** More room, for text that runs to several lines. */
  tall?: boolean
  /** The most room, for writing: about half the screen, and the person can pull it taller. */
  large?: boolean
  name?: string
  /** For a form that reads the selection or the caret. */
  inputRef?: Ref<HTMLTextAreaElement>
}) {
  const problem = problemOf(name, useContext(FormProblem))
  const hintId = useId()
  return (
    <div className="grid gap-1">
      <Labelled label={label}>
        <textarea
          ref={inputRef}
          autoFocus={autoFocus}
          data-field={name}
          className={`${FIELD} ${large ? "min-h-[clamp(14rem,42dvh,26rem)] leading-relaxed" : tall ? "min-h-36" : "min-h-20"}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...problem}
          aria-describedby={describedBy(problem, hint && hintId)}
        />
      </Labelled>
      {hint && (
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

/** A pick from a list: `children` are its `<option>`s. */
export function SelectField({
  label,
  value,
  onChange,
  hint,
  name,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  name?: string
  children: ReactNode
}) {
  const problem = problemOf(name, useContext(FormProblem))
  const hintId = useId()
  return (
    <div className="grid gap-1">
      <Labelled label={label}>
        <select
          data-field={name}
          className={FIELD}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...problem}
          aria-describedby={describedBy(problem, hint && hintId)}
        >
          {children}
        </select>
      </Labelled>
      {hint && (
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

/** The hint, and the problem when the field has one, for a screen reader to read with the field. */
function describedBy(problem: { "aria-describedby"?: string }, hint: string | undefined | "") {
  const ids = [hint, problem["aria-describedby"]].filter(Boolean)
  return ids.length ? ids.join(" ") : undefined
}

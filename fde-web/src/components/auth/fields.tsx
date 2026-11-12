import { Link } from "@tanstack/react-router"
import { useId, useState, useSyncExternalStore } from "react"
import type { FormEvent, ReactNode, Ref } from "react"
import { Button, buttonVariants } from "../ui/button"
import type { Step } from "./flow"

// The sign-in screens' controls: plain, large enough to tap, every one labelled, on the same tokens
// as the workspace's fields. Restyle them here.

const INPUT =
  "h-11 w-full min-w-0 rounded-field border bg-raised px-3.5 text-body text-foreground outline-none transition-[border-color,box-shadow] duration-150 hover:border-strong focus-visible:border-tint/60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-tint/12 aria-invalid:border-destructive read-only:text-muted-foreground read-only:hover:border-border"

type FieldProps = {
  ref?: Ref<HTMLInputElement>
  label: string
  value: string
  onChange?: (value: string) => void
  /** Why the value was refused, under the field. */
  error?: string
  hint?: string
  name: string
  type?: "text" | "email" | "password"
  /** What a password manager or the browser fills here. */
  autoComplete: string
  inputMode?: "numeric" | "email" | "text"
  autoFocus?: boolean
  readOnly?: boolean
  maxLength?: number
  /** Something after the label, on its line: "Forgotten password?". */
  aside?: ReactNode
  /** Something inside the field's row, after it: the show-password button. */
  after?: ReactNode
}

/** A labelled one-line field. Its error and hint are read with it by a screen reader. */
export function Field({
  ref,
  label,
  value,
  onChange,
  error,
  hint,
  name,
  type = "text",
  autoComplete,
  inputMode,
  autoFocus,
  readOnly,
  maxLength,
  aside,
  after,
}: FieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error && errorId, hint && hintId].filter(Boolean).join(" ") || undefined
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-meta font-medium text-soft">
          {label}
        </label>
        {aside}
      </div>
      <div className="flex gap-2">
        <input
          ref={ref}
          id={id}
          name={name}
          type={type}
          className={INPUT}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          autoComplete={autoComplete}
          inputMode={inputMode}
          autoFocus={autoFocus}
          readOnly={readOnly}
          maxLength={maxLength}
          autoCapitalize={type === "text" && inputMode !== "numeric" ? undefined : "none"}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {after}
      </div>
      {error && (
        <p id={errorId} className="text-meta text-destructive">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="text-micro text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

/**
 * A password field with a show and hide button. The value lives only in the screen's state: it is
 * never put in the address, storage, a log or an error.
 */
export function PasswordField(props: Omit<FieldProps, "type" | "after" | "inputMode">) {
  const [shown, setShown] = useState(false)
  return (
    <Field
      {...props}
      type={shown ? "text" : "password"}
      after={
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4 text-meta"
          aria-pressed={shown}
          aria-label={shown ? "Hide password" : "Show password"}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? "Hide" : "Show"}
        </Button>
      }
    />
  )
}

/**
 * A sign-in form. It cannot be sent before the page's script has run: `Submit` is disabled until
 * then, so a password never goes anywhere but the API's sign-in routes (ADR 0007). `method="post"`
 * is a second guard: were it ever sent natively, the fields would go in a body, never the address.
 */
export function AuthForm({
  label,
  onSubmit,
  children,
}: {
  label: string
  onSubmit: () => void
  children: ReactNode
}) {
  return (
    <form
      method="post"
      aria-label={label}
      noValidate
      className="grid gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {children}
    </form>
  )
}

const noSubscribe = () => () => {}

/**
 * False in the server's markup and while React hydrates it, true once the page's script runs. The
 * server snapshot is what hydration uses, so the first client render matches the server's.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
}

/**
 * The form's main button. Disabled until the page's script runs, so the form cannot be sent natively
 * before `onSubmit` handles it (pressing Enter in a field does nothing while the default button is
 * disabled). While working it says so and cannot be pressed twice.
 */
export function Submit({
  working,
  children,
  busy,
}: {
  working: boolean
  children: ReactNode
  /** What it says while working: "Signing in…". */
  busy: string
}) {
  const hydrated = useHydrated()
  return (
    <Button type="submit" className="h-11 w-full text-[13px]" disabled={working || !hydrated}>
      {working ? busy : children}
    </Button>
  )
}

/** A second way on, as a full-width outline button. */
export function Secondary({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 w-full text-[13px]"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/** A refusal for the whole form, announced when it appears. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="text-meta text-destructive">
      {children}
    </div>
  )
}

/** A confirmation, announced when it appears. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-field bg-tint-soft px-4 py-3 text-meta text-foreground">
      {children}
    </p>
  )
}

/** A link to another sign-in step, keeping where the person was going. */
export function StepLink({
  step,
  returnTo,
  button = false,
  children,
}: {
  step: Step
  returnTo: string
  /** Drawn as the screen's main button, for a screen whose only way on it is. */
  button?: boolean
  children: ReactNode
}) {
  return (
    <Link
      to="/sign-in"
      search={{ return_to: returnTo, ...(step === "password" ? {} : { step }) }}
      className={
        button
          ? buttonVariants({ className: "h-11 w-full text-[13px]" })
          : "justify-self-start rounded-sm text-meta text-soft underline decoration-strong underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
      }
    >
      {children}
    </Link>
  )
}

/** "or", between two ways to sign in. */
export function Or() {
  return (
    <div className="flex items-center gap-3 text-micro text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
      or
    </div>
  )
}

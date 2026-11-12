import { useId, useLayoutEffect, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { Button } from "../ui/button"
import { Icon } from "../ui/icon"
import type { IconName } from "../ui/icon"
import { Proof, StepMeta, StepNumber } from "./blocks"
import { companyProblem } from "@/lib/records"
import type { CompanyFields } from "@/lib/records"
import { Email, INVITE_ROLES, PlanStepItem } from "@/lib/workspace/blocks"
import type { InviteRole, PlanStep, Verdict } from "@/lib/workspace/blocks"
import {
  APPROACHES,
  APPROVERS,
  ROLE_LABEL,
  RULES,
  VERDICT_LABEL,
  defaultRules,
} from "@/lib/workspace/new-company"
import type { Answers, Invite } from "@/lib/workspace/new-company"
import { cn } from "@/lib/utils"

// The answer to each step of the new-company conversation (issue #209). Each form keeps what is
// typed until its Continue, then hands one answer up; nothing here saves or sends anything.

const INPUT =
  "w-full rounded-field border bg-raised px-3.5 text-body text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-strong focus-visible:border-tint/60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-tint/12 aria-invalid:border-destructive"

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode
}) {
  const id = useId()
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ")
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-meta font-medium text-soft">
        {label}
      </label>
      {children({
        id,
        ...(described ? { "aria-describedby": described } : {}),
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-micro text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-micro text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The card an answer is given in, and its one primary action. */
function AnswerCard({
  onSubmit,
  label,
  children,
  submit = "Continue",
  skip,
  problem,
}: {
  onSubmit: () => void
  /** What the form is called to a screen reader: the question. */
  label: string
  children: ReactNode
  submit?: string
  skip?: () => void
  problem?: string
}) {
  function send(event: FormEvent) {
    event.preventDefault()
    onSubmit()
  }
  return (
    <form
      aria-label={label}
      noValidate
      onSubmit={send}
      className="grid gap-6 rounded-card border bg-canvas p-6 shadow-lift motion-safe:animate-settle max-[560px]:p-4"
    >
      {children}
      {problem && (
        <p role="alert" className="text-meta text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-5">
        {skip && (
          <Button type="button" variant="ghost" size="lg" onClick={skip}>
            Skip for now
          </Button>
        )}
        <Button type="submit" size="lg">
          {submit}
          <Icon name="arrow-right" size={15} strokeWidth={2} />
        </Button>
      </div>
    </form>
  )
}

export function CompanyForm({
  label,
  initial,
  onAnswer,
}: {
  label: string
  initial: CompanyFields | null
  onAnswer: (fields: CompanyFields) => void
}) {
  const [f, setF] = useState<CompanyFields>(
    initial ?? { name: "", industry: "", region: "", summary: "" },
  )
  const [problem, setProblem] = useState("")
  const set = (patch: Partial<CompanyFields>) => setF({ ...f, ...patch })
  const nameMissing = problem !== "" && !f.name.trim()

  return (
    <AnswerCard
      label={label}
      problem={nameMissing ? undefined : problem}
      onSubmit={() => {
        const bad = companyProblem(f)
        if (bad) return setProblem(bad)
        setProblem("")
        onAnswer(f)
      }}
    >
      <Field label="Company name" error={nameMissing ? problem : undefined}>
        {(props) => (
          <input
            {...props}
            autoComplete="organization"
            value={f.name}
            onChange={(e) => set({ name: e.target.value })}
            className={cn(INPUT, "h-11")}
          />
        )}
      </Field>
      <Field
        label="What are you delivering?"
        hint="A sentence or two, such as: automate claims intake for their freight team."
      >
        {(props) => (
          <textarea
            {...props}
            rows={3}
            value={f.summary}
            onChange={(e) => set({ summary: e.target.value })}
            className={cn(INPUT, "min-h-24 resize-y py-2.5")}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
        <Field label="Industry" hint="Optional.">
          {(props) => (
            <input
              {...props}
              value={f.industry}
              onChange={(e) => set({ industry: e.target.value })}
              className={cn(INPUT, "h-11")}
            />
          )}
        </Field>
        <Field label="Region" hint="Optional. Such as UK or EMEA.">
          {(props) => (
            <input
              {...props}
              value={f.region}
              onChange={(e) => set({ region: e.target.value })}
              className={cn(INPUT, "h-11")}
            />
          )}
        </Field>
      </div>
    </AnswerCard>
  )
}

/** A radio choice drawn as a card: the native radio stays, so arrows and Space work. */
function ChoiceCard({
  name,
  checked,
  onChange,
  title,
  detail,
}: {
  name: string
  checked: boolean
  onChange: () => void
  title: string
  detail: string
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-field border p-4 transition-[border-color,background-color,box-shadow] duration-150 hover:border-strong has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-tint/12",
        checked && "border-tint/60 bg-tint-soft/50 hover:border-tint/60",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-4 flex-none place-items-center rounded-full border border-strong bg-canvas transition-colors",
          checked && "border-tint",
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full bg-tint transition-transform",
            checked ? "scale-100" : "scale-0",
          )}
        />
      </span>
      <span className="grid gap-0.5">
        <span className="text-body font-medium">{title}</span>
        <span className="text-meta text-muted-foreground">{detail}</span>
      </span>
    </label>
  )
}

export function StartForm({
  label,
  initial,
  onAnswer,
}: {
  label: string
  initial: Answers["start"]
  onAnswer: (start: NonNullable<Answers["start"]>) => void
}) {
  const [s, setS] = useState<NonNullable<Answers["start"]>>(
    initial ?? { approach: "talk", contact: "", criterion: "" },
  )
  const [problem, setProblem] = useState("")
  const name = useId()
  return (
    <AnswerCard
      label={label}
      problem={problem}
      onSubmit={() => {
        if (s.contact.trim().length > 120 || s.criterion.trim().length > 200)
          return setProblem("Keep the contact under 120 characters and the criterion under 200.")
        setProblem("")
        onAnswer({ ...s, contact: s.contact.trim(), criterion: s.criterion.trim() })
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="sr-only">First move</legend>
        {APPROACHES.map((a) => (
          <ChoiceCard
            key={a.id}
            name={name}
            checked={s.approach === a.id}
            onChange={() => setS({ ...s, approach: a.id })}
            title={a.label}
            detail={a.detail}
          />
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
        <Field label="Main contact at the company" hint="Optional. The plan names them.">
          {(props) => (
            <input
              {...props}
              value={s.contact}
              onChange={(e) => setS({ ...s, contact: e.target.value })}
              className={cn(INPUT, "h-11")}
            />
          )}
        </Field>
        <Field
          label="What would show it worked?"
          hint="Optional. Becomes a success criterion, such as: claims triaged within two hours."
        >
          {(props) => (
            <input
              {...props}
              value={s.criterion}
              onChange={(e) => setS({ ...s, criterion: e.target.value })}
              className={cn(INPUT, "h-11")}
            />
          )}
        </Field>
      </div>
    </AnswerCard>
  )
}

/** A small set of radios drawn as one pill: the choice for a rule, or who approves. */
function Segmented<T extends string>({
  legend,
  options,
  value,
  onChange,
  hideLegend,
}: {
  legend: string
  options: ReadonlyArray<{ id: T; label: string }>
  value: T
  onChange: (value: T) => void
  hideLegend?: boolean
}) {
  const name = useId()
  return (
    <fieldset className="contents">
      <legend className={hideLegend ? "sr-only" : "mb-2 text-meta font-medium text-soft"}>
        {legend}
      </legend>
      <span className="inline-flex flex-none rounded-full border bg-raised p-0.5">
        {options.map((o) => (
          <label
            key={o.id}
            className={cn(
              "cursor-pointer rounded-full px-3 py-1 text-micro font-medium text-muted-foreground transition-colors select-none hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tint/40",
              value === o.id && "bg-canvas text-foreground shadow-[0_1px_2px_var(--border-strong)]",
            )}
          >
            <input
              type="radio"
              name={name}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </span>
    </fieldset>
  )
}

const VERDICT_OPTIONS = (["allowed", "ask", "never"] as const).map((id) => ({
  id,
  label: VERDICT_LABEL[id],
}))

export function RulesForm({
  label,
  initial,
  onAnswer,
}: {
  label: string
  initial: Answers["rules"]
  onAnswer: (rules: NonNullable<Answers["rules"]>) => void
}) {
  const [r, setR] = useState(initial ?? defaultRules())
  return (
    <AnswerCard label={label} onSubmit={() => onAnswer(r)}>
      <ul className="grid divide-y">
        {RULES.map((rule) => (
          <li
            key={rule.id}
            className="flex items-center justify-between gap-4 py-3 first:pt-0 max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-2"
          >
            <span className="grid gap-0.5">
              <span className="text-body">{rule.action}</span>
              {rule.locked && (
                <span className="text-micro text-muted-foreground">{rule.locked}</span>
              )}
            </span>
            {rule.locked ? (
              <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-micro text-muted-foreground">
                {VERDICT_LABEL[rule.verdict]}
                <span className="sr-only">, fixed</span>
              </span>
            ) : (
              <Segmented<Verdict>
                legend={rule.action}
                hideLegend
                options={VERDICT_OPTIONS}
                value={r.verdicts[rule.id] ?? rule.verdict}
                onChange={(v) => setR({ ...r, verdicts: { ...r.verdicts, [rule.id]: v } })}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="grid justify-items-start">
        <Segmented
          legend="Who approves when an agent asks?"
          options={APPROVERS}
          value={r.approver}
          onChange={(approver) => setR({ ...r, approver })}
        />
      </div>
    </AnswerCard>
  )
}

const ROLE_OPTIONS = INVITE_ROLES.map((id) => ({ id, label: ROLE_LABEL[id] }))

export function PeopleForm({
  label,
  initial,
  onAnswer,
}: {
  label: string
  initial: Answers["people"]
  onAnswer: (people: Array<Invite>) => void
}) {
  const [rows, setRows] = useState<Array<Invite>>(
    initial && initial.length > 0 ? initial : [{ email: "", role: "engineer" }],
  )
  const [bad, setBad] = useState<Array<number>>([])
  const [problem, setProblem] = useState("")
  const lastEmail = useRef<HTMLInputElement>(null)
  const added = useRef(false)

  useLayoutEffect(() => {
    if (added.current) lastEmail.current?.focus()
    added.current = false
  }, [rows.length])

  function submit() {
    const filled = rows
      .map((row, i) => ({ ...row, email: row.email.trim(), i }))
      .filter((row) => row.email)
    const wrong = filled.filter((row) => !Email.safeParse(row.email).success).map((row) => row.i)
    const seen = new Set<string>()
    const twice = filled
      .filter((row) => seen.size === seen.add(row.email.toLowerCase()).size)
      .map((row) => row.i)
    if (wrong.length > 0 || twice.length > 0) {
      setBad([...wrong, ...twice])
      return setProblem(wrong.length > 0 ? "Check the marked addresses." : "Each address once.")
    }
    setBad([])
    setProblem("")
    onAnswer(filled.map(({ email, role }) => ({ email, role })))
  }

  return (
    <AnswerCard label={label} problem={problem} onSubmit={submit} skip={() => onAnswer([])}>
      <ul className="grid gap-2">
        {rows.map((row, i) => (
          <li key={i} className="flex items-center gap-2 max-[560px]:flex-wrap">
            <input
              ref={i === rows.length - 1 ? lastEmail : undefined}
              type="email"
              autoComplete="off"
              aria-label={`Email of person ${i + 1}`}
              aria-invalid={bad.includes(i) || undefined}
              value={row.email}
              onChange={(e) =>
                setRows(rows.map((r, j) => (j === i ? { ...r, email: e.target.value } : r)))
              }
              placeholder="name@example.com"
              className={cn(INPUT, "h-10 min-w-0 flex-1 max-[560px]:basis-full")}
            />
            <select
              aria-label={`Role of person ${i + 1}`}
              value={row.role}
              onChange={(e) =>
                setRows(
                  rows.map((r, j) => (j === i ? { ...r, role: e.target.value as InviteRole } : r)),
                )
              }
              className={cn(INPUT, "h-10 w-auto flex-none pr-8 max-[560px]:flex-1")}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <IconButton
              icon="close"
              label={`Remove person ${i + 1}`}
              onClick={() =>
                setRows(
                  rows.length === 1
                    ? [{ email: "", role: "engineer" }]
                    : rows.filter((_, j) => j !== i),
                )
              }
            />
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="ghost"
          disabled={rows.length >= 20}
          onClick={() => {
            added.current = true
            setRows([...rows, { email: "", role: "engineer" }])
          }}
        >
          <Icon name="user-plus" size={15} />
          Add a person
        </Button>
      </div>
    </AnswerCard>
  )
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  className,
  ...data
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
  "data-move"?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-8 flex-none place-items-center rounded-full text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-selected hover:text-foreground disabled:pointer-events-none disabled:opacity-30 motion-safe:active:scale-[0.92]",
        className,
      )}
      {...data}
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

let added = 0
const STEP_TITLE = PlanStepItem.shape.title

/**
 * The plan the workspace proposed, for the FDE to change: reorder, rename, add and remove steps.
 * Every change is local until Continue; the summary beside it shows the draft as it goes.
 */
export function PlanForm({
  label,
  steps,
  onChange,
  onAnswer,
}: {
  label: string
  steps: Array<PlanStep>
  onChange: (steps: Array<PlanStep>) => void
  onAnswer: (steps: Array<PlanStep>) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [newTitle, setNewTitle] = useState("")
  const [problem, setProblem] = useState("")
  const [said, setSaid] = useState("")
  const rows = useRef(new Map<string, HTMLLIElement>())
  const tops = useRef(new Map<string, number>())
  const refocus = useRef<{ id: string; move: "up" | "down" } | null>(null)

  // Steps glide to their new place when the order changes (FLIP); not under reduced motion.
  useLayoutEffect(() => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    for (const [id, el] of rows.current) {
      const top = el.getBoundingClientRect().top
      const before = tops.current.get(id)
      if (!calm && before !== undefined && before !== top && typeof el.animate === "function")
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], {
          duration: 220,
          easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
        })
      tops.current.set(id, top)
    }
    // Moving a row moves its button in the page, which loses focus: put it back.
    const want = refocus.current
    refocus.current = null
    if (want) {
      const row = rows.current.get(want.id)
      const button =
        row?.querySelector<HTMLButtonElement>(`[data-move="${want.move}"]:not(:disabled)`) ??
        row?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)")
      button?.focus()
    }
  }, [steps])

  function move(i: number, by: -1 | 1) {
    const j = i + by
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    const [step] = next.splice(i, 1)
    next.splice(j, 0, step!)
    refocus.current = { id: step!.id, move: by < 0 ? "up" : "down" }
    onChange(next)
    setSaid(`Moved “${step!.title}” to step ${j + 1} of ${steps.length}.`)
  }

  function rename(id: string) {
    const title = STEP_TITLE.safeParse(draftTitle)
    if (!title.success)
      return setProblem("A step needs a name of up to 120 characters on one line.")
    setProblem("")
    onChange(steps.map((s) => (s.id === id ? { ...s, title: title.data } : s)))
    setRenaming(null)
  }

  function add() {
    const title = STEP_TITLE.safeParse(newTitle)
    if (!title.success) return setProblem("Name the step first, up to 120 characters on one line.")
    if (steps.length >= 12) return setProblem("A plan holds up to 12 steps.")
    setProblem("")
    // A new step sits on the stage of the last one, as a task added at the end of the plan would.
    const stage = steps.at(-1)?.stage ?? "discover"
    onChange([...steps, { id: `added_${++added}`, title: title.data, stage }])
    setNewTitle("")
    setSaid(`Added “${title.data}” as step ${steps.length + 1}.`)
  }

  return (
    <AnswerCard
      label={label}
      problem={problem}
      submit="Use this plan"
      onSubmit={() => {
        if (renaming) return setProblem("Finish renaming the step first.")
        if (steps.length === 0) return setProblem("A plan needs at least one step.")
        setProblem("")
        onAnswer(steps)
      }}
    >
      <ol aria-label="Plan" className="grid">
        {steps.map((step, i) => (
          <li
            key={step.id}
            ref={(el) => {
              if (el) rows.current.set(step.id, el)
              else rows.current.delete(step.id)
            }}
            className="group relative -mx-2 flex items-start gap-3 rounded-field px-2 py-2.5 transition-colors hover:bg-card max-[560px]:flex-wrap max-[560px]:gap-y-1"
          >
            <span className="pt-0.5">
              <StepNumber n={i + 1} />
            </span>
            {renaming === step.id ? (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  autoFocus
                  aria-label={`Name of step ${i + 1}`}
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      rename(step.id)
                    }
                    if (e.key === "Escape") {
                      e.preventDefault()
                      setRenaming(null)
                      setProblem("")
                    }
                  }}
                  className={cn(INPUT, "h-9 min-w-0 flex-1")}
                />
                <Button type="button" variant="outline" onClick={() => rename(step.id)}>
                  Save
                </Button>
              </span>
            ) : (
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-body break-words">{step.title}</span>
                <StepMeta step={step} />
                {step.criterion && <Proof criterion={step.criterion} />}
              </span>
            )}
            {renaming !== step.id && (
              <span className="flex flex-none items-center opacity-100 transition-opacity duration-150 max-[560px]:-my-1 max-[560px]:basis-full max-[560px]:pl-7 pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100">
                <IconButton
                  icon="chevron-up"
                  data-move="up"
                  label={`Move “${step.title}” up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                />
                <IconButton
                  icon="chevron-down"
                  data-move="down"
                  label={`Move “${step.title}” down`}
                  disabled={i === steps.length - 1}
                  onClick={() => move(i, 1)}
                />
                <IconButton
                  icon="pencil"
                  label={`Rename “${step.title}”`}
                  onClick={() => {
                    setDraftTitle(step.title)
                    setRenaming(step.id)
                  }}
                />
                <IconButton
                  icon="close"
                  label={`Remove “${step.title}”`}
                  onClick={() => {
                    onChange(steps.filter((s) => s.id !== step.id))
                    setSaid(`Removed “${step.title}”.`)
                  }}
                />
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2">
        <input
          aria-label="New step"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          placeholder="Add a step"
          className={cn(INPUT, "h-10 min-w-0 flex-1")}
        />
        <Button type="button" variant="outline" disabled={!newTitle.trim()} onClick={add}>
          <Icon name="plus" size={14} />
          Add
        </Button>
      </div>
      <p role="status" className="sr-only">
        {said}
      </p>
    </AnswerCard>
  )
}

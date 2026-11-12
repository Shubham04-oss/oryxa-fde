import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { Button } from "../ui/button"
import { Icon } from "../ui/icon"
import type { IconName } from "../ui/icon"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu"
import { Proof, StepMeta, StepNumber } from "./blocks"
import { checkName, companyProblem } from "@/lib/records"
import { COMPARATOR_LABEL, criterionProblem, inUnit, measure, targetOf } from "@/lib/scope"
import type { Comparator, CriterionFields } from "@/lib/scope"
import { Email, INVITE_ROLES, PlanStepItem } from "@/lib/workspace/blocks"
import type { InviteRole, PlanStep, Verdict } from "@/lib/workspace/blocks"
import {
  APPROACHES,
  APPROVERS,
  MAX_STEP_PROOF,
  NO_CRITERION,
  ROLE_LABEL,
  RULES,
  VERDICT_LABEL,
  defaultRules,
} from "@/lib/workspace/new-company"
import type { Answers, CompanyAnswer, Invite, StartAnswer } from "@/lib/workspace/new-company"
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
  initial: CompanyAnswer | null
  onAnswer: (fields: CompanyAnswer) => void
}) {
  const [f, setF] = useState<CompanyAnswer>(
    initial ?? { name: "", project: "", industry: "", region: "", summary: "" },
  )
  const [problem, setProblem] = useState("")
  const set = (patch: Partial<CompanyAnswer>) => setF({ ...f, ...patch })
  const nameMissing = problem !== "" && !f.name.trim()
  const projectMissing = problem !== "" && !nameMissing && !f.project.trim()

  return (
    <AnswerCard
      label={label}
      problem={nameMissing || projectMissing ? undefined : problem}
      onSubmit={() => {
        const bad =
          companyProblem(f) ??
          (f.project.trim()
            ? checkName(f.project, "invalid_name", true)
            : "Name the first project.")
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
        label="First project"
        hint="What the work is called, such as: Claims intake."
        error={projectMissing ? problem : undefined}
      >
        {(props) => (
          <input
            {...props}
            value={f.project}
            onChange={(e) => set({ project: e.target.value })}
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
          // The muted ink, not the border colour: an unchosen circle must be seen (3:1 or more).
          "mt-0.5 grid size-4 flex-none place-items-center rounded-full border-[1.5px] border-muted-foreground bg-canvas transition-colors",
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

/** What a start answer may hold, checked as the API checks a criterion, before anything is sent. */
export function startProblem(s: StartAnswer) {
  if ([...s.contact.trim()].length > 120 || [...s.criterion.description.trim()].length > 200)
    return "Keep the contact under 120 characters and the criterion under 200."
  if (s.contact.trim() && checkName(s.contact, "invalid_name", true))
    return "The main contact's name is one line of plain text."
  if (!s.criterion.description.trim()) return null
  if ([...s.criterion.proof.trim()].length > MAX_STEP_PROOF)
    return `Say how it will be proven in up to ${MAX_STEP_PROOF} characters.`
  return criterionProblem(s.criterion)
}

export function StartForm({
  label,
  initial,
  onAnswer,
}: {
  label: string
  initial: Answers["start"]
  onAnswer: (start: StartAnswer) => void
}) {
  const [s, setS] = useState<StartAnswer>(
    initial ?? { approach: "talk", contact: "", criterion: NO_CRITERION },
  )
  const [problem, setProblem] = useState("")
  const name = useId()
  const c = s.criterion
  const setCriterion = (patch: Partial<CriterionFields>) =>
    setS({ ...s, criterion: { ...c, ...patch } })
  const named = c.description.trim() !== ""
  const target = targetOf(c.target)
  const baseline = targetOf(c.baseline)
  // The optional baseline and proof are a step away, so the step stays short on a phone; once open,
  // or once either holds something, they stay in view, so nothing typed is ever hidden.
  const [more, setMore] = useState(Boolean(c.baseline.trim() || c.proof.trim()))
  const baselineBox = useRef<HTMLInputElement>(null)
  const opening = useRef(false)
  useEffect(() => {
    if (more && opening.current) baselineBox.current?.focus()
    opening.current = false
  }, [more])
  return (
    <AnswerCard
      label={label}
      problem={problem}
      onSubmit={() => {
        const bad = startProblem(s)
        if (bad) return setProblem(bad)
        setProblem("")
        // A criterion left blank is none: what was typed under it goes with it.
        const criterion: CriterionFields = named
          ? {
              description: c.description.trim(),
              metric: c.metric.trim(),
              comparator: c.comparator,
              target: c.target.trim(),
              unit: c.unit.trim(),
              baseline: c.baseline.trim(),
              proof: c.proof.trim(),
            }
          : NO_CRITERION
        onAnswer({ ...s, contact: s.contact.trim(), criterion })
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
              value={c.description}
              onChange={(e) => setCriterion({ description: e.target.value })}
              className={cn(INPUT, "h-11")}
            />
          )}
        </Field>
      </div>
      {named && (
        // A criterion is measured: the API keeps it only with what is measured and its target.
        <fieldset className="grid gap-4 rounded-field border bg-card p-4 motion-safe:animate-settle max-[560px]:p-3">
          <legend className="px-1 text-meta font-medium text-soft">How it is measured</legend>
          <Field label="What is measured" hint="Such as hours from a claim arriving to its triage.">
            {(props) => (
              <input
                {...props}
                value={c.metric}
                onChange={(e) => setCriterion({ metric: e.target.value })}
                className={cn(INPUT, "h-11")}
              />
            )}
          </Field>
          {/* On a phone the comparison takes the row, and the target and unit share the next. */}
          <div className="grid grid-cols-3 items-start gap-4 max-[560px]:grid-cols-2 max-[560px]:[&>:first-child]:col-span-2">
            <Field label="It passes when it is">
              {(props) => (
                <select
                  {...props}
                  value={c.comparator}
                  onChange={(e) => setCriterion({ comparator: e.target.value as Comparator })}
                  className={cn(INPUT, "h-11 pr-8")}
                >
                  {(Object.keys(COMPARATOR_LABEL) as Array<Comparator>).map((k) => (
                    <option key={k} value={k}>
                      {COMPARATOR_LABEL[k]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Target">
              {(props) => (
                <input
                  {...props}
                  inputMode="decimal"
                  value={c.target}
                  onChange={(e) => setCriterion({ target: e.target.value })}
                  className={cn(INPUT, "h-11")}
                />
              )}
            </Field>
            <Field label="Unit" hint="Optional. Such as % or h.">
              {(props) => (
                <input
                  {...props}
                  value={c.unit}
                  onChange={(e) => setCriterion({ unit: e.target.value })}
                  className={cn(INPUT, "h-11")}
                />
              )}
            </Field>
          </div>
          {more ? (
            <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
              <Field label="Baseline" hint="Optional. Measured before the work, in the same unit.">
                {(props) => (
                  <input
                    {...props}
                    ref={baselineBox}
                    inputMode="decimal"
                    value={c.baseline}
                    onChange={(e) => setCriterion({ baseline: e.target.value })}
                    className={cn(INPUT, "h-11")}
                  />
                )}
              </Field>
              <Field
                label="How we will prove it"
                hint="Optional. Such as: an eval on sample data, run against the baseline."
              >
                {(props) => (
                  <input
                    {...props}
                    value={c.proof}
                    onChange={(e) => setCriterion({ proof: e.target.value })}
                    className={cn(INPUT, "h-11")}
                  />
                )}
              </Field>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                opening.current = true
                setMore(true)
              }}
              className="inline-flex items-center gap-1.5 justify-self-start rounded-sm text-meta font-medium text-soft underline decoration-strong underline-offset-4 transition-colors hover:text-foreground"
            >
              <Icon name="plus" size={14} className="flex-none" />
              Add a baseline and how it will be proven
            </button>
          )}
          {c.metric.trim() && target !== null && (
            <p className="text-meta text-soft">
              Met when{" "}
              {measure({ ...c, metric: c.metric.trim(), target, unit: c.unit.trim() || null })}.
              {baseline !== null && ` Baseline ${inUnit(baseline, c.unit.trim())}.`}
            </p>
          )}
        </fieldset>
      )}
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
              "cursor-pointer rounded-full px-3 py-1 text-meta font-medium text-muted-foreground transition-colors select-none hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tint/40",
              // The chosen option in the tint's well, as a chosen card is: seen at a glance.
              value === o.id &&
                "bg-tint-soft text-tint ring-1 ring-tint/35 ring-inset hover:text-tint",
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
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
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
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

let added = 0
const STEP_TITLE = PlanStepItem.shape.title

/** Where focus goes after a change to the plan: a step's menu button, the new step's field. */
type FocusTo = { step: string } | "new-step"

/**
 * The plan the workspace proposed, for the FDE to change: reorder, rename, add and remove steps,
 * from one menu per step. Every change is local until Continue; the summary shows the draft.
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
  const newStep = useRef<HTMLInputElement>(null)
  // Set by a change, used once the page shows it: a removed row or a closed rename takes its
  // control with it, which would leave focus on the page itself.
  const focusTo = useRef<FocusTo | null>(null)

  const target = (to: FocusTo | null): HTMLElement | null =>
    to === "new-step"
      ? newStep.current
      : to
        ? (rows.current.get(to.step)?.querySelector<HTMLElement>("[data-step-menu]") ?? null)
        : null

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
  }, [steps])

  useLayoutEffect(() => {
    const to = focusTo.current
    focusTo.current = null
    target(to)?.focus()
  })

  function move(i: number, by: -1 | 1) {
    const j = i + by
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    const [step] = next.splice(i, 1)
    next.splice(j, 0, step!)
    focusTo.current = { step: step!.id }
    onChange(next)
    setSaid(`Moved “${step!.title}” to step ${j + 1} of ${steps.length}.`)
  }

  function remove(i: number) {
    const step = steps[i]!
    // The step that takes its place, or the one before it, or the field to add one.
    const near = steps[i + 1] ?? steps[i - 1]
    focusTo.current = near ? { step: near.id } : "new-step"
    onChange(steps.filter((s) => s.id !== step.id))
    setSaid(`Removed “${step.title}”.`)
  }

  function stopRenaming(id: string) {
    focusTo.current = { step: id }
    setRenaming(null)
    setProblem("")
  }

  function rename(id: string) {
    const title = STEP_TITLE.safeParse(draftTitle)
    if (!title.success)
      return setProblem("A step needs a name of up to 120 characters on one line.")
    onChange(steps.map((s) => (s.id === id ? { ...s, title: title.data } : s)))
    stopRenaming(id)
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
            className="relative -mx-2 flex items-start gap-3 rounded-field px-2 py-2.5 transition-colors hover:bg-card"
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
                      stopRenaming(step.id)
                    }
                  }}
                  className={cn(INPUT, "h-9 min-w-0 flex-1")}
                />
                <Button type="button" variant="outline" onClick={() => rename(step.id)}>
                  Save
                </Button>
              </span>
            ) : (
              <>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-body break-words">{step.title}</span>
                  <StepMeta step={step} />
                  {step.criterion && <Proof criterion={step.criterion} />}
                </span>
                <StepMenu
                  title={step.title}
                  first={i === 0}
                  last={i === steps.length - 1}
                  onMove={(by) => move(i, by)}
                  onRename={() => {
                    setDraftTitle(step.title)
                    setRenaming(step.id)
                  }}
                  onRemove={() => remove(i)}
                />
              </>
            )}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2">
        <input
          ref={newStep}
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

/**
 * A step's changes behind one button, so a long plan stays a list of steps. The plan form puts
 * focus back itself after a change (`finalFocus` is off then); Escape returns it to the button.
 */
function StepMenu({
  title,
  first,
  last,
  onMove,
  onRename,
  onRemove,
}: {
  title: string
  first: boolean
  last: boolean
  onMove: (by: -1 | 1) => void
  onRename: () => void
  onRemove: () => void
}) {
  const chose = useRef(false)
  const pick = (act: () => void) => () => {
    chose.current = true
    act()
  }
  return (
    <Menu>
      <MenuTrigger
        data-step-menu=""
        aria-label={`Change “${title}”`}
        className="-my-1 grid size-8 flex-none place-items-center rounded-full text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-selected hover:text-foreground data-popup-open:bg-selected data-popup-open:text-foreground motion-safe:active:scale-[0.92]"
      >
        <Icon name="more" size={16} />
      </MenuTrigger>
      <MenuContent
        label={`Change “${title}”`}
        finalFocus={() => {
          const handled = chose.current
          chose.current = false
          return !handled
        }}
      >
        <MenuItem
          disabled={first}
          onClick={pick(() => onMove(-1))}
          className="data-disabled:opacity-45"
        >
          <Icon name="chevron-up" size={15} className="text-muted-foreground" />
          Move up
        </MenuItem>
        <MenuItem
          disabled={last}
          onClick={pick(() => onMove(1))}
          className="data-disabled:opacity-45"
        >
          <Icon name="chevron-down" size={15} className="text-muted-foreground" />
          Move down
        </MenuItem>
        <MenuItem onClick={pick(onRename)}>
          <Icon name="pencil" size={15} className="text-muted-foreground" />
          Rename
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={pick(onRemove)}>
          <Icon name="close" size={15} className="text-muted-foreground" />
          Remove
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

import { useEffect, useId, useRef, useState } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Button } from "../ui/button"
import { BlockView, Empty, LongText } from "./blocks"
import { CompanyForm, PeopleForm, PlanForm, RulesForm, StartForm } from "./step-forms"
import { Voice } from "./welcome"
import { api } from "@/lib/api/client"
import type { SetupRequest } from "@/lib/api/client"
import { commitSetUp } from "@/lib/records"
import { inUnit, measure, targetOf } from "@/lib/scope"
import { STAGE_LABEL } from "@/lib/stage"
import type { Block, PlanStep } from "@/lib/workspace/blocks"
import {
  NO_ANSWERS,
  STEPS,
  answerText,
  askOf,
  nextStep,
  proposePlan,
  readyToCreate,
  relinkPlan,
  summaryBlocks,
} from "@/lib/workspace/new-company"
import type { Answers, StepId } from "@/lib/workspace/new-company"
import { STEP_OF, prepare, setupBody, setupProblem } from "@/lib/workspace/setup"
import type { Part, SetupProblem } from "@/lib/workspace/setup"
import { cn } from "@/lib/utils"

// A new company, made in a conversation (issues #209 and #249, DESIGN.md "The workspace"). The
// workspace asks one step at a time; each answer fills a block on the summary beside it. Nothing is
// saved or sent until the person confirms on the review step, and then in one setup call.

export function NewCompanyConversation() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS)
  const [current, setCurrent] = useState<StepId>("company")
  // The plan being changed on its step, before it is accepted; proposed when the step first opens.
  const [draft, setDraft] = useState<Array<PlanStep> | null>(null)
  const [edited, setEdited] = useState(false)
  const [creating, setCreating] = useState(false)
  const [problem, setProblem] = useState<SetupProblem | null>(null)
  // The setup as last sent: its key and bytes go again only with an identical body.
  const sent = useRef<SetupRequest | null>(null)
  // A second click before the first one's render cannot send a second request.
  const sending = useRef(false)
  const question = useRef<HTMLHeadingElement>(null)
  const opened = useRef(false)

  // A new step: its question takes focus, so a screen reader reads it and the keyboard starts there.
  useEffect(() => {
    if (!opened.current) {
      opened.current = true
      return
    }
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    question.current?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" })
    question.current?.focus({ preventScroll: true })
  }, [current])

  function answer<TStep extends Exclude<StepId, "review">>(
    id: TStep,
    value: NonNullable<Answers[TStep]>,
  ) {
    const next: Answers = { ...answers, [id]: value }
    // The plan follows the first move until the person has changed it themselves; after that only
    // the criterion its steps work towards follows.
    if (id === "start" && next.plan)
      next.plan = edited ? relinkPlan(next.plan, next) : proposePlan(next)
    if (id === "plan") setDraft(null)
    setAnswers(next)
    setProblem(null)
    setCurrent(nextStep(next))
  }

  function open(id: StepId) {
    if (id === "plan") setDraft(answers.plan ?? proposePlan(answers))
    setCurrent(id)
  }

  // Opening the plan step proposes a plan from the answers so far.
  const planSteps = current === "plan" ? (draft ?? answers.plan ?? proposePlan(answers)) : null
  const shown: Answers = planSteps ? { ...answers, plan: planSteps } : answers
  const blocks = summaryBlocks(shown)

  async function create() {
    // The only write this screen makes, and only from the review, once every step is answered.
    const body = current === "review" ? setupBody(answers) : null
    if (!body || sending.current) return
    const request = prepare(body, sent.current)
    sent.current = request
    sending.current = true
    setCreating(true)
    setProblem(null)
    try {
      const out = await api.setUpCompany(request)
      await commitSetUp(client, out)
      await navigate({
        to: "/companies/$companyId/projects/$projectId",
        params: { companyId: out.company.id, projectId: out.project.id },
      })
    } catch (error) {
      const failed = setupProblem(error, body)
      // A refused body, or a key that set up something else: the next attempt takes a new key.
      if (failed.kind === "part" || failed.key === "fresh") sent.current = null
      setProblem(failed)
      setCreating(false)
      sending.current = false
    }
  }

  const index = STEPS.findIndex((s) => s.id === current)
  const step = STEPS[index]!
  const ask = askOf(step, answers)

  return (
    <div className="mx-auto grid w-[min(1120px,calc(100%-48px))] grid-cols-[minmax(0,1fr)_minmax(280px,340px)] items-start gap-[clamp(32px,5vw,72px)] pt-10 pb-24 text-body max-[960px]:grid-cols-1 max-[800px]:w-[calc(100%-32px)] max-[800px]:pt-6">
      <section aria-label="Conversation" className="grid min-w-0 gap-8">
        <Progress index={index} onSummary={<SummaryDrawer blocks={blocks} />} />

        <ol className="grid gap-8">
          {STEPS.map((s, i) => {
            if (s.id === current) {
              return (
                <li key={s.id} className="grid gap-5 motion-safe:animate-rise">
                  <div className="flex items-start gap-3">
                    <Voice />
                    <div className="grid gap-1">
                      <h2
                        ref={question}
                        tabIndex={-1}
                        className="text-title font-semibold text-balance outline-none"
                      >
                        {ask}
                      </h2>
                      <p className="text-meta text-muted-foreground">{s.why}</p>
                    </div>
                  </div>
                  <div className="pl-9 max-[560px]:pl-0">
                    <StepAnswer
                      id={s.id}
                      label={ask}
                      answers={answers}
                      plan={planSteps}
                      onPlanChange={(steps) => {
                        setDraft(steps)
                        setEdited(true)
                      }}
                      onAnswer={answer}
                      review={
                        <Review
                          answers={answers}
                          ready={readyToCreate(answers)}
                          creating={creating}
                          problem={problem}
                          onCreate={() => void create()}
                          onChange={open}
                        />
                      }
                    />
                  </div>
                </li>
              )
            }
            const said = answerText(s.id, answers)
            if (!said) return null
            return (
              <li
                key={s.id}
                className="grid gap-3"
                aria-label={`Step ${i + 1}: ${askOf(s, answers)}`}
              >
                <p className="flex items-start gap-3 text-meta text-muted-foreground">
                  <Voice />
                  <span className="pt-0.5">{askOf(s, answers)}</span>
                </p>
                <div className="flex items-end justify-end gap-2 pl-9">
                  <button
                    type="button"
                    onClick={() => open(s.id)}
                    aria-label={`Change: ${askOf(s, answers)}`}
                    className="mb-2 rounded-full px-2 py-1 text-micro text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
                  >
                    Change
                  </button>
                  <p className="max-w-[85%] rounded-[18px] rounded-br-md border bg-card px-4 py-2.5 break-words whitespace-pre-wrap">
                    <span className="sr-only">You answered: </span>
                    {said}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <aside aria-label="Summary" className="sticky top-6 max-[960px]:hidden">
        <Summary blocks={blocks} />
      </aside>
    </div>
  )
}

function StepAnswer({
  id,
  label,
  answers,
  plan,
  onPlanChange,
  onAnswer,
  review,
}: {
  id: StepId
  label: string
  answers: Answers
  plan: Array<PlanStep> | null
  onPlanChange: (steps: Array<PlanStep>) => void
  onAnswer: <TStep extends Exclude<StepId, "review">>(
    id: TStep,
    value: NonNullable<Answers[TStep]>,
  ) => void
  review: React.ReactNode
}) {
  switch (id) {
    case "company":
      return (
        <CompanyForm
          label={label}
          initial={answers.company}
          onAnswer={(v) => onAnswer("company", v)}
        />
      )
    case "start":
      return (
        <StartForm label={label} initial={answers.start} onAnswer={(v) => onAnswer("start", v)} />
      )
    case "rules":
      return (
        <RulesForm label={label} initial={answers.rules} onAnswer={(v) => onAnswer("rules", v)} />
      )
    case "people":
      return (
        <PeopleForm
          label={label}
          initial={answers.people}
          onAnswer={(v) => onAnswer("people", v)}
        />
      )
    case "plan":
      return (
        <PlanForm
          label={label}
          steps={plan ?? []}
          onChange={onPlanChange}
          onAnswer={(v) => onAnswer("plan", v)}
        />
      )
    case "review":
      return review
  }
}

function Review({
  answers,
  ready,
  creating,
  problem,
  onCreate,
  onChange,
}: {
  answers: Answers
  ready: boolean
  creating: boolean
  problem: SetupProblem | null
  onCreate: () => void
  onChange: (step: StepId) => void
}) {
  const savedId = useId()
  const laterId = useId()
  const wrong = problem?.kind === "part" ? problem : null
  const general = problem?.kind === "general" ? problem : null
  return (
    <div className="grid gap-6 rounded-card border bg-canvas p-6 shadow-lift motion-safe:animate-settle max-[560px]:p-4">
      <section aria-labelledby={savedId} className="grid gap-3">
        <h3 id={savedId} className="text-meta font-semibold">
          Saved when you create it
        </h3>
        <dl className="grid divide-y rounded-field border">
          {savedRows(answers).map((row) => (
            <div
              key={row.part}
              className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 max-[560px]:grid-cols-1"
            >
              <dt className="text-micro leading-[20px] text-muted-foreground">{row.label}</dt>
              <dd className="grid min-w-0 gap-1 text-meta break-words">
                {row.value}
                {wrong?.part === row.part && (
                  <p
                    role="alert"
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-meta text-destructive"
                  >
                    <span>{wrong.message}</span>
                    <button
                      type="button"
                      onClick={() => onChange(STEP_OF[row.part])}
                      className="rounded-sm font-medium underline underline-offset-4 hover:no-underline"
                    >
                      Change {row.label.toLowerCase()}
                    </button>
                  </p>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby={laterId} className="grid gap-3">
        <h3 id={laterId} className="text-meta font-semibold">
          Not saved yet
        </h3>
        <ul className="grid gap-2.5">
          {notSaved(answers).map((item) => (
            <li key={item.label} className="grid gap-0.5 text-meta">
              <span className="font-medium text-soft">{item.label}</span>
              <span className="text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      </section>
      {general && (
        <p role="alert" className="text-meta text-destructive">
          {general.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-5">
        <Link
          to="/"
          className="inline-flex h-10 items-center rounded-full px-4 text-[13px] font-medium text-soft transition-colors hover:bg-selected hover:text-foreground"
        >
          Not now
        </Link>
        <Button size="lg" disabled={!ready || creating} onClick={onCreate}>
          {creating ? "Creating…" : general?.key === "retry" ? "Try again" : "Create company"}
        </Button>
      </div>
    </div>
  )
}

const bare = (s: string) => s.replace(/\s+/g, "").toLowerCase()

const Quiet = ({ children }: { children: React.ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
)

/** Each part the setup call saves, as the review shows it: taken from the answers, as sent. */
function savedRows(answers: Answers): Array<{ part: Part; label: string; value: React.ReactNode }> {
  const c = answers.company
  const start = answers.start
  const plan = answers.plan ?? []
  if (!c || !start) return []
  const where = [c.industry.trim(), c.region.trim()].filter(Boolean).join(" · ")
  const criterion = start.criterion.description.trim() ? start.criterion : null
  const target = criterion ? targetOf(criterion.target) : null
  const baseline = criterion ? targetOf(criterion.baseline) : null
  const proving = plan.filter((s) => s.criterion).length
  return [
    {
      part: "company",
      label: "Company",
      value: (
        <>
          <span className="font-medium">{c.name.trim()}</span>
          {where && <Quiet>{where}</Quiet>}
          <Quiet>You become its lead.</Quiet>
        </>
      ),
    },
    {
      part: "project",
      label: "First project",
      value: (
        <>
          <span className="font-medium">{c.project.trim()}</span>
          {c.summary.trim() ? <LongText value={c.summary.trim()} /> : <Quiet>No summary.</Quiet>}
        </>
      ),
    },
    {
      part: "contact",
      label: "Main contact",
      value: start.contact.trim() ? (
        <>
          <span className="font-medium">{start.contact.trim()}</span>
          <Quiet>A stakeholder at the company, marked as its main contact.</Quiet>
        </>
      ) : (
        <Quiet>No one named.</Quiet>
      ),
    },
    {
      part: "criterion",
      label: "Success criterion",
      value: criterion ? (
        <>
          <span className="font-medium">{criterion.description}</span>
          {target !== null && (
            <span>
              Met when{" "}
              {measure({
                metric: criterion.metric,
                comparator: criterion.comparator,
                target,
                unit: criterion.unit || null,
              })}
              .{baseline !== null && ` Baseline ${inUnit(baseline, criterion.unit)}.`}
            </span>
          )}
          <Quiet>
            {criterion.proof
              ? `How we will prove it: ${criterion.proof}`
              : "How it will be proven is not said yet."}
          </Quiet>
        </>
      ) : (
        <Quiet>None yet. Add one on the project.</Quiet>
      ),
    },
    {
      part: "plan",
      label: "Plan",
      value: (
        <>
          <span>
            {plan.length} {plan.length === 1 ? "task" : "tasks"}, in this order, each on its stage
            {proving > 0 ? `; ${proving} work towards the criterion` : ""}. No one is assigned.
          </span>
          <ol className="grid gap-1 pt-1">
            {plan.map((step, i) => (
              <li key={step.id} className="flex min-w-0 gap-2">
                <span className="w-5 flex-none text-right text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                <span className="min-w-0">
                  {step.title}
                  {/* "Build" under "Build" says nothing twice, as the plan block does. */}
                  {bare(step.title) !== bare(STAGE_LABEL[step.stage]) && (
                    <Quiet> · {STAGE_LABEL[step.stage]}</Quiet>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </>
      ),
    },
  ]
}

/** What the conversation asked that this call does not save, said plainly (ADR 0008). */
function notSaved(answers: Answers): Array<{ label: string; detail: string }> {
  const people = answers.people ?? []
  const withSomeone = (answers.plan ?? []).some((s) => s.with)
  return [
    {
      label: "Rules for agents",
      detail:
        "Each rule is confirmed on its own, once rules can be saved. Until then this setup sets none.",
    },
    ...(people.length > 0
      ? [
          {
            label: people.length === 1 ? "1 invitation" : `${people.length} invitations`,
            detail: `No one is invited. Each invitation is confirmed on its own, once invitations can be sent: ${people.map((p) => p.email).join(", ")}.`,
          },
        ]
      : []),
    ...(withSomeone
      ? [
          {
            label: "Who a step is with",
            detail: "The plan's tasks do not keep it. The main contact is saved on the company.",
          },
        ]
      : []),
  ]
}

function Progress({ index, onSummary }: { index: number; onSummary: React.ReactNode }) {
  const total = STEPS.length
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-micro font-medium text-muted-foreground tabular-nums">
          Step {index + 1} of {total}
        </p>
        <div className="min-[961px]:hidden">{onSummary}</div>
      </div>
      <div aria-hidden="true" className="flex gap-1">
        {STEPS.map((s, i) => (
          <span
            key={s.id}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-300",
              i < index ? "bg-tint/60" : i === index ? "bg-tint" : "bg-selected",
            )}
          />
        ))}
      </div>
    </div>
  )
}

const SECTIONS: Array<{ type: Block["type"]; title: string; empty: string; later?: true }> = [
  { type: "brief", title: "Company", empty: "Its name and what you deliver." },
  { type: "plan", title: "Plan", empty: "Proposed once I know how you want to start." },
  {
    type: "rules",
    title: "Rules for agents",
    empty: "What agents may do, and who approves.",
    later: true,
  },
  { type: "people", title: "People", empty: "Who to invite, if anyone.", later: true },
]

/** The summary beside the conversation: one section per block, empty until its step is answered. */
function Summary({ blocks, titled = true }: { blocks: Array<Block>; titled?: boolean }) {
  return (
    <div className="rounded-card border bg-card">
      {titled && (
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="text-meta font-semibold">Summary</h2>
          <span className="rounded-full border px-2 py-0.5 text-micro text-muted-foreground">
            Draft
          </span>
        </div>
      )}
      {SECTIONS.map((section) => {
        const block = blocks.find((b) => b.type === section.type)
        return (
          <section
            key={section.type}
            aria-label={section.title}
            className="grid gap-2.5 border-t px-5 py-4"
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-micro font-medium text-muted-foreground">{section.title}</h3>
              {section.later && (
                <span className="text-micro text-muted-foreground">Not saved yet</span>
              )}
            </div>
            {block ? (
              <div key="filled" className="motion-safe:animate-settle">
                <BlockView block={block} />
              </div>
            ) : (
              <Empty>{section.empty}</Empty>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** On a narrow screen the summary is a sheet from the bottom, opened from beside the progress. */
function SummaryDrawer({ blocks }: { blocks: Array<Block> }) {
  const filled = SECTIONS.filter((s) => blocks.some((b) => b.type === s.type)).length
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-canvas px-3 text-micro font-medium text-soft transition-colors hover:border-strong hover:text-foreground">
        Summary
        <span className="text-muted-foreground tabular-nums">
          {filled} of {SECTIONS.length}
        </span>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-[24px] border-t bg-canvas p-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-overlay transition-transform duration-300 ease-[var(--ease-calm)] outline-none data-ending-style:translate-y-full data-starting-style:translate-y-full motion-reduce:transition-none">
          <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-selected" aria-hidden="true" />
          <div className="flex items-center justify-between gap-3 px-2 pt-1 pb-3">
            <DialogPrimitive.Title className="text-lead font-semibold">
              Summary
            </DialogPrimitive.Title>
            {/* First in the sheet, so focus opens it at the top. */}
            <DialogPrimitive.Close className="h-9 rounded-full border px-4 text-meta font-medium text-soft transition-colors hover:bg-selected hover:text-foreground">
              Done
            </DialogPrimitive.Close>
          </div>
          <Summary blocks={blocks} titled={false} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

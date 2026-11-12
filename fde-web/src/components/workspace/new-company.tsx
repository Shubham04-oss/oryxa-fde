import { useEffect, useRef, useState } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Button } from "../ui/button"
import { BlockView, Empty } from "./blocks"
import { CompanyForm, PeopleForm, PlanForm, RulesForm, StartForm } from "./step-forms"
import { Voice } from "./welcome"
import { api } from "@/lib/api/client"
import { attempt, commitCompanyCreated, companyBody } from "@/lib/records"
import type { Block, PlanStep } from "@/lib/workspace/blocks"
import {
  NO_ANSWERS,
  STEPS,
  answerText,
  askOf,
  nextStep,
  proposePlan,
  readyToCreate,
  reviewChecklist,
  summaryBlocks,
} from "@/lib/workspace/new-company"
import type { Answers, StepId } from "@/lib/workspace/new-company"
import { cn } from "@/lib/utils"

// A new company, made in a conversation (issue #209, DESIGN.md "The workspace"). The workspace asks
// one step at a time; each answer fills a block on the summary beside it. Nothing is saved or sent
// until the person confirms on the review step, and then only through the existing create call.

export function NewCompanyConversation() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS)
  const [current, setCurrent] = useState<StepId>("company")
  // The plan being changed on its step, before it is accepted; proposed when the step first opens.
  const [draft, setDraft] = useState<Array<PlanStep> | null>(null)
  const [edited, setEdited] = useState(false)
  const [creating, setCreating] = useState(false)
  const [problem, setProblem] = useState("")
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
    // The plan follows the first move until the person has changed it themselves.
    if (id === "start" && !edited && next.plan) next.plan = proposePlan(next)
    if (id === "plan") setDraft(null)
    setAnswers(next)
    setProblem("")
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
    if (current !== "review" || !readyToCreate(answers) || !answers.company) return
    setCreating(true)
    setProblem("")
    const failed = await attempt(async () => {
      const created = await api.createCompany(companyBody(answers.company!))
      await commitCompanyCreated(client, created)
      await navigate({ to: "/companies/$companyId", params: { companyId: created.id } })
    }, "company")
    if (failed) {
      setProblem(failed)
      setCreating(false)
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
                          checklist={reviewChecklist(answers)}
                          ready={readyToCreate(answers)}
                          creating={creating}
                          problem={problem}
                          onCreate={() => void create()}
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
  checklist,
  ready,
  creating,
  problem,
  onCreate,
}: {
  checklist: Block | null
  ready: boolean
  creating: boolean
  problem: string
  onCreate: () => void
}) {
  return (
    <div className="grid gap-6 rounded-card border bg-canvas p-6 shadow-lift motion-safe:animate-settle max-[560px]:p-4">
      {checklist && <BlockView block={checklist} />}
      <p className="rounded-field bg-card px-4 py-3 text-meta text-soft">
        Creating saves the company now. In this preview the plan, rules and invitations are not kept
        yet, and no one is invited.
      </p>
      {problem && (
        <p role="alert" className="text-meta text-destructive">
          {problem}
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
          {creating ? "Creating…" : "Create company"}
        </Button>
      </div>
    </div>
  )
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

const SECTIONS: Array<{ type: Block["type"]; title: string; empty: string }> = [
  { type: "brief", title: "Company", empty: "Its name and what you deliver." },
  { type: "plan", title: "Plan", empty: "Proposed once I know how you want to start." },
  { type: "rules", title: "Rules for agents", empty: "What agents may do, and who approves." },
  { type: "people", title: "People", empty: "Who to invite, if anyone." },
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
            <h3 className="text-micro font-medium text-muted-foreground">{section.title}</h3>
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

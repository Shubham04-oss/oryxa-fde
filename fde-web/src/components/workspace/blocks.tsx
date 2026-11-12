import { useNavigate } from "@tanstack/react-router"
import { Button } from "../ui/button"
import { Icon } from "../ui/icon"
import type {
  Block,
  BriefBlock,
  ChecklistBlock,
  Destination,
  PeopleBlock,
  PlanBlock,
  PlanStep,
  RulesBlock,
  SuggestionBlock,
  Verdict,
} from "@/lib/workspace/blocks"
import { ROLE_LABEL, VERDICT_LABEL } from "@/lib/workspace/new-company"
import { STAGE_LABEL } from "@/lib/stage"
import { cn } from "@/lib/utils"

// How each building block looks (DESIGN.md, "The workspace"). Every value is shown as React text,
// never as markup, and a block of a type this file does not know renders nothing.

/** Where a destination is in the router. */
export function useGo() {
  const navigate = useNavigate()
  return (to: Destination) => {
    switch (to.screen) {
      case "today":
        return navigate({ to: "/today" })
      case "companies":
        return navigate({ to: "/companies" })
      case "new-company":
        return navigate({ to: "/new-company" })
      case "company":
        return navigate({ to: "/companies/$companyId", params: { companyId: to.company } })
      case "project":
        return navigate({
          to: "/companies/$companyId/projects/$projectId",
          params: { companyId: to.company, projectId: to.project },
        })
    }
  }
}

export function Suggestion({
  block,
  onDismiss,
}: {
  block: SuggestionBlock
  /** Without it, the row offers approve only. */
  onDismiss?: () => void
}) {
  const go = useGo()
  return (
    <article
      aria-label={block.title}
      className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-card max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-3 max-[560px]:px-4"
    >
      <div className="grid min-w-0 flex-1 gap-0.5">
        {block.context && (
          <p className="truncate text-micro text-muted-foreground">{block.context}</p>
        )}
        <h3 className="text-body font-medium text-pretty">{block.title}</h3>
        {block.detail && (
          <p className="line-clamp-2 text-meta text-muted-foreground">{block.detail}</p>
        )}
      </div>
      <div className="flex flex-none items-center gap-1">
        <Button variant="outline" onClick={() => void go(block.approve.to)}>
          {block.approve.label}
        </Button>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={`Not now: ${block.title}`}
            title="Not now"
            className="grid size-8 place-items-center rounded-full text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-selected hover:text-foreground motion-safe:active:scale-[0.92]"
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
    </article>
  )
}

function Brief({ block }: { block: BriefBlock }) {
  return (
    <dl className="grid gap-3">
      {block.items.map((item) => (
        <div key={item.label} className="grid gap-0.5">
          <dt className="text-micro text-muted-foreground">{item.label}</dt>
          <dd className="text-meta break-words whitespace-pre-line text-foreground">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A criterion a step works towards, and how it will be proven: the place evals will fill. */
export function Proof({ criterion }: { criterion: { name: string; proof: string } }) {
  return (
    <span className="mt-1 grid gap-0.5 border-l-2 border-tint/40 pl-2.5 text-micro">
      <span className="text-soft">Criterion: {criterion.name}</span>
      <span className="text-muted-foreground">How we will prove it: {criterion.proof}</span>
    </span>
  )
}

/** A step's stage, and who it is with: the task it becomes sits on that stage. */
export function StepMeta({ step }: { step: PlanStep }) {
  const stage = STAGE_LABEL[step.stage]
  // "Build" under a step called "Build" says nothing twice.
  const parts = [stage.toLowerCase() === step.title.toLowerCase() ? null : stage, step.with]
  const said = parts.filter(Boolean).join(" · ")
  if (!said) return null
  return <span className="text-micro text-muted-foreground">{said}</span>
}

/** A step's place in the plan, in the plan's one colour. */
export function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-5 flex-none place-items-center rounded-full bg-tint-soft text-[10px] font-semibold text-tint tabular-nums"
    >
      {n}
    </span>
  )
}

function Plan({ block }: { block: PlanBlock }) {
  if (block.steps.length === 0) return <Empty>No steps yet.</Empty>
  return (
    <ol className="grid gap-3">
      {block.steps.map((step, i) => (
        <li key={step.id} className="flex gap-2.5">
          <StepNumber n={i + 1} />
          <span className="grid min-w-0 gap-0.5">
            <span className="text-meta break-words text-foreground">{step.title}</span>
            <StepMeta step={step} />
            {step.criterion && <Proof criterion={step.criterion} />}
          </span>
        </li>
      ))}
    </ol>
  )
}

const VERDICT_DOT: Record<Verdict, string> = {
  allowed: "bg-success",
  ask: "bg-tint",
  never: "bg-strong",
}

function Rules({ block }: { block: RulesBlock }) {
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2">
        {block.rules.map((rule) => (
          <li key={rule.id} className="flex items-baseline justify-between gap-3 text-meta">
            <span className="min-w-0 text-foreground">{rule.action}</span>
            <span className="inline-flex flex-none items-center gap-1.5 text-micro text-soft">
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", VERDICT_DOT[rule.verdict])}
              />
              {VERDICT_LABEL[rule.verdict]}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-micro text-muted-foreground">Approves: {block.approver}</p>
    </div>
  )
}

function People({ block }: { block: PeopleBlock }) {
  if (block.people.length === 0) return <Empty>No one for now.</Empty>
  return (
    <ul className="grid gap-2">
      {block.people.map((person) => (
        <li key={person.email} className="flex items-baseline justify-between gap-3 text-meta">
          <span className="min-w-0 truncate text-foreground">{person.email}</span>
          <span className="flex-none text-micro text-muted-foreground">
            {ROLE_LABEL[person.role]}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Checklist({ block }: { block: ChecklistBlock }) {
  return (
    <ul className="grid gap-2.5">
      {block.items.map((item) => (
        <li key={item.label} className="flex items-center gap-2.5 text-meta">
          {item.done ? (
            <span className="grid size-4 flex-none place-items-center rounded-full bg-success text-canvas">
              <Icon name="check" size={11} strokeWidth={2.5} />
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="size-4 flex-none rounded-full border border-strong"
            />
          )}
          <span className={item.done ? "text-foreground" : "text-muted-foreground"}>
            {item.label}
            <span className="sr-only">{item.done ? ", done" : ", not yet"}</span>
          </span>
          {item.optional && <span className="text-micro text-muted-foreground">Optional</span>}
        </li>
      ))}
    </ul>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-meta text-muted-foreground">{children}</p>
}

/**
 * One block, drawn. Suggestions are drawn by `Suggestion` where they can be dismissed; here they
 * offer approve only. A type this file does not know is drawn as nothing.
 */
export function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "suggestion":
      return <Suggestion block={block} />
    case "brief":
      return <Brief block={block} />
    case "plan":
      return <Plan block={block} />
    case "rules":
      return <Rules block={block} />
    case "people":
      return <People block={block} />
    case "checklist":
      return <Checklist block={block} />
    default:
      return null
  }
}

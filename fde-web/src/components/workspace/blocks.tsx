import { useId, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "../ui/button"
import { Icon } from "../ui/icon"
import { VERDICTS } from "@/lib/workspace/blocks"
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
  lead,
}: {
  block: SuggestionBlock
  /** Without it, the row offers approve only. */
  onDismiss?: () => void
  /** The first suggestion: its approve is the screen's primary action. */
  lead?: boolean
}) {
  const go = useGo()
  return (
    <article
      aria-label={block.title}
      className="flex items-center gap-6 px-5 py-4 max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-3 max-[560px]:px-4"
    >
      <div className="grid min-w-0 flex-1 gap-1">
        {block.context && (
          <p className="truncate text-micro text-muted-foreground">{block.context}</p>
        )}
        <h3 className="text-body font-semibold text-pretty">{block.title}</h3>
        {block.detail && (
          <p className="line-clamp-2 text-meta text-muted-foreground">{block.detail}</p>
        )}
      </div>
      <div className="flex flex-none items-center gap-1">
        <Button variant={lead ? "default" : "outline"} onClick={() => void go(block.approve.to)}>
          {block.approve.label}
          <Icon name="arrow-right" size={14} strokeWidth={2} />
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

/** Opens the rest of a list or a value in place, and says whether it is open. */
function ShowMore({
  open,
  onToggle,
  controls,
  more,
  less = "Show less",
}: {
  open: boolean
  onToggle: () => void
  controls: string
  more: string
  less?: string
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="justify-self-start rounded-sm text-micro font-medium text-soft underline decoration-strong underline-offset-4 transition-colors hover:text-foreground hover:decoration-current"
    >
      {open ? less : more}
    </button>
  )
}

/** A value this long (in characters, or lines) is shown shortened, with Show more. */
const LONG = 140

function BriefValue({ value }: { value: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const long = [...value].length > LONG || value.split("\n").length > 3
  return (
    <dd className="grid min-w-0 gap-1">
      <span
        id={id}
        className={cn(
          "text-meta break-words whitespace-pre-line text-foreground",
          long && !open && "line-clamp-3",
        )}
      >
        {value}
      </span>
      {long && (
        <ShowMore open={open} onToggle={() => setOpen(!open)} controls={id} more="Show more" />
      )}
    </dd>
  )
}

function Brief({ block }: { block: BriefBlock }) {
  return (
    <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2">
      {block.items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-micro leading-[18px] text-muted-foreground">{item.label}</dt>
          <BriefValue value={item.value} />
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

const bare = (s: string) => s.replace(/\s+/g, "").toLowerCase()

/** A step's stage, and who it is with: the task it becomes sits on that stage. */
export function StepMeta({ step }: { step: PlanStep }) {
  const stage = STAGE_LABEL[step.stage]
  // "Build" under "Build", or "Handoff" under "Hand off", says nothing twice.
  const parts = [bare(stage) === bare(step.title) ? null : stage, step.with && `with ${step.with}`]
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

/** How many steps the plan's digest shows before Show all. */
const FIRST_STEPS = 3

/** The plan as a digest: how many steps, how many prove a criterion, and the first few. */
function Plan({ block }: { block: PlanBlock }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const n = block.steps.length
  if (n === 0) return <Empty>No steps yet.</Empty>
  const proving = block.steps.filter((s) => s.criterion).length
  const shown = open ? block.steps : block.steps.slice(0, FIRST_STEPS)
  return (
    <div className="grid gap-3">
      <p className="text-meta text-soft">
        {n} {n === 1 ? "step" : "steps"}
        {proving > 0 && (
          <span className="text-muted-foreground">
            {" · "}
            {proving} {proving === 1 ? "proves" : "prove"} a criterion
          </span>
        )}
      </p>
      <ol id={id} className="grid gap-2">
        {shown.map((step, i) => (
          <li key={step.id} className="flex items-start gap-2.5">
            <StepNumber n={i + 1} />
            <span className="grid min-w-0 gap-0.5">
              <span className="text-meta break-words text-foreground">{step.title}</span>
              {open && <StepMeta step={step} />}
              {open && step.criterion && <Proof criterion={step.criterion} />}
            </span>
          </li>
        ))}
      </ol>
      {n > FIRST_STEPS && (
        <ShowMore
          open={open}
          onToggle={() => setOpen(!open)}
          controls={id}
          more={`Show all ${n} steps`}
        />
      )}
    </div>
  )
}

const VERDICT_DOT: Record<Verdict, string> = {
  allowed: "bg-success",
  ask: "bg-tint",
  // A ring in the muted ink: "Never" is not a status, and it must still be seen (3:1 or more).
  never: "border-[1.5px] border-muted-foreground",
}

function VerdictDot({ verdict }: { verdict: Verdict }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 flex-none rounded-full", VERDICT_DOT[verdict])}
    />
  )
}

/** The rules as a digest: how many of each verdict and who approves; the rules themselves on Show. */
function Rules({ block }: { block: RulesBlock }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const counts = VERDICTS.map((verdict) => ({
    verdict,
    n: block.rules.filter((r) => r.verdict === verdict).length,
  })).filter((c) => c.n > 0)
  return (
    <div className="grid gap-3">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-soft">
        {counts.map((c) => (
          <span key={c.verdict} className="inline-flex items-center gap-1.5">
            <VerdictDot verdict={c.verdict} />
            {c.n} {VERDICT_LABEL[c.verdict].toLowerCase()}
          </span>
        ))}
      </p>
      {/* Kept in the page when closed, so the button's aria-controls always names it. */}
      <ul id={id} hidden={!open} className="grid gap-2">
        {block.rules.map((rule) => (
          <li key={rule.id} className="flex items-baseline justify-between gap-3 text-meta">
            <span className="min-w-0 text-foreground">{rule.action}</span>
            <span className="inline-flex flex-none items-center gap-1.5 text-micro text-soft">
              <VerdictDot verdict={rule.verdict} />
              {VERDICT_LABEL[rule.verdict]}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-micro text-muted-foreground">Approves: {block.approver}</p>
        <ShowMore
          open={open}
          onToggle={() => setOpen(!open)}
          controls={id}
          more="Show the rules"
          less="Hide the rules"
        />
      </div>
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
            // The muted ink, not the border colour: an open item's circle must be seen (3:1 or more).
            <span
              aria-hidden="true"
              className="size-4 flex-none rounded-full border-[1.5px] border-muted-foreground"
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
 * offer approve only. A type this file does not know is drawn as nothing. Plan and rules are
 * drawn as a digest that opens in place: the full plan is edited on its own step.
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

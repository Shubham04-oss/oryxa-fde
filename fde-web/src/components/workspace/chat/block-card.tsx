import { Link } from "@tanstack/react-router"
import { BlockView, Proof, StepMeta, StepNumber, Suggestion } from "../blocks"
import { Icon } from "../../ui/icon"
import type { IconName } from "../../ui/icon"
import type { Block, Destination } from "@/lib/workspace/blocks"
import type { Names } from "@/lib/workspace/chat"
import { cn } from "@/lib/utils"

// A block in the thread is a compact card with Open; the right panel shows it at full size. Every
// value is React text. A source chip links to the record the turn read, by the name the person reads
// for it through the API, and only to one of our own routes.

const KIND: Record<Block["type"], { title: string; icon: IconName }> = {
  plan: { title: "Plan", icon: "calendar-check" },
  checklist: { title: "Checklist", icon: "checklist" },
  rules: { title: "Rules for agents", icon: "rules" },
  people: { title: "People to invite", icon: "user-plus" },
  brief: { title: "Brief", icon: "file" },
  suggestion: { title: "Suggestion", icon: "sparkle" },
}

export const blockTitle = (block: Block) => KIND[block.type].title

/** One line on what is in it, with numbers. */
export function blockSummary(block: Block) {
  switch (block.type) {
    case "plan": {
      const n = block.steps.length
      const proving = block.steps.filter((s) => s.criterion).length
      return `${n} ${n === 1 ? "step" : "steps"}${proving ? ` · ${proving} ${proving === 1 ? "proves" : "prove"} a criterion` : ""}`
    }
    case "checklist": {
      const done = block.items.filter((i) => i.done).length
      return `${done} of ${block.items.length} done`
    }
    case "rules":
      return `${block.rules.length} ${block.rules.length === 1 ? "rule" : "rules"} · approves: ${block.approver}`
    case "people":
      return `${block.people.length} ${block.people.length === 1 ? "person" : "people"}`
    case "brief":
      return `${block.items.length} ${block.items.length === 1 ? "fact" : "facts"}`
    case "suggestion":
      return block.title
  }
}

function Peek({ block }: { block: Block }) {
  if (block.type === "plan")
    return (
      <ol className="grid gap-1.5">
        {block.steps.slice(0, 3).map((step, i) => (
          <li key={step.id} className="flex items-start gap-2.5">
            <StepNumber n={i + 1} />
            <span className="min-w-0 truncate text-meta text-foreground">{step.title}</span>
          </li>
        ))}
        {block.steps.length > 3 && (
          <li className="pl-[30px] text-micro text-muted-foreground tabular-nums">
            and {block.steps.length - 3} more
          </li>
        )}
      </ol>
    )
  if (block.type === "checklist") {
    const done = block.items.filter((i) => i.done).length
    return (
      <div aria-hidden="true" className="flex gap-1">
        {block.items.map((item, i) => (
          <span
            key={i}
            className={cn("h-1 flex-1 rounded-full", item.done ? "bg-success" : "bg-selected")}
          />
        ))}
        <span className="sr-only">
          {done} of {block.items.length} done
        </span>
      </div>
    )
  }
  return <BlockView block={block} />
}

export function SourceChip({ to, names }: { to: Destination; names: Names }) {
  const label =
    to.screen === "companies"
      ? "Your companies"
      : to.screen === "company"
        ? (names.company ?? "Company")
        : to.screen === "project"
          ? (names.project ?? "Project")
          : to.screen === "today"
            ? "Today"
            : "New company"
  const icon: IconName =
    to.screen === "project" ? "project" : to.screen === "company" ? "building" : "home"
  const className =
    "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border bg-card px-2 text-micro text-soft transition-colors hover:border-strong hover:text-foreground"
  const inner = (
    <>
      <Icon name={icon} size={12} className="flex-none text-muted-foreground" />
      <span className="truncate">{label}</span>
    </>
  )
  const title = `Source: ${label}`
  switch (to.screen) {
    case "project":
      return (
        <Link
          to="/companies/$companyId/projects/$projectId"
          params={{ companyId: to.company, projectId: to.project }}
          className={className}
          title={title}
        >
          {inner}
        </Link>
      )
    case "company":
      return (
        <Link
          to="/companies/$companyId"
          params={{ companyId: to.company }}
          className={className}
          title={title}
        >
          {inner}
        </Link>
      )
    case "today":
      return (
        <Link to="/today" className={className} title={title}>
          {inner}
        </Link>
      )
    default:
      return (
        <Link to="/companies" className={className} title={title}>
          {inner}
        </Link>
      )
  }
}

export function BlockCard({
  block,
  sources,
  names,
  open,
  onOpen,
}: {
  block: Block
  sources: Array<Destination>
  names: Names
  /** This block is the one in the panel. */
  open: boolean
  onOpen: () => void
}) {
  // A suggestion is its own small card, with its one action.
  if (block.type === "suggestion")
    return (
      <div className="overflow-hidden rounded-[14px] border bg-canvas">
        <Suggestion block={block} />
      </div>
    )
  const kind = KIND[block.type]
  return (
    <article
      aria-label={kind.title}
      className={cn(
        "grid gap-3 rounded-[14px] border bg-canvas px-4 py-3.5 transition-[border-color,box-shadow] duration-150",
        open && "border-strong shadow-lift",
      )}
    >
      <header className="flex items-center gap-2.5">
        <span className="grid size-7 flex-none place-items-center rounded-lg bg-card text-muted-foreground">
          <Icon name={kind.icon} size={15} />
        </span>
        <span className="grid min-w-0 flex-1">
          <span className="text-body font-medium">{kind.title}</span>
          <span className="truncate text-micro text-muted-foreground tabular-nums">
            {blockSummary(block)}
          </span>
        </span>
        <button
          type="button"
          onClick={onOpen}
          aria-pressed={open}
          aria-label={`Open the ${kind.title.toLowerCase()} beside the conversation`}
          className="inline-flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-micro font-medium text-soft transition-colors hover:border-strong hover:text-foreground aria-pressed:bg-selected"
        >
          <Icon name="panel" size={13} />
          Open
        </button>
      </header>
      {block.type === "plan" || block.type === "checklist" ? <Peek block={block} /> : null}
      {sources.length > 0 && (
        <footer className="flex flex-wrap items-center gap-1.5">
          <span className="text-micro text-muted-foreground">From</span>
          {sources.map((to) => (
            <SourceChip key={JSON.stringify(to)} to={to} names={names} />
          ))}
        </footer>
      )}
    </article>
  )
}

/** A block at full size, for the right panel. */
export function BlockFull({ block }: { block: Block }) {
  if (block.type !== "plan") return <BlockView block={block} />
  return (
    <ol className="grid gap-4">
      {block.steps.map((step, i) => (
        <li key={step.id} className="flex items-start gap-3">
          <StepNumber n={i + 1} />
          <span className="grid min-w-0 gap-0.5">
            <span className="text-body break-words text-foreground">{step.title}</span>
            <StepMeta step={step} />
            {step.criterion && <Proof criterion={step.criterion} />}
          </span>
        </li>
      ))}
    </ol>
  )
}

import { Plan, PlanContent, PlanHeader } from "../../ai/plan"
import { Task, TaskContent, TaskTrigger } from "../../ai/task"
import { Tool, ToolContent, ToolHeader } from "../../ai/tool"
import { Icon } from "../../ui/icon"
import {
  isTool,
  seconds,
  stepAsked,
  stepFound,
  stepLabel,
  stepsSummary,
  todoState,
  toolOf,
} from "@/lib/workspace/chat"
import type { ChatTurn, Names, Part, TodoState } from "@/lib/workspace/chat"
import { cn } from "@/lib/utils"

// The agent's work as part of the turn (issue #263): each read is one line in fixed words, with its
// state and how long it took, opening to what was asked and how much came back (counts only, never
// the records). While the turn runs every line shows; once it ends they fold to "Read 3 things".

type ToolPart = Extract<Part, { toolCallId: string }>

const took = (p: ToolPart) =>
  p.endedAt && p.endedAt > p.startedAt ? seconds(p.endedAt - p.startedAt) : undefined

function StepLine({ part, names }: { part: ToolPart; names: Names }) {
  const tool = toolOf(part)!
  const duration = took(part)
  return (
    <Tool>
      <ToolHeader
        title={stepLabel(tool, part.state, names)}
        state={part.state}
        trailing={duration}
      />
      <ToolContent>
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 py-1 text-meta">
          <dt className="text-muted-foreground">Asked for</dt>
          <dd className="text-soft">{stepAsked(tool, names)}</dd>
          <dt className="text-muted-foreground">Came back</dt>
          <dd className="text-soft tabular-nums">{stepFound(tool, part.state, part.count)}</dd>
          {duration && (
            <>
              <dt className="text-muted-foreground">Took</dt>
              <dd className="text-soft tabular-nums">{duration}</dd>
            </>
          )}
        </dl>
      </ToolContent>
    </Tool>
  )
}

export function StepsStrip({ turn, names }: { turn: ChatTurn; names: Names }) {
  const tools = turn.parts.filter(isTool)
  if (tools.length === 0) return null
  const lines = tools.map((part) => <StepLine key={part.toolCallId} part={part} names={names} />)
  if (turn.status === "streaming")
    return (
      <div role="group" aria-label="What the workspace is reading" className="grid">
        {lines}
      </div>
    )
  const total = tools.reduce(
    (sum, p) => sum + (p.endedAt && p.endedAt > p.startedAt ? p.endedAt - p.startedAt : 0),
    0,
  )
  return (
    <Task aria-label="What the workspace read">
      <TaskTrigger
        title={stepsSummary(turn.parts)}
        extra={total > 0 && <span className="text-micro tabular-nums">· {seconds(total)}</span>}
      />
      <TaskContent>{lines}</TaskContent>
    </Task>
  )
}

const TODO_WORDS: Record<TodoState, string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  waiting_on_you: "Waits on you",
  skipped: "Skipped",
  failed: "Did not happen",
}

function TodoMark({ state }: { state: TodoState }) {
  if (state === "done")
    return (
      <span className="grid size-4 flex-none place-items-center rounded-full bg-success text-canvas">
        <Icon name="check" size={11} strokeWidth={2.5} />
      </span>
    )
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 flex-none place-items-center rounded-full border-[1.5px]",
        state === "active" && "border-tint",
        state === "waiting_on_you" && "border-dashed border-tint",
        state === "failed" && "border-attention",
        (state === "pending" || state === "skipped") && "border-muted-foreground",
      )}
    >
      {state === "active" && (
        <span className="size-1.5 rounded-full bg-tint motion-safe:animate-pulse" />
      )}
    </span>
  )
}

/** The turn's own checklist: each item ticks when what it is tied to has finished, never on a claim. */
export function TurnTodo({ turn }: { turn: ChatTurn }) {
  const todo = turn.parts.find(
    (p): p is Extract<typeof p, { type: "data-todo" }> => p.type === "data-todo",
  )
  if (!todo) return null
  const items = todo.data.map((item) => ({ item, state: todoState(turn, item.link) }))
  const done = items.filter((i) => i.state === "done").length
  const waiting = items.filter((i) => i.state === "waiting_on_you").length
  const streaming = turn.status === "streaming"
  return (
    <Plan isStreaming={streaming} defaultOpen>
      <PlanHeader
        title={streaming ? "Working through it" : "Plan for this answer"}
        extra={
          <span className="text-micro font-normal text-muted-foreground tabular-nums">
            {done} of {items.length} done
            {waiting > 0 && ` · ${waiting} ${waiting === 1 ? "waits" : "wait"} on you`}
          </span>
        }
      />
      <PlanContent>
        <ol className="grid gap-2">
          {items.map(({ item, state }) => (
            <li key={item.id} className="flex items-center gap-2.5 text-meta">
              <TodoMark state={state} />
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  state === "done" ? "text-foreground" : "text-soft",
                  state === "skipped" && "text-muted-foreground line-through",
                )}
              >
                {item.label}
              </span>
              <span
                className={cn(
                  "flex-none text-micro",
                  state === "waiting_on_you" ? "text-tint" : "text-muted-foreground",
                  (state === "done" || state === "pending") && "sr-only",
                )}
              >
                {TODO_WORDS[state]}
              </span>
            </li>
          ))}
        </ol>
      </PlanContent>
    </Plan>
  )
}

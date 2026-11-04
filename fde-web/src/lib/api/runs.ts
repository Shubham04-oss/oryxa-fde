import { z } from "zod"
import { UserId } from "./schemas"

// Agent runs (crates/oryxa-fde-agent/openapi.json, generated into agent-runs.gen.ts) and the harness events a
// run writes (`oryxa_fde_agent::event`, sandbox/harness/README.md). runs.test.ts checks these against the spec,
// and checks the event parser against the harness's recorded session.

function id<TBrand extends string>() {
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .brand<TBrand>()
}

export const AgentRunId = id<"AgentRunId">()
export type AgentRunId = z.infer<typeof AgentRunId>
export const ApprovalId = id<"ApprovalId">()
export type ApprovalId = z.infer<typeof ApprovalId>

const instant = z.iso.datetime({ offset: true })
const count = z.int().nonnegative()

/** A run's life: queued, then running (perhaps waiting on approvals), then finished or failed. */
export const RunState = z.enum(["queued", "running", "waiting_for_approval", "finished", "failed"])
export type RunState = z.infer<typeof RunState>

export const Repository = z.object({ owner: z.string(), name: z.string(), base: z.string() })
export type Repository = z.infer<typeof Repository>

export const Usage = z.object({ input_tokens: count, output_tokens: count })

/** What became of a finished run's work. */
export const Delivery = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("no_changes") }),
  z.object({ status: z.literal("pull_request"), number: count, url: z.string() }),
  z.object({ status: z.literal("failed") }),
])
export type Delivery = z.infer<typeof Delivery>

export const RunOut = z.object({
  id: AgentRunId,
  state: RunState,
  task: z.string(),
  repository: Repository,
  /** A WorkOS user id. */
  created_by: UserId,
  created_at: instant,
  started_at: instant.nullish(),
  ended_at: instant.nullish(),
  /** Why a failed run failed: `approval_rejected`, `cancelled`, `timed_out`, `over_budget` and so on. */
  failure: z.string().nullish(),
  /** The approval the run waits for, while `waiting_for_approval`. */
  pending_approval: ApprovalId.nullish(),
  usage: Usage,
  delivery: Delivery,
})
export type RunOut = z.infer<typeof RunOut>

export const ApprovalOut = z.object({
  id: ApprovalId,
  /** The action on the company's approval list, e.g. `deploy`. */
  action: z.string(),
  title: z.string(),
  /** The tool and its full input, exactly as they run if approved. */
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  requested_at: instant,
  decision: z
    .object({ outcome: z.enum(["approved", "rejected"]), by: z.string(), at: instant })
    .nullish(),
})
export type ApprovalOut = z.infer<typeof ApprovalOut>

export const EventsOut = z.object({ events: z.array(z.record(z.string(), z.unknown())) })

/** What starting a run takes: the task, and the repository and branch it starts from. */
export type CreateRun = { task: string; repository: Repository }

const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"])
export type ToolStatus = z.infer<typeof ToolStatus>
const line = { v: z.literal(1), seq: count }

/** One harness event line. Each comes from a sandbox that runs untrusted code, so each is parsed. */
export const RunEvent = z.discriminatedUnion("type", [
  z.object({
    ...line,
    type: z.literal("plan"),
    entries: z.array(
      z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }),
    ),
  }),
  z.object({ ...line, type: z.literal("message"), text: z.string() }),
  z.object({
    ...line,
    type: z.literal("tool_call"),
    id: z.string(),
    title: z.string(),
    kind: z.enum([
      "read",
      "edit",
      "delete",
      "move",
      "search",
      "execute",
      "think",
      "fetch",
      "other",
    ]),
    status: ToolStatus,
  }),
  z.object({
    ...line,
    type: z.literal("file_change"),
    tool_call_id: z.string(),
    path: z.string(),
    change: z.enum(["created", "modified", "deleted"]),
  }),
  z.object({
    ...line,
    type: z.literal("command"),
    tool_call_id: z.string(),
    command: z.string(),
    status: ToolStatus,
  }),
  z.object({
    ...line,
    type: z.literal("approval_request"),
    id: ApprovalId,
    tool_call_id: z.string(),
    action: z.string(),
    title: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({ ...line, type: z.literal("usage"), usage: Usage }),
  z.object({
    ...line,
    type: z.literal("result"),
    outcome: z.enum(["success", "error", "rejected", "cancelled"]),
    reason: z.string().optional(),
    text: z.string(),
    turns: count,
    usage: Usage,
  }),
])
export type RunEvent = z.infer<typeof RunEvent>

/**
 * The events that parse, in `seq` order with each `seq` once, and how many did not. A newer harness's unknown
 * event is counted and shown as such, rather than blanking the review screen.
 */
export function parseEvents(raw: Array<unknown>): { events: Array<RunEvent>; skipped: number } {
  const bySeq = new Map<number, RunEvent>()
  let skipped = 0
  for (const value of raw) {
    const parsed = RunEvent.safeParse(value)
    if (parsed.success) bySeq.set(parsed.data.seq, parsed.data)
    else skipped += 1
  }
  return { events: [...bySeq.values()].sort((a, b) => a.seq - b.seq), skipped }
}

/** Two event lists as one: stored and live lines overlap, so each `seq` is kept once, in order. */
export function mergeEvents(a: Array<RunEvent>, b: Array<RunEvent>): Array<RunEvent> {
  const bySeq = new Map<number, RunEvent>()
  for (const event of [...a, ...b]) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq)
}

type Of<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>

/** What the review screen shows of a run's events. */
export type RunSummary = {
  /** The latest plan: each plan event replaces the last. */
  plan: Of<"plan">["entries"]
  /** Each file the run changed, with its last change, in the order first touched. */
  changes: Array<{ path: string; change: Of<"file_change">["change"] }>
  /** Every shell command, in order, with how it ended: tests and builds show here. */
  commands: Array<{ seq: number; command: string; status: ToolStatus }>
  messages: Array<{ seq: number; text: string }>
  result: Of<"result"> | null
}

export function summarize(events: Array<RunEvent>): RunSummary {
  const summary: RunSummary = { plan: [], changes: [], commands: [], messages: [], result: null }
  const changed = new Map<string, Of<"file_change">["change"]>()
  for (const event of events) {
    if (event.type === "plan") summary.plan = event.entries
    else if (event.type === "file_change") changed.set(event.path, event.change)
    else if (event.type === "command")
      summary.commands.push({ seq: event.seq, command: event.command, status: event.status })
    else if (event.type === "message") summary.messages.push({ seq: event.seq, text: event.text })
    else if (event.type === "result") summary.result = event
  }
  summary.changes = [...changed].map(([path, change]) => ({ path, change }))
  return summary
}

/** A run that may still change: the screen follows it. */
export const isActive = (state: RunState) =>
  state === "queued" || state === "running" || state === "waiting_for_approval"

/** The pull request's address, only when it is a GitHub pull request page, so a link cannot go elsewhere. */
export function pullRequestUrl(delivery: Delivery): string | null {
  if (delivery.status !== "pull_request") return null
  let url: URL
  try {
    url = new URL(delivery.url)
  } catch {
    return null
  }
  const ok =
    url.protocol === "https:" &&
    url.host === "github.com" &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url.pathname)
  return ok ? url.href : null
}

// The API's own rules for a run's repository (`oryxa_fde_agent::git::Repository::new`) and task: each part
// reaches a command line in the sandbox. Checked here too, so the form can say which field is wrong.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/

function branchOk(base: string) {
  return (
    BRANCH.test(base) &&
    !base.endsWith("/") &&
    !base.endsWith(".") &&
    !base.endsWith(".lock") &&
    !base.includes("..") &&
    !base.includes("//") &&
    !base.includes("/.")
  )
}

/** The first part of a repository the API would refuse, or null. */
export function repositoryProblem(r: Repository): "owner" | "name" | "base" | null {
  if (!OWNER.test(r.owner)) return "owner"
  if (!NAME.test(r.name)) return "name"
  return branchOk(r.base) ? null : "base"
}

const MAX_TASK_BYTES = 64 * 1024

/** Whether the API takes this task: some text, at most 64 KiB, no control characters but newline and tab. */
export function taskOk(task: string) {
  return (
    task.trim().length > 0 &&
    new TextEncoder().encode(task).byteLength <= MAX_TASK_BYTES &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(task)
  )
}

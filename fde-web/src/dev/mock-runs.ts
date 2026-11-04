// Agent runs for the dev mock (mock-api.ts), typed from agent-runs.gen.ts so they follow the run spec. The
// events follow the harness's format (sandbox/harness/README.md). Sample data only: every task, repository
// and command here is invented.

import type { components } from "../lib/api/agent-runs.gen"

type S = components["schemas"]
type Line = Record<string, unknown> & { v: 1; seq: number; type: string }

export type MockRun = { run: S["RunOut"]; events: Array<Line>; approvals: Array<S["ApprovalOut"]> }

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/** Numbers each event in order, as the harness does. */
function lines(...events: Array<Record<string, unknown> & { type: string }>): Array<Line> {
  return events.map((event, seq) => ({ v: 1, seq, ...event }))
}

const step = (content: string, status: "pending" | "in_progress" | "completed") => ({
  content,
  status,
})
const tool = (id: string, title: string, kind: string, status: string) => ({
  type: "tool_call",
  id,
  title,
  kind,
  status,
})

const DISPATCH = { owner: "kestrel-freight", name: "dispatch-copilot", base: "main" }
const FORECASTS = { owner: "lumen-grocers", name: "store-forecasts", base: "main" }

function run(
  id: string,
  task: string,
  repository: S["Repository"],
  state: string,
  minutes: number,
  extra: Partial<S["RunOut"]> = {},
): S["RunOut"] {
  return {
    id,
    task,
    repository,
    state,
    created_by: "usr_riya",
    created_at: ago(minutes),
    started_at: state === "queued" ? null : ago(minutes - 1),
    ended_at: null,
    failure: null,
    pending_approval: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    delivery: { status: "none" },
    ...extra,
  }
}

export function seedRuns(): Record<string, Array<MockRun>> {
  const push = {
    command: "git push origin agent/run_k2",
    title: "Push agent/run_k2 to kestrel-freight/dispatch-copilot",
  }
  const deploy = {
    command: "npm run deploy -- --env production",
    title: "Deploy forecasts to the buyers' dashboard",
  }
  return {
    prj_kestrel_dispatch: [
      {
        run: run(
          "run_k2",
          "Add driver-hours checks to the eval suite, then open a pull request.",
          DISPATCH,
          "waiting_for_approval",
          20,
          { pending_approval: "apr_k2", usage: { input_tokens: 48_200, output_tokens: 5_100 } },
        ),
        events: lines(
          {
            type: "message",
            text: "I'll add the driver-hours checks to the eval suite and run it.",
          },
          {
            type: "plan",
            entries: [
              step("Add driver-hours rules to the eval suite", "in_progress"),
              step("Run the eval suite", "pending"),
              step("Open a pull request", "pending"),
            ],
          },
          tool("t1", "Read evals/dispatch.yaml", "read", "completed"),
          tool("t2", "Edit evals/dispatch.yaml", "edit", "completed"),
          {
            type: "file_change",
            tool_call_id: "t2",
            path: "evals/dispatch.yaml",
            change: "modified",
          },
          tool("t3", "Write evals/rules/driver_hours.py", "edit", "completed"),
          {
            type: "file_change",
            tool_call_id: "t3",
            path: "evals/rules/driver_hours.py",
            change: "created",
          },
          tool("t4", "Run: npm run evals", "execute", "failed"),
          { type: "command", tool_call_id: "t4", command: "npm run evals", status: "failed" },
          tool("t5", "Edit evals/rules/driver_hours.py", "edit", "completed"),
          {
            type: "file_change",
            tool_call_id: "t5",
            path: "evals/rules/driver_hours.py",
            change: "modified",
          },
          tool("t6", "Run: npm run evals", "execute", "completed"),
          { type: "command", tool_call_id: "t6", command: "npm run evals", status: "completed" },
          {
            type: "plan",
            entries: [
              step("Add driver-hours rules to the eval suite", "completed"),
              step("Run the eval suite", "completed"),
              step("Open a pull request", "in_progress"),
            ],
          },
          tool("t7", `Run: ${push.command}`, "execute", "pending"),
          {
            type: "approval_request",
            id: "apr_k2",
            tool_call_id: "t7",
            action: "push",
            title: push.title,
            tool: "Bash",
            input: { command: push.command },
          },
          { type: "usage", usage: { input_tokens: 48_200, output_tokens: 5_100 } },
        ),
        approvals: [
          {
            id: "apr_k2",
            action: "push",
            title: push.title,
            tool: "Bash",
            input: { command: push.command },
            requested_at: ago(2),
            decision: null,
          },
        ],
      },
      {
        run: run(
          "run_k1",
          "Load the depot rules into the context pack.",
          DISPATCH,
          "finished",
          2_900,
          {
            ended_at: ago(2_860),
            usage: { input_tokens: 61_000, output_tokens: 7_400 },
            delivery: {
              status: "pull_request",
              number: 42,
              url: "https://github.com/kestrel-freight/dispatch-copilot/pull/42",
            },
          },
        ),
        events: lines(
          { type: "message", text: "I'll load each depot's rules sheet into the context pack." },
          {
            type: "plan",
            entries: [
              step("Load the depot rules", "completed"),
              step("Test the loader", "completed"),
            ],
          },
          tool("t1", "Write src/context/depot_rules.ts", "edit", "completed"),
          {
            type: "file_change",
            tool_call_id: "t1",
            path: "src/context/depot_rules.ts",
            change: "created",
          },
          tool("t2", "Edit src/context/pack.ts", "edit", "completed"),
          {
            type: "file_change",
            tool_call_id: "t2",
            path: "src/context/pack.ts",
            change: "modified",
          },
          tool("t3", "Run: npm test", "execute", "completed"),
          { type: "command", tool_call_id: "t3", command: "npm test", status: "completed" },
          {
            type: "result",
            outcome: "success",
            text: "Loaded the depot rules into the context pack, with tests. Opened a pull request.",
            turns: 9,
            usage: { input_tokens: 61_000, output_tokens: 7_400 },
          },
        ),
        approvals: [],
      },
    ],
    prj_lumen_forecast: [
      {
        run: run(
          "run_l2",
          "Rewrite the forecast reasons in buyers' words.",
          FORECASTS,
          "running",
          6,
          {
            usage: { input_tokens: 9_800, output_tokens: 1_200 },
          },
        ),
        events: lines(
          {
            type: "message",
            text: "I'll rewrite the reason templates and check them against the samples.",
          },
          {
            type: "plan",
            entries: [
              step("Rewrite the reason templates", "in_progress"),
              step("Check them on samples", "pending"),
            ],
          },
          tool("t1", "Read src/reasons/templates.ts", "read", "completed"),
          tool("t2", "Edit src/reasons/templates.ts", "edit", "in_progress"),
        ),
        approvals: [],
      },
      {
        run: run(
          "run_l1",
          "Deploy the week 4 forecasts to the buyers' dashboard.",
          FORECASTS,
          "failed",
          1_500,
          {
            ended_at: ago(1_490),
            failure: "approval_rejected",
            usage: { input_tokens: 7_000, output_tokens: 600 },
          },
        ),
        events: lines(
          tool("t1", `Run: ${deploy.command}`, "execute", "pending"),
          {
            type: "approval_request",
            id: "apr_l1",
            tool_call_id: "t1",
            action: "deploy",
            title: deploy.title,
            tool: "Bash",
            input: { command: deploy.command },
          },
          {
            type: "result",
            outcome: "rejected",
            reason: "approval_rejected",
            text: "Stopped: the deploy was rejected.",
            turns: 2,
            usage: { input_tokens: 7_000, output_tokens: 600 },
          },
        ),
        approvals: [
          {
            id: "apr_l1",
            action: "deploy",
            title: deploy.title,
            tool: "Bash",
            input: { command: deploy.command },
            requested_at: ago(1_495),
            decision: { outcome: "rejected", by: "usr_riya", at: ago(1_491) },
          },
        ],
      },
    ],
    prj_bw_referrals: [
      {
        run: run(
          "run_b1",
          "Map the intake form fields from the synthetic letters.",
          { owner: "brightwater", name: "referral-intake", base: "main" },
          "queued",
          1,
        ),
        events: [],
        approvals: [],
      },
    ],
  }
}

const json = (body: unknown, status = 200) => Response.json(structuredClone(body), { status })
const refuse = (status: number, error: string) => Response.json({ error }, { status })
const active = (state: string) =>
  state === "queued" || state === "running" || state === "waiting_for_approval"

/** Ends a run as the API would: failed, with why, and the harness's last line. */
function end(found: MockRun, failure: string, outcome: "rejected" | "cancelled", text: string) {
  found.run.state = "failed"
  found.run.failure = failure
  found.run.pending_approval = null
  found.run.ended_at = new Date().toISOString()
  found.events.push({
    v: 1,
    seq: found.events.length,
    type: "result",
    outcome,
    reason: failure,
    text,
    turns: 0,
    usage: found.run.usage,
  })
}

/**
 * Answers `/v1/companies/<c>/projects/<p>/agent-runs[/...]`, given the parts after `agent-runs`, for a project
 * already checked to be the FDE's. `me` creates and decides.
 */
export async function runRoutes(
  runs: Array<MockRun>,
  method: string,
  parts: Array<string>,
  request: Request,
  me: string,
): Promise<Response | null> {
  const [runId, sub, approvalId, decision] = parts
  if (runId === undefined) {
    if (method === "GET") return json(runs.map((r) => r.run))
    if (method !== "POST") return null
    const body = (await request.json().catch(() => null)) as Partial<S["CreateRun"]> | null
    const task = body?.task?.trim() ?? ""
    if (!task || task.length > 65_536) return refuse(400, "invalid_task")
    const repo = body?.repository
    if (!repo?.owner || !repo.name || !repo.base) return refuse(400, "invalid_repository")
    const created: MockRun = {
      run: { ...run(`run_new_${runs.length + 1}`, task, repo, "queued", 0), created_by: me },
      events: [],
      approvals: [],
    }
    runs.unshift(created)
    return json(created.run, 202)
  }
  const found = runs.find((r) => r.run.id === runId)
  if (!found) return refuse(404, "not_found")
  if (method === "GET" && sub === undefined) return json(found.run)
  if (method === "GET" && sub === "events" && approvalId === undefined)
    return json({ events: found.events })
  if (method === "GET" && sub === "approvals" && approvalId === undefined)
    return json(found.approvals)
  if (method === "POST" && sub === "cancel" && approvalId === undefined) {
    if (!active(found.run.state)) return refuse(409, "rejected_ended")
    end(found, "cancelled", "cancelled", "Stopped: the run was cancelled.")
    return json(found.run, 202)
  }
  if (method === "POST" && sub === "approvals" && approvalId !== undefined) {
    const asked = found.approvals.find((a) => a.id === approvalId)
    if (!asked) return refuse(404, "not_found")
    if (asked.decision) return refuse(409, "rejected_already_decided")
    if (found.run.pending_approval !== approvalId) return refuse(409, "rejected_not_pending")
    if (decision !== "approve" && decision !== "reject") return null
    const outcome = decision === "approve" ? "approved" : "rejected"
    asked.decision = { outcome, by: me, at: new Date().toISOString() }
    if (outcome === "approved") {
      found.run.state = "running"
      found.run.pending_approval = null
    } else {
      end(found, "approval_rejected", "rejected", "Stopped: the action was rejected.")
    }
    return json(asked)
  }
  return null
}

# oryxa-fde-agent

Agent runs: the run model, the context pack, the harness event format, and the run service with its API, which
`oryxa-fde-api` mounts. The sandbox side is in `sandbox/` (gateway Worker, harness, image).

## A run

1. **Create.** `POST /v1/companies/<company>/projects/<project>/agent-runs` with a task and a GitHub repository
   (owner, name, base branch) needs `work` on the project. The run is stored as `queued` and gets its own task.
2. **Queue.** Runs in one company take turns, since they share the company's sandbox and its `/workspace`. Then
   the project's budget is checked: a used-up budget fails the run (`over_budget`) before anything starts.
3. **Prepare.** The run service:
   - builds the context pack from the store (scope, criteria, decisions) and service config (model, region, turns,
     approval list);
   - refuses to start if an action on the approval list has no host held for it in the company's outbound policy,
     since approving it would gate nothing at the network;
   - starts the sandbox and checks out a fresh copy of the base branch in `/workspace/repo`;
   - writes the pack through the gateway and compares the digest it reads back;
   - then starts the harness on it. Any failure here ends the run with `setup_failed`.
4. **Run.** Each harness line is applied to the run model, stored in the transcript and posted to live output.
   - An `approval_request` is stored and the run waits.
   - An approval request whose action is not on the run's approval list stops the run.
   - `approve` or `reject` records the FDE's decision. The run's task then opens the action's hosts at the
     gateway (on approval), writes the decision to the harness's stdin, and only then changes state.
   - Those hosts are open for that run and that one approved tool call: the run closes them as soon as the call
     returns (its `tool_call` completes or fails), and a five-minute limit is the backstop. A second deploy, from
     the agent or anything it left running, needs a new approval.
   - `usage` events count against the spend budget, and the time limit is the lower of what is left of the
     budget's minutes and the longest one run may take.
   - Cancel, a time limit or a used-up budget sends the harness a `cancel` line.
5. **Deliver.** A finished run's work goes to the branch `fde-agent/<run>` with a draft pull request, both from
   inside the sandbox so the gateway adds the GitHub token by reference. The company's outbound policy must allow
   `github.com` and `api.github.com` with that token.
6. **End.** The run's end, its use (seconds and dollars) and `AgentRunFinished` (ids and the outcome only) are
   recorded together.

Everything fails closed:
- a store that cannot keep the transcript or an approval request stops the run (`store_unavailable`);
- output that is not a harness line stops it (`bad_output`);
- a decision that cannot reach the harness, or whose hosts cannot open, ends it (`decision_undelivered`);
- a harness that does not stop within the grace period has its sandbox destroyed.

## API

`openapi.json` holds the routes: runs, their events and approvals, cancel, and the project's agent budget (set it
with `manage` on the company). Decisions and cancels go through the store, so the run's task finds them however
many API tasks there are; it polls every second and is woken at once on the same task.

## Configuration

In `oryxa-fde-api`'s environment (`src/prod.rs`): without `SANDBOX_GATEWAY_URL` agent runs are off and no route is
mounted. `AGENT_MODEL` and `AGENT_REGION` are then required; budgets, prices, the approval list and the longest run
have defaults.

## Storage

Runs, their transcripts and approvals, and each project's budget and use are in `oryxa-fde-store`'s agent run
tables (migration `0006_agent_runs.sql`, `src/runs.rs`), with forced row-level security. `pg.rs` implements
`RunStore` on them: every call is one transaction scoped to the project, and a run's end commits with its use and
`agent-run.finished`. Decisions and cancels are read from there, so any API task can take them. `InMemoryRuns` is
for tests.

## Contracts with other streams

- **Live output (web stream).** The API posts harness lines as NDJSON to
  `{REALTIME_URL}/internal/v1/tenants/<tenant>/companies/<company>/projects/<project>/agent-runs/<run>/events`,
  with `Authorization: Bearer <REALTIME_TOKEN>`. It is best effort; the transcript is the record.

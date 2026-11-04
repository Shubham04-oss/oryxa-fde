# oryxa-fde-agent

Agent runs: the run model, the context pack, the harness event format, and the run service with its API, which
`oryxa-fde-api` mounts. The sandbox side is in `sandbox/` (gateway Worker, harness, image).

## A run

1. **Create.** `POST /v1/companies/<company>/projects/<project>/agent-runs` with a task and a GitHub repository
   (owner, name, base branch) needs `work` on the project. The run is stored as `queued` and gets its own task.
2. **Queue.** Runs in one company take turns, oldest first, since they share the company's sandbox and its
   `/workspace`. The turn is a lease in the store, so runs started on different API tasks take turns too; a queued
   run can be cancelled. Once the run has the sandbox, its part of the project's budget is reserved under a lock on
   the project's budget row: what is left after ended runs' use and other live runs' reservations. A used-up budget
   fails the run (`over_budget`) before anything starts. A heartbeat renews the lease and keeps the reservation
   until the run's end is recorded; a run whose API task is gone lets go of both within a minute.
3. **Prepare.** The run service:
   - builds the context pack from the store (scope, criteria, decisions) and service config (model, region, turns,
     approval list);
   - refuses to start if an action on the approval list has no host held for it in the company's outbound policy,
     since approving it would gate nothing at the network;
   - destroys whatever container the sandbox still has and starts a fresh one, so nothing an earlier run left (a
     harness orphaned by a deploy, or whatever its agent left running) shares it; a sandbox that will not stop is
     never reused;
   - checks out a fresh copy of the base branch in `/workspace/repo`;
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
- hosts that cannot be closed, after their approved call returns or at the run's end, fail it and destroy the
  sandbox (`grant_not_closed`), even if the harness had finished: nothing is delivered from that sandbox;
- a run that loses its lease (the store refuses to renew it, or cannot renew it before it would lapse) destroys
  the sandbox and ends (`store_unavailable`), since another run may already have been given it;
- a harness that does not stop within the grace period has its sandbox destroyed;
- a sandbox that will not stop is asked three times; its grants are then closed one by one, and the next run
  destroys it before starting, or does not start.

## API

`openapi.json` holds the routes: runs, their events and approvals, cancel, and the project's agent budget (set it
with `manage` on the company). Decisions and cancels go through the store, so the run's task finds them however
many API tasks there are; it polls every second and is woken at once on the same task.

## Configuration

In `oryxa-fde-api`'s environment (`src/prod.rs`): without `SANDBOX_GATEWAY_URL` agent runs are off and no route is
mounted. `AGENT_MODEL` and `AGENT_REGION` are then required; budgets, prices, the approval list and the longest run
have defaults.

## Storage

Runs, their transcripts and approvals, each project's budget and use, and each company's sandbox lease are in
`oryxa-fde-store`'s agent run tables (migration `0007_agent_runs.sql`, `src/runs.rs`), with forced row-level
security and updates limited by column. `pg.rs` implements `RunStore` on them: every call is one transaction scoped
to the project, and a run's end commits with its use, the lease's release and `agent-run.finished`, once.
Decisions and cancels are read from there, so any API task can take them. `InMemoryRuns` is for tests.

A run whose API task stopped (a deploy) holds neither the sandbox nor any budget once its heartbeat lapses. Every
API task sweeps for such runs when it starts and then every minute: each fails as `interrupted` (one whose model had
already ended keeps that end) and its time up to its last heartbeat, and its model spend, are counted. A run that
is still driven is never swept, whatever it reads; a new run counts as driven for its first minute. The sweep finds
them across tenants as the relay role, which may read only the ids of such runs, and ends each in its project's
own transaction. Its harness cancels itself when the gateway closes its stdin with the API task.

## Contracts with other streams

- **Live output (web stream).** The API posts harness lines as NDJSON to
  `{REALTIME_URL}/internal/v1/tenants/<tenant>/companies/<company>/projects/<project>/agent-runs/<run>/events`,
  with `Authorization: Bearer <REALTIME_TOKEN>`. It is best effort; the transcript is the record.

# Harness

Runs one agent run inside a company's sandbox. It runs the Claude Agent SDK headless on Amazon Bedrock and turns
the SDK's output into the internal event format, one JSON object per line on stdout. It also routes permission
prompts for actions on the company's approval list to an approval channel. The run model and the event types on
the API side are in `crates/oryxa-fde-agent`.

```
oryxa-harness --pack /etc/oryxa/runs/<run>.json --sha256 <hex>
```

The gateway starts it as root (`POST /runs/<run>/harness`). Root is needed for two things only: reading the pack,
which only root can open, and starting the agent as another user. Right after it starts the SDK's agent process
as `agent`, the harness drops to its own user `harness` for good (`src/users.ts`). The agent's tool calls, and
anything they leave running, then cannot open the harness's stdin through `/proc`, read its output or signal it.
Started as any other user, the harness refuses to run (`not_root`).

| Stream | Carries                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stdout | Events: `plan`, `message`, `tool_call`, `file_change`, `command`, `approval_request`, `usage`, then one `result`. Each line has `v: 1` and a `seq` from 0.            |
| stdin  | `{"type":"approval_decision","id":"apr_…","outcome":"approved"\|"rejected"}` and `{"type":"cancel"}`. The API writes them through the gateway's `/exec/<exec>/stdin`. |
| stderr | Diagnostics, the agent process's included. Never parsed.                                                                                                              |

The exit code is 0 for `success`, 1 for `error`, 2 for `rejected` and 3 for `cancelled`. The `result` event carries
the outcome.

## Context pack

The API builds the pack (`oryxa_fde_agent::ContextPack`), and the gateway writes it as root to
`/etc/oryxa/runs/<run>.json` before the run starts. It holds the task, the agreed scope of work, the success
criteria, decisions, conventions and the agent config: the Bedrock model, the region, the maximum number of turns
and the approval list. The harness refuses a pack whose SHA-256 is not the one on its command line, and one that
does not match the schema, including one whose approval pattern does not compile. It applies the same size limits
as the API, in bytes (`test/fixtures/pack-limits.json`, checked by both sides' tests). The project context goes
into the system prompt as fenced data, not as instructions.

## What the run may do

- **No credentials.** The SDK runs with `CLAUDE_CODE_USE_BEDROCK=1` and `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`, and
  its environment is built from an explicit list (`PATH`, locale, the CA variables, and `HOME=/home/agent`).
  Nothing else from the sandbox is inherited. The gateway's outbound handler adds the Bedrock credential to requests for the
  allowed `bedrock-runtime.<region>.amazonaws.com` host, using a Bedrock API key as a bearer token. There is no
  claude.ai login.
- **No repository settings.** The run passes `settingSources: []`. The SDK otherwise loads `.claude/` settings
  and hooks from the repository, and their allow rules would skip approvals.
- **A coding tool set.** Read, Write, Edit, NotebookEdit, Glob, Grep, Bash, WebFetch and the task tools. The
  SDK's default set also schedules, messages and spawns agents.
- **Approvals.** A tool call that matches a rule on the approval list (tool name, and a regular expression over
  the command or the JSON input) emits `approval_request` and waits. The request carries the tool and its full
  input, so an engineer approves exactly what will run. An input over 256 KiB is refused, never truncated.
  Approval lets the call run. Rejection denies it, aborts the SDK and ends the run with `result` `rejected`. An
  aborted run counts as a rejection. The gateway also holds the hosts behind an approval action
  until the FDE approves it, so the prompt is not the only gate.
- **Cancel.** A `cancel` line aborts the SDK, rejects a pending approval and ends the run with `result`
  `cancelled`, even if the SDK is stuck. The API sends it to cancel a run or at its time limit. A closed stdin
  does the same: the gateway closes it when the API task driving the run is gone (a deploy), and a run nobody can
  approve or cancel must not go on.
- **Error text.** An error `result` shows fixed text. The SDK's own messages go to stderr.
- **Usage.** After each model response, a `usage` event carries the run's tokens so far, so the API can stop a run
  at its spend budget. The SDK's assistant messages carry only the usage known when a response starts; the
  harness asks for partial messages (`includePartialMessages`) and takes the final count from each response's
  `message_delta`. Cache reads and writes count as input in full, so a budget stops a run early rather than late.

## Develop

```bash
npm ci
npm run check   # prettier and tsc
npm test        # vitest
npm run build   # dist/, as the image builds it
```

`test/fixtures/session.sdk.jsonl` is a real recording. `test/record/record.mjs` ran the harness and the SDK in
the sandbox image against a local model server that plays scripted turns: plan, read, edit, add a test, a failing
`npm test`, a fix, a passing `npm test`. The SDK executed every tool. The replay test pins the events it produced,
`session.events.jsonl`, and the Rust contract test parses the same file. Record again after an SDK upgrade, and
read the new events before committing them.

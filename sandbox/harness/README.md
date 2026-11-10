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
  its environment is built from an explicit list (`PATH`, locale and the CA variables), with the run's own home.
  Nothing else from the sandbox is inherited. The gateway's outbound handler authenticates requests to the
  allowed `bedrock-runtime.<region>.amazonaws.com` host: it signs them with short-lived IAM credentials (SigV4,
  see `sandbox/gateway/README.md`), or adds a Bedrock API key as a bearer token. There is no claude.ai login.
- **No repository settings.** The run passes `settingSources: []`. The SDK otherwise loads `.claude/` settings
  and hooks from the repository, and their allow rules would skip approvals.
- **A clean start.** Before the agent starts, root kills every process of `agent` left from an earlier run (one
  `kill(-1)` run as `agent`, which no fork slips past, always run once), confirms in `/proc` that none is left and
  otherwise ends the run as `unclean_sandbox`. A zombie counts as gone only with one thread: a leader whose main
  thread exited alone is a zombie whose other threads still run. Only then does it remove every earlier run's
  directories (`/tmp/oryxa-claude-*`, `/tmp/oryxa-opencode-*`, `/etc/oryxa/opencode-*`), listing their parents and
  never following a link, and make this run's (`src/clean.ts`). So nothing an earlier run left running can race the
  cleanup. No process is exempt from the scan: pid 1, the image's `sleep infinity`, runs as `init`, so the agent
  can neither trace it nor write its memory, and an image that ran it as `agent` could never start a run. The
  killer is itself an agent process, so it is waited on for 2 seconds at most, then killed by root, and the scan
  decides.
  Each run, on either backend, gets a fresh home with its own XDG and temp directories. With
  `settingSources: []` the CLI ignored user settings, hooks, MCP servers, `CLAUDE.md`, skills, agents and commands
  planted in its home, but its shell tool sources `~/.bashrc`, so a shared home would let one run change the
  next one's commands. Today the API also gives every run a new container; this does not rely on it.
- **A coding tool set.** Read, Write, Edit, NotebookEdit, Glob, Grep, Bash, WebFetch and the task tools. The
  SDK's default set also schedules, messages and spawns agents.
- **Approvals.** A tool call that matches a rule on the approval list (tool name, and a regular expression over
  the command for `Bash`, or else over each string value in the input, never its key names) emits
  `approval_request` and waits. Key names differ between harnesses (`file_path` here, `path` on OpenCode), values
  do not, so one rule matches the same call on both. The request carries the tool and its full
  input, so an engineer approves exactly what will run. An input over 256 KiB is never matched: like one
  nested too deep to walk, it is covered by any rule on its tool, whatever the pattern, and then refused, never
  truncated.
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

## OpenCode backend

`ORYXA_FDE_HARNESS=opencode` in the harness's environment runs the run on OpenCode instead of the Claude Agent SDK
(`claude`, the default; any other value ends the run as `unknown_harness`). Nothing sets it yet: the gateway passes
only `HOME`, so every run is a Claude run until the pack names the harness. ADR 0004 keeps it off until the pinned
version passes the gate, and the sandbox image does not carry the binary yet. What it does rests on the spike's
findings in `OPENCODE.md`:

- **Protocol.** The harness starts `opencode acp` as `agent` and speaks to it with the Agent Client Protocol's own
  TypeScript library (`@agentclientprotocol/sdk`, pinned). It handles two things: permission requests and session
  updates. It offers OpenCode no file system or terminal.
- **Policy is a file.** `src/opencode.json` is the spike's verified `intended.json` (every tool asks, the rest denied,
  project config, plugins, MCP, sharing and updates off). Root writes it per run into a fresh directory under
  `/etc/oryxa` with only the model, region and turn limit filled in, and the environment is built from a list:
  OpenCode's disable switches, the run's fresh home and XDG and temp directories, and placeholder Bedrock keys
  (`placeholder-access-key-id`), which the outbound handler drops before it signs again.
- **Approvals.** Every tool call asks, reads included. A call the company's list does not cover is approved at once;
  one it covers waits for an engineer, as on the Claude backend. Rules name the SDK's tools, so OpenCode's are mapped
  (`shell` is `Bash`, `read` is `Read`, …). The answer is always once or reject, never always. A tool outside the
  coding set (`skill`, `opencode_worktree_remove`, anything new) is rejected, and a rejection ends the run.
- **Events.** Message chunks are joined, OpenCode's todo list becomes the plan, an edit's diff becomes a
  `file_change`, and a `shell` call becomes a `command` that fails when its exit code is not 0 (ACP says `completed`).
- **Usage and limits.** OpenCode reports usage once per turn, and a run is one turn, so the `usage` event comes at
  the end, with cache and reasoning tokens counted in full. The pack's turn limit is OpenCode's step limit, and the
  harness has its own one-hour deadline, because OpenCode retries a failing model forever. Cancel and the deadline
  send `session/cancel`; OpenCode then gets five seconds before its stdin is closed. A model OpenCode reports
  differently from the one asked for ends the run (`model_unavailable`), since an unknown id falls back to another.

`test/opencode.test.ts` replays the spike's recorded sessions through the backend against a fake ACP peer
(`test/acp-peer.ts`); `test/fixtures/opencode/session-healthz.events.jsonl` pins the events of the full session.

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

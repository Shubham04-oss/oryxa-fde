# Harness

Runs one agent run inside a company's sandbox. It runs the Claude Agent SDK headless on Amazon Bedrock and turns
the SDK's output into the internal event format, one JSON object per line on stdout. It also routes permission
prompts for actions on the company's approval list to an approval channel. The run model and the event types on
the API side are in `crates/oryxa-fde-agent`.

```
oryxa-harness [/workspace/.oryxa/context.json]
```

| Stream | Carries                                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stdout | Events: `plan`, `message`, `tool_call`, `file_change`, `command`, `approval_request`, then one `result`. Each line has `v: 1` and a `seq` from 0.        |
| stdin  | Decisions: `{"type":"approval_decision","id":"apr_…","outcome":"approved"\|"rejected"}`. The API writes them through the gateway's `/exec/<exec>/stdin`. |
| stderr | The SDK's diagnostics. Never parsed.                                                                                                                     |

The exit code is 0 for `success`, 2 for `rejected` and 1 for `error`. The `result` event carries the outcome.

## Context pack

The API builds the pack (`oryxa_fde_agent::ContextPack`) and writes it to `/workspace/.oryxa/context.json`
before the run starts. It holds the task, the agreed scope of work, the success criteria, decisions, conventions
and the agent config: the Bedrock model, the region, the maximum number of turns and the approval list. The
harness refuses a pack that does not match the schema, including one whose approval pattern does not compile.
The project context goes into the system prompt as fenced data, not as instructions.

## What the run may do

- **No credentials.** The SDK runs with `CLAUDE_CODE_USE_BEDROCK=1` and `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`, and
  its environment is built from an explicit list (`PATH`, `HOME`, locale, the CA variables). Nothing else from
  the sandbox is inherited. The gateway's outbound handler adds the Bedrock credential to requests for the
  allowed `bedrock-runtime.<region>.amazonaws.com` host, using a Bedrock API key as a bearer token. There is no
  claude.ai login.
- **No repository settings.** The run passes `settingSources: []`. The SDK otherwise loads `.claude/` settings
  and hooks from the repository, and their allow rules would skip approvals.
- **A coding tool set.** Read, Write, Edit, NotebookEdit, Glob, Grep, Bash, WebFetch and the task tools. The
  SDK's default set also schedules, messages and spawns agents.
- **Approvals.** A tool call that matches a rule on the approval list (tool name, and a regular expression over
  the command or the JSON input) emits `approval_request` and waits. The request carries the tool and its full
  input, so an engineer approves exactly what will run. An input over 256 KiB is refused, never truncated.
  Approval lets the call run. Rejection denies it, aborts the SDK and ends the run with `result` `rejected`. A
  closed stdin or an aborted run counts as a rejection.
- **Error text.** An error `result` shows fixed text. The SDK's own messages go to stderr.

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

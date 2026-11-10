# The agent fleet

Who builds what, on which model, and how we keep the machines healthy. `CLAUDE.md` is still the
contract; this page adds the fleet rules on top of it.

Only Claude accounts and OpenCode work on this repo. Codex/ChatGPT and Cursor are not used.

## Tiers

| Tier | Who | Use it for |
| --- | --- | --- |
| **Builders** | The four Claude accounts, one per role in `CLAUDE.md` | Every PR. Design, ADRs, Rust crates, the web app, infra, reviews. |
| **Fast tier** | OpenCode: DeepSeek V4.1 Flash (free and Workers AI), GLM 5.3 (Workers AI) | Research, lookups, triage, docs checks, test scaffolding, mechanical edits, a second-opinion security pass |
| **Escalation** | Claude on AWS Bedrock or Google Vertex | Only when the builders hit rate limits or a job needs it, and only with the lead's OK (it is billed per token) |

### Which model for which job

| Job | Model |
| --- | --- |
| Design, ADRs, hard Rust (authz, events, store, sandbox), lead review | Claude Fable 5.2 or Opus 5.5, effort high or xhigh |
| Routine implementation inside a well-specified issue | Claude Sonnet 5.5 |
| One-line lookups, status checks, machine checks | Claude Haiku 5.5, or DeepSeek V4.1 Flash |
| "Find where X is", "list what calls Y", summarise a doc or log | DeepSeek V4.1 Flash |
| Second-opinion security review of PRs that touch authz, sandbox, outbound HTTP, secrets or events | GLM 5.3 (`cloudflare-workers-ai/@cf/zai-org/glm-5.3`) |
| Draft tests, fixtures, doc updates for a builder to check | DeepSeek V4.1 Flash or GLM 5.3 |

Default to the cheapest tier that can do the job well. A builder hands a task down when it is
self-contained and checkable; it never hands down a decision.

### Fast-tier rules

- **Works for a builder.** It runs inside a builder's issue and branch. The builder reviews the
  output, commits it under its own role, and owns the PR. The fast tier never opens a PR,
  merges, labels, or comments on GitHub by itself.
- **Code and docs only.** It sees the repo and public docs. Secrets and customer data never go to it,
  and neither do `.env*`, `*.pem` or `*.key` files, tokens, or logs that hold them.
- **Its output is untrusted** like anything else an agent reads: check it, test it, and never paste it
  into a security rule unread.
- **A GLM 5.3 security pass does not replace lead review.** It adds findings for the builder to fix
  or answer on the PR.

## Machines

| Machine | Hardware | Good for | Heavy jobs at once |
| --- | --- | --- | --- |
| Linux box | 4 cores, 23 GB RAM, 4 GB swap | Lead session, reviews, fast-tier runs, light jobs | **1** Rust build |
| Mac mini | M4, 10 cores, 16 GB | Main build machine for a Rust role | **2** Rust builds |
| MacBook Pro | M1 Pro, 10 cores, 16 GB | One builder; the founder also uses it | **1** Rust build |

A heavy job is anything that compiles the workspace (`cargo build/test/clippy`), a `pnpm build`, or a
live-test stack. Fast-tier agents and read-only research do not count, but keep them to about four
per machine.

## Keeping the machines healthy

- **Check before you start a heavy job.** Count the `cargo`/`rustc` processes already running and
  look at swap. On the Linux box, don't start a build when swap is over 75% used or a build
  is already running: queue the work or run it on the Mac mini.
- **One worktree per issue, removed when the PR merges or closes.** Each `target/` is several GB:
  `git worktree remove <path>` (or `cargo clean` first if it is a long-lived checkout).
- **Containers you start, you stop.** Name them with the issue number (`fde-92-pg`) and remove them
  when the run ends, pass or fail. Never stop containers you did not start: other projects share
  these machines.
- **No orphan processes.** Dev servers, watchers and `--ignored` test stacks end with the task.
  Delegated agents stop everything they started before they report back.
- **Disk:** if a machine drops under 30 GB free, clear merged worktrees, `cargo clean` stale ones,
  and `docker image prune` images that only this repo uses.
- **Long, parallel work goes to the Macs.** Keep the Linux box free to coordinate.

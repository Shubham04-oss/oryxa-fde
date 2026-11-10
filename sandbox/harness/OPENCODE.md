# OpenCode spike (issue #123)

What running OpenCode 2.2.7 headless over the Agent Client Protocol showed, for the backend issues that follow. This is evidence, not
a design: nothing in the harness, the image, the gateway or the Rust crates changed. Fixtures are in `test/fixtures/opencode/`, the lab
is in `opencode-spike/`. Everything below was run in the lab unless it says "source" (read in the v2.2.7 tree) or "docs".

## Summary

- **Pin `v2.2.7`** (published 10 November 2026, the latest release when the spike ran). `opencode acp` exists in it and speaks ACP
  protocol version 1, one JSON-RPC message per line on stdio.
- **ADR 0004's central assumption does not hold for ACP as shipped.** `opencode acp` starts a second process of itself,
  `opencode serve --stdio --port 0`, which listens on `127.0.0.1:<random port>` for the whole run. A process the agent starts can find the
  port, read the server's Basic-auth password from `/proc/<pid>/environ` (same user), and answer permission requests over HTTP. This was
  done in the lab. Making the binary execute-only (`chmod 0711`, so the process is not dumpable) stopped the path tried, on this
  machine's kernel; it rests on a kernel setting the sandbox runtime has not been checked for. The pipes themselves could not be
  forged in the lab (see Forged answers).
- Under the intended settings, in sessions of under a minute against a stub model, the run reached **no host except the model's**,
  with one exception: `grep` and `glob` download ripgrep from `github.com` when there is no `rg` on `PATH`, and fail without it, so the
  image must carry `rg` (with Bedrock: `bedrock-runtime.<region>.amazonaws.com`, seen only as far as the TLS handshake), and a hostile repository and home
  changed nothing, provided the run gets a fresh home and a root-owned config directory. The settings were shown as a set; only
  the model catalogue switch was shown to be needed on its own.
- ACP gives **no plan updates** (the todo list is a `todowrite` tool call behind a flag) and **token usage only once per turn**, so the
  harness's mid-run `usage` events and plan events cannot be copied over one-to-one.

## The lab

Everything ran in throwaway containers named `fde-123-*` on this machine (arm64; the product's sandbox image is amd64 only, so the
amd64 build was **not run**, and no emulation was tried). `record.sh` builds the lab, runs every case and writes the fixtures; it
leaves nothing running.

- `Dockerfile`: `node:24-trixie-slim` (Debian 13), a non-root user `agent` (uid 1001), and the release tarball downloaded **during the
  build**, checked against the release's `SHA256SUMS`, which is itself checked against a hash written in the Dockerfile.
- Network `fde-123-net` is Docker `--internal`: no route out. Its only peers are `fde-123-sink` and `fde-123-model`. The OpenCode
  container's DNS server is the sink, which answers every name with its own address and logs DNS queries, the `Host` header of HTTP on
  port 80 and the SNI of TLS on port 443 (`sink.mjs`). A sidecar in the OpenCode container's network namespace sets a default route
  through the sink and runs `tcpdump`, so even a connection to a bare IP address shows as an outbound packet, and lists listening sockets
  from outside the process.
- The OpenCode container has no credentials, no capabilities (`--cap-drop ALL`, `no-new-privileges`), no Docker socket, and one mount: a
  scratch directory. Scripts are copied in with `docker cp`.
- The model is a stub that speaks OpenAI's chat-completions wire format with canned turns (`model-stub.mjs`, `scenarios.mjs`) and
  records Bedrock requests. The protocol is what matters, not the answers. OpenCode was told about it as a custom
  `@ai-sdk/openai-compatible` provider.
- `acp-client.mjs` stands in for the adapter: it starts `opencode acp` with pipes only it holds, runs one prompt, answers permission
  requests by a fixed policy and records every frame in both directions.

Fixtures hold invented sample content only, scrubbed of session and message ids, trace ids, signatures, dates, timings and the host's
search domains. `test/opencode-fixtures.test.ts` pins their shape and fails on anything machine-specific or secret-shaped.

## 1. Version, binary, checksum, licence

|                               |                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                    | `anomalyco/opencode` (MIT; `LICENSE`: "Copyright (c) 2025 opencode"). The release is marked immutable.                                                                                                                                                              |
| Tag                           | `v2.2.7`, commit `fedc6f208aa2bd54c1019227214568083f6380ad`, published 2026-11-10 10:37 UTC. `v2.2.6` (2026-11-06) is the fallback; its notes also list `opencode acp`. Only 2.2.7 was run.                                                                         |
| Assets                        | `https://github.com/anomalyco/opencode/releases/download/v2.2.7/` `opencode-linux-x64.tar.gz`, `opencode-linux-arm64.tar.gz` (and `-musl`, `-baseline` variants), `SHA256SUMS`. A tarball holds one file, `opencode` (253,873,144 bytes on arm64), no licence file. |
| `SHA256SUMS`                  | `72c73a07124c65662239facaa7da2f3fe474078bbd4cbfa68bf90ae8fdca3b8b`                                                                                                                                                                                                  |
| `opencode-linux-x64.tar.gz`   | `89a6cee227b54bc011179c528a5e63176032462b1a5e21723b616801cddc2ca7` (from `SHA256SUMS`; agrees with the asset digest GitHub reports; **not downloaded or run**)                                                                                                      |
| `opencode-linux-arm64.tar.gz` | `c1682057f0815cb2abdd6e00305f1146ebaf1c167f0335cdb74ddc80008120e7` (downloaded in the image build and checked; this is what ran)                                                                                                                                    |

The release publishes a checksum list and nothing else (no signature, no provenance file), so a hash protects against a corrupted or
swapped download but not against a bad release. Pin the tarball hash in our Dockerfile after a person has read it.

**Licence notice.** The repo and the sub-packages I looked at are MIT (`packages/ui`, `http-recorder`, `process-daemon`, and the vendored
Ghostty code in `process-daemon`, with their own copyright lines). The only third-party notices the release documents are for the
desktop app (Apache-2.0 BetterOffice and eigenpal packages in `packages/app/src/settings/about/notices`), not for the CLI binary. The
binary is a Bun single-file executable; it contains no licence texts (a search for the MIT preamble found none), so the notices of the
npm packages it bundles are not carried with it. I did not audit the bundled dependency licences, because the release does not list
them. Bun's own licence terms (it includes JavaScriptCore, which Bun documents as LGPL) are from memory, not checked. Whether keeping the
binary in our image needs a notice file is a question for the lead. We run it in our own sandboxes and do not ship it to customers.

## 2. `opencode acp` and the protocol

`opencode acp` exists in 2.2.7 (`opencode --help`, and the 2.2.6 release notes). Framing is **newline-delimited JSON-RPC 2.0** on
stdin/stdout, protocol version 1. The agent writes log noise to stderr only (it was empty in the lab). After stdin closes it exits with
code 0 within milliseconds; no process was left behind.

Handshake (`session-healthz.acp.jsonl`):

1. `initialize` → `agentCapabilities` (`loadSession`, `mcpCapabilities.http`, image and embedded-context prompts; sessions: list, resume, fork,
   close, delete), `authMethods: [{id: "opencode-login"}]` (not needed with a configured provider), `agentInfo {name: "OpenCode", version: "2.2.7"}`.
2. `session/new {cwd, mcpServers: []}` → `{sessionId: "ses_…", configOptions}`; options are `model`, `effort` and `mode` (`build` and one
   other, not examined). Session ids match the harness's id rule.
3. `session/prompt {sessionId, prompt: [{type: "text", text}]}` runs the **whole task as one request**: it answers only when the agent
   loop ends, with `{stopReason, usage}`. An `available_commands_update` arrives first.

One full session (the healthz task, `session-healthz.acp.jsonl`, nine tool calls, nine permission requests):

- **Message text:** `agent_message_chunk {messageId, content: {type: "text", text}}`. The stub sent each message as one chunk; chunking
  of a real streamed answer was not observed.
- **Tool calls:** `tool_call` (status `pending`, `rawInput: {}`) → `tool_call_update` (`in_progress`, now with `kind`, `title`, `locations`,
  `rawInput`) → `session/request_permission` → `tool_call_update` (`completed` or `failed`, with `content` and `rawOutput`). The calls carry
  a non-standard `name` field (OpenCode's tool name). `toolCallId` is the id the model provider gave the call, so it is model-controlled
  text. Kinds seen: `read`, `edit`, `search`, `execute`, `fetch`, `think` (subagent), `other` (`todowrite`).
- **Edit with a diff:** the update's `content` holds `{type: "diff", path, oldText, newText}` (full file texts; `oldText: null` for a
  new file) and a text part; `rawOutput.metadata.files[].patch` is a unified diff with `additions` and `deletions`.
- **Shell command:** OpenCode's tool is `shell` (not `bash`); `title` becomes the command text, `rawInput {command, workdir}`, and the
  result is output text plus `Exit code: N`, with `rawOutput.metadata.exit`. **A command that exits 1 still has status `completed`**; only a
  tool failure (a denied tool, an interrupt, a rejection) is `failed`.
- **Plan:** none. No ACP `plan` update was ever sent. OpenCode's todo list is the `todowrite` tool, which a release build offers only with
  `OPENCODE_FLAGS=todo` (verified: the tool appears in the request only then). It shows up as an `other` tool call whose `rawInput.todos`
  is the list (`pending|in_progress|completed|cancelled`), and, under a base policy of ask, it raises a permission request.
- **Permission request:** `session/request_permission {sessionId, toolCall: {toolCallId, name, title, kind, rawInput, locations,
content?}, options}`. The options are always `once` (`allow_once`), `always` (`allow_always`), `reject` (`reject_once`). The request
  carries the exact `rawInput` (the first `tool_call` does not), so it can feed the harness's `approval_request`. The agent's request ids
  (0, 1, 2, …) and the client's own (1, 2, 3, …) overlap, so answers must be matched by direction.
- **Answer:** `{result: {outcome: {outcome: "selected", optionId}}}`. A client `cancelled` outcome is treated as a rejection (source).
- **Rejection:** the tool call fails ("The user declined this tool call") and the turn ends with `stopReason: "cancelled"`
  (`session-reject.acp.jsonl`). This matches the harness, where a rejection ends the run.
- **Cancel:** `session/cancel {sessionId}` (a notification). While a permission request was pending, and again while `sleep 61` was
  running, the turn ended at once with `stopReason: "cancelled"`; the running tool call became `failed` ("Tool execution interrupted") and the
  `sleep` process was gone a second later (`session-cancel.acp.jsonl`).
- **Retries:** when the model host fails, OpenCode retries with growing delays and reports it as `session_info_update` with
  `_meta["opencode/retry"] {attempt, nextRetryAt, error}`. In one lab run it was at attempt 7 when the client gave up. Nothing ends the turn
  on its own, so the adapter needs its own deadline. With no usable credentials `session/prompt` fails at once with JSON-RPC error
  `-32000 "Authentication required"`.

## 3. Listening sockets

**Yes.** While a prompt ran under the intended settings (`sockets.txt`, taken from the sidecar in the container's network namespace):

```
tcp LISTEN 127.0.0.1:<port>      (opencode serve --stdio --port 0)
```

plus Docker's own resolver on `127.0.0.11`. The source explains it: `opencode acp` runs `Standalone.start()`, which spawns
`opencode serve --stdio --port 0` with `OPENCODE_PASSWORD=<32 random bytes>` in its environment, reads a ready line with the URL from
its stdout, and talks to it over HTTP with Basic auth (`opencode:<password>`). `--stdio` is only the lease: EOF on that pipe ends the
server. `serve` has `--hostname` and `--port` and no way to use a Unix socket, and `acp` takes no options for either. The listener was
bound to loopback only: a probe from another container to the container's address was refused. It was not reachable from outside, but
**every process in the container can reach it**, including everything the agent's shell tool runs. Unauthenticated requests got 401.

Separately, any `opencode` CLI command (for example `opencode debug config` without `--standalone`) starts a persistent
`opencode serve --service` daemon on another loopback port that outlives the command. The ACP path does not, but a tool command that runs
`opencode …` inside the sandbox would.

## 4. Token usage

ACP reports usage **once per turn, not per step**, and a turn is the whole prompt:

- `session/prompt`'s result has `usage {inputTokens, outputTokens, totalTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens?}`,
  summed over every model step of the turn. Stub steps reporting 3,900 prompt tokens of which 1,200 were cached and 540 completion
  tokens of which 90 were reasoning came back as `inputTokens 2700`, `cachedReadTokens 1200`, `outputTokens 450`, `thoughtTokens 90`,
  `totalTokens 4440` (`session-usage.acp.jsonl`): **input excludes cache reads and writes, output excludes reasoning**, and the total
  has all of it. The optional fields are present only when above zero.
- One `usage_update {used, size, cost {amount, currency}}` follows at the end of the turn: `used` is the **last step's** total (the
  context in use), `size` the model's context limit, `cost` was `0 USD` for the stub, which has no price. It is not a running total.

So the harness's rule, input counting cache in full and a `usage` event after each response so the API can stop a run at its budget,
cannot be met from ACP. A budget that must stop a run mid-turn has to be metered where each model request passes, the outbound handler,
or the run has to be bounded by the adapter's own time and cancel. If ACP usage is used at all, it arrives when the run is over; sum
`inputTokens + cachedReadTokens + cachedWriteTokens` as input, and `outputTokens + thoughtTokens` as output, to stay on the safe side.

## 5. Hosts, and the settings that stop them

With the intended settings the sink saw **nothing** in the healthz session and the packet capture showed traffic only to the stub
(`egress.json`, case `intended`). The one exception is below: `grep` and `glob` with no `rg` installed (case `s-readonly`). The cases that follow switch each unwanted thing on to see what it reaches (`net-matrix.sh`, `egress.json`):

| Host                                                                                                                     | Trigger                                                                                                                                                                                                                                                                                                                                   | Stopped by (verified unless noted)                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models.opencode.ai` (3 TLS connections at startup)                                                                      | the model catalogue fetch, on by default                                                                                                                                                                                                                                                                                                  | `OPENCODE_DISABLE_MODELS_FETCH=1` (case `models-fetch-off`: no connection). `OPENCODE_MODELS_PATH` and `OPENCODE_MODELS_URL` exist in source, not run.                                                                                     |
| `search.parallel.ai`, `mcp.exa.ai` or `agent.tinyfish.ai` (the provider is picked at random; all three seen across runs) | the `websearch` tool, when allowed                                                                                                                                                                                                                                                                                                        | `permission.websearch: "deny"` removes the tool from the model's list; `websearch: false` in config is also set.                                                                                                                           |
| any host in a URL                                                                                                        | `webfetch`, when allowed (`example.com` seen)                                                                                                                                                                                                                                                                                             | `permission.webfetch: "deny"` (tool removed). The outbound handler still has to hold hosts.                                                                                                                                                |
| `registry.npmjs.org`                                                                                                     | `plugin: ["…"]` in config                                                                                                                                                                                                                                                                                                                 | `plugin: []` in the root-owned config, plus project config off.                                                                                                                                                                            |
| any host a remote MCP server names; any process a local one runs                                                         | `mcp: {…}`                                                                                                                                                                                                                                                                                                                                | `mcp: {}`, plus project config off. A local MCP server is code OpenCode starts.                                                                                                                                                            |
| the endpoint in `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                            | OpenCode exports traces when this variable is set (case `otel`)                                                                                                                                                                                                                                                                           | do not pass any `OTEL_*` variable; build the run's environment from a list, as the harness does today.                                                                                                                                     |
| `opencode.ai`                                                                                                            | seen when no usable provider was configured: a run retried its model calls against it (the built-in free models; source names `opencode.ai/inference/…`, Console config and share URLs too)                                                                                                                                               | `enabled_providers` limited to the provider in use, and `OPENCODE_DISABLE_FREE_MODELS=1` (set; its effect alone was not isolated).                                                                                                         |
| `opencode.ai` update check (source: `services/updater.ts`, URLs `opencode.ai/update/api/…`)                              | the TUI start, `opencode upgrade`, `uninstall`                                                                                                                                                                                                                                                                                            | **not triggered by `opencode acp`** in any run. `OPENCODE_DISABLE_AUTOUPDATE=1` and `autoupdate: false` are set anyway; their effect could not be shown because nothing triggered the check.                                               |
| sharing                                                                                                                  | `share: "auto"`                                                                                                                                                                                                                                                                                                                           | no host contact was seen in an ACP session with `share: "auto"`; `share: "disabled"` is set anyway. Not shown to be necessary.                                                                                                             |
| telemetry                                                                                                                |                                                                                                                                                                                                                                                                                                                                           | no analytics host other than the OTLP endpoint above appeared in any run, default settings included.                                                                                                                                       |
| `github.com`                                                                                                             | **`grep` and `glob`**: OpenCode looks for `rg` on `PATH`, then in its cache directory, else downloads ripgrep from `github.com/BurntSushi/ripgrep/releases` (source: `ripgrep/binary.ts`, checked against a hash in the binary). With the host unreachable both tools fail with "ripgrep execution failed" (`session-readonly.acp.jsonl`) | put `rg` on `PATH` in the image: the same session then ran both tools and reached no host (`session-readonly-rg.acp.jsonl`, `egress.json` case `s-readonly-rg`). A fresh per-run cache directory would otherwise download it on every run. |
| `registry.npmjs.org` again                                                                                               | **the agent's own `npm test`**: npm's update notifier                                                                                                                                                                                                                                                                                     | not OpenCode. The sandbox's command environment should set `NPM_CONFIG_UPDATE_NOTIFIER=false`; the outbound handler holds the host in any case.                                                                                            |
| `bedrock-runtime.us-east-1.amazonaws.com`                                                                                | the model, with Bedrock and no `endpoint` override                                                                                                                                                                                                                                                                                        | this is the intended host. No control-plane host (`bedrock.…`) was contacted.                                                                                                                                                              |

**The settings that make up the intended run** (`config/intended.json`, and the environment in `record.sh`), all accepted by the
2.2.7 parser (`opencode debug config --standalone` lists them as parsed fields):

- Environment: `OPENCODE_CONFIG_DIR=<root-owned dir>`, `OPENCODE_DISABLE_PROJECT_CONFIG=1` (source also accepts
  `OPENCODE_CONFIG_PROJECT_DISABLE`), `OPENCODE_DISABLE_CLAUDE_CODE=1` (source: also `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`),
  `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_FILEWATCHER=1` (by default the server starts
  file watchers over `/`, `/etc`, `/workspace` and the home directory, seen in its log; that disabling stops them was not checked),
  `OPENCODE_DISABLE_FREE_MODELS=1`, `OPENCODE_FLAGS=todo` (only if the todo list is wanted).
  `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DB`, `OPENCODE_SERVER_PASSWORD` exist (source) and were not run.
- Config fields: `model`, `small_model`, `enabled_providers`, `provider.<id>`, `share: "disabled"`, `autoupdate: false`,
  `snapshot: false`, `websearch: false`, `plugin: []`, `mcp: {}`, `permission` (next section). The older (v1) config shape is still
  accepted in 2.2.7 and normalised internally to a list of `{action, resource, effect}` rules; whether a later 2.x drops it is unknown,
  which is a reason to pin and to re-run `record.sh` on every upgrade.
- OpenCode also looks for credentials it was not given: `~/.aws/{config,credentials}` and `~/.config/gcloud/…` were probed (absent in
  the lab; the sandbox must keep them absent).

## 6. Permissions

Base policy `"*": "ask"` (v1-shaped config, verified):

- **Every tool call raises a permission request**, read-only ones included, and so does `todowrite`
  (`session-readonly.acp.jsonl`: `read`, `glob`, `grep`). The adapter sees every call, and the fixture test checks that every tool
  call that completed had a request for it earlier in the file (the one exception is a call covered by an earlier `always`). The request comes after the call's
  `in_progress` update, so the tool has not run.
- **An answer of `once` does not persist**: three identical `shell` calls raised three requests (`session-once.acp.jsonl`).
- **An answer of `always` persists for the rest of the session, and is broader than the call**: after `always` on `echo sample-one`,
  `echo sample-two` ran without a request (1 request for 3 calls, `session-always.acp.jsonl`; the pattern the tool suggests was
  evidently `echo *`). It was not remembered by a second `opencode acp` process on the same home. **The adapter must never select
  `always`**; and a forged answer of `always` (see below) would defeat the policy for the session.
- **Tools that can be denied outright** (`session-forbidden.acp.jsonl`): `question`, `subagent`, `websearch`, `webfetch` and `execute`
  (Code Mode's JavaScript tool) are removed from the model's tool list by `permission.<name>: "deny"`; a call to one fails with "No tool
  named … is currently available" and no request. Tool names in 2.2.7 are `read`, `write`, `edit`, `glob`, `grep`, `shell`, `skill`,
  `subagent`, `question`, `webfetch`, `websearch`, `todowrite` (flag), `execute`.
- **Two things that cannot be removed.** (a) `skill` stays in the tool list under `"skill": "deny"`; with no skills present a call fails
  ("Unable to load skill"), and the home-directory section below shows why that is not enough alone. (b) Once `execute` is denied, OpenCode
  offers its management tools as direct tools: `opencode_models`, `opencode_session_move`, `opencode_session_rename`,
  `opencode_worktree_create`, `opencode_worktree_list`, `opencode_worktree_remove`, `opencode_list_mcp_resources`,
  `opencode_read_mcp_resource`. Denying each by name removes seven. **`opencode_worktree_remove` stays offered** whatever the key, and a call
  to it raises an ordinary request (rejected in `worktree-remove`), so it is covered by the base policy of ask, not by a deny. The intended
  run's tool list is `edit, glob, grep, opencode_worktree_remove, read, shell, skill, todowrite, write`.
- Not tested: `external_directory`, `doom_loop`, granular rules, per-agent permissions, the second `mode`.
- The docs say v2's defaults allow most tools (reads of `.env` ask). I did not run the default policy by itself; the hostile
  repository's `permission: "allow"` did take effect where project config was on.

## 7. Hostile repository

`hostile-seed.sh` plants, all invented: a repository `opencode.json` (own model and provider on an invented host, `permission: "allow"`,
`share: "auto"`, an npm plugin, a local MCP server that writes a marker file, a remote MCP server, `instructions`), `.opencode/` with a plugin
that writes a marker and fetches a host, a replacement `build` agent, a command, a skill and its own `opencode.json`, `AGENTS.md` and
`CLAUDE.md` that tell the agent to ignore the task and touch a file, `.claude/` with a skill, a `CLAUDE.md` and a `settings.json` with a
hook; and in the home: a global `opencode.json` and plugin, `AGENTS.md`, skills under `~/.config/opencode`, `~/.claude`, `~/.agents`, a
`~/.claude/CLAUDE.md`, and a credential file. Then it runs the healthz session (`hostile.json`):

|                                              | Files created by hostile code                                                      | Hosts reached                                                                        | Reached the model                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intended settings, hostile repo **and** home | none                                                                               | none                                                                                 | nothing hostile; model `stub-1`; the **same tool list, the same system prompt (byte for byte) and the same ACP session, event for event, as the clean run** |
| No protections (global config only)          | `PWNED-plugin-project`, `PWNED-plugin-home`, `PWNED-mcp-project`, `PWNED-mcp-home` | the plugin's host, the MCP server's host, `registry.npmjs.org`, `models.opencode.ai` | the repository's model took over and the stub was never asked                                                                                               |
| No protections, stub model kept in config    | `PWNED-plugin-project`, `PWNED-plugin-home`, `PWNED-mcp-home`                      | the plugin's host                                                                    | `AGENTS.md` (repo and home), the `instructions` file, repository and home skills; the full tool set (subagent, webfetch, …)                                 |

So project config, `.opencode/`, `.claude/`, `AGENTS.md`, plugins and MCP definitions all act on a run with defaults, and all stopped under
`OPENCODE_DISABLE_PROJECT_CONFIG=1` + `OPENCODE_DISABLE_CLAUDE_CODE=1` + a root-owned `OPENCODE_CONFIG_DIR`. I did not test each switch
alone. A hostile `plugin` entry that cannot be installed also made `session/new` fail with `ServiceUnavailableError`, so an unprotected
run can be broken by the repository.

## Home directory

The agent's `/home/agent` persists between runs in a company's sandbox. What the intended run read there, with a hostile home in place
(`home-reads.txt`, from `strace -f` on a readable copy of the binary):

- **`~/.local/share/opencode/auth.json` is read, and a key in it overrides the configured one.** A planted file made OpenCode send
  `Authorization: Bearer planted-home-key-sample` to the stub instead of the config's `placeholder`. With a persistent home, one run can
  leave credentials, saved state and history (`opencode.db`, `log/`, `shell/`, `tool-output/`) for the next.
- **`~/.agents/skills/*/SKILL.md` is read** although `OPENCODE_DISABLE_CLAUDE_CODE=1` and project config are off. With
  `skill: "deny"` its text did not reach the model; with `skill: "ask"` it did (`HOSTILE-HOME-SKILL-MARKER` in the request). A fresh
  home removed it.
- `~/.claude` was only stat'ed (disabled); `~/.config/opencode` was not read because `OPENCODE_CONFIG_DIR` replaces it (the
  root-owned directory was probed for `AGENTS.md`, `agents/`, `commands/`, `plugins/`, `skills/`, so those could carry our own
  instructions later). `~/.gitconfig`, `~/.aws` and `~/.config/gcloud` were probed (absent).
- Sessions: a second run on the same home did not carry over an `always` answer.

**Making a run start clean (verified):** give each run a fresh directory it can write, and point everything at it: `HOME`,
`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` and `TMPDIR` (`opencode debug paths` then shows data, cache,
state, logs, database and bin all inside it; OpenCode's tmp directory otherwise stays at `/tmp/opencode`). With that, the planted
`auth.json` was ignored (`Bearer placeholder`) and the home skill did not surface even with `skill: "ask"` (`home-fresh`,
`hostile-skill-ask-fresh-home`). Config comes from a root-owned `OPENCODE_CONFIG_DIR`. Data and state must be writable by the agent
user (the database lives there), so "root owns it" applies to config only. Keep `skill: "deny"` as well.

## Forged permission answers

OpenCode and its tools run as the same user. Tried from a process the agent's shell tool started (`forge.mjs`, `forged-answers.json`),
against a second tool call that the client never answers, so the only way it can proceed is a forged answer:

| Path                                                                                                                                                                                                                                                     | Binary readable (0755)                                                                                                          | Binary execute-only (0711)                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP to the loopback server**: find the port from `/proc/<serve pid>/fd`, read `OPENCODE_PASSWORD` from `/proc/<serve pid>/environ` (43 characters), `GET /api/permission/request`, `POST /api/session/<id>/permission/<id>/reply {"decision":"once"}` | **works**: 204, the file was written with no answer from the client                                                             | **blocked**: `EACCES` listing `/proc/<serve pid>/fd`, the first step; the process is not dumpable. The agent still runs and the run is otherwise unchanged. |
| **stdin pipe**: open `/proc/<acp pid>/fd/0` for writing and send a JSON-RPC answer for request id 1                                                                                                                                                      | **does not work**: `ENXIO`. Node starts the child with a socket pair, not a pipe, and a socket cannot be opened through `/proc` | `EACCES`                                                                                                                                                    |

Without the password the server answers 401, and a request with the right password is a complete API (it lists and answers pending
permissions, and by design much more). So **the permission prompt can be trusted only if the password cannot be read**.

What the execute-only run showed, and what it did not:

- The forger stopped at its first `/proc` read, listing `/proc/<serve pid>/fd` to find the port. It never tried `environ` at 0711.
  The port is not the secret (a process can scan loopback for it), so what matters is that `environ` and `/proc/<pid>/mem` are
  unreadable. They are governed by the same rule as `fd` (a non-dumpable process's `/proc` entries belong to root and need ptrace
  access), but reading them at 0711 was not run, and neither was `ptrace`.
- The mechanism is the kernel's: exec of a binary the caller cannot read marks the process non-dumpable **as set by the
  `fs.suid_dumpable` sysctl**. At `0` (the usual default, and this machine's behaviour) or `2` the entries are closed; at `1` the
  process stays dumpable and the protection is gone. A runtime with its own kernel or `/proc` (gVisor, for example) may differ. The
  Cloudflare sandbox runtime was not tested, so the gate has to run `forge.mjs` there, reading `environ` directly.
- The password is not in the tools' own environment (source, not run): in stdio mode `packages/cli/src/server-process.ts` deletes
  `OPENCODE_PASSWORD` from the server's `process.env`, and `Env.session()` in `packages/cli/src/env.ts` filters it out of what tools
  inherit. Deleting it from `process.env` does not change `/proc/<pid>/environ`, which is why the readable-binary forge worked. The
  gate's test should also check `env` inside a tool command.
- `ss -p` and `strace` also stop working on the process, which is the same effect.

A second line of defence is the adapter answering `once` only, the outbound handler holding hosts, and the sandbox seeing only sample
data.

## 8. Credentials and Bedrock on the wire

Provider `amazon-bedrock`, `region` and `endpoint` pointing at the stub (the field names are those of 2.2.7, verified), placeholder
credentials only (`bedrock-wire.json`). OpenCode **signs the request itself** (SigV4) from credentials in its environment:

```
POST /model/<model id>/converse-stream        (Bedrock Converse streaming; Host is the endpoint's host)
authorization: AWS4-HMAC-SHA256 Credential=<key id>/<date>/<region>/bedrock/aws4_request,
               SignedHeaders=host;x-amz-date[;x-amz-security-token];x-opencode-client;x-opencode-project;
                             x-opencode-session;x-opencode-session-id;x-session-affinity;x-session-id,
               Signature=<64 hex>
x-amz-date: <timestamp>                       x-amz-security-token: <token>   (only with AWS_SESSION_TOKEN)
content-type: application/json                user-agent: opencode/latest/2.2.7/acp
x-opencode-client, x-opencode-project, x-opencode-session, x-opencode-session-id, x-session-affinity, x-session-id
b3, traceparent
```

- With `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` only: a signature over the headers above (no `x-amz-content-sha256`).
- With `AWS_BEARER_TOKEN_BEDROCK` instead: `Authorization: Bearer <token>`, no `x-amz-*` headers (the docs say a bearer token wins over keys and
  profiles).
- With no credentials at all: **no request is sent**; the session fails with "Authentication required". So a placeholder is needed, as
  ADR 0004 assumed. Without an `endpoint` override the host is `bedrock-runtime.<region>.amazonaws.com`, and it was the only host (TLS SNI seen).
- **The real service was never involved.** The headers above were sent to the stub through the `endpoint` override, and the stub
  refused them; without the override the lab has no route out, so only the host name was seen. Not verified: that the real endpoint
  accepts this request once re-signed, the path and body it expects, its streamed response (AWS event-stream framing) and where
  usage appears in it, and OpenCode's behaviour on real Bedrock errors and throttling.
- The signature binds `host`, `x-amz-date` and the custom headers, so the outbound handler must **drop `authorization`, `x-amz-date`
  and `x-amz-security-token` and sign again** over what it forwards, not verify. The model id is in the path (`anthropic.claude-fable-5-2`
  here), and the session id appears in four headers.
- A model id that is not in OpenCode's built-in catalogue fell back to another model (my first id did), so the id must be checked
  against the catalogue snapshot, which cannot be refreshed with `OPENCODE_DISABLE_MODELS_FETCH=1`. Prices come from that catalogue, which
  is relevant to ADR 0004's "budget uses the price of the model it runs".

## Where reality differs from the desk study

| Desk study                                                           | Found                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository is `anomalyco/opencode`                                   | Confirmed. MIT.                                                                                                                                                                                                               |
| Current line is 2.2.x, breaking v1's config and plugin formats       | Confirmed (2.2.7). v1-shaped config is still accepted and normalised; **tool names changed** (`shell`, not `bash`; `subagent`, not `task`; a new `execute`), and there are new `opencode_*` tools. Plugin formats not tested. |
| `opencode acp` in the source tree, not confirmed in a release        | **Exists in 2.2.7 (and 2.2.6)** and works.                                                                                                                                                                                    |
| `opencode serve` opens a loopback listener, which ADR 0004 rules out | **Corrected: `opencode acp` itself starts that server** and uses it. The ACP pipes are not the whole interface.                                                                                                               |
| Default permission policy allows everything                          | Matches the docs; not run by itself. `"*": "ask"` works as intended.                                                                                                                                                          |
| SECURITY.md: the permission system is not a security boundary        | Confirmed (read at the tag): "it is not designed to provide security isolation" and "run OpenCode inside a Docker container or VM". The forged-answer result is a concrete case.                                              |
| Bedrock signs from the default credential chain                      | Confirmed, plus: a bearer token is an alternative; without credentials no request is sent; it also probes `~/.aws` and gcloud files.                                                                                          |

## Still unknown

- Behaviour on **amd64** and under the Cloudflare sandbox runtime (kernel, `/proc` options, the user model: the harness runs OpenCode
  as `agent` while it runs as `harness`). The execute-only protection depends on it.
- A **real model**: how a streamed answer is chunked into `agent_message_chunk`, reasoning chunks (`agent_thought_chunk` exists in the
  source), real cache fields, real Bedrock errors and throttling, and prices in `cost`.
- Whether each environment switch is needed **alone** (only the model catalogue fetch was shown alone), and the effect of
  `OPENCODE_DISABLE_FREE_MODELS`, `OPENCODE_DISABLE_FILEWATCHER`, `OPENCODE_DISABLE_AUTOUPDATE` and `share`.
- The `session/load` and resume paths, `mcpServers` passed by the client, `external_directory`, compaction, images, the second
  `mode`, `--auto`, long sessions and the `opencode run` alternative to ACP.
- Whether a later 2.x keeps the v1 config shape, the `todo` flag, the `opencode_*` tool names, the loopback server or the tool deny keys.
- The bundled dependencies' licences.

## What the backend issue must do differently from the desk study

1. **Do not describe the ACP link as "pipes only".** Drive it over stdio as designed, but also treat the loopback HTTP server as part of the
   attack surface: ship `opencode` execute-only (`0711`, root-owned) in the image and confirm in the sandbox that
   `/proc/<pid>/environ` and `fd` of the OpenCode processes are unreadable to the agent's commands (copy `forge.mjs`, which needs only
   `node`). Add a check to the egress/hostile tests. If that cannot be had on the real runtime, the decision to make is a patched
   build or a different mode (`opencode run`), not an assumption. Meanwhile the adapter selects `once` or `reject` and nothing else.
2. **The adapter, not OpenCode, ends a stuck run.** A turn is one `session/prompt`; failures retry indefinitely and report only in
   `_meta["opencode/retry"]`. Give the adapter a deadline and use `session/cancel`, which was reliable and killed the tool processes.
3. **Usage and plan do not map one-to-one.** `usage` is available once, at the end of the turn, with cache and reasoning split out; a
   budget that stops a run mid-way needs the outbound handler to meter, or wall-clock bounds. There are no plan events: derive them from
   `todowrite` (needs `OPENCODE_FLAGS=todo`; its permission request must be answered by the adapter, not an FDE), or drop the plan.
4. **Map OpenCode's tool vocabulary.** `shell`/`read`/`write`/`edit`/`glob`/`grep`, not `Bash`/`Write`/…; approval rules match the tool
   name and `rawInput`. `file_change` comes from `diff` content (`oldText: null` is a create); `command` from the `shell` update, whose exit
   code is in the text and `rawOutput.metadata.exit` (status stays `completed` on exit 1). Message chunks need joining into the harness's
   `message` events. Ids come from the model: run them through the existing safe-id map.
5. **Every call asks, so no call is seen only after the fact.** That is what the harness needs, but every `read` and `glob` is a
   request, and the adapter must auto-approve the safe ones against the company's list rather than ask a person.
6. **Run configuration:** per-run fresh `HOME`, `XDG_*` and `TMPDIR`; config only in a root-owned `OPENCODE_CONFIG_DIR`; the environment
   switches in section 5; the deny list in section 6 including the `opencode_*` tools, `execute` and `skill`; a minimal environment (no
   `OTEL_*`, `AWS_*` beyond the placeholders). `opencode_worktree_remove` and `skill` cannot be removed, so they stay behind `ask` and a
   rejection.
7. **Bedrock:** a placeholder `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (or `AWS_BEARER_TOKEN_BEDROCK`) is required or no request is
   sent; the outbound handler replaces `authorization` and removes `x-amz-date` and `x-amz-security-token` before signing; model ids
   come from OpenCode's own catalogue.
8. **Image:** install `ripgrep` so `rg` is on `PATH` (`grep` and `glob` otherwise download it from github.com and fail without it); download the tarball at build time and check the hash written in the Dockerfile; bring both x64 variants into the egress test
   (`-baseline` runs on CPUs without AVX2); no `opencode` CLI call may run inside the sandbox (it starts a background daemon).
9. **Tests to re-run on each upgrade:** `record.sh` (about ten minutes on this machine) regenerates the fixtures; read the diff before
   committing, as with the SDK recording.

## Reproduce

```bash
docker build -t fde-123-opencode -f opencode-spike/Dockerfile opencode-spike    # from sandbox/harness
LAB_DIR=$(mktemp -d) ./opencode-spike/record.sh                                  # all sections; or: sessions sockets forged egress hostile bedrock
```

`record.sh` removes the lab containers and network when it ends and leaves its raw case logs in `$LAB_DIR/cases/`.
`LAB_DIR` must be empty or a directory the lab made earlier (it holds a `.fde-123-lab` marker): `lab.sh` refuses any other directory, and
only ever cleans one with the marker, because containers write to it and root cleans it. The lab container is started with no DNS
search domains, so no name from the recording machine appears in the sink's log; `make-fixtures.mjs` stops on any host name outside
its known list and `*.example`.

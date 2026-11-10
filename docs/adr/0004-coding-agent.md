# 0004: The coding agent

Status: accepted, 3 November 2026. Amended 10 November 2026: OpenCode becomes the main harness.

## Decision
- The main way FDEs build is a coding agent in each company's sandbox, not a browser editor.
- **Two harnesses behind one adapter.** OpenCode (MIT-licensed, run headless in the sandbox) is the
  main one, and the Claude Agent SDK is the second. A company's agent config chooses which a run
  uses. Bedrock is the first model path for both. Neither authenticates through a personal login,
  and the product never uses the name "Claude Code".
- Each harness runs behind the adapter, which turns its output into one internal event format
  shaped on the Agent Client Protocol. Adding a harness changes neither the format nor the API.
  OpenCode is driven over ACP on pipes that only the adapter holds, never over a listening socket,
  so the agent cannot answer its own permission requests.
- Each run gets a context pack: the company's scope, success criteria, decisions, config and
  conventions, written into the sandbox before the agent starts.
- Secrets and model credentials never enter the sandbox. The outbound handler adds them to allowed
  requests only. A harness that insists on a credential gets a fixed placeholder, which the
  outbound handler overwrites. Model hosts are ones the policy signs for or adds secrets to.
- **A harness reads nothing from the repository it works on:** no settings, instructions, plugins,
  skills or MCP servers. The run's configuration is written by root where the agent cannot write.
- **A harness's own permission system is a convenience, not a boundary.** OpenCode says so of its
  own. The adapter decides every approval against the company's list, an approval covers one call
  and is never remembered, and the outbound handler's held hosts back it.
- Actions on the company's approval list (deploys, new network hosts, anything sent to the
  customer) pause the run until an FDE approves.
- **A harness version is pinned exactly and checked by hash.** It is enabled only after it passes
  the recorded-session, hostile-repository and egress tests. It becomes the default only after an
  eval comparison against the current default. Until OpenCode passes, runs use the Claude Agent SDK.
- A run's budget uses the price of the model it runs.
- Changes the agent makes to agent configuration files (`.opencode/`, `opencode.json*`, `AGENTS.md`,
  `.claude/`) are held for review and never delivered silently: merged, they would run on the next
  person's machine.
- An FDE may also run their own agent on their own machine. It reads project context through the
  read-only MCP server, and we record no transcript. Its output returns as a pull request or an
  upload (ADR 0006).
- Hosted sandboxes take sample data only until the runner exists.

## Why OpenCode first
Model choice: a run can use a cheap, fast model for routine work and a stronger one where it
matters, and a customer's own model later. It is open source under a permissive licence, so we can
pin, read and patch what runs in the sandbox. The cost is a fast-moving project whose current
major version has experimental server routes and allows everything by default, which is why the
gates above come before it is switched on.

## Not decided here
Vertex and other model hosts that need new signing in the outbound handler; sign-in to the MCP
server from an FDE's own agent (today it takes a short-lived bearer token).

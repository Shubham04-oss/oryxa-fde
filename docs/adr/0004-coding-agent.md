# 0004: The coding agent

Status: accepted, 3 November 2026.

## Decision
- The main way FDEs build is a coding agent in each company's sandbox, not a browser editor.
- First harness: the Claude Agent SDK on Bedrock. It authenticates through AWS, never through a
  claude.ai login, and the product never uses the name "Claude Code".
- The harness adapter turns harness output into one internal event format shaped on the Agent
  Client Protocol, so Codex, OpenCode and other agents plug in later.
- Each run gets a context pack: the company's scope, success criteria, decisions, config and
  conventions, written into the sandbox before the agent starts.
- Secrets and model credentials never enter the sandbox. The outbound handler adds them to allowed
  requests only.
- Actions on the company's approval list (deploys, new network hosts, anything sent to the
  customer) pause the run until an FDE approves.
- Sample data only until the runner exists.

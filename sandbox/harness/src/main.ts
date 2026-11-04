#!/usr/bin/env node
// Entry point inside the sandbox: `oryxa-harness [context-pack-path]`. Events go to stdout, approval decisions
// come in on stdin, and the SDK's own diagnostics go to stderr.
import { query } from "@anthropic-ai/claude-agent-sdk";

import { StdioApprovals } from "./approvals.js";
import { EventWriter } from "./events.js";
import { runHarness } from "./harness.js";
import { CONTEXT_PACK_PATH, type LoadedPack, loadPack } from "./pack.js";

const events = new EventWriter((line) => process.stdout.write(line));
let loaded: LoadedPack;
try {
  loaded = await loadPack(process.argv[2] ?? CONTEXT_PACK_PATH);
} catch {
  events.emit({
    type: "result",
    outcome: "error",
    reason: "invalid_context_pack",
    text: "",
    turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  process.exit(1);
}

const approvals = new StdioApprovals(process.stdin);
const outcome = await runHarness(loaded, { query, approvals, emit: (e) => events.emit(e), env: process.env });
process.exit(outcome === "success" ? 0 : outcome === "rejected" ? 2 : 1);

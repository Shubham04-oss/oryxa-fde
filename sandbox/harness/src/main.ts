#!/usr/bin/env node
// Entry point inside the sandbox: `oryxa-harness --pack <path> --sha256 <hex>`. The gateway starts it as root; it
// reads the root-only pack, makes the sandbox clean for the run (`startClean`), starts the agent as `agent` and drops
// to `harness` (see `agentSpawner`). Events go to stdout, approval decisions and cancellation come in on stdin, and
// diagnostics go to stderr.
import { parseArgs } from "node:util";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { StdioApprovals } from "./approvals.js";
import { freshHome, HOME_PREFIXES, startClean } from "./clean.js";
import { EventWriter, type Outcome } from "./events.js";
import { type BackendDeps, runHarness } from "./harness.js";
import { type LoadedPack, loadPack } from "./pack.js";
import { agentSpawner } from "./users.js";

const EXIT_CODES: Record<Outcome, number> = { success: 0, error: 1, rejected: 2, cancelled: 3 };

const events = new EventWriter((line) => process.stdout.write(line));
function fail(reason: string): never {
  events.emit({
    type: "result",
    outcome: "error",
    reason,
    text: "",
    turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  process.exit(1);
}

// ponytail: the backend comes from the harness's environment until the pack names it.
const backend = process.env["ORYXA_FDE_HARNESS"] ?? "claude";
if (backend !== "claude" && backend !== "opencode") fail("unknown_harness");

// Root is needed to read the pack and to start the agent as another user; the harness gives it up right after.
if (process.getuid?.() !== 0) fail("not_root");
let loaded: LoadedPack;
try {
  const { values } = parseArgs({ options: { pack: { type: "string" }, sha256: { type: "string" } }, strict: true });
  if (values.pack === undefined || values.sha256 === undefined) throw new Error("--pack and --sha256 are required");
  loaded = await loadPack(values.pack, values.sha256);
} catch {
  fail("invalid_context_pack");
}

// Before any agent process starts: none from an earlier run is alive, and no earlier run's directories are left.
try {
  await startClean();
} catch (cause) {
  if (cause instanceof Error) process.stderr.write(`harness: ${cause.message}\n`);
  fail("unclean_sandbox");
}

const input = new StdioApprovals(process.stdin);
const deps: BackendDeps = {
  approvals: input,
  cancel: input.cancelled,
  emit: (e) => events.emit(e),
  env: process.env,
};
let outcome: Outcome;
if (backend === "opencode") {
  // Loaded only here, so a Claude run, the only one enabled, never loads the ACP library as root.
  const { runOpenCode, startOpenCode } = await import("./opencode.js");
  outcome = await runOpenCode(loaded, { ...deps, start: startOpenCode(agentSpawner(), process.env) });
} else {
  let home: string;
  try {
    home = await freshHome(HOME_PREFIXES.claude);
  } catch (cause) {
    if (cause instanceof Error) process.stderr.write(`harness: ${cause.message}\n`);
    fail("agent_error");
  }
  outcome = await runHarness(loaded, { ...deps, query, spawn: agentSpawner(), home });
}
process.exit(EXIT_CODES[outcome]);

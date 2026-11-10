import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EventWriter } from "../src/events.js";
import { openCodeConfig, openCodeEnv, type OpenCodeDeps, prepareRun, runOpenCode } from "../src/opencode.js";
import { parsePack } from "../src/pack.js";
import { type Frame, RecordedPeer, recording } from "./acp-peer.js";
import { collect, fixture, jsonLines, ManualApprovals, samplePack } from "./fakes.js";

const MODEL = "amazon-bedrock/anthropic.claude-opus-5-5";
// A pack whose approval list covers the recorded `echo sample-one`, written as a rule on the SDK's `Bash`.
const echoRule = () => {
  const pack = JSON.parse(fixture("context.json"));
  pack.config.approvals = [{ action: "deploy", tool: "Bash", pattern: "sample-one" }];
  return parsePack(pack);
};
const answers = (peer: RecordedPeer) =>
  peer.sent.filter((m) => m["method"] === undefined).map((m) => m["result"].outcome.optionId);

function run(peer: RecordedPeer, extra: Partial<OpenCodeDeps> = {}, pack = samplePack()) {
  const approvals = new ManualApprovals();
  const { events, emit } = collect();
  let n = 0;
  const outcome = runOpenCode(pack, {
    approvals,
    emit,
    env: {},
    start: async () => peer,
    newApprovalId: () => `apr_${++n}`,
    ...extra,
  });
  return { approvals, events, outcome };
}

describe("OpenCode recorded session", () => {
  it("replays into the expected events, approving every call no rule covers once and at once", async () => {
    const peer = new RecordedPeer(recording("healthz"), MODEL);
    const lines: string[] = [];
    const writer = new EventWriter((line) => lines.push(line));
    const outcome = await runOpenCode(samplePack(), {
      approvals: new ManualApprovals(),
      emit: (e) => writer.emit(e),
      env: {},
      start: async () => peer,
    });
    expect(peer.error).toBeUndefined();
    expect(outcome).toBe("success");
    expect(lines.map((l) => JSON.parse(l))).toEqual(jsonLines(fixture("opencode/session-healthz.events.jsonl")));
    // Nine tool calls, reads and the todo list included, each asked and answered once; never `always`.
    expect(answers(peer)).toEqual(Array(9).fill("once"));
    // No file system or terminal is offered to the agent.
    expect(peer.sent[0]).toMatchObject({
      method: "initialize",
      params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    });
    expect(peer.stopped).toBe(true);
  });

  it("asks an engineer about a call on the list, under the SDK's tool name, and does not remember the approval", async () => {
    // Three identical `echo` calls in the recording; the rule covers the first two (`sample-one`).
    const peer = new RecordedPeer(recording("once"), MODEL);
    const { approvals, events, outcome } = run(peer, {}, echoRule());
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("approval_request"));
    expect(events.at(-1)).toEqual({
      type: "approval_request",
      id: "apr_1",
      tool_call_id: "call_stub_0_0",
      action: "deploy",
      title: "Run: echo sample-one",
      tool: "Bash",
      input: { command: "echo sample-one", workdir: "/workspace/repo" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answers(peer)).toEqual([]);
    approvals.decide("apr_1", "approved");
    // The same command again is a new request, not covered by the first answer.
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "approval_request", id: "apr_2" }));
    approvals.decide("apr_2", "approved");
    expect(await outcome).toBe("success");
    expect(answers(peer)).toEqual(["once", "once", "once"]);
    expect(events.filter((e) => e.type === "approval_request")).toHaveLength(2);
  });

  it("ends the run when an engineer rejects", async () => {
    const peer = new RecordedPeer(recording("reject"), MODEL);
    const { approvals, events, outcome } = run(peer, {}, echoRule());
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("approval_request"));
    approvals.decide("apr_1", "rejected");
    expect(await outcome).toBe("rejected");
    expect(answers(peer)).toEqual(["reject"]);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "approval_request",
      "tool_call",
      "command",
      "usage",
      "result",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "rejected" });
  });

  it("rejects a tool the run does not offer without asking anyone", async () => {
    // The reject recording, with OpenCode asking to run a tool that cannot be denied in its config.
    const frames = JSON.parse(
      JSON.stringify(recording("reject")).replaceAll('"name":"shell"', '"name":"opencode_worktree_remove"'),
    ) as Frame[];
    const peer = new RecordedPeer(frames, MODEL);
    const { events, outcome } = run(peer);
    expect(await outcome).toBe("rejected");
    expect(answers(peer)).toEqual(["reject"]);
    expect(events.some((e) => e.type === "approval_request")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "rejected", reason: "tool_not_allowed" });
  });

  it("refuses to run a model other than the one asked for", async () => {
    // The recordings ran a stub model; OpenCode falls back to another model when it does not know the one asked for.
    const peer = new RecordedPeer(recording("healthz"));
    const { events, outcome } = run(peer);
    expect(await outcome).toBe("error");
    expect(peer.sent.some((m) => m["method"] === "session/prompt")).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({ type: "result", outcome: "error", reason: "model_unavailable" }),
    ]);
  });

  it("reports the turn's usage with cache and reasoning counted in full", async () => {
    const peer = new RecordedPeer(recording("usage"), MODEL);
    const { events, outcome } = run(peer);
    expect(await outcome).toBe("success");
    const usage = { input_tokens: 2700 + 1200, output_tokens: 450 + 90 };
    expect(events.filter((e) => e.type === "usage")).toEqual([{ type: "usage", usage }]);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "success", usage });
  });
});

describe("OpenCode cancel and deadline", () => {
  it("cancels the turn with session/cancel and ends the run as cancelled", async () => {
    const peer = new RecordedPeer(recording("cancel"), MODEL);
    const cancel = new AbortController();
    const { events, outcome } = run(peer, { cancel: cancel.signal });
    await vi.waitFor(() => expect(answers(peer)).toEqual(["once"]));
    cancel.abort();
    expect(await outcome).toBe("cancelled");
    expect(peer.sent.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: "ses_sample001" } });
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_call", "command", "usage", "result"]);
    expect(events.at(-1)).toMatchObject({ outcome: "cancelled", usage: { input_tokens: 1200, output_tokens: 180 } });
  });

  it("cancels a turn that runs past the deadline", async () => {
    const peer = new RecordedPeer(recording("cancel"), MODEL);
    const { events, outcome } = run(peer, { deadlineMs: 50 });
    expect(await outcome).toBe("cancelled");
    expect(peer.sent.some((m) => m["method"] === "session/cancel")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "cancelled", reason: "time_limit" });
  });

  it("stops OpenCode when it does not end the turn after session/cancel", async () => {
    // OpenCode retrying a failing model forever: the recording stops after the client's session/cancel.
    const frames = recording("cancel");
    const silent = frames.slice(0, frames.findIndex((f) => f.msg["method"] === "session/cancel") + 1);
    const peer = new RecordedPeer(silent, MODEL);
    const cancel = new AbortController();
    const { events, outcome } = run(peer, { cancel: cancel.signal, graceMs: 20 });
    await vi.waitFor(() => expect(answers(peer)).toEqual(["once"]));
    cancel.abort();
    expect(await outcome).toBe("cancelled");
    expect(peer.stopped).toBe(true);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", outcome: "cancelled", text: "", turns: 0, usage: { input_tokens: 0, output_tokens: 0 } },
    ]);
  });

  it("ends with an error result when OpenCode cannot be started", async () => {
    const { events, emit } = collect();
    const outcome = await runOpenCode(samplePack(), {
      approvals: new ManualApprovals(),
      emit,
      env: {},
      start: () => Promise.reject(new Error("spawn EACCES")),
    });
    expect(outcome).toBe("error");
    expect(events).toEqual([expect.objectContaining({ type: "result", outcome: "error", reason: "agent_error" })]);
  });

  it("does not start OpenCode for a run cancelled before it started", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const start = vi.fn();
    const { events } = collect();
    const outcome = await runOpenCode(samplePack(), {
      approvals: new ManualApprovals(),
      emit: (e) => events.push(e),
      env: {},
      cancel: cancel.signal,
      start,
    });
    expect(outcome).toBe("cancelled");
    expect(start).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(["result"]);
  });
});

describe("OpenCode run configuration", () => {
  const intended = JSON.parse(
    // The spike's verified settings (OPENCODE.md, section 5), which the product's static config must keep.
    fixture("../../opencode-spike/config/intended.json"),
  ) as Record<string, unknown>;

  it("keeps the spike's verified policy and fills in only the model, region and turn limit", () => {
    const config = openCodeConfig(samplePack().pack);
    for (const key of ["share", "autoupdate", "snapshot", "websearch", "plugin", "mcp", "permission"])
      expect(config[key], key).toEqual(intended[key]);
    expect(config).toEqual({
      enabled_providers: ["amazon-bedrock"],
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      websearch: false,
      plugin: [],
      mcp: {},
      permission: intended["permission"],
      model: MODEL,
      small_model: MODEL,
      provider: { "amazon-bedrock": { options: { region: "eu-west-1" } } },
      agent: { build: { steps: 40 } },
    });
  });

  it("builds the environment from a list, with fresh directories and placeholder credentials", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/root",
      TMPDIR: "/tmp",
      SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      AWS_ACCESS_KEY_ID: "sample-key-that-must-not-pass",
      AWS_BEARER_TOKEN_BEDROCK: "sample-key-that-must-not-pass",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example",
      OPENCODE_CONFIG_CONTENT: "{}",
    };
    const env = openCodeEnv(base, samplePack().pack, {
      config: "/etc/oryxa/opencode-x",
      home: "/tmp/oryxa-opencode-x",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      HOME: "/tmp/oryxa-opencode-x",
      XDG_CONFIG_HOME: "/tmp/oryxa-opencode-x/.config",
      XDG_DATA_HOME: "/tmp/oryxa-opencode-x/.local/share",
      XDG_STATE_HOME: "/tmp/oryxa-opencode-x/.local/state",
      XDG_CACHE_HOME: "/tmp/oryxa-opencode-x/.cache",
      TMPDIR: "/tmp/oryxa-opencode-x/tmp",
      OPENCODE_CONFIG_DIR: "/etc/oryxa/opencode-x",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_FLAGS: "todo",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      AWS_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "placeholder-access-key-id",
      AWS_SECRET_ACCESS_KEY: "placeholder-secret-access-key",
    });
  });

  it("writes the config where the agent cannot change it, and gives the agent fresh directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "fde-139-"));
    const owned: string[] = [];
    const dirs = await prepareRun(samplePack().pack, { config: root, run: root }, async (path) => {
      owned.push(path);
    });
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    expect(await mode(dirs.config)).toBe(0o755);
    expect(await mode(join(dirs.config, "opencode.json"))).toBe(0o644);
    expect(JSON.parse(await readFile(join(dirs.config, "opencode.json"), "utf8"))).toEqual(
      openCodeConfig(samplePack().pack),
    );
    // Only the run directory is handed to the agent, and nothing in it is shared with another run.
    expect(owned).not.toContain(dirs.config);
    expect(owned.every((p) => p.startsWith(dirs.home))).toBe(true);
    for (const path of owned) expect(await mode(path)).toBe(0o700);
    const second = await prepareRun(samplePack().pack, { config: root, run: root }, async () => {});
    expect(second.home).not.toBe(dirs.home);
    expect(second.config).not.toBe(dirs.config);
    await rm(root, { recursive: true });
  });
});

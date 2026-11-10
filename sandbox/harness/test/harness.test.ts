import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { Adapter } from "../src/adapter.js";
import { EventWriter } from "../src/events.js";
import { harnessEnv, runHarness } from "../src/harness.js";
import { collect, FakeQuery, fixture, jsonLines, ManualApprovals, samplePack } from "./fakes.js";

const SESSION = "5b0f3d0e-sample-session";
// The run's fresh home, which `main.ts` makes with `freshHome`.
const HOME = "/tmp/oryxa-claude-sample";
const deployCall = {
  type: "assistant",
  message: {
    id: "msg_bdrk_d1",
    type: "message",
    role: "assistant",
    model: "anthropic.claude-opus-5-5",
    content: [{ type: "tool_use", id: "toolu_bdrk_d1", name: "Bash", input: { command: "npx wrangler deploy" } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-0000000000d1",
  session_id: SESSION,
} as unknown as SDKMessage;
const deployDone = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bdrk_d1", content: "Deployed." }] },
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-0000000000d2",
  session_id: SESSION,
} as unknown as SDKMessage;
const success = {
  type: "result",
  subtype: "success",
  duration_ms: 10,
  duration_api_ms: 8,
  is_error: false,
  num_turns: 2,
  result: "Deployed.",
  stop_reason: "end_turn",
  total_cost_usd: 0,
  usage: { input_tokens: 20, output_tokens: 10 },
  modelUsage: {},
  permission_denials: [],
  uuid: "00000000-0000-4000-8000-0000000000d3",
  session_id: SESSION,
} as unknown as SDKMessage;
const deployScript = [deployCall, { ask: "Bash", input: { command: "npx wrangler deploy" } }, deployDone, success];

describe("recorded session", () => {
  it("replays into the expected event sequence", async () => {
    const recorded = jsonLines(fixture("session.sdk.jsonl")) as SDKMessage[];
    const fake = new FakeQuery(recorded);
    const lines: string[] = [];
    const writer = new EventWriter((line) => lines.push(line));
    const outcome = await runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals: new ManualApprovals(),
      emit: (e) => writer.emit(e),
      env: {},
    });
    expect(outcome).toBe("success");
    expect(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true);
    expect(lines.map((l) => JSON.parse(l))).toEqual(jsonLines(fixture("session.events.jsonl")));
  });
});

describe("approvals", () => {
  it("pause the run on an action on the approval list until an engineer approves", async () => {
    const fake = new FakeQuery(deployScript);
    const approvals = new ManualApprovals();
    const { events, emit } = collect();
    const run = runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals,
      emit,
      env: {},
      newApprovalId: () => "apr_1",
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("approval_request"));
    expect(events.at(-1)).toEqual({
      type: "approval_request",
      id: "apr_1",
      tool_call_id: "toolu_bdrk_d1",
      action: "deploy",
      title: "Run: npx wrangler deploy",
      tool: "Bash",
      input: { command: "npx wrangler deploy" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.progressedAfterPermission).toBe(false);
    const seenWhilePaused = events.length;

    approvals.decide("apr_1", "approved");
    expect(await run).toBe("success");
    expect(fake.permissions).toEqual([{ behavior: "allow", updatedInput: { command: "npx wrangler deploy" } }]);
    expect(events.slice(seenWhilePaused).map((e) => e.type)).toEqual(["tool_call", "command", "result"]);
  });

  it("end the run when an engineer rejects", async () => {
    const fake = new FakeQuery(deployScript);
    const approvals = new ManualApprovals();
    const { events, emit } = collect();
    const run = runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals,
      emit,
      env: {},
      newApprovalId: () => "apr_1",
    });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("approval_request"));
    approvals.decide("apr_1", "rejected");
    expect(await run).toBe("rejected");
    expect(fake.permissions).toEqual([expect.objectContaining({ behavior: "deny", interrupt: true })]);
    expect(fake.options?.abortController?.signal.aborted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "approval_request", "result"]);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "rejected" });
  });

  it("show the full input, however long, and refuse one too large to review", async () => {
    const padded = `wrangler deploy --env staging ${" ".repeat(300)}; wrangler deploy --env production`;
    const fake = new FakeQuery([{ ask: "Bash", input: { command: padded } }, success]);
    const approvals = new ManualApprovals();
    const { events, emit } = collect();
    const run = runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals,
      emit,
      env: {},
      newApprovalId: () => "apr_1",
    });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("approval_request"));
    expect(events.at(-1)).toMatchObject({ tool: "Bash", input: { command: padded } });
    approvals.decide("apr_1", "rejected");
    await run;

    const huge = new FakeQuery([
      { ask: "Bash", input: { command: `npx wrangler deploy ${"x".repeat(300_000)}` } },
      success,
    ]);
    const second = collect();
    await runHarness(samplePack(), {
      home: HOME,
      query: huge.query,
      approvals: new ManualApprovals(),
      emit: second.emit,
      env: {},
    });
    expect(second.events.some((e) => e.type === "approval_request")).toBe(false);
    expect(huge.permissions).toEqual([expect.objectContaining({ behavior: "deny" })]);
  });

  it("refuse an input too large to match, even when the rule's pattern would not match it", async () => {
    // `deploy` is nowhere in it: under the size bound it would be unlisted and run.
    const fake = new FakeQuery([{ ask: "Bash", input: { command: `echo ${"x".repeat(300_000)}` } }, success]);
    const { events, emit } = collect();
    await runHarness(samplePack(), { home: HOME, query: fake.query, approvals: new ManualApprovals(), emit, env: {} });
    expect(events.some((e) => e.type === "approval_request")).toBe(false);
    expect(fake.permissions).toEqual([expect.objectContaining({ behavior: "deny" })]);
  });

  it("let tools outside the approval list run without asking", async () => {
    const fake = new FakeQuery([{ ask: "Bash", input: { command: "npm test" } }, success]);
    const { events, emit } = collect();
    expect(
      await runHarness(samplePack(), {
        home: HOME,
        query: fake.query,
        approvals: new ManualApprovals(),
        emit,
        env: {},
      }),
    ).toBe("success");
    expect(fake.permissions).toEqual([{ behavior: "allow", updatedInput: { command: "npm test" } }]);
    expect(events.some((e) => e.type === "approval_request")).toBe(false);
  });
});

describe("SDK options", () => {
  it("load no repository settings and run on Bedrock with no credentials in the environment", async () => {
    const fake = new FakeQuery([success]);
    const env = {
      PATH: "/usr/bin",
      HOME: "/root",
      TMPDIR: "/tmp",
      SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      ANTHROPIC_API_KEY: "sample-key-that-must-not-pass",
      AWS_ACCESS_KEY_ID: "sample-key-that-must-not-pass",
      AWS_SECRET_ACCESS_KEY: "sample-key-that-must-not-pass",
      AWS_BEARER_TOKEN_BEDROCK: "sample-key-that-must-not-pass",
      CLAUDE_CODE_OAUTH_TOKEN: "sample-key-that-must-not-pass",
    };
    await runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals: new ManualApprovals(),
      emit: () => {},
      env,
    });
    const options = fake.options;
    expect(options?.settingSources).toEqual([]);
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.permissionMode).toBe("default");
    expect(options?.model).toBe("anthropic.claude-opus-5-5");
    expect(options?.maxTurns).toBe(40);
    expect(options?.cwd).toBe("/workspace");
    expect(fake.prompt).toBe("Add a /healthz endpoint to the API service, with a test.");
    expect(options?.env).toEqual({
      PATH: "/usr/bin",
      // The run's own home, XDG and temp directories, never the agent's shared home or the harness's.
      HOME,
      XDG_CONFIG_HOME: `${HOME}/.config`,
      XDG_DATA_HOME: `${HOME}/.local/share`,
      XDG_STATE_HOME: `${HOME}/.local/state`,
      XDG_CACHE_HOME: `${HOME}/.cache`,
      TMPDIR: `${HOME}/tmp`,
      SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      AWS_REGION: "eu-west-1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "oryxa-fde-harness/0.1.0",
    });
    expect(JSON.stringify(harnessEnv(env, samplePack().pack, HOME))).not.toContain("sample-key-that-must-not-pass");
  });

  it("start the agent through the spawner it is given", async () => {
    const fake = new FakeQuery([success]);
    const spawn = vi.fn();
    await runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals: new ManualApprovals(),
      emit: () => {},
      env: {},
      spawn,
    });
    expect(fake.options?.spawnClaudeCodeProcess).toBe(spawn);
  });

  it("report an SDK that ends without a result as an error", async () => {
    const { events, emit } = collect();
    const fake = new FakeQuery([]);
    expect(
      await runHarness(samplePack(), {
        home: HOME,
        query: fake.query,
        approvals: new ManualApprovals(),
        emit,
        env: {},
      }),
    ).toBe("error");
    expect(events).toEqual([expect.objectContaining({ type: "result", outcome: "error", reason: "no_result" })]);
  });
});

describe("errors", () => {
  it("never show the SDK's own error text in the product", async () => {
    const failing = (() =>
      (async function* () {
        throw new Error("Claude Code process exited with code 1");
      })()) as unknown as Parameters<typeof runHarness>[1]["query"];
    const { events, emit } = collect();
    expect(
      await runHarness(samplePack(), { home: HOME, query: failing, approvals: new ManualApprovals(), emit, env: {} }),
    ).toBe("error");
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result", outcome: "error", reason: "sdk_error" });
    expect(JSON.stringify(result)).not.toMatch(/claude/i);
  });
});

describe("cancel", () => {
  // An SDK that never yields again, as one stuck on a slow model call would.
  const stuck = (() =>
    (async function* () {
      yield deployCall;
      await new Promise(() => {});
    })()) as unknown as Parameters<typeof runHarness>[1]["query"];

  it("ends a running run with a cancelled result, even when the SDK does not stop", async () => {
    const cancel = new AbortController();
    const { events, emit } = collect();
    const run = runHarness(samplePack(), {
      home: HOME,
      query: stuck,
      approvals: new ManualApprovals(),
      emit,
      env: {},
      cancel: cancel.signal,
    });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("tool_call"));
    cancel.abort();
    expect(await run).toBe("cancelled");
    expect(events.at(-1)).toEqual({
      type: "result",
      outcome: "cancelled",
      text: "",
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });

  it("denies a pending approval and never lets it run", async () => {
    const fake = new FakeQuery(deployScript);
    const approvals = new ManualApprovals();
    const cancel = new AbortController();
    const { events, emit } = collect();
    const run = runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals,
      emit,
      env: {},
      cancel: cancel.signal,
      newApprovalId: () => "apr_1",
    });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("approval_request"));
    cancel.abort();
    expect(await run).toBe("cancelled");
    // An approval that arrives after the cancel changes nothing.
    approvals.decide("apr_1", "approved");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.permissions).toEqual([{ behavior: "deny", message: "The run was cancelled.", interrupt: true }]);
    expect(fake.options?.abortController?.signal.aborted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "approval_request", "result"]);
    expect(events.at(-1)).toMatchObject({ outcome: "cancelled" });
  });

  it("stops a run cancelled before it started", async () => {
    const fake = new FakeQuery([deployCall, success]);
    const cancel = new AbortController();
    cancel.abort();
    const { events, emit } = collect();
    const outcome = await runHarness(samplePack(), {
      home: HOME,
      query: fake.query,
      approvals: new ManualApprovals(),
      emit,
      env: {},
      cancel: cancel.signal,
    });
    expect(outcome).toBe("cancelled");
    expect(events.map((e) => e.type)).toEqual(["result"]);
  });
});

describe("usage", () => {
  const stream = (event: unknown) =>
    ({ type: "stream_event", event, parent_tool_use_id: null }) as unknown as SDKMessage;
  const response = (input: Record<string, number>, output: number) => [
    stream({ type: "message_start", message: { id: "msg_1", usage: { ...input, output_tokens: 1 } } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
    stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } }),
    stream({ type: "message_stop" }),
  ];

  it("reports each finished response's final use, summed over the run, with cache tokens counted in full", () => {
    const adapter = new Adapter();
    const first = response({ input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, 40);
    const second = response({ input_tokens: 300 }, 60);
    expect(first.flatMap((m) => adapter.events(m))).toEqual([
      { type: "usage", usage: { input_tokens: 160, output_tokens: 40 } },
    ]);
    expect(second.flatMap((m) => adapter.events(m))).toEqual([
      { type: "usage", usage: { input_tokens: 460, output_tokens: 100 } },
    ]);
  });

  it("ignores counts that are not plain non-negative integers", () => {
    const adapter = new Adapter();
    const events = response({ input_tokens: -5, cache_read_input_tokens: 1.5 }, Number.NaN).flatMap((m) =>
      adapter.events(m),
    );
    expect(events).toEqual([{ type: "usage", usage: { input_tokens: 0, output_tokens: 1 } }]);
    expect(adapter.events(stream({ type: "message_stop" }))).toEqual([]);
  });
});

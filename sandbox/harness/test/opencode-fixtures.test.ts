import { readdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";

import { describe, expect, it } from "vitest";

// The OpenCode spike's recordings (see OPENCODE.md): what `opencode acp` 2.2.7 said and did over its stdio pipes in
// the lab. Nothing here runs OpenCode; these tests pin the shape of the evidence so a re-recording that changes
// behaviour, or leaks something machine-specific, is noticed in review.
const DIR = new URL("./fixtures/opencode/", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, DIR), "utf8");
const json = (name: string) => JSON.parse(text(name)) as Record<string, any>;

interface Frame {
  dir: "agent->client" | "client->agent";
  msg: Record<string, any>;
}
const session = (name: string): Frame[] =>
  text(`session-${name}.acp.jsonl`)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame);
const fromAgent = (frames: Frame[]) => frames.filter((f) => f.dir === "agent->client").map((f) => f.msg);
const permissions = (frames: Frame[]) => fromAgent(frames).filter((m) => m["method"] === "session/request_permission");
const updates = (frames: Frame[], kind: string) =>
  fromAgent(frames)
    .filter((m) => m["params"]?.update?.sessionUpdate === kind)
    .map((m) => m["params"].update as Record<string, any>);
const stop = (frames: Frame[]) => fromAgent(frames).find((m) => m["result"]?.stopReason !== undefined)?.["result"];

const SESSIONS = ["healthz", "reject", "always", "once", "cancel", "readonly", "readonly-rg", "forbidden", "usage"];

describe("recorded ACP sessions", () => {
  it.each(SESSIONS)("%s is newline-delimited JSON-RPC 2.0 and opens with initialize", (name) => {
    const frames = session(name);
    expect(frames.every((f) => f.msg["jsonrpc"] === "2.0")).toBe(true);
    expect(frames[0]).toMatchObject({ dir: "client->agent", msg: { method: "initialize" } });
    expect(frames[1]?.msg["result"]?.protocolVersion).toBe(1);
  });

  // The two sides number their requests separately (both start near 0), so an answer is a client response.
  it.each(SESSIONS)("%s: every permission request is answered once, by the client, with an offered option", (name) => {
    const frames = session(name);
    for (const request of permissions(frames)) {
      const answers = frames.filter(
        (f) => f.dir === "client->agent" && f.msg["method"] === undefined && f.msg["id"] === request["id"],
      );
      expect(answers).toHaveLength(1);
      const offered = (request["params"].options as { optionId: string }[]).map((o) => o.optionId);
      expect(offered).toEqual(["once", "always", "reject"]);
      expect(offered).toContain(answers[0]?.msg["result"].outcome.optionId);
    }
  });

  it("the full session runs plan, read, edit, write, a failing and a passing shell command, then ends the turn", () => {
    const frames = session("healthz");
    const calls = updates(frames, "tool_call");
    expect(calls.map((c) => c["name"])).toEqual([
      "todowrite",
      "read",
      "edit",
      "todowrite",
      "write",
      "shell",
      "edit",
      "shell",
      "todowrite",
    ]);
    expect(calls.map((c) => c["kind"])).toEqual([
      "other",
      "read",
      "edit",
      "other",
      "edit",
      "execute",
      "edit",
      "execute",
      "other",
    ]);
    expect(stop(frames)?.["stopReason"]).toBe("end_turn");
    // OpenCode 2.2.7 sends no ACP `plan` update: the todo list is only a `todowrite` tool call.
    expect(updates(frames, "plan")).toHaveLength(0);
    // An edit carries a diff, and the shell result carries the exit code.
    const edits = updates(frames, "tool_call_update").filter((u) => u["content"]?.some((c: any) => c.type === "diff"));
    expect(edits.length).toBeGreaterThanOrEqual(2);
    const shell = updates(frames, "tool_call_update").filter((u) =>
      JSON.stringify(u["content"] ?? "").includes("Exit code: 1"),
    );
    expect(shell).toHaveLength(1);
    // A command that exits 1 is still `completed`: the adapter must read the exit code.
    expect(shell[0]?.["status"]).toBe("completed");
  });

  it.each(["healthz", "readonly", "once", "usage"])(
    "%s: every tool call that ran was preceded by a permission request for it",
    (name) => {
      const messages = fromAgent(session(name));
      const completed = messages.filter(
        (m) => m["params"]?.update?.sessionUpdate === "tool_call_update" && m["params"].update.status === "completed",
      );
      expect(completed.length).toBeGreaterThan(0);
      for (const done of completed) {
        const id = done["params"].update.toolCallId;
        const asked = messages.findIndex(
          (m) => m["method"] === "session/request_permission" && m["params"].toolCall.toolCallId === id,
        );
        expect(asked, `${id} completed without a request`).toBeGreaterThanOrEqual(0);
        expect(asked).toBeLessThan(messages.indexOf(done));
      }
    },
  );

  it("the exception is a call covered by an earlier answer of always, which runs without a new request", () => {
    const messages = fromAgent(session("always"));
    const asked = new Set(
      messages.filter((m) => m["method"] === "session/request_permission").map((m) => m["params"].toolCall.toolCallId),
    );
    const completed = messages
      .filter(
        (m) => m["params"]?.update?.sessionUpdate === "tool_call_update" && m["params"].update.status === "completed",
      )
      .map((m) => m["params"].update.toolCallId as string);
    expect(completed.filter((id) => !asked.has(id))).toHaveLength(2);
  });

  it("read-only tools ask too under a base policy of ask", () => {
    expect(permissions(session("readonly")).map((p) => p["params"].toolCall.name)).toEqual(["read", "glob", "grep"]);
  });

  it("grep and glob fail without ripgrep, and work with it", () => {
    const outcome = (name: string, tool: string) => {
      const calls = fromAgent(session(name))
        .filter((m) => m["params"]?.update?.sessionUpdate === "tool_call_update")
        .map((m) => m["params"].update as Record<string, any>);
      const asked = fromAgent(session(name))
        .filter((m) => m["method"] === "session/request_permission" && m["params"].toolCall.name === tool)
        .map((m) => m["params"].toolCall.toolCallId);
      return calls
        .filter((u) => asked.includes(u["toolCallId"]) && u["status"] !== "in_progress")
        .map((u) => u["status"]);
    };
    expect(outcome("readonly", "grep")).toEqual(["failed"]);
    expect(outcome("readonly", "glob")).toEqual(["failed"]);
    expect(outcome("readonly-rg", "grep")).toEqual(["completed"]);
    expect(outcome("readonly-rg", "glob")).toEqual(["completed"]);
  });

  it("an answer of once does not persist, and an answer of always does, for the rest of the session", () => {
    expect(permissions(session("once"))).toHaveLength(3);
    expect(permissions(session("always"))).toHaveLength(1);
  });

  it("a rejection or a cancel ends the turn as cancelled", () => {
    expect(stop(session("reject"))?.["stopReason"]).toBe("cancelled");
    const cancel = session("cancel");
    expect(cancel.some((f) => f.dir === "client->agent" && f.msg["method"] === "session/cancel")).toBe(true);
    expect(stop(cancel)?.["stopReason"]).toBe("cancelled");
  });

  it("denied tools raise no request and fail", () => {
    const frames = session("forbidden");
    expect(permissions(frames)).toHaveLength(0);
    const finished = updates(frames, "tool_call_update").filter((u) => u["status"] === "failed");
    expect(finished).toHaveLength(6);
  });

  it("usage is reported per turn, with cache and reasoning counts, and once more as context size", () => {
    const frames = session("usage");
    expect(stop(frames)?.["usage"]).toEqual({
      inputTokens: 2700,
      outputTokens: 450,
      totalTokens: 4440,
      thoughtTokens: 90,
      cachedReadTokens: 1200,
    });
    expect(updates(frames, "usage_update")).toHaveLength(1);
  });
});

describe("recorded findings", () => {
  it("the intended settings reach no host but the model once rg is on PATH", () => {
    const egress = json("egress.json");
    expect(egress["intended"]).toEqual([]);
    expect(egress["s-healthz"]).toEqual([]);
    expect(egress["hostile-protected"]).toEqual([]);
    expect(egress["default"]).toEqual(["models.opencode.ai"]);
    expect(egress["models-fetch-off"]).toEqual([]);
    // Without `rg` on PATH, grep and glob download ripgrep; with it they reach nothing.
    expect(egress["s-readonly"]).toEqual(["github.com"]);
    expect(egress["s-readonly-rg"]).toEqual([]);
  });

  it("a hostile repository and home change nothing under the intended settings, and do without them", () => {
    const hostile = json("hostile.json");
    expect(hostile["identical_to_clean"]).toBe(true);
    expect(hostile["hostile_with_intended_settings"].files_created_by_hostile_code).toEqual([]);
    expect(hostile["hostile_with_intended_settings"].hostile_text_in_requests).toEqual([]);
    expect(hostile["hostile_without_protections"].files_created_by_hostile_code.length).toBeGreaterThan(0);
    expect(hostile["hostile_without_protections_stub_model_kept"].hostile_text_in_requests.length).toBeGreaterThan(0);
  });

  it("a skill in the home directory surfaces once skills are offered, and a fresh home stops it", () => {
    const hostile = json("hostile.json");
    expect(hostile["hostile_with_intended_settings_and_skills_offered"].hostile_text_in_requests).toEqual([
      "HOSTILE-HOME-SKILL-MARKER",
    ]);
    expect(hostile["hostile_with_intended_settings_skills_offered_fresh_home"].hostile_text_in_requests).toEqual([]);
  });

  it("a credential file in the home directory overrides the configured key, and a fresh home does not", () => {
    const { default_home, fresh_home_and_xdg_dirs } = json("hostile.json")["home_auth_json_overrides_config_key"];
    expect(default_home).toBe("Bearer planted-home-key-sample");
    expect(fresh_home_and_xdg_dirs).toBe("Bearer placeholder");
  });

  it("Bedrock requests are signed by OpenCode itself, or carry the bearer token", () => {
    const wire = json("bedrock-wire.json");
    expect(wire["access_keys"].headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=placeholder-access-key-id\//,
    );
    expect(wire["access_keys_with_session_token"].headers["x-amz-security-token"]).toBe("placeholder-session-token");
    expect(wire["bearer_token"].headers.authorization).toBe("Bearer placeholder-bearer-not-real");
    expect(wire["no_credentials_sent_a_request"]).toBe(false);
  });

  it("a process under the agent can answer permissions over HTTP unless the binary is execute-only", () => {
    const forged = json("forged-answers.json");
    const last = (key: string) => forged[key].steps.at(-1);
    expect(last("http-readable")).toMatchObject({ step: "reply once to a pending request", status: 204 });
    expect(last("http-execonly")).toMatchObject({ step: "failed", error: "EACCES" });
    expect(last("stdin-readable")).toMatchObject({ ok: false, error: "ENXIO" });
    expect(last("stdin-execonly")).toMatchObject({ ok: false, error: "EACCES" });
  });
});

describe("fixture hygiene", () => {
  const files = readdirSync(DIR).filter((name) => name !== ".gitkeep");
  // Host names the lab's sessions legitimately mention; anything else must be an invented `*.example` name.
  const KNOWN_HOSTS = new Set([
    "models.opencode.ai",
    "opencode.ai",
    "mcp.exa.ai",
    "search.parallel.ai",
    "agent.tinyfish.ai",
    "example.com",
    "github.com",
    "registry.npmjs.org",
    "bedrock-runtime.us-east-1.amazonaws.com",
  ]);
  const NAME =
    /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|dev|app|cloud|internal|lan|local|example)\b/g;
  // The recording machine's own identifiers, read at test time so no literal is kept here. A CI runner is not that
  // machine, and its user name (`runner`) occurs in ordinary text such as node's `test_runner`.
  const own = process.env["CI"] ? [] : [hostname(), userInfo().username].filter((v) => v.length >= 5 && v !== "agent");

  it.each(files)("%s names nothing of the recording machine and holds no secret-shaped value", (name) => {
    const body = text(name);
    // Paths: the lab's /home/agent is the sample user; any other home path is a machine's.
    expect(body).not.toMatch(/\/home\/(?!agent\b)|\/Users\/|\/root\//);
    // Names: no tailnet or internal-only domain, and no host name outside the known set and `*.example`.
    expect(body).not.toMatch(/\.ts\.net|\.internal\b|[a-z0-9]\.lan\b|[a-z0-9]\.local\b|[a-z0-9]\.compute\b/);
    for (const found of body.matchAll(NAME)) {
      const host = found[0];
      expect(KNOWN_HOSTS.has(host) || host.endsWith(".example"), `unexpected host name ${host}`).toBe(true);
    }
    // Addresses: only the lab network and loopback.
    for (const found of body.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
      expect(found[0]).toMatch(/^(10\.123\.0\.\d+|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/);
    }
    // The lab is IPv4 only, so no hardware address and no IPv6 address but loopback.
    expect(body).not.toMatch(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i);
    for (const found of body.matchAll(/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/gi)) {
      const v6 = found[0].includes("::") || /[a-f]/i.test(found[0]);
      expect(v6 && !["::", "::1"].includes(found[0]), `unexpected address ${found[0]}`).toBe(false);
    }
    for (const value of own) expect(body.toLowerCase()).not.toContain(value.toLowerCase());
    // Ids are the numbered samples, and nothing is key-shaped (including AWS access key ids, however bounded).
    expect(body).not.toMatch(/ses_(?!sample)[A-Za-z0-9]{10,}/);
    expect(body).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_|github_pat_|-----BEGIN/);
    // The only bearer values are the invented placeholders.
    for (const match of body.matchAll(/Bearer ([A-Za-z0-9._-]+)/g)) {
      expect(match[1]).toMatch(/^(placeholder|planted-home-key-sample)/);
    }
  });
});

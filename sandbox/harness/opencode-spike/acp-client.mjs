// A minimal Agent Client Protocol client, standing in for the adapter during the spike. It starts `opencode acp`
// with pipes only it holds, runs one prompt, answers permission requests by a fixed policy, and writes every frame
// in both directions to --out (one JSON object per line: direction, ms since start, the raw line).
//   node acp-client.mjs --cwd /workspace/repo --prompt "..." --out /scratch/frames.jsonl [--answer allow_once]
//        [--cancel-after-tool-calls N] [--cancel-after-ms N] [--cmd opencode --cmd-arg acp] [--no-prompt] [--client-caps '{}']
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const cwd = opt("cwd", "/workspace/repo");
const out = opt("out", "/scratch/frames.jsonl");
const prompt = opt("prompt", "[scenario:hello] hello");
// allow_once | reject_once | allow_always | cancelled | allow_once_then_reject (alternate) | first-only (answer the
// first request once, never answer another) | none (never answer)
const answer = opt("answer", "allow_once");
const cancelAfterToolCalls = Number(opt("cancel-after-tool-calls", "0"));
const command = opt("cmd", "opencode");
const commandArgs = opts("cmd-arg").length > 0 ? opts("cmd-arg") : ["acp"];
const clientCaps = JSON.parse(opt("client-caps", "{}"));
const timeoutMs = Number(opt("timeout-ms", "120000"));
const cancelAfterMs = Number(opt("cancel-after-ms", "0"));
const startupOnly = args.includes("--no-prompt");

writeFileSync(out, "");
const t0 = Date.now();
const record = (direction, line) =>
  appendFileSync(out, `${JSON.stringify({ d: direction, ms: Date.now() - t0, line })}\n`);

const child = spawn(command, commandArgs, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
record("meta", `spawned pid=${child.pid} cmd=${[command, ...commandArgs].join(" ")}`);
child.stderr.on("data", (chunk) => appendFileSync(`${out}.stderr`, chunk));
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

let nextId = 1;
const pending = new Map();
const send = (message) => {
  const line = JSON.stringify(message);
  record("c2a", line);
  child.stdin.write(`${line}\n`);
};
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

let sessionId;
let toolCalls = 0;
let permissionCount = 0;
let cancelSent = false;

createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  record("a2c", line);
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "session/update") {
    const u = message.params?.update;
    if (u?.sessionUpdate === "tool_call") toolCalls++;
    if (cancelAfterToolCalls > 0 && toolCalls >= cancelAfterToolCalls && !cancelSent && sessionId) {
      cancelSent = true;
      send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    }
    return;
  }
  if (message.method === "session/request_permission") {
    permissionCount++;
    const options = message.params?.options ?? [];
    const pick = (kind) => options.find((o) => o.kind === kind);
    let result;
    const mode =
      answer === "first-only"
        ? "allow_once"
        : answer === "allow_once_then_reject"
          ? permissionCount % 2 === 1
            ? "allow_once"
            : "reject_once"
          : answer;
    if (mode === "none" || (answer === "first-only" && permissionCount > 1)) return;
    if (mode === "cancelled") result = { outcome: { outcome: "cancelled" } };
    else {
      const chosen = pick(mode) ?? options[0];
      result = { outcome: { outcome: "selected", optionId: chosen?.optionId } };
    }
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }
  if (message.id !== undefined) {
    // Any other request from the agent (fs/*, terminal/*): we advertise none, so refuse it.
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported by the spike client" } });
  }
});

const deadline = setTimeout(() => {
  record("meta", "client timeout");
  child.kill("SIGKILL");
  setTimeout(() => process.exit(2), 500);
}, timeoutMs);

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: clientCaps,
  clientInfo: { name: "oryxa-spike", version: "0" },
});
if (init.error === undefined && !startupOnly) {
  const created = await request("session/new", { cwd, mcpServers: [] });
  sessionId = created.result?.sessionId;
  if (sessionId !== undefined) {
    if (cancelAfterMs > 0) {
      setTimeout(() => {
        cancelSent = true;
        send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      }, cancelAfterMs);
    }
    const done = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    record("meta", `prompt done: ${JSON.stringify(done.result ?? done.error)}`);
  }
}
if (startupOnly) await new Promise((r) => setTimeout(r, Number(opt("hold-ms", "3000"))));
clearTimeout(deadline);
child.stdin.end();
const end = await Promise.race([
  exited,
  new Promise((r) => setTimeout(() => r({ code: "still running after stdin EOF" }), 5000)),
]);
record("meta", `exit ${JSON.stringify(end)}`);
if (end.code === "still running after stdin EOF") child.kill("SIGKILL");
process.exit(0);

// Records a real harness session for the replay fixtures: the harness and the SDK run for real, inside the sandbox
// image, against a local model server that plays a scripted turn per request. No Bedrock, no credentials.
//
//   npm run build && docker run --rm --network none -v "$PWD:/harness" \
//     -v "$PWD/dist:/opt/oryxa-harness/dist:ro" oryxa-fde-sandbox:dev node /harness/test/record/record.mjs
//
// It writes test/fixtures/session.sdk.jsonl (what the SDK emitted) and session.events.jsonl (what the harness
// emitted). Review the events by hand before committing them: the replay test pins them from then on.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

import { query } from "/opt/oryxa-harness/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { EventWriter } from "/opt/oryxa-harness/dist/events.js";
import { runHarness } from "/opt/oryxa-harness/dist/harness.js";
import { parsePack } from "/opt/oryxa-harness/dist/pack.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const REPO = "/workspace/repo";
const SERVER = `${REPO}/src/server.mjs`;
const TEST = `${REPO}/test/healthz.test.mjs`;

// The sample customer repository the agent works on.
mkdirSync(`${REPO}/src`, { recursive: true });
mkdirSync(`${REPO}/test`, { recursive: true });
writeFileSync(`${REPO}/package.json`, JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2));
writeFileSync(
  SERVER,
  'export function handle(path) {\n  if (path === "/") return { status: 200, body: "hello" };\n  return { status: 404, body: "not found" };\n}\n',
);

const text = (t) => ({ type: "text", text: t });
const tool = (name, input) => ({ type: "tool_use", name, input });
const taskIds = (body) => [...JSON.stringify(body.messages).matchAll(/Task #(\d+)/g)].map((m) => m[1]);

// One assistant turn per model request that offers tools. Later turns read the task ids the SDK assigned.
const turns = [
  () => [
    text("I'll add a /healthz route and a test for it."),
    tool("TaskCreate", {
      subject: "Add a /healthz route",
      description: "Return 200 ok.",
      activeForm: "Adding the route",
    }),
    tool("TaskCreate", { subject: "Add a test for /healthz", description: "node:test", activeForm: "Adding a test" }),
  ],
  (body) => [
    tool("TaskUpdate", { taskId: taskIds(body)[0], status: "in_progress" }),
    tool("Read", { file_path: SERVER }),
  ],
  () => [
    tool("Edit", {
      file_path: SERVER,
      old_string: '  if (path === "/") return',
      new_string: '  if (path === "/healthz") return { status: 200, body: "ok" };\n  if (path === "/") return',
    }),
  ],
  (body) => [
    tool("TaskUpdate", { taskId: taskIds(body)[0], status: "completed" }),
    tool("TaskUpdate", { taskId: taskIds(body)[1], status: "in_progress" }),
    tool("Write", {
      file_path: TEST,
      content:
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { handle } from "../src/server.mjs";\n\ntest("healthz", () => {\n  assert.deepEqual(handle("/healthz"), { status: 200, body: "ok\\n" });\n});\n',
    }),
  ],
  () => [tool("Bash", { command: "cd repo && npm test", description: "Run the tests" })],
  () => [tool("Edit", { file_path: TEST, old_string: 'body: "ok\\n"', new_string: 'body: "ok"' })],
  () => [tool("Bash", { command: "cd repo && npm test", description: "Run the tests again" })],
  (body) => [tool("TaskUpdate", { taskId: taskIds(body)[1], status: "completed" })],
  () => [text('Added GET /healthz returning "ok", with a test. The tests pass.')],
];

let turn = 0;
let blockId = 0;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw === "" ? {} : JSON.parse(raw);
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
      return;
    }
    // Side requests (titles, summaries) carry no tools; the scripted turns answer the agent loop only.
    const blocks =
      Array.isArray(body.tools) && body.tools.length > 0 && turn < turns.length ? turns[turn++](body) : [text("ok")];
    const content = blocks.map((b) =>
      b.type === "tool_use" ? { ...b, id: `toolu_rec_${String(++blockId).padStart(2, "0")}` } : b,
    );
    const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    const message = {
      id: `msg_rec_${turn}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 180 },
    };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    send({
      type: "message_start",
      message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1 } },
    });
    content.forEach((block, index) => {
      if (block.type === "text") {
        send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        send({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      } else {
        send({ type: "content_block_start", index, content_block: { ...block, input: {} } });
        send({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        });
      }
      send({ type: "content_block_stop", index });
    });
    send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 180 } });
    send({ type: "message_stop" });
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const sdkLines = [];
const eventLines = [];
// The recorder's only change to the harness: the first-party protocol to the local server instead of Bedrock.
const recordingQuery = (params) => {
  const env = {
    ...params.options.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: "sample-recorder-key",
  };
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_SKIP_BEDROCK_AUTH;
  const inner = query({ ...params, options: { ...params.options, model: "claude-opus-5-5", env } });
  return (async function* () {
    for await (const message of inner) {
      sdkLines.push(JSON.stringify(message));
      yield message;
    }
  })();
};

const loaded = parsePack(JSON.parse(readFileSync(new URL("context.json", FIXTURES), "utf8")));
const writer = new EventWriter((line) => eventLines.push(line));
const outcome = await runHarness(loaded, {
  query: recordingQuery,
  approvals: { request: async () => "rejected" },
  emit: (e) => writer.emit(e),
  env: process.env,
});
server.close();

const sdk = `${sdkLines.join("\n")}\n`;
if (sdk.includes("sample-recorder-key")) throw new Error("the recording holds the recorder's key");
writeFileSync(new URL("session.sdk.jsonl", FIXTURES), sdk);
writeFileSync(new URL("session.events.jsonl", FIXTURES), eventLines.join(""));
console.error(`outcome=${outcome} sdk_messages=${sdkLines.length} events=${eventLines.length} turns_used=${turn}`);

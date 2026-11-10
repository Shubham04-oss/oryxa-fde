// A stand-in model provider for the OpenCode spike: canned answers, no credentials. It speaks OpenAI's chat
// completions wire format (what `@ai-sdk/openai-compatible` sends) and records Amazon Bedrock Converse requests
// (headers only) for the signing check. The protocol is what matters here, not the answers. Every request is
// logged to $LOG as one JSON object per line; chat bodies are logged in full, Bedrock bodies not at all.
import { appendFileSync } from "node:fs";
import http from "node:http";

import { scenarios } from "./scenarios.mjs";

const LOG = process.env.LOG ?? "/scratch/logs/model.jsonl";
const PORT = Number(process.env.PORT ?? 8080);
const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);

const lastUserText = (messages) => {
  const user = messages.filter((m) => m.role === "user").at(-1);
  if (user === undefined) return "";
  return typeof user.content === "string" ? user.content : user.content.map((p) => p.text ?? "").join("\n");
};

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.url.startsWith("/model/")) {
        // Bedrock Converse / ConverseStream: record the signing headers and refuse; the body is not needed.
        log({ kind: "bedrock", method: req.method, url: req.url, headers: req.rawHeaders, bytes: raw.length });
        res.writeHead(403, { "content-type": "application/json", "x-amzn-errortype": "AccessDeniedException" });
        res.end('{"message":"stub: request recorded, not served"}');
        return;
      }
      if (!req.url.endsWith("/chat/completions")) {
        log({ kind: "other", method: req.method, url: req.url, headers: req.rawHeaders });
        res.writeHead(404).end("{}");
        return;
      }
      const body = JSON.parse(raw);
      const text = lastUserText(body.messages);
      const name = /\[scenario:([a-z0-9-]+)\]/.exec(JSON.stringify(body.messages))?.[1];
      // The agent loop carries tools; side requests (titles) do not and get a short plain answer.
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      // A turn is one model request in the agent loop: count the assistant messages so far.
      const turn = body.messages.filter((m) => m.role === "assistant").length;
      const script = name === undefined ? undefined : scenarios[name];
      const step = hasTools && script !== undefined ? script(turn, body) : undefined;
      log({
        kind: "chat",
        url: req.url,
        headers: req.rawHeaders,
        scenario: name,
        turn,
        hasTools,
        toolNames: hasTools ? body.tools.map((t) => t.function?.name) : [],
        stream: body.stream === true,
        model: body.model,
        step: step === undefined ? "plain" : (step.toolCalls ?? []).map((c) => c.name),
        body: process.env.LOG_BODIES === "0" ? undefined : body,
        prompt: text.slice(0, 200),
      });
      const reply = step ?? { text: hasTools ? "Done." : "Sample title" };
      const id = `chatcmpl-stub-${turn}`;
      const toolCalls = (reply.toolCalls ?? []).map((c, i) => ({
        index: i,
        id: `call_stub_${turn}_${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
      const usage = { prompt_tokens: 1200 + turn * 100, completion_tokens: 180, total_tokens: 1380 + turn * 100 };
      // Cache and reasoning counts, when a scenario asks for them, to see which fields OpenCode passes on.
      if (name === "usage-detail") {
        usage.prompt_tokens_details = { cached_tokens: 400 };
        usage.completion_tokens_details = { reasoning_tokens: 30 };
      }
      const finish = toolCalls.length > 0 ? "tool_calls" : "stop";
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created: 0,
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: finish,
                message: {
                  role: "assistant",
                  content: reply.text ?? null,
                  ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
              },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (choices, extra = {}) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices, ...extra })}\n\n`,
        );
      send([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
      if (reply.text) send([{ index: 0, delta: { content: reply.text }, finish_reason: null }]);
      if (toolCalls.length > 0) send([{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: finish }]);
      send([], { usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  })
  .listen(PORT, "0.0.0.0", () => log({ kind: "model_stub_started", port: PORT }));

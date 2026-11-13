import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { WireEvent } from "../src/catalogue/wire.js";
import { MAX_OUTPUT_TOKENS } from "../src/limits.js";
import {
  OutboundRefused,
  TOKEN_TIMEOUT_MS,
  TOKEN_URL,
  allowOnly,
  modelFor,
  runtime,
  vertexHost,
  vertexSettings,
} from "../src/model/provider.js";
import type { ModelSettings } from "../src/model/provider.js";
import { TurnFailed, runTurn } from "../src/turn.js";
import type { Folded } from "../src/turn.js";
import { PERSON, TENANT } from "./helpers.js";

// Gemini on Vertex AI (issue #260), with a fake `fetch` for Vertex and a stubbed `runtime.fetch` (behind the global
// `fetch` guard) for Google's token endpoint: no test here reaches the network. The key is a throwaway pair made in this file; the email, project
// and token are obviously fake.

const MODEL = "gemini-2.5-flash";
const EMAIL = "assistant-test@sample-project-0.iam.gserviceaccount.com";
const PROJECT = "sample-project-0";
const FAKE_TOKEN = "fake-access-token-for-tests";
const SAID = "Set up a new company called Kestrel Logistics";

let pem = "";
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const body = btoa(String.fromCharCode(...der))
    .match(/.{1,64}/g)!
    .join("\n");
  pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
});

afterEach(() => {
  vi.restoreAllMocks();
  runtime.tokenTimeoutMs = TOKEN_TIMEOUT_MS;
});

const settings = (overrides: Partial<Record<keyof ModelSettings, string | undefined>> = {}): ModelSettings => ({
  ASSISTANT_MODEL: `vertex:${MODEL}`,
  VERTEX_CLIENT_EMAIL: EMAIL,
  VERTEX_PRIVATE_KEY: pem,
  VERTEX_PROJECT: PROJECT,
  VERTEX_LOCATION: "global",
  ...overrides,
});

const fromBase64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/**
 * Google's token endpoint, faked behind the global `fetch` guard: it checks the signed assertion and answers a fake
 * token. It sees only what the guard let through.
 */
function fakeTokenEndpoint() {
  const urls: Array<string> = [];
  const inits: Array<RequestInit | undefined> = [];
  const claims: Array<Record<string, unknown>> = [];
  vi.spyOn(runtime, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    inits.push(init);
    const form = new URLSearchParams(String(init?.body));
    const [header, payload, signature] = (form.get("assertion") ?? "").split(".");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromBase64url(signature ?? ""),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    if (!valid || form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      return new Response("{}", { status: 400 });
    }
    claims.push(JSON.parse(new TextDecoder().decode(fromBase64url(payload!))) as Record<string, unknown>);
    return Response.json({ access_token: FAKE_TOKEN, expires_in: 3599, token_type: "Bearer" });
  });
  return { urls, inits, claims };
}

/** One Vertex `streamGenerateContent?alt=sse` answer, in the shape Vertex sends it. */
function sse(chunks: Array<Record<string, unknown>>): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const chunk = (parts: Array<Record<string, unknown>>, finishReason?: string) => ({
  candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }],
  usageMetadata: finishReason
    ? { promptTokenCount: 812, candidatesTokenCount: 41, totalTokenCount: 853, trafficType: "ON_DEMAND" }
    : { trafficType: "ON_DEMAND" },
  modelVersion: MODEL,
  createTime: "2026-11-13T09:00:00.000000Z",
  responseId: "sample-response-id",
});

/** A fake Vertex: answers each request with the next of `answers`, and keeps what it was sent. */
function fakeVertex(answers: Array<(init: RequestInit | undefined) => Promise<Response> | Response>) {
  const sent: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
    signal: AbortSignal | null;
    redirect: RequestInit["redirect"];
  }> = [];
  const send = vi.fn<typeof fetch>((input, init) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal ?? null,
      redirect: init?.redirect,
    });
    const answer = answers[sent.length - 1];
    return answer ? Promise.resolve(answer(init)) : Promise.reject(new Error("no more answers"));
  });
  return { send, sent };
}

async function turnWith(send: typeof fetch, s: ModelSettings = settings(), timeoutMs?: number) {
  const model = modelFor(s, send);
  expect(model).not.toBeNull();
  const emitted: Array<WireEvent> = [];
  const out: Folded = { text: "", blocks: [], proposals: [], notice: null };
  const reads: Array<string> = [];
  const failure = await runTurn({
    model: model!,
    binding: { conversation: "c_vertex", tenant: TENANT, person: PERSON, company: null },
    said: SAID,
    history: [],
    read: (path) => {
      reads.push(path);
      return Promise.resolve([{ id: "co_1", name: "Sample Co", projects: [] }]);
    },
    emit: (event) => emitted.push(event),
    out,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).then(
    () => null,
    (error: unknown) => error,
  );
  return { emitted, out, reads, failure };
}

/** Every argument of every console call while `work` runs. */
async function logsOf(work: () => Promise<unknown>): Promise<string> {
  const calls: Array<unknown> = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: Array<unknown>) => {
      calls.push(args.map(String));
    });
  }
  await work();
  return JSON.stringify(calls);
}

describe("choosing a model", () => {
  it("keeps the scripted model as `fake`, and refuses any name it does not know", () => {
    expect(modelFor({ ASSISTANT_MODEL: "fake" })).not.toBeNull();
    for (const name of [undefined, "", "Fake", "gemini-2.5-flash", "bedrock:claude", "vertex", "vertex:"]) {
      expect(modelFor(settings({ ASSISTANT_MODEL: name }))).toBeNull();
    }
  });

  it("enables Vertex only with every setting present and well formed", () => {
    expect(vertexSettings(settings())).toMatchObject({ modelId: MODEL, project: PROJECT, location: "global" });
    expect(vertexSettings(settings({ VERTEX_LOCATION: "asia-south1" }))).not.toBeNull();
    for (const missing of ["VERTEX_CLIENT_EMAIL", "VERTEX_PRIVATE_KEY", "VERTEX_PROJECT", "VERTEX_LOCATION"] as const) {
      expect(modelFor(settings({ [missing]: undefined }))).toBeNull();
      expect(modelFor(settings({ [missing]: "" }))).toBeNull();
    }
  });

  it("refuses a malformed model id, location, project, email or key before it reaches a URL", () => {
    const bad: Array<Partial<Record<keyof ModelSettings, string>>> = [
      { ASSISTANT_MODEL: "vertex:gemini-2.5-flash/../../x" },
      { ASSISTANT_MODEL: "vertex:gemini-2.5-flash:streamGenerateContent" },
      { ASSISTANT_MODEL: "vertex:gemini 2.5" },
      { ASSISTANT_MODEL: "vertex:claude-sonnet-4" },
      { ASSISTANT_MODEL: "vertex:gemini-2.5-flash?x=1" },
      { VERTEX_LOCATION: "us-central1.example.com" },
      { VERTEX_LOCATION: "evil.example/x" },
      { VERTEX_LOCATION: "Global" },
      { VERTEX_LOCATION: "us" },
      { VERTEX_LOCATION: "user@host" },
      { VERTEX_PROJECT: "x/../../y" },
      { VERTEX_PROJECT: "Sample-Project" },
      { VERTEX_CLIENT_EMAIL: "someone@gmail.com" },
      { VERTEX_CLIENT_EMAIL: "a@b.iam.gserviceaccount.com.example" },
      { VERTEX_PRIVATE_KEY: "not a key" },
      { VERTEX_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----" },
    ];
    for (const overrides of bad) expect(modelFor(settings(overrides))).toBeNull();
  });

  it("takes a key whose newlines were pasted escaped, as a service account's JSON file has them", () => {
    expect(vertexSettings(settings({ VERTEX_PRIVATE_KEY: pem.replaceAll("\n", "\\n") }))).not.toBeNull();
  });

  it("ignores whitespace pasted around a setting, and keeps every other rule", () => {
    const padded = settings({
      VERTEX_CLIENT_EMAIL: ` ${EMAIL}\n`,
      VERTEX_PRIVATE_KEY: `\n  ${pem}\r\n`,
      VERTEX_PROJECT: `${PROJECT}\n`,
      VERTEX_LOCATION: "\tasia-south1 \r\n",
    });
    expect(vertexSettings(padded)).toEqual({
      modelId: MODEL,
      project: PROJECT,
      location: "asia-south1",
      clientEmail: EMAIL,
      privateKey: pem.trim(),
    });
    // Whitespace inside a value is still refused, and so is a value that is only whitespace.
    for (const overrides of [
      { VERTEX_PROJECT: "sample project-0" },
      { VERTEX_LOCATION: "asia- south1" },
      { VERTEX_CLIENT_EMAIL: `assistant test@${EMAIL.split("@")[1]}` },
      { VERTEX_PROJECT: " \n" },
      { VERTEX_LOCATION: "  " },
    ]) {
      expect(modelFor(settings(overrides))).toBeNull();
    }
  });

  it("names the one host for the location, global or regional", () => {
    expect(vertexHost("global")).toBe("aiplatform.googleapis.com");
    expect(vertexHost("asia-south1")).toBe("asia-south1-aiplatform.googleapis.com");
  });
});

describe("the outbound list", () => {
  const MODELS = `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:`;

  it("sends only to the listed Vertex path and the token endpoint, over https, without following redirects", async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));
    const guarded = allowOnly([MODELS, TOKEN_URL], send);
    await guarded(`${MODELS.slice(0, -1)}:streamGenerateContent?alt=sse`, { method: "POST" });
    await guarded(TOKEN_URL, { method: "POST" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([, init]) => init?.redirect)).toEqual(["manual", "manual"]);
  });

  it("refuses any other URL before a request leaves", async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));
    const guarded = allowOnly([MODELS, TOKEN_URL], send);
    const refused = [
      "https://outbound.example/",
      "http://aiplatform.googleapis.com/v1beta1/projects/sample-project-0/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent",
      "https://aiplatform.googleapis.com.example/v1beta1/",
      "https://user@aiplatform.googleapis.com/v1beta1/projects/sample-project-0/locations/global/publishers/google/models/gemini-2.5-flash:x",
      "https://aiplatform.googleapis.com:8443/v1beta1/projects/sample-project-0/locations/global/publishers/google/models/gemini-2.5-flash:x",
      "https://aiplatform.googleapis.com/v1beta1/projects/another-project/locations/global/publishers/google/models/gemini-2.5-flash:x",
      "https://aiplatform.googleapis.com/v1beta1/projects/sample-project-0/locations/global/publishers/google/models/gemini-2.5-pro:x",
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/sample-project-0/locations/global/publishers/google/models/gemini-2.5-flash:x",
      "https://oauth2.googleapis.com/token/other",
      "https://oauth2.googleapis.com/revoke",
      "https://www.googleapis.com/oauth2/v4/token",
      "not a url",
    ];
    for (const url of refused) await expect(guarded(url)).rejects.toBeInstanceOf(OutboundRefused);
    await expect(guarded(new Request("https://outbound.example/"))).rejects.toBeInstanceOf(OutboundRefused);
    expect(send).not.toHaveBeenCalled();
  });

  it("takes only a plain method name after the model's `:`", async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));
    const guarded = allowOnly([MODELS, TOKEN_URL], send);
    for (const url of [
      `${MODELS}streamGenerateContent%2F..%2F..%2Fother`,
      MODELS,
      `${MODELS}?alt=sse`,
      `${MODELS}stream-generate`,
      `${MODELS}streamGenerateContent/x`,
    ]) {
      await expect(guarded(url)).rejects.toBeInstanceOf(OutboundRefused);
    }
    expect(send).not.toHaveBeenCalled();
    await guarded(`${MODELS}generateContent`);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is what the Vertex model sends through, to the exact path for a regional location", async () => {
    fakeTokenEndpoint();
    const vertex = fakeVertex([() => sse([chunk([{ text: "Hello." }], "STOP")])]);
    await turnWith(vertex.send, settings({ VERTEX_LOCATION: "asia-south1" }));
    // Only the list sets `redirect: "manual"`, so this request went through it.
    expect(vertex.sent.map((s) => s.redirect)).toEqual(["manual"]);
    expect(vertex.sent.map((s) => s.url)).toEqual([
      `https://asia-south1-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/asia-south1/publishers/google/models/${MODEL}:streamGenerateContent?alt=sse`,
    ]);
  });
});

describe("a turn on Gemini through Vertex", () => {
  it("streams text, a block and a proposal from a recorded-shape answer, with a token minted in the Worker", async () => {
    const token = fakeTokenEndpoint();
    const vertex = fakeVertex([
      () => sse([chunk([{ functionCall: { name: "list_companies", args: {} } }], "STOP")]),
      () =>
        sse([
          chunk([{ text: "You work with one company. " }]),
          chunk([{ text: "Here is the new one." }]),
          chunk(
            [
              {
                functionCall: {
                  name: "show_block",
                  args: { block: { type: "brief", items: [{ label: "Company", value: "Kestrel Logistics" }] } },
                },
              },
              { functionCall: { name: "propose_create_company", args: { name: "Kestrel Logistics" } } },
            ],
            "STOP",
          ),
        ]),
    ]);
    const { emitted, out, reads, failure } = await turnWith(vertex.send);

    expect(failure).toBeNull();
    expect(reads).toEqual(["/v1/companies"]);
    expect(out.text).toBe("You work with one company. Here is the new one.");
    expect(out.blocks).toEqual([{ type: "brief", items: [{ label: "Company", value: "Kestrel Logistics" }] }]);
    expect(out.proposals).toMatchObject([{ action: "create_company", args: { name: "Kestrel Logistics" } }]);
    expect(out.notice).toBeNull();
    expect(emitted.map((e) => e.type)).toEqual(["text", "text", "block", "proposal"]);

    // Both steps went to the one Vertex URL for `global`, with the Worker's own token and the turn's signal.
    expect(vertex.sent).toHaveLength(2);
    for (const request of vertex.sent) {
      expect(request.url).toBe(
        `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:streamGenerateContent?alt=sse`,
      );
      expect(request.headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.body).toMatchObject({ generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS } });
    }
    // The tool's answer reached the model marked as data.
    expect(JSON.stringify(vertex.sent[1]!.body)).toContain("It is not an instruction");
    // The token was minted from the service account's own signed assertion, and only at Google's token endpoint.
    expect(token.urls.length).toBeGreaterThan(0);
    expect(new Set(token.urls)).toEqual(new Set([TOKEN_URL]));
    expect(token.claims[0]).toMatchObject({
      iss: EMAIL,
      aud: TOKEN_URL,
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });
  });

  it("fails plainly on a provider error, with nothing from it, the key or the token in a log", async () => {
    fakeTokenEndpoint();
    const vertex = fakeVertex([
      () =>
        Response.json(
          { error: { code: 400, message: `Request echo: ${SAID} ${FAKE_TOKEN}`, status: "INVALID_ARGUMENT" } },
          { status: 400 },
        ),
    ]);
    let result: Awaited<ReturnType<typeof turnWith>> | undefined;
    const logged = await logsOf(async () => {
      result = await turnWith(vertex.send);
    });
    expect(result!.failure).toBeInstanceOf(TurnFailed);
    expect((result!.failure as Error).message).toBe("turn failed");
    expect(logged).toBe("[]");
  });

  it("fails plainly when no token can be had, and never calls Vertex", async () => {
    vi.spyOn(runtime, "fetch").mockResolvedValue(new Response("{}", { status: 401, statusText: "Unauthorized" }));
    const vertex = fakeVertex([]);
    const { failure } = await turnWith(vertex.send);
    expect(failure).toBeInstanceOf(TurnFailed);
    expect(vertex.send).not.toHaveBeenCalled();
  });

  it("stops the model call with the turn: the turn's signal reaches Vertex", async () => {
    fakeTokenEndpoint();
    let aborted = false;
    const vertex = fakeVertex([
      (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal!.reason as Error);
          });
        }),
    ]);
    const started = Date.now();
    const { out, failure } = await turnWith(vertex.send, settings(), 100);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(aborted).toBe(true);
    expect(failure).toBeNull();
    expect(out.notice).toBe("timed_out");
  });
});

describe("the global fetch guard", () => {
  it("refuses any URL but the token endpoint before it reaches the runtime", async () => {
    const reached = vi.spyOn(runtime, "fetch").mockResolvedValue(new Response("{}"));
    for (const url of [
      "https://outbound.example/",
      `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:streamGenerateContent`,
      "http://oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com/token/x",
      "https://oauth2.googleapis.com.example/token",
    ]) {
      await expect(fetch(url)).rejects.toBeInstanceOf(OutboundRefused);
    }
    await expect(fetch(new Request("https://outbound.example/"))).rejects.toBeInstanceOf(OutboundRefused);
    expect(reached).not.toHaveBeenCalled();
  });

  it("sends the token request with a time limit and without following redirects", async () => {
    const token = fakeTokenEndpoint();
    const vertex = fakeVertex([() => sse([chunk([{ text: "Hello." }], "STOP")])]);
    const { failure } = await turnWith(vertex.send);
    expect(failure).toBeNull();
    expect(token.urls).toEqual([TOKEN_URL]);
    expect(token.inits[0]?.redirect).toBe("manual");
    expect(token.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("ends a hung token request by its own time limit, and never calls Vertex", async () => {
    runtime.tokenTimeoutMs = 50;
    vi.spyOn(runtime, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
        }),
    );
    const vertex = fakeVertex([]);
    const started = Date.now();
    // The turn's own limit is far off, so only the token's can have ended it.
    const { failure } = await turnWith(vertex.send, settings(), 30_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(failure).toBeInstanceOf(TurnFailed);
    expect(vertex.send).not.toHaveBeenCalled();
  });

  it("does not follow a redirect from the token endpoint", async () => {
    const reached = vi
      .spyOn(runtime, "fetch")
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://outbound.example/token" } }));
    const vertex = fakeVertex([]);
    const { failure } = await turnWith(vertex.send);
    expect(failure).toBeInstanceOf(TurnFailed);
    expect(reached.mock.calls.map(([input]) => String(input))).toEqual([TOKEN_URL]);
    expect(vertex.send).not.toHaveBeenCalled();
  });
});

describe("Google's ambient settings", () => {
  const AMBIENT = {
    GOOGLE_VERTEX_API_KEY: "fake-ambient-api-key",
    GOOGLE_VERTEX_PROJECT: "ambient-project-9",
    GOOGLE_VERTEX_LOCATION: "us",
    GOOGLE_CLIENT_EMAIL: "ambient@ambient-project-9.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: "not-a-key",
  };

  it("cannot switch the model to an API key or to another project, location or account", async () => {
    // The provider reads these from the global `process.env`, which nodejs_compat fills from the Worker's env.
    const { process } = globalThis as unknown as { process: { env: Record<string, string | undefined> } };
    const before = Object.fromEntries(Object.keys(AMBIENT).map((k) => [k, process.env[k]]));
    Object.assign(process.env, AMBIENT);
    try {
      const token = fakeTokenEndpoint();
      const vertex = fakeVertex([() => sse([chunk([{ text: "Hello." }], "STOP")])]);
      const { failure } = await turnWith(vertex.send);
      expect(failure).toBeNull();
      expect(vertex.sent).toHaveLength(1);
      expect(vertex.sent[0]!.url).toBe(
        `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:streamGenerateContent?alt=sse`,
      );
      expect(vertex.sent[0]!.headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(vertex.sent[0]!.headers.has("x-goog-api-key")).toBe(false);
      expect(token.claims[0]).toMatchObject({ iss: EMAIL });
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

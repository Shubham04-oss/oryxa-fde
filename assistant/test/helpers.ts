import { exports } from "cloudflare:workers";

import { SESSION } from "./fake-api.js";

// Sample values set in vitest.config.ts.
export const SERVICE = "sample-service-token-for-tests-0123456789";
export const KEY = "sample-binding-key-for-tests-0123456789ab";

export const TENANT = "org_sample";
export const PERSON = "user_riya";

let next = 0;
/** A conversation id no other test uses, so each test has its own object. */
export const freshConversation = () => `c_t${(next += 1)}_${crypto.randomUUID().slice(0, 8)}`;

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** Signs `claims` as fde-web does (fde-web/src/assistant.ts). */
export async function sign(claims: Record<string, unknown>, key = KEY): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

/** A binding for `conversation`, valid for a minute, for the sample person's home conversation unless overridden. */
export function bindingFor(conversation: string, overrides: Record<string, unknown> = {}): Promise<string> {
  return sign({
    v: 1,
    conv: conversation,
    tenant: TENANT,
    person: PERSON,
    company: null,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  });
}

export interface CallOptions {
  method?: string;
  token?: string | null;
  binding?: string | null;
  session?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Calls the Worker as fde-web does: service token, binding, and the session on a turn. */
export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const conversation = /^\/internal\/v1\/conversations\/([^/]+)/.exec(path)?.[1] ?? "none";
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? SERVICE : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const binding = options.binding === undefined ? await bindingFor(conversation) : options.binding;
  if (binding !== null) headers.set("x-assistant-binding", binding);
  if (options.session !== undefined && options.session !== null) headers.set("x-assistant-session", options.session);
  return exports.default.fetch(
    new Request(`https://assistant.internal${path}`, {
      method: options.method ?? "GET",
      headers,
      // A GET carries no body, whatever the caller passed.
      ...(options.body === undefined || (options.method ?? "GET") === "GET"
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  );
}

export interface Frame {
  id: number | null;
  event: string | null;
  data: unknown;
}

function frames(text: string): Array<Frame> {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":"))
    .map((block) => {
      let id: number | null = null;
      let event: string | null = null;
      let data: unknown = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = Number(line.slice(4));
        else if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6)) as unknown;
      }
      return { id, event, data };
    });
}

/** Every frame of an SSE answer, read to its end. */
export async function readAll(response: Response): Promise<Array<Frame>> {
  return frames(await response.text());
}

/** The first `count` data frames of an SSE answer; then the connection is dropped. */
export async function readSome(response: Response, count: number): Promise<Array<Frame>> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const got = frames(text).filter((f) => f.event === null);
    if (got.length >= count) {
      await reader.cancel();
      return got.slice(0, count);
    }
    const { done, value } = await reader.read();
    if (done) return got;
    text += value;
  }
}

/** The wire events of a turn: data frames only, without the SSE control frames. */
export const events = (all: Array<Frame>) => all.filter((f) => f.event === null).map((f) => f.data);

/** Says `text` in `conversation` and reads the whole turn. */
export async function say(conversation: string, text: string, session = SESSION, binding?: string) {
  const response = await call(`/internal/v1/conversations/${conversation}/turns`, {
    method: "POST",
    session,
    body: { text },
    ...(binding === undefined ? {} : { binding }),
  });
  const all = response.status === 200 ? await readAll(response) : [];
  return { response, all, events: events(all) };
}

/** The reply's text, joined from its deltas. */
export const replyText = (got: Array<unknown>) =>
  got
    .filter((e) => (e as { type: string }).type === "text")
    .map((e) => (e as { delta: string }).delta)
    .join("");

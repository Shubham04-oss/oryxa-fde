import { createGoogleVertex } from "@ai-sdk/google-vertex/edge";
import { customProvider } from "ai";
import type { LanguageModel } from "ai";

import { scriptedModel } from "./fake.js";

// Which model answers (ADR 0009): chosen by name in config (`ASSISTANT_MODEL`), through the AI SDK's provider
// layer, the only place a provider is named. `fake` is the scripted model; `vertex:<model id>` is Gemini on Vertex
// AI (issue #260), enabled only when every Vertex setting is present and well formed. Anything else is refused,
// never replaced by another model. A model is always passed as an object: a bare model id would send the call to
// the AI SDK's default gateway, a host this Worker does not allow.

const enabled = customProvider({ languageModels: { fake: scriptedModel() } });

/** The settings a model is chosen from: the Worker's env, read for one turn and kept nowhere. */
export interface ModelSettings {
  readonly ASSISTANT_MODEL?: string | undefined;
  readonly VERTEX_CLIENT_EMAIL?: string | undefined;
  readonly VERTEX_PRIVATE_KEY?: string | undefined;
  readonly VERTEX_PROJECT?: string | undefined;
  readonly VERTEX_LOCATION?: string | undefined;
}

/** Google's token endpoint, which the Vertex provider's edge entry posts its signed assertion to. */
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** How long the token request may take before it is abandoned. */
export const TOKEN_TIMEOUT_MS = 10_000;

// Strict shapes, checked before any of them reaches a URL, a header or a key import.
const MODEL_ID = /^gemini-[0-9][a-z0-9.-]{0,62}[a-z0-9]$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// `global`, or one region such as `us-central1` or `asia-south1`. The `us` and `eu` multi-regions are not taken.
const LOCATION = /^(?:global|[a-z]{2,16}-[a-z]{2,16}[0-9]{1,2})$/;
const CLIENT_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
/** What may follow a model's `:` in a Vertex path, such as `streamGenerateContent`. */
const METHOD = /^[A-Za-z]+$/;
const PRIVATE_KEY = /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]{100,8000}\n-----END PRIVATE KEY-----$/;

interface Vertex {
  readonly modelId: string;
  readonly project: string;
  readonly location: string;
  readonly clientEmail: string;
  readonly privateKey: string;
}

/** The Vertex settings, or null when any is missing or malformed. */
export function vertexSettings(settings: ModelSettings): Vertex | null {
  const name = settings.ASSISTANT_MODEL ?? "";
  if (!name.startsWith("vertex:")) return null;
  const modelId = name.slice("vertex:".length);
  // A key pasted into a secret often keeps its newlines escaped, as in a service account's JSON file.
  const privateKey = (settings.VERTEX_PRIVATE_KEY ?? "").replaceAll("\\n", "\n").replaceAll("\r\n", "\n").trim();
  // A newline left from pasting a var must not switch the model off; whitespace inside a value is still refused.
  const project = settings.VERTEX_PROJECT?.trim();
  const location = settings.VERTEX_LOCATION?.trim();
  const clientEmail = settings.VERTEX_CLIENT_EMAIL?.trim();
  if (!MODEL_ID.test(modelId) || !PRIVATE_KEY.test(privateKey)) return null;
  if (project === undefined || !PROJECT.test(project)) return null;
  if (location === undefined || !LOCATION.test(location)) return null;
  if (clientEmail === undefined || !CLIENT_EMAIL.test(clientEmail)) return null;
  return { modelId, project, location, clientEmail, privateKey };
}

/** The one Vertex host for `location`, as the provider names it. */
export function vertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/** Thrown before a request leaves when its URL is not on the list. It names nothing from the request. */
export class OutboundRefused extends Error {
  constructor() {
    super("outbound request refused");
  }
}

/**
 * A `fetch` that sends only to the listed URLs, over https, and refuses anything else before it leaves. Each
 * entry is an exact origin with an exact path, or a path prefix ending in `:` followed by a plain method name.
 * Redirects are not followed, so an answer cannot move a request to another host.
 */
export function allowOnly(allowed: ReadonlyArray<string>, send: typeof fetch): typeof fetch {
  const list = allowed.map((entry) => new URL(entry));
  return (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return Promise.reject(new OutboundRefused());
    }
    const ok =
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      list.some(
        (entry) =>
          url.origin === entry.origin &&
          (entry.pathname.endsWith(":")
            ? url.pathname.startsWith(entry.pathname) && METHOD.test(url.pathname.slice(entry.pathname.length))
            : url.pathname === entry.pathname),
      );
    if (!ok) return Promise.reject(new OutboundRefused());
    return input instanceof Request
      ? send(new Request(input, { ...init, redirect: "manual" }))
      : send(url.href, { ...init, redirect: "manual" });
  };
}

/** Gemini on Vertex for one turn: the key lives in this provider's closure, for the call, and nowhere else. */
function vertexModel(v: Vertex, send: typeof fetch): LanguageModel {
  const models = `https://${vertexHost(v.location)}/v1beta1/projects/${v.project}/locations/${v.location}/publishers/google/models/${v.modelId}:`;
  const provider = createGoogleVertex({
    project: v.project,
    location: v.location,
    // An empty key pins the service-account path: express mode would otherwise read GOOGLE_VERTEX_API_KEY.
    apiKey: "",
    googleCredentials: { clientEmail: v.clientEmail, privateKey: v.privateKey },
    fetch: allowOnly([models, TOKEN_URL], send),
  });
  // ponytail: the edge entry mints its token with the global `fetch`, which the guard below holds to TOKEN_URL alone,
  // with its own time limit and no redirects. It still mints a token for every model step rather than caching one.
  return provider.languageModel(v.modelId);
}

/**
 * The runtime's own `fetch`, kept before the guard below replaces the global one. Only this module calls it: the
 * Vertex model through `allowOnly`, and the guard. Tests stub `runtime.fetch` and shorten `tokenTimeoutMs`.
 */
export const runtime: { fetch: typeof fetch; tokenTimeoutMs: number } = {
  fetch: globalThis.fetch.bind(globalThis),
  tokenTimeoutMs: TOKEN_TIMEOUT_MS,
};

// The global `fetch` reaches Google's token endpoint and nothing else (ADR 0009: outbound hosts enforced in code).
// The Vertex provider's edge entry mints its token with it, beyond reach of the `fetch` it is given. Installed once
// and never restored: turns share the isolate, so a guard swapped per call would race between them. Nothing else in
// `src/` calls the global `fetch` (eslint), and the API is reached through its service binding, not this.
globalThis.fetch = allowOnly([TOKEN_URL], (input, init) => {
  const limit = AbortSignal.timeout(runtime.tokenTimeoutMs);
  return runtime.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
});

/** The model the settings select, or null when it is not enabled or not fully configured: the turn is refused. */
export function modelFor(
  settings: ModelSettings,
  send: typeof fetch = (input, init) => runtime.fetch(input, init),
): LanguageModel | null {
  if (settings.ASSISTANT_MODEL === "fake") return enabled.languageModel("fake");
  const vertex = vertexSettings(settings);
  return vertex === null ? null : vertexModel(vertex, send);
}

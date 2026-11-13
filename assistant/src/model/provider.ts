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

// Strict shapes, checked before any of them reaches a URL, a header or a key import.
const MODEL_ID = /^gemini-[0-9][a-z0-9.-]{0,62}[a-z0-9]$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// `global`, or one region such as `us-central1` or `asia-south1`. The `us` and `eu` multi-regions are not taken.
const LOCATION = /^(?:global|[a-z]{2,16}-[a-z]{2,16}[0-9]{1,2})$/;
const CLIENT_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
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
  const { VERTEX_PROJECT: project, VERTEX_LOCATION: location, VERTEX_CLIENT_EMAIL: clientEmail } = settings;
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
 * entry is an exact origin with an exact path, or a path prefix ending in `:` (the model's method follows it).
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
          (entry.pathname.endsWith(":") ? url.pathname.startsWith(entry.pathname) : url.pathname === entry.pathname),
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
  // ponytail: the edge entry mints its token with the runtime's own `fetch`, not the one above, so that one request
  // is held to the list only by the URL fixed in the pinned package (TOKEN_URL); test/vertex.test.ts fails if it
  // changes. It also mints a token for every model step rather than caching one for its hour.
  return provider.languageModel(v.modelId);
}

/** The model the settings select, or null when it is not enabled or not fully configured: the turn is refused. */
export function modelFor(
  settings: ModelSettings,
  // eslint-disable-next-line no-restricted-globals -- the model's own requests, reached only through `allowOnly`.
  send: typeof fetch = (input, init) => fetch(input, init),
): LanguageModel | null {
  if (settings.ASSISTANT_MODEL === "fake") return enabled.languageModel("fake");
  const vertex = vertexSettings(settings);
  return vertex === null ? null : vertexModel(vertex, send);
}

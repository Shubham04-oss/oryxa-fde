import { queryOptions } from "@tanstack/react-query"
import createClient from "openapi-fetch"
import { z } from "zod"
import type { paths } from "./fde-api.gen"
import { Me } from "./schemas"

// The app's only way to the FDE API. Screens use `api` and `queries` and never see where the
// answers come from. Calls go through a client generated from the API's OpenAPI spec
// (fde-api.gen.ts, `pnpm api:generate`) to this app's own origin, where the Worker forwards
// `/api/*` and `/auth/*` to the API (src/server.ts). The session is an HttpOnly cookie the API
// sets, so no token is ever handled here. A `Transport` answers: the network, or the dev mock.

/** A refusal: an HTTP status and a short code, with optional text that is safe to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = "ApiError"
  }
}

/** Words for refusals the API answers with a code only. Anything else shows generic copy. */
export const SAFE_TEXT: Record<string, string> = {
  forbidden: "You are not allowed to do that here. Ask an organisation admin.",
  // The API could not reach a service it needs (WorkOS, SpiceDB). Nothing is wrong on this end.
  unavailable: "The workspace is briefly unavailable. Try again in a minute.",
}

// The API's ErrorBody is a code only (openapi.json); any other field is ignored, never shown.
const ErrorBody = z.object({ error: z.string() })

function refusal(status: number, body: unknown) {
  const parsed = ErrorBody.safeParse(body)
  const code = parsed.success ? parsed.data.error : `http_${status}`
  return new ApiError(status, code, SAFE_TEXT[code])
}

/** What answers the app's requests. Answers are untrusted until `api` parses them. */
export type Transport = {
  /** Answers one request to this app's origin. */
  fetch: (request: Request) => Promise<Response>
  /** Starts sign-in, to come back to `returnTo`, a path `safeReturnTo` has checked. */
  signIn: (returnTo: string) => Promise<void>
  /**
   * Leaves the app for `url`, a same-origin `/auth/*` path that redirects to a sign-in provider and
   * comes back through `/auth/callback` (Google, `sign-in-api.ts`). Settles only on the mock.
   */
  leave: (url: string) => Promise<void>
}

/** The real API, through the Worker, and AuthKit's hosted sign-in through the API. */
export const network: Transport = {
  fetch: (request) => fetch(request),
  signIn(returnTo) {
    window.location.assign(signInUrl(returnTo))
    // The page is leaving for AuthKit, so this never settles.
    return new Promise<void>(() => {})
  },
  leave(url) {
    window.location.assign(url)
    return new Promise<void>(() => {})
  },
}

/** Whether this build answers from the dev mock. Never true in a production build. */
export function mockApiOn(env: { DEV: boolean; VITE_FDE_MOCK_API?: string }) {
  return env.DEV && env.VITE_FDE_MOCK_API === "1"
}

/** The transport this build uses: the network, or the dev mock in `pnpm dev:mock` and tests. */
export function selected(): Promise<Transport> {
  // `import.meta.env.DEV` is the literal `false` in a production build, so this branch and the
  // mock module are dropped from it (mock-excluded.test.ts proves it).
  return import.meta.env.DEV && mockApiOn(import.meta.env)
    ? import("../../dev/mock-api").then((mock) => mock.mockApi)
    : Promise.resolve(network)
}

/** CSRF: the API refuses a write without it, and the Worker refuses one from another origin. */
export const HEADERS = { "X-Oryxa-Request": "1" }

/** This app's origin, which every call goes to. Calls only run in the browser. */
const origin = () => globalThis.location.origin

function connect(transport: Transport) {
  const options = { fetch: transport.fetch, headers: HEADERS }
  // `/v1/*` goes under `/api`, which the Worker strips; `/auth/*` it forwards as it is.
  const client = createClient<paths>({ baseUrl: `${origin()}/api`, ...options })
  const auth = createClient<paths>({ baseUrl: origin(), ...options })

  /** One call's answer, parsed; a refusal throws an `ApiError`. */
  async function read<T>(
    schema: z.ZodType<T>,
    call: Promise<{ data?: unknown; error?: unknown; response: Response }>,
  ): Promise<T> {
    const { data, error, response } = await call
    if (!response.ok) throw refusal(response.status, error)
    return schema.parse(data)
  }

  return {
    me: () => read(Me, client.GET("/v1/me")),
    signIn: (returnTo: string) => transport.signIn(safeReturnTo(returnTo)),
    async signOut() {
      const { error, response } = await auth.POST("/auth/logout")
      if (!response.ok) throw refusal(response.status, error)
    },
  }
}

type Api = ReturnType<typeof connect>

/** `api` over `transport`, connected on first use. Tests pass their own transport. */
export function apiOver(transport: () => Promise<Transport>): Api {
  let connected: Promise<Api> | undefined
  const use = () => (connected ??= transport().then(connect))
  return {
    me: async () => (await use()).me(),
    signIn: async (returnTo) => (await use()).signIn(returnTo),
    signOut: async () => (await use()).signOut(),
  }
}

export const api = apiOver(selected)

/** True when the app runs on the dev mock, so screens can say so instead of implying a backend. */
export const onMock = mockApiOn(import.meta.env)

const HERE = "https://fde.invalid"

/** A same-origin path to come back to after sign-in, or "/" for anything else. */
export function safeReturnTo(value: unknown): string {
  // Browsers drop tabs and newlines from a URL and read `\` as `/`, so "/\t/evil.example" and
  // "/\\evil.example" would leave the app. Refuse both, then let the URL parser judge the origin.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(value))
    return "/"
  let url: URL
  try {
    url = new URL(value, HERE)
  } catch {
    return "/"
  }
  const path = `${url.pathname}${url.search}${url.hash}`
  // Resolving dot segments can leave "//host" ("/.//evil.example"), which a browser reads as another origin.
  return url.origin === HERE && !path.startsWith("//") ? path : "/"
}

/** Where sign-in starts: AuthKit's hosted page, through the API, coming back to `returnTo`. */
export function signInUrl(returnTo: string) {
  return `/auth/login?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`
}

/** Refusals (4xx) are final; anything else is retried twice. */
function retry(failures: number, error: unknown) {
  if (error instanceof ApiError && error.status < 500) return false
  return failures < 2
}

export const queries = {
  me: () => queryOptions({ queryKey: ["me"], queryFn: api.me, retry, staleTime: 60_000 }),
}

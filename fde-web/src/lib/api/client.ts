import { queryOptions } from "@tanstack/react-query"
import type { z } from "zod"
import { Companies, Company, Me, Project, Today } from "./schemas"
import type { CompanyId, ProjectScope, Stage } from "./schemas"

// The app's only way to the FDE API. Screens use `api` and `queries` and never see where the
// answers come from: the dev mock today, the client generated from the API stream's OpenAPI spec
// in wave 2. Swapping one for the other is a new `Transport` here and nothing else.

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

/**
 * What answers the app's calls. Answers are untrusted (`unknown`) until `api` parses them, so a
 * transport cannot hand a screen something the schemas did not check.
 */
export type Transport = {
  me: () => Promise<unknown>
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  companies: () => Promise<unknown>
  company: (company: CompanyId) => Promise<unknown>
  project: (scope: ProjectScope) => Promise<unknown>
  today: () => Promise<unknown>
  moveStage: (scope: ProjectScope, to: Stage) => Promise<unknown>
}

// ponytail: no real transport until the API's OpenAPI client lands (plan wave 2), so a
// production build reaches nothing and every screen shows its error state.
const refuse = () =>
  Promise.reject(new ApiError(503, "api_not_connected", "The FDE API is not connected yet."))
const notConnected: Transport = {
  me: refuse,
  signIn: refuse,
  signOut: refuse,
  companies: refuse,
  company: refuse,
  project: refuse,
  today: refuse,
  moveStage: refuse,
}

/** Whether this build answers from the dev mock. Never true in a production build. */
export function mockApiOn(env: { DEV: boolean; VITE_FDE_MOCK_API?: string }) {
  return env.DEV && env.VITE_FDE_MOCK_API === "1"
}

let current: Promise<Transport> | undefined

function transport(): Promise<Transport> {
  // `import.meta.env.DEV` is the literal `false` in a production build, so this branch and the
  // mock module are dropped from it (mock-excluded.test.ts proves it).
  current ??=
    import.meta.env.DEV && mockApiOn(import.meta.env)
      ? import("../../dev/mock-api").then((mock) => mock.mockApi)
      : Promise.resolve(notConnected)
  return current
}

async function call<T>(schema: z.ZodType<T>, run: (t: Transport) => Promise<unknown>) {
  return schema.parse(await run(await transport()))
}

export const api = {
  me: () => call(Me, (t) => t.me()),
  signIn: async () => (await transport()).signIn(),
  signOut: async () => (await transport()).signOut(),
  companies: () => call(Companies, (t) => t.companies()),
  company: (id: CompanyId) => call(Company, (t) => t.company(id)),
  project: (scope: ProjectScope) => call(Project, (t) => t.project(scope)),
  today: () => call(Today, (t) => t.today()),
  /** Moves a project to `to`; the API refuses a move `canMove` would refuse. */
  moveStage: (scope: ProjectScope, to: Stage) => call(Project, (t) => t.moveStage(scope, to)),
}

/** True when the app runs on the dev mock, so screens can say so instead of implying a backend. */
export const onMock = mockApiOn(import.meta.env)

/** A same-origin path to come back to after sign-in, or "/" for anything else. */
export function safeReturnTo(value: unknown): string {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/"
}

/** Refusals (4xx) and "not connected" are final; anything else is retried twice. */
function retry(failures: number, error: unknown) {
  if (error instanceof ApiError && (error.status < 500 || error.status === 503)) return false
  return failures < 2
}

const read = { retry }

export const queries = {
  me: () => queryOptions({ queryKey: ["me"], queryFn: api.me, ...read, staleTime: 60_000 }),
  companies: () => queryOptions({ queryKey: ["companies"], queryFn: api.companies, ...read }),
  company: (id: CompanyId) =>
    queryOptions({ queryKey: ["companies", id], queryFn: () => api.company(id), ...read }),
  project: (scope: ProjectScope) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project],
      queryFn: () => api.project(scope),
      ...read,
    }),
  today: () => queryOptions({ queryKey: ["today"], queryFn: api.today, ...read }),
}

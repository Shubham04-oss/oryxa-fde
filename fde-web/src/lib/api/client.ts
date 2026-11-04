import { queryOptions } from "@tanstack/react-query"
import createClient from "openapi-fetch"
import { z } from "zod"
import type { paths } from "./fde-api.gen"
import {
  AccessRequestOut,
  CompanyOut,
  CompanySummaryOut,
  DecisionOut,
  Me,
  ProjectOut,
  ScopeOut,
  StakeholderOut,
  SystemOut,
  TaskOut,
  TodayOut,
} from "./schemas"
import type { Company, CompanyId, Project, ProjectScope, Stage } from "./schemas"

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
const SAFE_TEXT: Record<string, string> = {
  rejected_stage_transition: "A project moves one stage forward, or back to an earlier one.",
}

const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })

function refusal(status: number, body: unknown) {
  const parsed = ErrorBody.safeParse(body)
  const code = parsed.success ? parsed.data.error : `http_${status}`
  return new ApiError(status, code, (parsed.success && parsed.data.message) || SAFE_TEXT[code])
}

/** What answers the app's requests. Answers are untrusted until `api` parses them. */
export type Transport = {
  /** Answers one request to this app's origin. */
  fetch: (request: Request) => Promise<Response>
  /** Starts sign-in, to come back to `returnTo`, a path `safeReturnTo` has checked. */
  signIn: (returnTo: string) => Promise<void>
}

/** The real API, through the Worker, and AuthKit's hosted sign-in through the API. */
export const network: Transport = {
  fetch: (request) => fetch(request),
  signIn(returnTo) {
    window.location.assign(signInUrl(returnTo))
    // The page is leaving for AuthKit, so this never settles.
    return new Promise<void>(() => {})
  },
}

/** Whether this build answers from the dev mock. Never true in a production build. */
export function mockApiOn(env: { DEV: boolean; VITE_FDE_MOCK_API?: string }) {
  return env.DEV && env.VITE_FDE_MOCK_API === "1"
}

function selected(): Promise<Transport> {
  // `import.meta.env.DEV` is the literal `false` in a production build, so this branch and the
  // mock module are dropped from it (mock-excluded.test.ts proves it).
  return import.meta.env.DEV && mockApiOn(import.meta.env)
    ? import("../../dev/mock-api").then((mock) => mock.mockApi)
    : Promise.resolve(network)
}

/** CSRF: the API refuses a write without it, and the Worker refuses one from another origin. */
const HEADERS = { "X-Oryxa-Request": "1" }

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

  const company = (id: CompanyId) => ({ params: { path: { company: id } } })
  const project = (scope: ProjectScope) => ({ params: { path: scope } })

  const get = {
    companies: () => read(z.array(CompanySummaryOut), client.GET("/v1/companies")),
    company: (id: CompanyId) =>
      read(CompanyOut, client.GET("/v1/companies/{company}", company(id))),
    projects: (id: CompanyId) =>
      read(z.array(ProjectOut), client.GET("/v1/companies/{company}/projects", company(id))),
    stakeholders: (id: CompanyId) =>
      read(
        z.array(StakeholderOut),
        client.GET("/v1/companies/{company}/stakeholders", company(id)),
      ),
    systems: (id: CompanyId) =>
      read(z.array(SystemOut), client.GET("/v1/companies/{company}/systems", company(id))),
    project: (s: ProjectScope) =>
      read(ProjectOut, client.GET("/v1/companies/{company}/projects/{project}", project(s))),
    // Through the project, so an assignee who is not on the company may read them too.
    projectStakeholders: (s: ProjectScope) =>
      read(
        z.array(StakeholderOut),
        client.GET("/v1/companies/{company}/projects/{project}/stakeholders", project(s)),
      ),
    projectSystems: (s: ProjectScope) =>
      read(
        z.array(SystemOut),
        client.GET("/v1/companies/{company}/projects/{project}/systems", project(s)),
      ),
    scope: (s: ProjectScope) =>
      read(ScopeOut, client.GET("/v1/companies/{company}/projects/{project}/scope", project(s))),
    access: (s: ProjectScope) =>
      read(
        z.array(AccessRequestOut),
        client.GET("/v1/companies/{company}/projects/{project}/access-requests", project(s)),
      ),
    tasks: (s: ProjectScope) =>
      read(
        z.array(TaskOut),
        client.GET("/v1/companies/{company}/projects/{project}/tasks", project(s)),
      ),
    decisions: (s: ProjectScope) =>
      read(
        z.array(DecisionOut),
        client.GET("/v1/companies/{company}/projects/{project}/decisions", project(s)),
      ),
  }

  return {
    me: () => read(Me, client.GET("/v1/me")),
    signIn: (returnTo: string) => transport.signIn(safeReturnTo(returnTo)),
    async signOut() {
      const { error, response } = await auth.POST("/auth/logout")
      if (!response.ok) throw refusal(response.status, error)
    },

    companies: async () => ({ companies: await get.companies() }),

    async company(id: CompanyId): Promise<Company> {
      const [c, list, projects, stakeholders, systems] = await Promise.all([
        get.company(id),
        get.companies(),
        get.projects(id),
        get.stakeholders(id),
        get.systems(id),
      ])
      // The FDE's part there comes with their list of companies, not with the company.
      const role = list.find((entry) => entry.id === c.id)?.role ?? null
      return { ...c, role, projects, stakeholders, systems }
    },

    async project(scope: ProjectScope): Promise<Project> {
      const [c, p, scopeOfWork, access, tasks, decisions, stakeholders, systems] =
        await Promise.all([
          get.company(scope.company),
          get.project(scope),
          get.scope(scope),
          get.access(scope),
          get.tasks(scope),
          get.decisions(scope),
          get.projectStakeholders(scope),
          get.projectSystems(scope),
        ])
      // The path already scopes it; an answer about another company is never shown.
      if (p.company !== c.id) throw new ApiError(404, "not_found")
      const where = { id: c.id, name: c.name }
      return {
        ...p,
        company: where,
        scope: scopeOfWork,
        access,
        tasks,
        decisions,
        stakeholders,
        systems,
      }
    },

    today: () => read(TodayOut, client.GET("/v1/today")),

    /** Moves a project to `to`; the API refuses a move `canMove` would refuse. */
    moveStage: (scope: ProjectScope, to: Stage) =>
      read(
        ProjectOut,
        client.PUT("/v1/companies/{company}/projects/{project}/stage", {
          ...project(scope),
          body: { stage: to },
        }),
      ),
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
    companies: async () => (await use()).companies(),
    company: async (id) => (await use()).company(id),
    project: async (scope) => (await use()).project(scope),
    today: async () => (await use()).today(),
    moveStage: async (scope, to) => (await use()).moveStage(scope, to),
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
  return url.origin === HERE ? `${url.pathname}${url.search}${url.hash}` : "/"
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

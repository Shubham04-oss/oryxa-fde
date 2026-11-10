import { queryOptions } from "@tanstack/react-query"
import createClient from "openapi-fetch"
import { z } from "zod"
import type { paths as RunPaths } from "./agent-runs.gen"
import type { paths } from "./fde-api.gen"
import { ApprovalOut, EventsOut, RunOut, isActive, parseEvents } from "./runs"
import type { AgentRunId, ApprovalId, CreateRun, RunEvent } from "./runs"
import {
  AccessRequestOut,
  AssigneeOut,
  CompanyOut,
  CompanySummaryOut,
  DecisionOut,
  Me,
  MemberOut,
  ProjectOut,
  ScopeItemOut,
  CriterionOut,
  ScopeOut,
  SignOffOut,
  StageChecklistOut,
  StageConflictBody,
  StakeholderOut,
  SystemOut,
  TaskOut,
  ThreadOut,
  TodayOut,
} from "./schemas"
import type { AccessBody, DecisionBody } from "../access"
import type { TaskBody } from "../board"
import type {
  CompanyBody,
  CompanyPatch,
  ProjectBody,
  ProjectPatch,
  StakeholderBody,
  SystemBody,
} from "../records"
import type { CriterionBody, ScopeItemBody } from "../scope"
import type {
  AccessRequestId,
  ChecklistItem,
  Company,
  CompanyId,
  CriterionId,
  MemberRole,
  Project,
  ProjectId,
  ProjectScope,
  ScopeItemId,
  Stage,
  StakeholderId,
  SystemId,
  TaskId,
  UserId,
} from "./schemas"

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

/**
 * The API refused to move a project forward because items of its stage checklist are open and no
 * reason came with the move. `open` is what the API found open when it answered, which may be more
 * than the page knew.
 */
export class ChecklistOpenError extends ApiError {
  constructor(readonly open: Array<ChecklistItem>) {
    super(409, "rejected_checklist_open", SAFE_TEXT.rejected_checklist_open)
    this.name = "ChecklistOpenError"
  }
}

/** Words for refusals the API answers with a code only. Anything else shows generic copy. */
export const SAFE_TEXT: Record<string, string> = {
  forbidden: "You are not allowed to do that here. Ask a lead, or an organisation admin.",
  conflict: "That clashes with a change made a moment ago. Reload the page and try again.",
  invalid_name: "A name is one line, 1 to 200 characters.",
  invalid_industry: "Industry is one line, up to 200 characters.",
  invalid_region: "Region is one line, up to 200 characters.",
  invalid_kind: "The kind is one line, up to 200 characters.",
  invalid_summary: "The summary is plain text, up to 4000 characters.",
  invalid_description: "The description is plain text, up to 4000 characters.",
  invalid_email: "Use an address like name@example.com.",
  invalid_metric: "What is measured is one line, up to 200 characters.",
  invalid_unit: "The unit is one line, up to 200 characters, such as % or s.",
  invalid_target: "The target must be a number.",
  rejected_target: "The target must be a number.",
  invalid_stakeholder: "That person is not a stakeholder at this company.",
  rejected_empty_scope:
    "Write at least one scope item or success criterion before it is signed off.",
  rejected_stage_transition: "A project moves one stage forward, or back to an earlier one.",
  rejected_checklist_open:
    "Some of this stage's checklist is still open. Give a reason to move on anyway.",
  invalid_reason: "The reason is plain text, 1 to 500 characters.",
  // The API could not reach a service it needs (WorkOS, SpiceDB). Nothing is wrong on this end.
  unavailable: "The workspace is briefly unavailable. Try again in a minute.",
  invalid_task: "Describe the task in plain text, up to 64 KiB.",
  invalid_repository: "Give the repository's owner, name and branch.",
  invalid_title: "The title is one line, up to 200 characters.",
  invalid_blocker: "Keep the blocker to plain text, up to 4000 characters.",
  invalid_due_on: "Use a date like 2026-11-30.",
  invalid_assignee: "That person is not on this project.",
  invalid_waiting_on: "That person is not a stakeholder at this company.",
  invalid_blocked_by: "That access request is not on this project.",
  invalid_owner: "That person is not a stakeholder at this company.",
  invalid_system: "That system is not one of this company's.",
  rejected_initial_status: "A request starts as requested or in progress.",
  invalid_rationale: "Why is plain text, up to 4000 characters.",
  invalid_decided_by: "Who decided is a name on one line, up to 200 characters.",
  invalid_decided_at: "Use a date like 2026-11-30.",
  rejected_blocker_required: "Say what is blocking it.",
  rejected_blocked_by_needs_blocked: "Only a blocked task can name an access request.",
  rejected_over_budget: "This project's agent budget is used up.",
  rejected_ended: "This run has already ended.",
  rejected_not_pending: "This approval is no longer waiting for a decision.",
  rejected_already_decided: "Someone has already decided this approval.",
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
  // Agent runs are served by the same API, from their own spec (crates/oryxa-fde-agent/openapi.json).
  const runs = createClient<RunPaths>({ baseUrl: `${origin()}/api`, ...options })

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
  const agentRun = (scope: ProjectScope, run: AgentRunId) => ({
    params: { path: { ...scope, run } },
  })
  const approval = (scope: ProjectScope, run: AgentRunId, id: ApprovalId) => ({
    params: { path: { ...scope, run, approval: id } },
  })
  const runsOf = (scope: ProjectScope) =>
    read(
      z.array(RunOut),
      runs.GET("/v1/companies/{company}/projects/{project}/agent-runs", project(scope)),
    )

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
    threads: (s: ProjectScope) =>
      read(
        z.array(ThreadOut),
        client.GET("/v1/companies/{company}/projects/{project}/threads", project(s)),
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

    /** The scope as it is now: the sign-off asks, to catch an edit made while its dialog was open. */
    scope: (scope: ProjectScope) => get.scope(scope),

    today: () => read(TodayOut, client.GET("/v1/today")),

    /** Creates a company; the caller becomes its lead. */
    createCompany: (body: CompanyBody) => read(CompanyOut, client.POST("/v1/companies", { body })),

    /** Changes the fields in `patch`; a field left out stays, `null` clears it. */
    updateCompany: (id: CompanyId, patch: CompanyPatch) =>
      read(CompanyOut, client.PATCH("/v1/companies/{company}", { ...company(id), body: patch })),

    /** Creates a project in the Discover stage. */
    createProject: (id: CompanyId, body: ProjectBody) =>
      read(ProjectOut, client.POST("/v1/companies/{company}/projects", { ...company(id), body })),

    updateProject: (scope: ProjectScope, patch: ProjectPatch) =>
      read(
        ProjectOut,
        client.PATCH("/v1/companies/{company}/projects/{project}", {
          ...project(scope),
          body: patch,
        }),
      ),

    addStakeholder: (id: CompanyId, body: StakeholderBody) =>
      read(
        StakeholderOut,
        client.POST("/v1/companies/{company}/stakeholders", { ...company(id), body }),
      ),

    /** Replaces a stakeholder: every field, so a change to one sends them all. */
    updateStakeholder: (id: CompanyId, stakeholder: StakeholderId, body: StakeholderBody) =>
      read(
        StakeholderOut,
        client.PUT("/v1/companies/{company}/stakeholders/{stakeholder}", {
          params: { path: { company: id, stakeholder } },
          body,
        }),
      ),

    async removeStakeholder(id: CompanyId, stakeholder: StakeholderId) {
      const { error, response } = await client.DELETE(
        "/v1/companies/{company}/stakeholders/{stakeholder}",
        { params: { path: { company: id, stakeholder } } },
      )
      if (response.status === 409)
        throw new ApiError(
          409,
          "conflict",
          "They signed off a scope, so they cannot be removed from the record.",
        )
      if (!response.ok) throw refusal(response.status, error)
    },

    addSystem: (id: CompanyId, body: SystemBody) =>
      read(SystemOut, client.POST("/v1/companies/{company}/systems", { ...company(id), body })),

    /** Replaces a system: every field. */
    updateSystem: (id: CompanyId, system: SystemId, body: SystemBody) =>
      read(
        SystemOut,
        client.PUT("/v1/companies/{company}/systems/{system}", {
          params: { path: { company: id, system } },
          body,
        }),
      ),

    async removeSystem(id: CompanyId, system: SystemId) {
      const { error, response } = await client.DELETE("/v1/companies/{company}/systems/{system}", {
        params: { path: { company: id, system } },
      })
      if (!response.ok) throw refusal(response.status, error)
    },

    members: (id: CompanyId) =>
      read(z.array(MemberOut), client.GET("/v1/companies/{company}/members", company(id))),

    async setMember(id: CompanyId, user: UserId, role: MemberRole) {
      const { error, response } = await client.PUT("/v1/companies/{company}/members/{user}", {
        params: { path: { company: id, user } },
        body: { role },
      })
      if (!response.ok) throw refusal(response.status, error)
    },

    async removeMember(id: CompanyId, user: UserId) {
      const { error, response } = await client.DELETE("/v1/companies/{company}/members/{user}", {
        params: { path: { company: id, user } },
      })
      if (!response.ok) throw refusal(response.status, error)
    },

    assignees: (scope: ProjectScope) =>
      read(
        z.array(AssigneeOut),
        client.GET("/v1/companies/{company}/projects/{project}/assignees", project(scope)),
      ),

    async assign(scope: ProjectScope, user: UserId) {
      const { error, response } = await client.PUT(
        "/v1/companies/{company}/projects/{project}/assignees/{user}",
        { params: { path: { ...scope, user } } },
      )
      if (!response.ok) throw refusal(response.status, error)
    },

    async unassign(scope: ProjectScope, user: UserId) {
      const { error, response } = await client.DELETE(
        "/v1/companies/{company}/projects/{project}/assignees/{user}",
        { params: { path: { ...scope, user } } },
      )
      if (!response.ok) throw refusal(response.status, error)
    },

    /** The checklist to leave the project's current stage, worked out from its records now. */
    stageChecklist: (scope: ProjectScope) =>
      read(
        StageChecklistOut,
        client.GET("/v1/companies/{company}/projects/{project}/stage-checklist", project(scope)),
      ),

    /**
     * Moves a project to `to`; the API refuses a move `canMove` would refuse. A forward move with
     * checklist items open needs a `reason`; without one it throws a `ChecklistOpenError`. Moving
     * back never takes one, and none is sent with it.
     */
    async moveStage(scope: ProjectScope, to: Stage, reason?: string) {
      const { data, error, response } = await client.PUT(
        "/v1/companies/{company}/projects/{project}/stage",
        { ...project(scope), body: reason === undefined ? { stage: to } : { stage: to, reason } },
      )
      if (response.status === 409) {
        const conflict = StageConflictBody.safeParse(error)
        if (conflict.success && conflict.data.error === "rejected_checklist_open")
          throw new ChecklistOpenError(conflict.data.open ?? [])
      }
      if (!response.ok) throw refusal(response.status, error)
      return ProjectOut.parse(data)
    },

    /** Adds a task; the API answers with it as saved. */
    addTask: (scope: ProjectScope, body: TaskBody) =>
      read(
        TaskOut,
        client.POST("/v1/companies/{company}/projects/{project}/tasks", {
          ...project(scope),
          body,
        }),
      ),

    /** Replaces a task: every field, so a change to one sends them all (`toBody`). */
    updateTask: (scope: ProjectScope, task: TaskId, body: TaskBody) =>
      read(
        TaskOut,
        client.PUT("/v1/companies/{company}/projects/{project}/tasks/{task}", {
          params: { path: { ...scope, task } },
          body,
        }),
      ),

    /** Replaces an access request: every field, so a change of status sends them all. */
    updateAccess: (scope: ProjectScope, access: AccessRequestId, body: AccessBody) =>
      read(
        AccessRequestOut,
        client.PUT("/v1/companies/{company}/projects/{project}/access-requests/{access_request}", {
          params: { path: { ...scope, access_request: access } },
          body,
        }),
      ),

    /** The people at a project's company, for a prompt that asks who a task waits on. */
    projectStakeholders: (scope: ProjectScope) => get.projectStakeholders(scope),

    /** The project's access requests, for a prompt that asks what blocks a task. */
    accessRequests: (scope: ProjectScope) => get.access(scope),

    /** The project's discussions, read to say which decisions came from one. */
    threads: (scope: ProjectScope) => get.threads(scope),

    /** Asks for access. The API takes a new request as requested or in progress only. */
    addAccess: (scope: ProjectScope, body: AccessBody) =>
      read(
        AccessRequestOut,
        client.POST("/v1/companies/{company}/projects/{project}/access-requests", {
          ...project(scope),
          body,
        }),
      ),

    /** Logs a decision. The log is append-only: there is no way to change or remove one. */
    addDecision: (scope: ProjectScope, body: DecisionBody) =>
      read(
        DecisionOut,
        client.POST("/v1/companies/{company}/projects/{project}/decisions", {
          ...project(scope),
          body,
        }),
      ),

    async removeTask(scope: ProjectScope, task: TaskId) {
      const { error, response } = await client.DELETE(
        "/v1/companies/{company}/projects/{project}/tasks/{task}",
        { params: { path: { ...scope, task } } },
      )
      if (!response.ok) throw refusal(response.status, error)
    },

    addScopeItem: (scope: ProjectScope, body: ScopeItemBody) =>
      read(
        ScopeItemOut,
        client.POST("/v1/companies/{company}/projects/{project}/scope/items", {
          ...project(scope),
          body,
        }),
      ),

    /** Replaces an item: its side and its words. */
    updateScopeItem: (scope: ProjectScope, item: ScopeItemId, body: ScopeItemBody) =>
      read(
        ScopeItemOut,
        client.PUT("/v1/companies/{company}/projects/{project}/scope/items/{item}", {
          params: { path: { ...scope, item } },
          body,
        }),
      ),

    async removeScopeItem(scope: ProjectScope, item: ScopeItemId) {
      const { error, response } = await client.DELETE(
        "/v1/companies/{company}/projects/{project}/scope/items/{item}",
        { params: { path: { ...scope, item } } },
      )
      if (!response.ok) throw refusal(response.status, error)
    },

    addCriterion: (scope: ProjectScope, body: CriterionBody) =>
      read(
        CriterionOut,
        client.POST("/v1/companies/{company}/projects/{project}/scope/criteria", {
          ...project(scope),
          body,
        }),
      ),

    /** Replaces a criterion: every field. */
    updateCriterion: (scope: ProjectScope, criterion: CriterionId, body: CriterionBody) =>
      read(
        CriterionOut,
        client.PUT("/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}", {
          params: { path: { ...scope, criterion } },
          body,
        }),
      ),

    async removeCriterion(scope: ProjectScope, criterion: CriterionId) {
      const { error, response } = await client.DELETE(
        "/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}",
        { params: { path: { ...scope, criterion } } },
      )
      if (!response.ok) throw refusal(response.status, error)
    },

    /** Records that `stakeholder` signed off the scope as it is now. */
    async signOffScope(scope: ProjectScope, stakeholder: StakeholderId) {
      const { data, error, response } = await client.POST(
        "/v1/companies/{company}/projects/{project}/scope/sign-offs",
        { ...project(scope), body: { stakeholder } },
      )
      // One sign-off per version: the unique key refuses a second.
      if (
        response.status === 409 &&
        (error as { error?: string } | undefined)?.error === "conflict"
      )
        throw new ApiError(
          409,
          "conflict",
          "This version of the scope has already been signed off. Reload to see by whom.",
        )
      if (!response.ok) throw refusal(response.status, error)
      return SignOffOut.parse(data)
    },

    runs: runsOf,

    /** A run with its events so far and its approval requests. */
    async run(scope: ProjectScope, id: AgentRunId): Promise<RunDetail> {
      const path = "/v1/companies/{company}/projects/{project}/agent-runs/{run}"
      const [run, stored, approvals] = await Promise.all([
        read(RunOut, runs.GET(path, agentRun(scope, id))),
        read(EventsOut, runs.GET(`${path}/events`, agentRun(scope, id))),
        read(z.array(ApprovalOut), runs.GET(`${path}/approvals`, agentRun(scope, id))),
      ])
      return { run, approvals, ...parseEvents(stored.events) }
    },

    startRun: (scope: ProjectScope, body: CreateRun) =>
      read(
        RunOut,
        runs.POST("/v1/companies/{company}/projects/{project}/agent-runs", {
          ...project(scope),
          body,
        }),
      ),

    cancelRun: (scope: ProjectScope, id: AgentRunId) =>
      read(
        RunOut,
        runs.POST(
          "/v1/companies/{company}/projects/{project}/agent-runs/{run}/cancel",
          agentRun(scope, id),
        ),
      ),

    /** Approves or rejects one approval request: exactly the tool call it shows, nothing else. */
    decide(scope: ProjectScope, run: AgentRunId, id: ApprovalId, outcome: "approve" | "reject") {
      const path = approval(scope, run, id)
      return read(
        ApprovalOut,
        outcome === "approve"
          ? runs.POST(
              "/v1/companies/{company}/projects/{project}/agent-runs/{run}/approvals/{approval}/approve",
              path,
            )
          : runs.POST(
              "/v1/companies/{company}/projects/{project}/agent-runs/{run}/approvals/{approval}/reject",
              path,
            ),
      )
    },

    // ponytail: one call per project until the agent stream lists runs across projects (#27 comment).
    async activeRuns(): Promise<Array<ActiveRun>> {
      const companies = await get.companies()
      const perProject = await Promise.all(
        companies.flatMap((c) =>
          c.projects.map(async (p) => {
            const list = await runsOf({ company: c.id, project: p.id })
            const where = {
              company: { id: c.id, name: c.name },
              project: { id: p.id, name: p.name },
            }
            return list.filter((run) => isActive(run.state)).map((run) => ({ run, ...where }))
          }),
        ),
      )
      return perProject.flat()
    },
  }
}

/** A run as the review screen reads it. */
export type RunDetail = {
  run: RunOut
  approvals: Array<ApprovalOut>
  events: Array<RunEvent>
  /** Lines the screen could not read, so it can say so. */
  skipped: number
}

/** A run that may still need the FDE, with where it is. */
export type ActiveRun = {
  run: RunOut
  company: { id: CompanyId; name: string }
  project: { id: ProjectId; name: string }
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
    scope: async (scope) => (await use()).scope(scope),
    today: async () => (await use()).today(),
    createCompany: async (body) => (await use()).createCompany(body),
    updateCompany: async (id, patch) => (await use()).updateCompany(id, patch),
    createProject: async (id, body) => (await use()).createProject(id, body),
    updateProject: async (scope, patch) => (await use()).updateProject(scope, patch),
    addStakeholder: async (id, body) => (await use()).addStakeholder(id, body),
    updateStakeholder: async (id, stakeholder, body) =>
      (await use()).updateStakeholder(id, stakeholder, body),
    removeStakeholder: async (id, stakeholder) => (await use()).removeStakeholder(id, stakeholder),
    addSystem: async (id, body) => (await use()).addSystem(id, body),
    updateSystem: async (id, system, body) => (await use()).updateSystem(id, system, body),
    removeSystem: async (id, system) => (await use()).removeSystem(id, system),
    members: async (id) => (await use()).members(id),
    setMember: async (id, user, role) => (await use()).setMember(id, user, role),
    removeMember: async (id, user) => (await use()).removeMember(id, user),
    assignees: async (scope) => (await use()).assignees(scope),
    assign: async (scope, user) => (await use()).assign(scope, user),
    unassign: async (scope, user) => (await use()).unassign(scope, user),
    stageChecklist: async (scope) => (await use()).stageChecklist(scope),
    moveStage: async (scope, to, reason) => (await use()).moveStage(scope, to, reason),
    addTask: async (scope, body) => (await use()).addTask(scope, body),
    updateTask: async (scope, task, body) => (await use()).updateTask(scope, task, body),
    updateAccess: async (scope, access, body) => (await use()).updateAccess(scope, access, body),
    projectStakeholders: async (scope) => (await use()).projectStakeholders(scope),
    accessRequests: async (scope) => (await use()).accessRequests(scope),
    threads: async (scope) => (await use()).threads(scope),
    addAccess: async (scope, body) => (await use()).addAccess(scope, body),
    addDecision: async (scope, body) => (await use()).addDecision(scope, body),
    removeTask: async (scope, task) => (await use()).removeTask(scope, task),
    addScopeItem: async (scope, body) => (await use()).addScopeItem(scope, body),
    updateScopeItem: async (scope, item, body) => (await use()).updateScopeItem(scope, item, body),
    removeScopeItem: async (scope, item) => (await use()).removeScopeItem(scope, item),
    addCriterion: async (scope, body) => (await use()).addCriterion(scope, body),
    updateCriterion: async (scope, criterion, body) =>
      (await use()).updateCriterion(scope, criterion, body),
    removeCriterion: async (scope, criterion) => (await use()).removeCriterion(scope, criterion),
    signOffScope: async (scope, stakeholder) => (await use()).signOffScope(scope, stakeholder),
    runs: async (scope) => (await use()).runs(scope),
    run: async (scope, id) => (await use()).run(scope, id),
    startRun: async (scope, body) => (await use()).startRun(scope, body),
    cancelRun: async (scope, id) => (await use()).cancelRun(scope, id),
    decide: async (scope, run, id, outcome) => (await use()).decide(scope, run, id, outcome),
    activeRuns: async () => (await use()).activeRuns(),
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
  /** Under the project's key, so a read of the project that is cancelled or invalidated takes this with it. */
  stageChecklist: (scope: ProjectScope) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project, "stage-checklist"],
      queryFn: () => api.stageChecklist(scope),
      ...read,
    }),
  today: () => queryOptions({ queryKey: ["today"], queryFn: api.today, ...read }),
  /** The people at a project's company, read when a prompt needs them. */
  projectStakeholders: (scope: ProjectScope) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project, "stakeholders"],
      queryFn: () => api.projectStakeholders(scope),
      ...read,
      staleTime: 60_000,
    }),
  /** The project's access requests, read when a prompt needs them. */
  projectAccess: (scope: ProjectScope) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project, "access-requests"],
      queryFn: () => api.accessRequests(scope),
      ...read,
    }),
  /** The project's discussions, to say which decisions were promoted from one. */
  threads: (scope: ProjectScope) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project, "threads"],
      queryFn: () => api.threads(scope),
      ...read,
      staleTime: 60_000,
    }),
  runs: (scope: ProjectScope) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project, "runs"],
      queryFn: () => api.runs(scope),
      ...read,
    }),
  /** A run, read again every few seconds while it may change; live output arrives in between. */
  run: (scope: ProjectScope, id: AgentRunId) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project, "runs", id],
      queryFn: () => api.run(scope, id),
      ...read,
      refetchInterval: (query) =>
        query.state.data && isActive(query.state.data.run.state) ? RUN_POLL_MS : false,
    }),
  activeRuns: () =>
    queryOptions({ queryKey: ["runs", "active"], queryFn: api.activeRuns, ...read }),
  /** A company's leads and engineers, by id: the API has no names for them yet. */
  members: (id: CompanyId) =>
    queryOptions({
      queryKey: ["companies", id, "members"],
      queryFn: () => api.members(id),
      ...read,
    }),
  /** The engineers assigned to a project, by id. */
  assignees: (scope: ProjectScope) =>
    queryOptions({
      queryKey: ["companies", scope.company, "projects", scope.project, "assignees"],
      queryFn: () => api.assignees(scope),
      ...read,
    }),
}

const RUN_POLL_MS = 5_000

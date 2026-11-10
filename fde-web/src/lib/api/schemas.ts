import { z } from "zod"

// The FDE API's answers, following its OpenAPI spec (crates/oryxa-fde-api/openapi.json, generated
// into fde-api.gen.ts). Every answer is parsed against these, so an API or mock that drifts fails
// loudly at runtime; schemas.test.ts fails the typecheck when one stops matching the spec.

/**
 * An id, with the rule `oryxa-core` and `oryxa-fde-core` enforce: 1 to `max` of [A-Za-z0-9_-].
 * Branded, so a raw string from the address bar cannot reach a call without being checked.
 */
function id<TBrand extends string>(max = 128) {
  return z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`))
    .brand<TBrand>()
}

export const TenantId = id<"TenantId">(64)
export const UserId = id<"UserId">(64)
export type UserId = z.infer<typeof UserId>
export const CompanyId = id<"CompanyId">()
export type CompanyId = z.infer<typeof CompanyId>
export const ProjectId = id<"ProjectId">()
export type ProjectId = z.infer<typeof ProjectId>
export const StakeholderId = id<"StakeholderId">()
export type StakeholderId = z.infer<typeof StakeholderId>
export const SystemId = id<"SystemId">()
export type SystemId = z.infer<typeof SystemId>
export const ScopeItemId = id<"ScopeItemId">()
export const CriterionId = id<"CriterionId">()
export const AccessRequestId = id<"AccessRequestId">()
export const TaskId = id<"TaskId">()
export type TaskId = z.infer<typeof TaskId>
export const DecisionId = id<"DecisionId">()

/** Every project-scoped call takes both ids, as `ProjectScope` does in `oryxa-fde-core`. */
export type ProjectScope = { company: CompanyId; project: ProjectId }

/** The project lifecycle, in order (`oryxa_fde_core::Stage`, the spec's `ProjectStage`). */
export const STAGES = [
  "discover",
  "scope",
  "access",
  "build",
  "evaluate",
  "deploy",
  "handoff",
  "operate",
] as const
export const Stage = z.enum(STAGES)
export type Stage = z.infer<typeof Stage>

const instant = z.iso.datetime({ offset: true })
const day = z.iso.date()
const optionalText = z.string().nullish()

/** Who is signed in: `GET /v1/me` (the spec's `MeOut`). */
export const Me = z.object({
  user: z.object({ id: UserId, name: z.string() }),
  organisation: z.object({ id: TenantId, name: z.string() }),
  role: z.enum(["admin", "member"]),
})
export type Me = z.infer<typeof Me>

export const CompanyOut = z.object({
  id: CompanyId,
  name: z.string(),
  industry: optionalText,
  region: optionalText,
  summary: optionalText,
  created_at: instant,
  updated_at: instant,
})
export type CompanyOut = z.infer<typeof CompanyOut>

export const ProjectOut = z.object({
  id: ProjectId,
  company: CompanyId,
  name: z.string(),
  stage: Stage,
  summary: optionalText,
  created_at: instant,
  updated_at: instant,
})
export type ProjectOut = z.infer<typeof ProjectOut>

export const ProjectSummaryOut = z.object({ id: ProjectId, name: z.string(), stage: Stage })
export type ProjectSummaryOut = z.infer<typeof ProjectSummaryOut>

/** The FDE's part at a company: a member's role, or `admin` for an organisation admin who is not one. */
export const CompanyRole = z.enum(["lead", "engineer", "admin"])
export type CompanyRole = z.infer<typeof CompanyRole>

/** A company in the FDE's list, with their part there and its projects (`GET /v1/companies`). */
export const CompanySummaryOut = CompanyOut.extend({
  role: CompanyRole.nullish(),
  projects: z.array(ProjectSummaryOut),
})
export type CompanySummary = z.infer<typeof CompanySummaryOut>

/** The part a stakeholder plays in the engagement (the spec's `StakeholderPart`). */
export const StakeholderPart = z.enum(["sponsor", "champion", "user", "it", "security", "other"])
export type StakeholderPart = z.infer<typeof StakeholderPart>

export const StakeholderOut = z.object({
  id: StakeholderId,
  name: z.string(),
  role: StakeholderPart,
  title: optionalText,
  /** Where a sponsor's weekly digest goes. */
  email: optionalText,
  /** When they unsubscribed from the weekly digest, if they did. */
  digest_unsubscribed_at: instant.nullish(),
  updated_at: instant,
})
export type StakeholderOut = z.infer<typeof StakeholderOut>

export const SystemOut = z.object({
  id: SystemId,
  name: z.string(),
  kind: optionalText,
  description: optionalText,
  updated_at: instant,
})
export type SystemOut = z.infer<typeof SystemOut>

export const ScopeItemOut = z.object({
  id: ScopeItemId,
  kind: z.enum(["in", "out"]),
  description: z.string(),
  updated_at: instant,
})

export const CriterionOut = z.object({
  id: CriterionId,
  description: z.string(),
  metric: z.string(),
  comparator: z.enum(["at_least", "at_most"]),
  target: z.number(),
  unit: optionalText,
  updated_at: instant,
})
export type CriterionOut = z.infer<typeof CriterionOut>

const version = z.int().nonnegative()

export const SignOffOut = z.object({
  version,
  stakeholder: StakeholderId,
  recorded_by: UserId,
  signed_at: instant,
})

export const ScopeOut = z.object({
  version,
  /** Whether the latest sign-off covers the current version. */
  signed_off: z.boolean(),
  sign_off: SignOffOut.nullish(),
  items: z.array(ScopeItemOut),
  criteria: z.array(CriterionOut),
})
export type ScopeOut = z.infer<typeof ScopeOut>

export const AccessState = z.enum(["requested", "in_progress", "granted", "denied", "revoked"])
export type AccessState = z.infer<typeof AccessState>

export const AccessRequestOut = z.object({
  id: AccessRequestId,
  description: z.string(),
  system: SystemId.nullish(),
  /** The stakeholder at the customer who can grant it. */
  owner: StakeholderId.nullish(),
  status: AccessState,
  requested_at: instant,
  status_changed_at: instant,
  granted_at: instant.nullish(),
  /** Whole days from the request until it was settled, or until now while it is open. */
  days_waiting: z.int(),
})
export type AccessRequestOut = z.infer<typeof AccessRequestOut>

export const TaskState = z.enum(["todo", "in_progress", "waiting_on_customer", "blocked", "done"])
export type TaskState = z.infer<typeof TaskState>

export const TaskOut = z.object({
  id: TaskId,
  title: z.string(),
  status: TaskState,
  blocker: optionalText,
  due_on: day.nullish(),
  /** A WorkOS user id. */
  assignee: UserId.nullish(),
  /** The stakeholder it waits on, and since when, while it waits on the customer. */
  waiting_on: StakeholderId.nullish(),
  waiting_since: instant.nullish(),
  /** The access request it is blocked on, while blocked on one. */
  blocked_by: AccessRequestId.nullish(),
  created_at: instant,
  updated_at: instant,
})
export type TaskOut = z.infer<typeof TaskOut>

export const DecisionOut = z.object({
  id: DecisionId,
  title: z.string(),
  rationale: z.string(),
  /** Who decided, often someone at the customer: a name, not an id. */
  decided_by: z.string(),
  decided_at: instant,
  recorded_by: UserId,
  created_at: instant,
})
export type DecisionOut = z.infer<typeof DecisionOut>

const Named = <T extends z.ZodType<string>>(ref: T) => z.object({ id: ref, name: z.string() })

/** Open work across every project the FDE is on (`GET /v1/today`), tagged by `kind`. */
export const TodayItemOut = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task"),
    task: TaskOut,
    company: Named(CompanyId),
    project: Named(ProjectId),
  }),
  z.object({
    kind: z.literal("access_request"),
    access: AccessRequestOut,
    /** The name of the stakeholder who can grant it. */
    owner: optionalText,
    company: Named(CompanyId),
    project: Named(ProjectId),
  }),
])
export type TodayItem = z.infer<typeof TodayItemOut>
export const TodayOut = z.object({ items: z.array(TodayItemOut) })

// What the company and project screens read, gathered by `api` (client.ts) from the answers above.

export type Company = CompanyOut & {
  role: CompanyRole | null
  projects: Array<ProjectOut>
  stakeholders: Array<StakeholderOut>
  systems: Array<SystemOut>
}

/** A project with its lifecycle records, and the company's people and systems they refer to. */
export type Project = Omit<ProjectOut, "company"> & {
  company: { id: CompanyId; name: string }
  scope: ScopeOut
  access: Array<AccessRequestOut>
  tasks: Array<TaskOut>
  decisions: Array<DecisionOut>
  stakeholders: Array<StakeholderOut>
  systems: Array<SystemOut>
}

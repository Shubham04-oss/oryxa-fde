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
const optionalText = z.string().nullish()

// ponytail: `/v1/me` is not in the spec yet (#24 comment); this is the shape asked of the API.
export const Me = z.object({
  user: z.object({ id: UserId, name: z.string() }),
  organisation: z.object({ id: TenantId, name: z.string() }),
  role: z.enum(["admin", "member"]),
})
export type Me = z.infer<typeof Me>

export const CompanyOut = z.object({
  id: CompanyId,
  name: z.string(),
  created_at: instant,
  updated_at: instant,
})
export type CompanyOut = z.infer<typeof CompanyOut>

export const ProjectOut = z.object({
  id: ProjectId,
  company: CompanyId,
  name: z.string(),
  stage: Stage,
  created_at: instant,
  updated_at: instant,
})
export type ProjectOut = z.infer<typeof ProjectOut>

/** The FDE's part at a company (`fde_company` in ADR 0002; the spec's `MemberRole`). */
export const CompanyRole = z.enum(["lead", "engineer"])
export type CompanyRole = z.infer<typeof CompanyRole>

export const MemberOut = z.object({ user: UserId, role: CompanyRole, added_at: instant })

export const StakeholderOut = z.object({
  id: StakeholderId,
  name: z.string(),
  title: optionalText,
  updated_at: instant,
})
export type StakeholderOut = z.infer<typeof StakeholderOut>

export const SystemOut = z.object({
  id: SystemId,
  name: z.string(),
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

// What the screens read, composed by `api` (client.ts) from the answers above.

/** A company in lists: its projects, and the FDE's part there (null when not a member). */
export type CompanySummary = CompanyOut & { role: CompanyRole | null; projects: Array<ProjectOut> }

export type Company = CompanySummary & {
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

type Where = {
  company: { id: CompanyId; name: string }
  project: { id: ProjectId; name: string }
}

/** Open work across every company the FDE is on: tasks and access requests not yet settled. */
export type TodayItem =
  | ({ kind: "task"; task: TaskOut } & Where)
  | ({ kind: "access_request"; access: AccessRequestOut; owner: string | null } & Where)

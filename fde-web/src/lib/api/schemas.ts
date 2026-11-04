import { z } from "zod"

// The shapes the FDE API answers with, following docs/plan.md and the API stream's issues (#2,
// #3). Every answer is parsed against these, so a mock or an API that drifts fails loudly instead
// of rendering something half right. When the API's OpenAPI spec lands, these follow it.

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
export const CompanyId = id<"CompanyId">()
export type CompanyId = z.infer<typeof CompanyId>
export const ProjectId = id<"ProjectId">()
export type ProjectId = z.infer<typeof ProjectId>
export const StakeholderId = id<"StakeholderId">()
export const SystemId = id<"SystemId">()
export const CriterionId = id<"CriterionId">()
export const AccessRequestId = id<"AccessRequestId">()
export const TaskId = id<"TaskId">()
export const DecisionId = id<"DecisionId">()

/** Every project-scoped call takes both ids, as `ProjectScope` does in `oryxa-fde-core`. */
export type ProjectScope = { company: CompanyId; project: ProjectId }

/** The project lifecycle, in order (`oryxa_fde_core::Stage`). */
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

const day = z.iso.date()
const instant = z.iso.datetime({ offset: true })

export const Me = z.object({
  user: z.object({ id: UserId, name: z.string() }),
  organisation: z.object({ id: TenantId, name: z.string() }),
  role: z.enum(["admin", "member"]),
})
export type Me = z.infer<typeof Me>

export const ProjectSummary = z.object({
  id: ProjectId,
  name: z.string(),
  stage: Stage,
  updated_at: instant,
})
export type ProjectSummary = z.infer<typeof ProjectSummary>

/** The FDE's part at a company (`fde_company` in ADR 0002). */
export const CompanyRole = z.enum(["lead", "engineer"])
export type CompanyRole = z.infer<typeof CompanyRole>

export const CompanySummary = z.object({
  id: CompanyId,
  name: z.string(),
  industry: z.string(),
  role: CompanyRole,
  projects: z.array(ProjectSummary),
})
export type CompanySummary = z.infer<typeof CompanySummary>
export const Companies = z.object({ companies: z.array(CompanySummary) })

export const Stakeholder = z.object({
  id: StakeholderId,
  name: z.string(),
  title: z.string(),
  part: z.enum(["sponsor", "champion", "decision_maker", "security", "it_owner", "end_user"]),
})
export type Stakeholder = z.infer<typeof Stakeholder>

export const System = z.object({
  id: SystemId,
  name: z.string(),
  kind: z.string(),
  notes: z.string(),
})
export type System = z.infer<typeof System>

export const Company = CompanySummary.extend({
  region: z.string(),
  summary: z.string(),
  stakeholders: z.array(Stakeholder),
  systems: z.array(System),
})
export type Company = z.infer<typeof Company>

export const Criterion = z.object({
  id: CriterionId,
  statement: z.string(),
  target: z.string(),
  status: z.enum(["not_measured", "passing", "failing"]),
})
export type Criterion = z.infer<typeof Criterion>

export const AccessRequest = z.object({
  id: AccessRequestId,
  system: z.string(),
  /** The person at the customer who can grant it. */
  owner: z.string(),
  status: z.enum(["requested", "in_review", "granted", "denied"]),
  requested_on: day,
})
export type AccessRequest = z.infer<typeof AccessRequest>

export const TaskStatus = z.enum(["todo", "in_progress", "blocked", "waiting_on_customer", "done"])
export type TaskStatus = z.infer<typeof TaskStatus>

export const Task = z.object({
  id: TaskId,
  title: z.string(),
  status: TaskStatus,
  due: day.nullable(),
  assignee: z.string().nullable(),
  /** Why it is blocked, when it is. */
  blocker: z.string().nullable(),
  /** Who at the customer it waits on, and since when, when it does. */
  waiting_on: z.string().nullable(),
  waiting_since: day.nullable(),
})
export type Task = z.infer<typeof Task>

export const Decision = z.object({
  id: DecisionId,
  title: z.string(),
  why: z.string(),
  decided_by: z.string(),
  decided_on: day,
})
export type Decision = z.infer<typeof Decision>

export const Project = ProjectSummary.extend({
  company: z.object({ id: CompanyId, name: z.string() }),
  summary: z.string(),
  scope: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    signed_off: z.object({ by: z.string(), on: day }).nullable(),
  }),
  criteria: z.array(Criterion),
  access: z.array(AccessRequest),
  tasks: z.array(Task),
  decisions: z.array(Decision),
})
export type Project = z.infer<typeof Project>

const Where = {
  company: z.object({ id: CompanyId, name: z.string() }),
  project: z.object({ id: ProjectId, name: z.string() }),
}

/** Open work across every company the FDE is on: tasks and access requests not yet done. */
export const TodayItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), task: Task, ...Where }),
  z.object({ kind: z.literal("access_request"), access: AccessRequest, ...Where }),
])
export type TodayItem = z.infer<typeof TodayItem>
export const Today = z.object({ items: z.array(TodayItem) })

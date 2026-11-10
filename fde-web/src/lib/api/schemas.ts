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
export type ScopeItemId = z.infer<typeof ScopeItemId>
export const CriterionId = id<"CriterionId">()
export type CriterionId = z.infer<typeof CriterionId>
export const AccessRequestId = id<"AccessRequestId">()
export type AccessRequestId = z.infer<typeof AccessRequestId>
export const TaskId = id<"TaskId">()
export type TaskId = z.infer<typeof TaskId>
export const DecisionId = id<"DecisionId">()
export const DocumentId = id<"DocumentId">()
export type DocumentId = z.infer<typeof DocumentId>
export const MeetingNoteId = id<"MeetingNoteId">()
export type MeetingNoteId = z.infer<typeof MeetingNoteId>

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

/** One item of the checklist to leave a stage (`key` is stable, e.g. `scope_signed_off`). */
export const ChecklistItemOut = z.object({ key: z.string(), label: z.string(), met: z.boolean() })
export type ChecklistItem = z.infer<typeof ChecklistItemOut>

/** What the project needs to leave its current stage, worked out from its records now. */
export const StageChecklistOut = z.object({ stage: Stage, items: z.array(ChecklistItemOut) })
export type StageChecklist = z.infer<typeof StageChecklistOut>

/** A refused stage move (409): `open` lists the items still open when a reason was needed. */
export const StageConflictBody = z.object({
  error: z.string(),
  open: z.array(ChecklistItemOut).nullish(),
})

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

const version = z.int().nonnegative()

/**
 * A record's version, bumped by every change to it; a `PUT` sends it back as `version`. The API
 * always sends it, but the spec marks it optional until the web's fixtures carry it.
 */
const recordVersion = version.optional()

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
  version: recordVersion,
})
export type StakeholderOut = z.infer<typeof StakeholderOut>

/** A company's role for a person who works on it (the spec's `MemberRole`). */
export const MemberRole = z.enum(["lead", "engineer"])
export type MemberRole = z.infer<typeof MemberRole>

/** A lead or engineer on a company. The API names them by id only (`user` is a WorkOS user id). */
export const MemberOut = z.object({ user: UserId, role: MemberRole, added_at: instant })
export type MemberOut = z.infer<typeof MemberOut>

/** An engineer assigned to a project. */
export const AssigneeOut = z.object({ user: UserId, added_at: instant })
export type AssigneeOut = z.infer<typeof AssigneeOut>

export const SystemOut = z.object({
  id: SystemId,
  name: z.string(),
  kind: optionalText,
  description: optionalText,
  updated_at: instant,
  version: recordVersion,
})
export type SystemOut = z.infer<typeof SystemOut>

export const ScopeItemOut = z.object({
  id: ScopeItemId,
  kind: z.enum(["in", "out"]),
  description: z.string(),
  updated_at: instant,
  version: recordVersion,
})
export type ScopeItemOut = z.infer<typeof ScopeItemOut>

export const CriterionOut = z.object({
  id: CriterionId,
  description: z.string(),
  metric: z.string(),
  comparator: z.enum(["at_least", "at_most"]),
  target: z.number(),
  unit: optionalText,
  updated_at: instant,
  version: recordVersion,
})
export type CriterionOut = z.infer<typeof CriterionOut>

export const SignOffOut = z.object({
  version,
  stakeholder: StakeholderId,
  recorded_by: UserId,
  signed_at: instant,
})
export type SignOffOut = z.infer<typeof SignOffOut>

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
  version: recordVersion,
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
  version: recordVersion,
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

/** A meeting note at a company or a project. Its body is customer text: shown as plain text, never as markup. */
export const MeetingNoteOut = z.object({
  id: MeetingNoteId,
  title: z.string(),
  /** The day the meeting was held, `YYYY-MM-DD`. */
  held_on: day,
  body: z.string(),
  /** The company's stakeholders who took part. */
  stakeholders: z.array(StakeholderId),
  /** The workspace's users who took part, by id: the API has no names for them yet. */
  attendees: z.array(UserId),
  created_by: UserId,
  created_at: instant,
  updated_at: instant,
})
export type MeetingNoteOut = z.infer<typeof MeetingNoteOut>

/** Where ingestion stands: `pending` until a worker has read it, then `ingested` (searchable) or `failed`. */
export const IngestState = z.enum(["pending", "ingested", "failed"])
export type IngestState = z.infer<typeof IngestState>

/**
 * A document of a company (`GET .../documents`, and the answer to an upload). Its name is the
 * uploader's and its bytes are the customer's: the name is shown as text and nothing else of the file
 * is ever read here. `failure` is a short code, not words.
 */
export const DocumentOut = z.object({
  id: DocumentId,
  name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  status: IngestState,
  failure: optionalText,
  chunks: z.number().int().nonnegative(),
  uploaded_by: UserId,
  created_at: instant,
  ingested_at: optionalText,
})
export type DocumentOut = z.infer<typeof DocumentOut>

/** One passage found by a search: customer text, shown as plain text. `score` only orders the list. */
export const SearchHitOut = z.object({
  document: DocumentId,
  document_name: z.string(),
  /** The passage's place in the document, from 0. */
  chunk: z.number().int().nonnegative(),
  text: z.string(),
  score: z.number(),
})
export type SearchHitOut = z.infer<typeof SearchHitOut>

/** Where notes are kept: a company, or one of its projects. */
export type NotePlace = { company: CompanyId; project?: ProjectId }

/** What a thread is about (`SubjectKind`): a record of the project or company, or a canvas shape. */
export const SubjectKind = z.enum([
  "stakeholder",
  "system",
  "document",
  "task",
  "decision",
  "access_request",
  "scope_item",
  "criterion",
  "meeting_note",
  "shape",
])
export type SubjectKind = z.infer<typeof SubjectKind>

/** A discussion on the project. The web only reads where a thread ended: `decision` is the one it was promoted to. */
export const ThreadOut = z.object({
  id: z.string(),
  subject: z.object({ kind: SubjectKind, id: z.string() }),
  created_by: z.string(),
  created_at: instant,
  last_comment_at: instant,
  comments: z.int().min(0),
  asked_at: instant.nullish(),
  customer_question: optionalText,
  decision: DecisionId.nullish(),
})
export type ThreadOut = z.infer<typeof ThreadOut>

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

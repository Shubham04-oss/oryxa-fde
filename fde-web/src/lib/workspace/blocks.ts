import { z } from "zod"
import { CompanyId, ProjectId, Stage } from "@/lib/api/schemas"

// The workspace's building blocks (issue #209): the only things it may put on a screen. A screen
// arranges and fills them; it never sends markup. Each block is checked here and a screen renders
// only what passes: an unknown or malformed block is dropped, never guessed at. This is the seam a
// model drives later, so everything in a block is untrusted text, shown as text.

/** One line of text a person reads: trimmed, not empty, no control characters, at most `max`. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "one line of plain text")

/** Several lines are fine; other control characters are not. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "plain text")

/** An id a block gives one of its parts, so a screen can key and refer to it. */
const PartId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

/** Where a block may send a person: one of our own screens, named, never a URL. */
export const Destination = z.discriminatedUnion("screen", [
  z.object({ screen: z.literal("today") }),
  z.object({ screen: z.literal("companies") }),
  z.object({ screen: z.literal("new-company") }),
  z.object({ screen: z.literal("company"), company: CompanyId }),
  z.object({ screen: z.literal("project"), company: CompanyId, project: ProjectId }),
])
export type Destination = z.infer<typeof Destination>

/** Something the workspace proposes: approve goes to where it is done, dismiss puts it away. */
export const SuggestionBlock = z.object({
  type: z.literal("suggestion"),
  id: PartId,
  /** Where it comes from, read first: "Kestrel Logistics · Dispatch planning". */
  context: line(160).optional(),
  title: line(160),
  detail: text(400).optional(),
  approve: z.object({ label: line(40), to: Destination }),
})

/** Facts about the work, as label and value: the company, what is delivered, how it starts. */
export const BriefBlock = z.object({
  type: z.literal("brief"),
  items: z.array(z.object({ label: line(40), value: text(600) })).max(8),
})

/** A success criterion a step works towards, and the placeholder for how it will be proven. */
const Criterion = z.object({ name: line(200), proof: line(240) })

/**
 * One step of the plan: an ordinary task (ADR 0008), on one of the eight stages and, where it
 * proves something, tied to a success criterion. There is no separate plan record.
 */
export const PlanStepItem = z.object({
  id: PartId,
  title: line(120),
  stage: Stage,
  /** Who the step is with, when it is with someone: "with Dana Ortiz". */
  with: line(120).optional(),
  criterion: Criterion.optional(),
})

/** The plan: an ordered list of steps the FDE has agreed. Order is the array's. */
export const PlanBlock = z.object({
  type: z.literal("plan"),
  steps: z.array(PlanStepItem).max(12),
})

export const VERDICTS = ["allowed", "ask", "never"] as const
export const Verdict = z.enum(VERDICTS)
export type Verdict = z.infer<typeof Verdict>

/** What agents may do on the company's work, and who says yes when they must ask. */
export const RulesBlock = z.object({
  type: z.literal("rules"),
  rules: z
    .array(
      z.object({ id: PartId, action: line(160), verdict: Verdict, note: line(200).optional() }),
    )
    .max(12),
  approver: line(80),
})

export const INVITE_ROLES = ["engineer", "lead", "sponsor", "it_admin"] as const
export const InviteRole = z.enum(INVITE_ROLES)
export type InviteRole = z.infer<typeof InviteRole>

/** The API's address rule, in short (records.ts): one @, a dotted domain, no spaces. */
export const Email = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/)

/** People to invite, by address and the part they play. */
export const PeopleBlock = z.object({
  type: z.literal("people"),
  people: z.array(z.object({ email: Email, role: InviteRole })).max(20),
})

/** What is done and what is still open before something can happen. */
export const ChecklistBlock = z.object({
  type: z.literal("checklist"),
  items: z
    .array(z.object({ label: line(160), done: z.boolean(), optional: z.boolean().optional() }))
    .max(12),
})

export const Block = z.discriminatedUnion("type", [
  SuggestionBlock,
  BriefBlock,
  PlanBlock,
  RulesBlock,
  PeopleBlock,
  ChecklistBlock,
])
export type Block = z.infer<typeof Block>
export type SuggestionBlock = z.infer<typeof SuggestionBlock>
export type BriefBlock = z.infer<typeof BriefBlock>
export type PlanBlock = z.infer<typeof PlanBlock>
export type PlanStep = z.infer<typeof PlanStepItem>
export type RulesBlock = z.infer<typeof RulesBlock>
export type PeopleBlock = z.infer<typeof PeopleBlock>
export type ChecklistBlock = z.infer<typeof ChecklistBlock>

/** The blocks of `input` that pass their schema, in order. Anything else is dropped. */
export function parseBlocks(input: unknown): Array<Block> {
  if (!Array.isArray(input)) return []
  return input.flatMap((raw) => {
    const parsed = Block.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  })
}

/** One block, or null when it does not pass. */
export function parseBlock(input: unknown): Block | null {
  return parseBlocks([input])[0] ?? null
}

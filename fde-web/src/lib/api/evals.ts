import { z } from "zod"
import { CriterionOut } from "./schemas"

// Eval suites, runs and results (crates/oryxa-fde-agent/openapi.evals.json, generated into evals.gen.ts), and the
// one read the page takes from the main API for "is it met": the room's criteria (`GET /v1/room/...`), which are
// the only place the API says whether a criterion's latest value meets its target. evals.test.ts checks these
// against the specs. Every string that came from a case, a model or an imported file is untrusted text.

function id<TBrand extends string>() {
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .brand<TBrand>()
}

export const SuiteId = id<"SuiteId">()
export type SuiteId = z.infer<typeof SuiteId>
export const EvalRunId = id<"EvalRunId">()
export type EvalRunId = z.infer<typeof EvalRunId>

const instant = z.iso.datetime({ offset: true })
const count = z.int().nonnegative()

/** A command run in the sandbox as `agent`, in `/workspace`. */
export const Command = z.object({ argv: z.array(z.string()), timeout_secs: count })
export type Command = z.infer<typeof Command>

/** The five graders. Each reads a case's output and says passed, failed, or errored when it could not decide. */
export const Grader = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact_match"), ignore_case: z.boolean().optional() }),
  z.object({ kind: z.literal("regex"), pattern: z.string() }),
  z.object({ kind: z.literal("json_schema"), schema: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("script"), argv: z.array(z.string()), timeout_secs: count }),
  z.object({ kind: z.literal("judge"), rubric: z.string() }),
])
export type Grader = z.infer<typeof Grader>

export const Case = z.object({
  id: z.string(),
  input: z.string(),
  expected: z.string().nullish(),
  criteria: z.array(z.string()).optional(),
})
export type Case = z.infer<typeof Case>

export const SuiteOut = z.object({
  id: SuiteId,
  name: z.string(),
  criteria: z.array(z.string()),
  target: Command.nullish(),
  graders: z.array(Grader),
  cases: z.array(Case),
})
export type SuiteOut = z.infer<typeof SuiteOut>

/** A grader's verdict on one case. `reason` is the grader's own words, and a judge may quote the output: text only. */
export const Verdict = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("passed"), score: z.number().nullish() }),
  z.object({ verdict: z.literal("failed"), reason: z.string() }),
  z.object({ verdict: z.literal("errored"), reason: z.string() }),
])
export type Verdict = z.infer<typeof Verdict>

export const CaseOutcome = z.enum(["passed", "failed", "errored"])
export type CaseOutcome = z.infer<typeof CaseOutcome>

export const CaseResult = z.object({
  case: z.string(),
  outcome: CaseOutcome,
  verdicts: z.array(Verdict),
  error: z.string().nullish(),
  output: z.string().nullish(),
})
export type CaseResult = z.infer<typeof CaseResult>

/** One criterion's result in a run: how many of the cases that measure it passed. `rate` is the API's, `passed / total`. */
export const CriterionRate = z.object({
  criterion: z.string(),
  passed: count,
  rate: z.number(),
  total: count,
})
export type CriterionRate = z.infer<typeof CriterionRate>

export const Report = z.object({
  cases: z.array(CaseResult),
  criteria: z.array(CriterionRate),
  errored: count,
  failed: count,
  passed: count,
})
export type Report = z.infer<typeof Report>

/** `running` until the API records the report, then `finished`: a run is finished only when it says so. */
export const EvalRunState = z.enum(["running", "finished"])

export const EvalRunOut = z.object({
  id: EvalRunId,
  suite: SuiteId,
  state: EvalRunState,
  imported: z.boolean(),
  created_by: z.string(),
  created_at: instant,
  ended_at: instant.nullish(),
  report: Report.nullish(),
})
export type EvalRunOut = z.infer<typeof EvalRunOut>

/** What a project's criteria look like to the room: the API's verdict on each one's latest value. */
export const RoomCriterion = z.object({
  criterion: CriterionOut,
  latest: z.number().nullish(),
  measured_at: instant.nullish(),
  passing: z.boolean().nullish(),
})
export type RoomCriterion = z.infer<typeof RoomCriterion>

/** The part of the room the Proof card reads. The rest (questions, the latest update) is the customer's view. */
export const ProofRoom = z.object({
  criteria: z.array(RoomCriterion),
  criteria_passing: count,
})
export type ProofRoom = z.infer<typeof ProofRoom>

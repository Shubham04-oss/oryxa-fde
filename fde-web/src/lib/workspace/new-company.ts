import { parseBlocks } from "./blocks"
import type { Block, InviteRole, PlanStep, Verdict } from "./blocks"
import type { CompanyFields } from "@/lib/records"

// The new-company conversation (issue #209), as data. The steps, their words, the rules agents
// follow and the plan the workspace proposes are all here; the screen only draws them. Scripted for
// now: a model can later choose the questions and fill the same blocks.

export type StepId = "company" | "start" | "rules" | "people" | "plan" | "review"

export type Step = {
  id: StepId
  /** What the workspace asks. `{name}` is the company's name. */
  ask: string
  /** Why it asks, in one quiet line. */
  why: string
  /** True when the person may skip it. */
  optional?: boolean
}

export const STEPS: ReadonlyArray<Step> = [
  {
    id: "company",
    ask: "Which company is it, and what are you delivering for them?",
    why: "A name is enough to start. The rest helps me propose a plan.",
  },
  {
    id: "start",
    ask: "How do you want to start?",
    why: "Not every engagement starts with building. Pick the first move.",
  },
  {
    id: "rules",
    ask: "What may agents do here, and who approves?",
    why: "Agents follow these on every run for this company.",
  },
  {
    id: "people",
    ask: "Who should be invited?",
    why: "Optional. Nothing is sent until you confirm.",
    optional: true,
  },
  {
    id: "plan",
    ask: "Here is a plan to start with. Change anything.",
    why: "Reorder, rename, add or remove steps. It becomes the company's first plan.",
  },
  {
    id: "review",
    ask: "Ready to create {name}?",
    why: "Check it over. Nothing is saved until you confirm.",
  },
]

export const APPROACHES = [
  { id: "talk", label: "Talk to them first", detail: "A discovery call, then agree scope." },
  {
    id: "scope",
    label: "Agree scope, then build",
    detail: "You know the problem. Write down what done means.",
  },
  {
    id: "pilot",
    label: "Start with a small pilot",
    detail: "Prove the idea on sample data, against a baseline.",
  },
] as const
export type Approach = (typeof APPROACHES)[number]["id"]

export type Rule = { id: string; action: string; verdict: Verdict; locked?: string }

/** What agents may do, with the default for a new company. Real data stays off (ADR 0003). */
export const RULES: ReadonlyArray<Rule> = [
  { id: "read_documents", action: "Read the company's documents", verdict: "allowed" },
  { id: "sandbox", action: "Run code in the sandbox on sample data", verdict: "allowed" },
  {
    id: "pull_requests",
    action: "Open pull requests in the customer's repositories",
    verdict: "ask",
  },
  { id: "message_customer", action: "Message people at the customer", verdict: "ask" },
  {
    id: "real_data",
    action: "Use the customer's real data",
    verdict: "never",
    locked: "Not until the company has its own keys.",
  },
]

export const VERDICT_LABEL: Record<Verdict, string> = {
  allowed: "Allowed",
  ask: "Ask first",
  never: "Never",
}

export const APPROVERS = [
  { id: "me", label: "Me" },
  { id: "leads", label: "Any lead on the company" },
] as const
export type Approver = (typeof APPROVERS)[number]["id"]

export const ROLE_LABEL: Record<InviteRole, string> = {
  engineer: "Engineer",
  lead: "Lead",
  sponsor: "Customer sponsor",
  it_admin: "Customer IT admin",
}

export type Invite = { email: string; role: InviteRole }

export type Answers = {
  company: CompanyFields | null
  start: { approach: Approach; contact: string; criterion: string } | null
  rules: { verdicts: Record<string, Verdict>; approver: Approver } | null
  /** An empty list once answered is "no one for now". */
  people: Array<Invite> | null
  plan: Array<PlanStep> | null
}

export const NO_ANSWERS: Answers = {
  company: null,
  start: null,
  rules: null,
  people: null,
  plan: null,
}

export const defaultRules = (): NonNullable<Answers["rules"]> => ({
  verdicts: Object.fromEntries(RULES.map((r) => [r.id, r.verdict])),
  approver: "me",
})

/** The first step still unanswered, or the review once every one is. */
export function nextStep(answers: Answers): StepId {
  for (const step of STEPS) if (step.id !== "review" && answers[step.id] === null) return step.id
  return "review"
}

/** The step's question, with the company's name in it. */
export function askOf(step: Step, answers: Answers) {
  return step.ask.replace("{name}", answers.company?.name.trim() || "the company")
}

const PROOF = "An eval on sample data, run against today's baseline."

/**
 * The plan the workspace proposes from the answers so far: it starts where the FDE said to start,
 * names the contact, and ties the criterion they gave to the steps that agree and prove it. Each
 * step is an ordinary task on one of the eight stages (ADR 0008), so the lifecycle still holds.
 */
export function proposePlan(answers: Answers): Array<PlanStep> {
  const start = answers.start
  const contact = start?.contact.trim() || ""
  const named = start?.criterion.trim() || ""
  const criterion = { name: named || "Each criterion agreed at scope", proof: PROOF }
  const withContact = contact ? { with: `with ${contact}` } : {}
  const scope: Omit<PlanStep, "id"> = {
    title: "Agree scope and success criteria",
    stage: "scope",
    ...withContact,
    ...(named ? { criterion: { name: named, proof: PROOF } } : {}),
  }
  const steps: Array<Omit<PlanStep, "id">> =
    start?.approach === "pilot"
      ? [
          { title: "Request access and sample data", stage: "access" },
          { title: "Build a pilot on sample data", stage: "build" },
          { title: "Evaluate the pilot", stage: "evaluate", criterion },
          { title: "Review the results", stage: "evaluate", ...withContact },
          { title: "Agree what comes next", stage: "handoff" },
        ]
      : start?.approach === "scope"
        ? [
            scope,
            { title: "Request access to the systems", stage: "access" },
            { title: "Build", stage: "build" },
            { title: "Evaluate", stage: "evaluate", criterion },
            { title: "Hand off", stage: "handoff" },
          ]
        : [
            {
              title: "Discovery call",
              stage: "discover",
              ...(contact ? withContact : { with: "with the sponsor" }),
            },
            scope,
            { title: "Request access to the systems", stage: "access" },
            { title: "Build", stage: "build" },
            { title: "Evaluate", stage: "evaluate", criterion },
            { title: "Hand off", stage: "handoff" },
          ]
  return steps.map((step, i) => ({ id: `step_${i + 1}`, ...step }))
}

function brief(answers: Answers): Block | null {
  const c = answers.company
  if (!c) return null
  const where = [c.industry.trim(), c.region.trim()].filter(Boolean).join(" · ")
  const approach = APPROACHES.find((a) => a.id === answers.start?.approach)
  const items = [
    { label: "Name", value: c.name },
    { label: "Sector", value: where },
    { label: "Delivering", value: c.summary },
    { label: "First move", value: approach?.label ?? "" },
    { label: "Main contact", value: answers.start?.contact ?? "" },
  ].filter((item) => item.value.trim())
  return { type: "brief", items }
}

/**
 * What the summary beside the conversation shows, as blocks: the brief, the plan, the rules and
 * the people, each once its step is answered. Checked like any other blocks.
 */
export function summaryBlocks(answers: Answers): Array<Block> {
  const raw: Array<unknown> = [brief(answers)]
  if (answers.plan) raw.push({ type: "plan", steps: answers.plan })
  if (answers.rules)
    raw.push({
      type: "rules",
      rules: RULES.map((r) => ({
        id: r.id,
        action: r.action,
        verdict: r.locked ? r.verdict : (answers.rules?.verdicts[r.id] ?? r.verdict),
        ...(r.locked ? { note: r.locked } : {}),
      })),
      approver: APPROVERS.find((a) => a.id === answers.rules?.approver)?.label ?? "Me",
    })
  if (answers.people) raw.push({ type: "people", people: answers.people })
  return parseBlocks(raw.filter(Boolean))
}

/** What the review checks before the company can be created. */
export function reviewChecklist(answers: Answers): Block | null {
  return (
    parseBlocks([
      {
        type: "checklist",
        items: [
          { label: "Company named", done: Boolean(answers.company?.name.trim()) },
          { label: "What you are delivering", done: Boolean(answers.company?.summary.trim()) },
          { label: "How to start", done: answers.start !== null },
          { label: "Rules for agents", done: answers.rules !== null },
          { label: "A plan with at least one step", done: (answers.plan?.length ?? 0) > 0 },
          {
            label: "People to invite",
            done: (answers.people?.length ?? 0) > 0,
            optional: true,
          },
        ],
      },
    ])[0] ?? null
  )
}

/** Whether the person may confirm: every step but the optional ones answered. */
export function readyToCreate(answers: Answers) {
  return (
    Boolean(answers.company?.name.trim()) &&
    answers.start !== null &&
    answers.rules !== null &&
    (answers.plan?.length ?? 0) > 0
  )
}

/** The person's answer, as one line of text in the conversation. */
export function answerText(id: StepId, answers: Answers): string {
  switch (id) {
    case "company": {
      const c = answers.company
      if (!c) return ""
      return c.summary.trim() ? `${c.name.trim()}. ${c.summary.trim()}` : c.name.trim()
    }
    case "start": {
      const s = answers.start
      if (!s) return ""
      const label = APPROACHES.find((a) => a.id === s.approach)?.label ?? ""
      return [label, s.contact.trim() && `Main contact: ${s.contact.trim()}`]
        .filter(Boolean)
        .join(". ")
    }
    case "rules": {
      const r = answers.rules
      if (!r) return ""
      const asks = RULES.filter((rule) => !rule.locked && r.verdicts[rule.id] === "ask").length
      const approver = APPROVERS.find((a) => a.id === r.approver)?.label ?? "Me"
      return asks === 0
        ? "Agents may go ahead without asking."
        : `Agents ask first for ${asks} ${asks === 1 ? "thing" : "things"}. ${r.approver === "me" ? "You approve" : `${approver} approves`}.`
    }
    case "people": {
      const p = answers.people
      if (!p) return ""
      if (p.length === 0) return "No one for now."
      return p.map((i) => `${i.email} (${ROLE_LABEL[i.role]})`).join(", ")
    }
    case "plan": {
      const plan = answers.plan
      if (!plan || plan.length === 0) return ""
      return `${plan.length} ${plan.length === 1 ? "step" : "steps"}, starting with “${plan[0]!.title}”.`
    }
    case "review":
      return ""
  }
}

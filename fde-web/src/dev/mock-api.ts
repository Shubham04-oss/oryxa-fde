// A stand-in for the FDE API, for `pnpm dev:mock` and the tests only, so every screen can be
// clicked through with no backend. It keeps the API's rules that the screens depend on: a session,
// only the FDE's own companies (anything else is a 404, never a 403 that would leak it exists),
// and the stage machine. src/lib/api/client.ts loads it only in a dev build with
// VITE_FDE_MOCK_API=1; mock-excluded.test.ts proves a production build leaves it out.
//
// Sample data only: every company, person and system here is invented.

import { ApiError } from "../lib/api/client"
import type { Transport } from "../lib/api/client"
import type { ProjectScope, Stage } from "../lib/api/schemas"
import { canMove } from "../lib/stage"
import { localDay } from "../lib/time"

/** What the production-build test looks for. Logged once so it is never tree-shaken away. */
export const MOCK_MARKER = "fde-dev-mock-api"
if (import.meta.env.MODE !== "test") console.info(`[${MOCK_MARKER}] answering from sample data`)

// Kept for the tab, so a reload stays signed in. Delete it to see sign-in again.
const SESSION_KEY = "fde.mock.session"

/** `n` days from today, as `YYYY-MM-DD`. */
function day(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return localDay(d)
}
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()

type Part = "sponsor" | "champion" | "decision_maker" | "security" | "it_owner" | "end_user"
type TaskStatus = "todo" | "in_progress" | "blocked" | "waiting_on_customer" | "done"
type AccessStatus = "requested" | "in_review" | "granted" | "denied"

function task(
  id: string,
  title: string,
  status: TaskStatus,
  due: number | null,
  assignee: string | null,
  extra: { blocker?: string; waitingOn?: string; waitingDays?: number } = {},
) {
  return {
    id,
    title,
    status,
    due: due === null ? null : day(due),
    assignee,
    blocker: extra.blocker ?? null,
    waiting_on: extra.waitingOn ?? null,
    waiting_since: extra.waitingDays === undefined ? null : day(-extra.waitingDays),
  }
}

function access(id: string, system: string, owner: string, status: AccessStatus, daysAgo: number) {
  return { id, system, owner, status, requested_on: day(-daysAgo) }
}

const person = (id: string, name: string, title: string, part: Part) => ({ id, name, title, part })
const system = (id: string, name: string, kind: string, notes: string) => ({
  id,
  name,
  kind,
  notes,
})
const criterion = (
  id: string,
  statement: string,
  target: string,
  status: "not_measured" | "passing" | "failing",
) => ({ id, statement, target, status })
const decision = (id: string, title: string, why: string, by: string, daysAgo: number) => ({
  id,
  title,
  why,
  decided_by: by,
  decided_on: day(-daysAgo),
})

function seed() {
  const projects = [
    {
      id: "prj_kestrel_dispatch",
      company: "cmp_kestrel",
      name: "Dispatch copilot",
      stage: "build" as Stage,
      updated_at: hoursAgo(2),
      summary: "Drafts load plans for dispatchers from open orders, driver hours and depot rules.",
      scope: {
        in_scope: [
          "Draft next-day load plans for the two pilot depots",
          "Explain each assignment in one line a dispatcher can check",
          "Read orders and driver hours from the planning database (read only)",
        ],
        out_of_scope: ["Changing the planning database", "Live re-routing during the day"],
        signed_off: { by: "Mara Lindqvist", on: day(-21) },
      },
      criteria: [
        criterion(
          "crt_k1",
          "Plans dispatchers accept with no changes",
          "At least 70% over two weeks",
          "failing",
        ),
        criterion(
          "crt_k2",
          "Plans that break a driver-hours rule",
          "None in 500 sampled plans",
          "passing",
        ),
        criterion("crt_k3", "Time to a draft plan", "Under 2 minutes per depot", "not_measured"),
      ],
      access: [
        access("acc_k1", "Planning database (read replica)", "Tomas Becker", "granted", 18),
        access("acc_k2", "Depot rules spreadsheet", "Ines Moreau", "in_review", 6),
        access("acc_k3", "Telematics export", "Tomas Becker", "denied", 9),
      ],
      tasks: [
        task("tsk_k1", "Load depot rules into the context pack", "in_progress", 1, "Riya Kapoor"),
        task("tsk_k2", "Replay last month's orders through the planner", "todo", 0, "Riya Kapoor"),
        task("tsk_k3", "Add driver-hours checks to the eval suite", "todo", -2, "Jonah Webb"),
        task("tsk_k4", "Agree the telematics alternative", "blocked", -1, "Riya Kapoor", {
          blocker: "Telematics export refused by the customer's security team",
        }),
        task("tsk_k5", "Dispatcher feedback session", "waiting_on_customer", 3, "Riya Kapoor", {
          waitingOn: "Mara Lindqvist",
          waitingDays: 4,
        }),
        task("tsk_k6", "Set up the sandbox with sample orders", "done", -12, "Jonah Webb"),
      ],
      decisions: [
        decision(
          "dec_k1",
          "Pilot at Leeds and Ghent depots only",
          "They have the cleanest order data and dispatchers who volunteered.",
          "Mara Lindqvist",
          24,
        ),
        decision(
          "dec_k2",
          "Plans are drafts, never sent to drivers directly",
          "Dispatchers stay accountable for every plan.",
          "Riya Kapoor",
          20,
        ),
      ],
    },
    {
      id: "prj_kestrel_claims",
      company: "cmp_kestrel",
      name: "Damage claims triage",
      stage: "discover" as Stage,
      updated_at: hoursAgo(30),
      summary: "Sort incoming damage claims by likely cause and route them to the right team.",
      scope: { in_scope: [], out_of_scope: [], signed_off: null },
      criteria: [],
      access: [],
      tasks: [
        task("tsk_kc1", "Interview the claims team lead", "waiting_on_customer", 2, "Riya Kapoor", {
          waitingOn: "Ines Moreau",
          waitingDays: 2,
        }),
        task("tsk_kc2", "Collect twenty anonymised sample claims", "todo", 5, "Riya Kapoor"),
      ],
      decisions: [],
    },
    {
      id: "prj_bw_referrals",
      company: "cmp_brightwater",
      name: "Referral intake",
      stage: "access" as Stage,
      updated_at: hoursAgo(5),
      summary: "Reads referral letters and fills the intake form for the clinic's coordinators.",
      scope: {
        in_scope: [
          "Extract patient-free fields from synthetic referral letters",
          "Suggest the receiving clinic and urgency",
        ],
        out_of_scope: ["Real patient records until the runner exists", "Clinical advice"],
        signed_off: { by: "Dr Helen Achebe", on: day(-8) },
      },
      criteria: [
        criterion(
          "crt_b1",
          "Fields extracted correctly",
          "95% on the 300-letter synthetic set",
          "not_measured",
        ),
        criterion("crt_b2", "Urgency matches a coordinator", "90% agreement", "not_measured"),
      ],
      access: [
        access("acc_b1", "Synthetic referral set", "Owen Price", "granted", 7),
        access("acc_b2", "Intake form API (staging)", "Owen Price", "requested", 5),
        access("acc_b3", "Clinic directory export", "Sana Qureshi", "in_review", 11),
      ],
      tasks: [
        task("tsk_b1", "Answer the security questionnaire", "in_progress", 0, "Jonah Webb"),
        task("tsk_b2", "Map intake form fields", "todo", -3, "Jonah Webb"),
        task("tsk_b3", "Staging credentials for the intake API", "blocked", 2, "Jonah Webb", {
          blocker: "Waiting for the intake API access request",
        }),
      ],
      decisions: [
        decision(
          "dec_b1",
          "Synthetic letters only in this phase",
          "No patient data leaves the clinic before the runner is in their cloud.",
          "Dr Helen Achebe",
          10,
        ),
      ],
    },
    {
      id: "prj_lumen_forecast",
      company: "cmp_lumen",
      name: "Store demand forecasts",
      stage: "evaluate" as Stage,
      updated_at: hoursAgo(1),
      summary:
        "Daily demand forecasts for fresh produce in forty stores, with reasons a buyer reads.",
      scope: {
        in_scope: ["Fresh produce in forty pilot stores", "A daily forecast with three reasons"],
        out_of_scope: ["Automatic ordering", "Promotions planning"],
        signed_off: { by: "Carlos Mendes", on: day(-40) },
      },
      criteria: [
        criterion("crt_l1", "Forecast error on fresh produce", "MAPE under 18%", "passing"),
        criterion("crt_l2", "Buyers who find the reasons useful", "4 of 5 in review", "failing"),
      ],
      access: [access("acc_l1", "Sales history warehouse", "Priya Raman", "granted", 45)],
      tasks: [
        task("tsk_l1", "Rewrite reasons in buyers' words", "in_progress", 1, "Riya Kapoor"),
        task("tsk_l2", "Buyer review of week 3 forecasts", "waiting_on_customer", -1, null, {
          waitingOn: "Priya Raman",
          waitingDays: 6,
        }),
        task("tsk_l3", "Publish eval results to the customer room", "todo", 0, "Riya Kapoor"),
      ],
      decisions: [
        decision(
          "dec_l1",
          "Measure with MAPE, not RMSE",
          "Buyers compare stores of very different sizes.",
          "Carlos Mendes",
          38,
        ),
      ],
    },
    {
      id: "prj_atlas_fnol",
      company: "cmp_atlas",
      name: "First notice of loss assistant",
      stage: "scope" as Stage,
      updated_at: hoursAgo(50),
      summary: "Helps call handlers capture a claim's first notice in one pass.",
      scope: {
        in_scope: ["Home claims by phone", "A checklist that adapts to the loss type"],
        out_of_scope: ["Motor claims", "Fraud scoring"],
        signed_off: null,
      },
      criteria: [
        criterion("crt_a1", "Calls with every required field", "98%", "not_measured"),
        criterion("crt_a2", "Average handling time", "Down 15% from baseline", "not_measured"),
      ],
      access: [access("acc_a1", "Call recordings (redacted)", "Daniel Osei", "requested", 3)],
      tasks: [
        task("tsk_a1", "Scope sign-off meeting", "waiting_on_customer", 4, "Jonah Webb", {
          waitingOn: "Grace Holm",
          waitingDays: 3,
        }),
        task("tsk_a2", "Draft the loss-type checklist", "in_progress", 6, "Jonah Webb"),
      ],
      decisions: [],
    },
    {
      id: "prj_cobalt_outage",
      company: "cmp_cobalt",
      name: "Outage report summaries",
      stage: "operate" as Stage,
      updated_at: hoursAgo(20),
      summary: "Summarises overnight outage reports for the morning operations call.",
      scope: {
        in_scope: ["Overnight reports from the outage log", "A one-page summary by 7am"],
        out_of_scope: ["Customer notifications"],
        signed_off: { by: "Arjun Nair", on: day(-120) },
      },
      criteria: [
        criterion("crt_c1", "Summaries ready by 7am", "Every weekday", "passing"),
        criterion("crt_c2", "Facts that match the log", "100% on spot checks", "passing"),
      ],
      access: [access("acc_c1", "Outage log (read only)", "Meera Iyer", "granted", 130)],
      tasks: [
        task("tsk_c1", "Monthly accuracy spot check", "todo", 0, "Riya Kapoor"),
        task("tsk_c2", "Handoff notes for the operations team", "done", -30, "Riya Kapoor"),
      ],
      decisions: [
        decision(
          "dec_c1",
          "Operations owns the summary from this month",
          "Handoff complete; FDE keeps a monthly check.",
          "Arjun Nair",
          14,
        ),
      ],
    },
    {
      id: "prj_cobalt_field",
      company: "cmp_cobalt",
      name: "Field crew handbook search",
      stage: "deploy" as Stage,
      updated_at: hoursAgo(8),
      summary: "Lets field crews search safety procedures from a phone, offline-first.",
      scope: {
        in_scope: ["The 2026 safety handbook", "Search on crew phones"],
        out_of_scope: ["Older handbooks", "Writing new procedures"],
        signed_off: { by: "Arjun Nair", on: day(-60) },
      },
      criteria: [
        criterion("crt_f1", "Right procedure in the top three", "92% on 200 questions", "passing"),
      ],
      access: [access("acc_f1", "Mobile device management", "Meera Iyer", "in_review", 9)],
      tasks: [
        task("tsk_f1", "Roll out to the north depot crews", "blocked", -4, "Jonah Webb", {
          blocker: "Mobile device management access still in review",
        }),
        task("tsk_f2", "Crew training video", "in_progress", 7, "Jonah Webb"),
      ],
      decisions: [],
    },
  ]

  const companies = [
    {
      id: "cmp_kestrel",
      name: "Kestrel Freight",
      industry: "Logistics",
      role: "lead",
      region: "EU (Frankfurt)",
      summary: "A regional freight carrier with 14 depots. Wants dispatchers to plan in minutes.",
      stakeholders: [
        person("stk_k1", "Mara Lindqvist", "Head of operations", "sponsor"),
        person("stk_k2", "Ines Moreau", "Dispatch lead, Ghent", "champion"),
        person("stk_k3", "Tomas Becker", "Data platform manager", "it_owner"),
        person("stk_k4", "Lea Novak", "Information security", "security"),
      ],
      systems: [
        system("sys_k1", "Planning database", "PostgreSQL", "Read replica only; nightly refresh."),
        system("sys_k2", "Depot rules", "Spreadsheet", "One sheet per depot, kept by dispatch."),
        system("sys_k3", "Telematics", "Vendor API", "Refused for now; see decisions."),
      ],
    },
    {
      id: "cmp_brightwater",
      name: "Brightwater Clinics",
      industry: "Healthcare",
      role: "engineer",
      region: "UK (London)",
      summary: "A network of outpatient clinics. Referral intake is slow and done by hand.",
      stakeholders: [
        person("stk_b1", "Dr Helen Achebe", "Medical director", "sponsor"),
        person("stk_b2", "Owen Price", "Integration engineer", "it_owner"),
        person("stk_b3", "Sana Qureshi", "Data protection officer", "security"),
      ],
      systems: [
        system("sys_b1", "Intake form", "Internal web app", "Staging API only in this phase."),
        system("sys_b2", "Clinic directory", "Export", "Weekly CSV."),
      ],
    },
    {
      id: "cmp_lumen",
      name: "Lumen Grocers",
      industry: "Retail",
      role: "lead",
      region: "US (Virginia)",
      summary: "A grocery chain of 220 stores. Fresh produce waste is the target.",
      stakeholders: [
        person("stk_l1", "Carlos Mendes", "VP supply chain", "sponsor"),
        person("stk_l2", "Priya Raman", "Fresh produce buyer", "champion"),
        person("stk_l3", "Wen Zhao", "Analytics engineer", "it_owner"),
      ],
      systems: [
        system("sys_l1", "Sales history", "Data warehouse", "Three years, daily, per store."),
        system("sys_l2", "Weather feed", "Vendor API", "Allowed host on the outbound list."),
      ],
    },
    {
      id: "cmp_atlas",
      name: "Atlas Mutual",
      industry: "Insurance",
      role: "engineer",
      region: "US (Ohio)",
      summary: "A mutual insurer. Call handlers miss fields on the first notice of a claim.",
      stakeholders: [
        person("stk_a1", "Grace Holm", "Claims director", "decision_maker"),
        person("stk_a2", "Daniel Osei", "Contact centre manager", "champion"),
      ],
      systems: [system("sys_a1", "Call recordings", "Object storage", "Redacted copies only.")],
    },
    {
      id: "cmp_cobalt",
      name: "Cobalt Grid",
      industry: "Energy",
      role: "lead",
      region: "India (Mumbai)",
      summary: "A power distributor. Two projects: one in operation, one rolling out to crews.",
      stakeholders: [
        person("stk_c1", "Arjun Nair", "Chief operating officer", "sponsor"),
        person("stk_c2", "Meera Iyer", "IT operations lead", "it_owner"),
        person("stk_c3", "Ravi Desai", "Field crew supervisor", "end_user"),
      ],
      systems: [
        system("sys_c1", "Outage log", "Internal database", "Read only."),
        system("sys_c2", "Crew phones", "Mobile device management", "Access in review."),
      ],
    },
  ]

  return {
    me: {
      user: { id: "usr_riya", name: "Riya Kapoor" },
      organisation: { id: "org_northlight", name: "Northlight FDE" },
      role: "admin",
    },
    companies,
    projects,
  }
}

let state = seed()

/** Tests only: fresh sample data, signed in or out. */
export function resetMockApi({ signedIn = true }: { signedIn?: boolean } = {}) {
  state = seed()
  setSession(signedIn)
}

function setSession(on: boolean) {
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, "1")
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Blocked storage: the mock session lasts until the next load.
  }
}

function hasSession() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1"
  } catch {
    return false
  }
}

const LATENCY_MS = import.meta.env.MODE === "test" ? 0 : 150

/** Answers like a network call: later, as a copy, and only with a session. */
async function answer<T>(make: () => T): Promise<T> {
  if (LATENCY_MS) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
  if (!hasSession()) throw new ApiError(401, "unauthenticated")
  return structuredClone(make())
}

const notFound = () => new ApiError(404, "not_found")

function summary(project: (typeof state.projects)[number]) {
  return {
    id: project.id,
    name: project.name,
    stage: project.stage,
    updated_at: project.updated_at,
  }
}

function companySummary(company: (typeof state.companies)[number]) {
  const projects = state.projects.filter((p) => p.company === company.id).map(summary)
  return {
    id: company.id,
    name: company.name,
    industry: company.industry,
    role: company.role,
    projects,
  }
}

function findProject({ company, project }: ProjectScope) {
  // Scoped like the API's store: both ids must match, so a project id from another company is a 404.
  const found = state.projects.find((p) => p.id === project && p.company === company)
  if (!found) throw notFound()
  return found
}

function projectAnswer(project: (typeof state.projects)[number]) {
  const company = state.companies.find((c) => c.id === project.company)!
  return { ...project, company: { id: company.id, name: company.name } }
}

export const mockApi: Transport = {
  me: () => answer(() => state.me),
  async signIn() {
    setSession(true)
  },
  async signOut() {
    setSession(false)
  },
  companies: () => answer(() => ({ companies: state.companies.map(companySummary) })),
  company: (id) =>
    answer(() => {
      const company = state.companies.find((c) => c.id === id)
      if (!company) throw notFound()
      return { ...company, ...companySummary(company) }
    }),
  project: (scope) => answer(() => projectAnswer(findProject(scope))),
  today: () =>
    answer(() => ({
      items: state.projects.flatMap((project) => {
        const company = state.companies.find((c) => c.id === project.company)!
        const where = {
          company: { id: company.id, name: company.name },
          project: { id: project.id, name: project.name },
        }
        return [
          ...project.tasks
            .filter((t) => t.status !== "done")
            .map((t) => ({ kind: "task", task: t, ...where })),
          ...project.access
            .filter((a) => a.status !== "granted")
            .map((a) => ({ kind: "access_request", access: a, ...where })),
        ]
      }),
    })),
  moveStage: (scope, to) =>
    answer(() => {
      const project = findProject(scope)
      if (project.stage === to)
        throw new ApiError(409, "stage_same", "The project is already there.")
      if (!canMove(project.stage, to))
        throw new ApiError(409, "stage_skip", "Stages advance one at a time.")
      project.stage = to
      project.updated_at = new Date().toISOString()
      return projectAnswer(project)
    }),
}

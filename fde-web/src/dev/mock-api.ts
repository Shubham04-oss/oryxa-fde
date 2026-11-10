// A stand-in for the FDE API, for `pnpm dev:mock` and the tests only, so every screen can be
// clicked through with no backend. It answers the spec's routes in the browser, typed from
// fde-api.gen.ts so it follows the spec. It keeps the API's rules the screens depend on: a
// session, only the FDE's own companies (anything else is a 403, as the API answers), and the
// stage machine. src/lib/api/client.ts loads it only in a dev build with VITE_FDE_MOCK_API=1;
// mock-excluded.test.ts proves a production build leaves it out.
//
// Sample data only: every company, person and system here is invented.

import type { z } from "zod"
import type { Transport } from "../lib/api/client"
import type { components } from "../lib/api/fde-api.gen"
import { STAGES } from "../lib/api/schemas"
import type { Me, Stage } from "../lib/api/schemas"
import { canMove } from "../lib/stage"
import { localDay } from "../lib/time"
import { runRoutes, seedRuns } from "./mock-runs"

type S = components["schemas"]

/** What the production-build test looks for. Logged once so it is never tree-shaken away. */
export const MOCK_MARKER = "fde-dev-mock-api"
if (import.meta.env.MODE !== "test") console.info(`[${MOCK_MARKER}] answering from sample data`)

// Kept for the tab, so a reload stays signed in. Delete it to see sign-in again.
const SESSION_KEY = "fde.mock.session"

const RIYA = "usr_riya"
const JONAH = "usr_jonah"

/** `days` (and `hours`) ago, as the API writes an instant. */
const ago = (days: number, hours = 0) =>
  new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString()

/** `n` days from today, as `YYYY-MM-DD`. */
function day(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return localDay(d)
}

const person = (
  id: string,
  name: string,
  title: string | null,
  role: S["StakeholderPart"],
): S["StakeholderOut"] => ({ id, name, title, role, updated_at: ago(30) })

const system = (
  id: string,
  name: string,
  kind: string | null,
  description: string | null,
): S["SystemOut"] => ({ id, name, kind, description, updated_at: ago(30) })

const member = (user: string, role: S["MemberRole"]): S["MemberOut"] => ({
  user,
  role,
  added_at: ago(90),
})

/** A task last changed `daysAgo`; `due` is in days from today, and a wait began `waitingDays` ago. */
function task(
  id: string,
  title: string,
  status: S["TaskState"],
  daysAgo: number,
  extra: {
    due?: number
    assignee?: string
    blocker?: string
    blockedBy?: string
    waitingOn?: string
    waitingDays?: number
  } = {},
): S["TaskOut"] {
  return {
    id,
    title,
    status,
    blocker: extra.blocker ?? null,
    due_on: extra.due === undefined ? null : day(extra.due),
    assignee: extra.assignee ?? null,
    waiting_on: extra.waitingOn ?? null,
    waiting_since: extra.waitingDays === undefined ? null : ago(extra.waitingDays),
    blocked_by: extra.blockedBy ?? null,
    created_at: ago(daysAgo + 10),
    updated_at: ago(daysAgo),
  }
}

/** An access request asked for `asked` days ago and, unless still open, settled `settled` days ago. */
function access(
  id: string,
  description: string,
  systemId: string | null,
  owner: string | null,
  status: S["AccessState"],
  asked: number,
  settled = 0,
): S["AccessRequestOut"] {
  const open = status === "requested" || status === "in_progress"
  return {
    id,
    description,
    system: systemId,
    owner,
    status,
    requested_at: ago(asked),
    status_changed_at: ago(open ? asked : settled),
    granted_at: status === "granted" ? ago(settled) : null,
    days_waiting: open ? asked : asked - settled,
  }
}

const inScope = (id: string, description: string): S["ScopeItemOut"] => ({
  id,
  kind: "in",
  description,
  updated_at: ago(30),
})
const outOfScope = (id: string, description: string): S["ScopeItemOut"] => ({
  id,
  kind: "out",
  description,
  updated_at: ago(30),
})

function criterion(
  id: string,
  description: string,
  metric: string,
  comparator: S["TargetComparator"],
  target: number,
  unit: string | null,
): S["CriterionOut"] {
  return { id, description, metric, comparator, target, unit, updated_at: ago(30) }
}

/** A scope; `signedOff` names who signed it, and whether it changed since (`current: false`). */
function scope(
  items: Array<S["ScopeItemOut"]>,
  criteria: Array<S["CriterionOut"]>,
  signedOff?: { by: string; daysAgo: number; current: boolean },
): S["ScopeOut"] {
  const version = items.length + criteria.length
  return {
    version,
    items,
    criteria,
    signed_off: signedOff?.current ?? false,
    sign_off: signedOff
      ? {
          version: signedOff.current ? version : version - 1,
          stakeholder: signedOff.by,
          recorded_by: RIYA,
          signed_at: ago(signedOff.daysAgo),
        }
      : null,
  }
}

function decision(
  id: string,
  title: string,
  rationale: string,
  decidedBy: string,
  daysAgo: number,
): S["DecisionOut"] {
  return {
    id,
    title,
    rationale,
    decided_by: decidedBy,
    decided_at: ago(daysAgo),
    recorded_by: RIYA,
    created_at: ago(daysAgo),
  }
}

type Records = {
  scope: S["ScopeOut"]
  access: Array<S["AccessRequestOut"]>
  tasks: Array<S["TaskOut"]>
  decisions: Array<S["DecisionOut"]>
}

type CompanySeed = {
  company: S["CompanyOut"]
  members: Array<S["MemberOut"]>
  stakeholders: Array<S["StakeholderOut"]>
  systems: Array<S["SystemOut"]>
}

function company(
  id: string,
  name: string,
  industry: string,
  region: string,
  summary: string,
  days: number,
): S["CompanyOut"] {
  return { id, name, industry, region, summary, created_at: ago(days), updated_at: ago(days) }
}

function project(
  id: string,
  companyId: string,
  name: string,
  stage: Stage,
  hours: number,
  summary: string,
): S["ProjectOut"] {
  return {
    id,
    company: companyId,
    name,
    stage,
    summary,
    created_at: ago(60),
    updated_at: ago(0, hours),
  }
}

const NO_RECORDS: Records = { scope: scope([], []), access: [], tasks: [], decisions: [] }

function seed() {
  const companies: Array<CompanySeed> = [
    {
      company: company(
        "cmp_kestrel",
        "Kestrel Freight",
        "Logistics",
        "EU (Frankfurt)",
        "A regional freight carrier with 14 depots. Wants dispatchers to plan in minutes.",
        80,
      ),
      members: [member(RIYA, "lead"), member(JONAH, "engineer")],
      stakeholders: [
        person("stk_k1", "Mara Lindqvist", "Head of operations", "sponsor"),
        person("stk_k2", "Ines Moreau", "Dispatch lead, Ghent", "champion"),
        person("stk_k3", "Tomas Becker", "Data platform manager", "it"),
        person("stk_k4", "Lea Novak", "Information security", "security"),
      ],
      systems: [
        system("sys_k1", "Planning database", "PostgreSQL", "Read replica only; nightly refresh."),
        system("sys_k2", "Depot rules", "Spreadsheet", "One sheet per depot, kept by dispatch."),
        system("sys_k3", "Telematics", "Vendor API", "Refused for now; see decisions."),
      ],
    },
    {
      company: company(
        "cmp_brightwater",
        "Brightwater Clinics",
        "Healthcare",
        "UK (London)",
        "A network of outpatient clinics. Referral intake is slow and done by hand.",
        50,
      ),
      members: [member(JONAH, "lead"), member(RIYA, "engineer")],
      stakeholders: [
        person("stk_b1", "Dr Helen Achebe", "Medical director", "sponsor"),
        person("stk_b2", "Owen Price", "Integration engineer", "it"),
        person("stk_b3", "Sana Qureshi", null, "security"),
      ],
      systems: [
        system("sys_b1", "Intake form", "Internal web app", "Staging API only in this phase."),
        system("sys_b2", "Clinic directory", "Export", null),
      ],
    },
    {
      company: company(
        "cmp_lumen",
        "Lumen Grocers",
        "Retail",
        "US (Virginia)",
        "A grocery chain of 220 stores. Fresh produce waste is the target.",
        70,
      ),
      members: [member(RIYA, "lead")],
      stakeholders: [
        person("stk_l1", "Carlos Mendes", "VP supply chain", "sponsor"),
        person("stk_l2", "Priya Raman", "Fresh produce buyer", "champion"),
        person("stk_l3", "Wen Zhao", "Analytics engineer", "it"),
      ],
      systems: [
        system("sys_l1", "Sales history", "Data warehouse", "Three years, daily, per store."),
        system("sys_l2", "Weather feed", "Vendor API", "On the outbound allowlist."),
      ],
    },
    {
      company: company(
        "cmp_atlas",
        "Atlas Mutual",
        "Insurance",
        "US (Ohio)",
        "A mutual insurer. Call handlers miss fields on the first notice of a claim.",
        20,
      ),
      members: [member(JONAH, "lead"), member(RIYA, "engineer")],
      stakeholders: [
        person("stk_a1", "Grace Holm", "Claims director", "other"),
        person("stk_a2", "Daniel Osei", "Contact centre manager", "champion"),
      ],
      systems: [system("sys_a1", "Call recordings", "Object storage", "Redacted copies only.")],
    },
    {
      company: company(
        "cmp_cobalt",
        "Cobalt Grid",
        "Energy",
        "India (Mumbai)",
        "A power distributor. Two projects: one in operation, one rolling out to crews.",
        150,
      ),
      // The organisation admin reaches it without being a member.
      members: [member(JONAH, "lead")],
      stakeholders: [
        person("stk_c1", "Arjun Nair", "Chief operating officer", "sponsor"),
        person("stk_c2", "Meera Iyer", "IT operations lead", "it"),
        person("stk_c3", "Ravi Desai", "Field crew supervisor", "user"),
      ],
      systems: [
        system("sys_c1", "Outage log", "Internal database", "Read only."),
        system("sys_c2", "Crew phones", "Mobile device management", null),
      ],
    },
  ]

  const projects: Array<{ project: S["ProjectOut"]; records: Records }> = [
    {
      project: project(
        "prj_kestrel_dispatch",
        "cmp_kestrel",
        "Dispatch copilot",
        "build",
        2,
        "Drafts load plans for dispatchers from open orders, driver hours and depot rules.",
      ),
      records: {
        scope: scope(
          [
            inScope("itm_k1", "Draft next-day load plans for the two pilot depots"),
            inScope("itm_k2", "Explain each assignment in one line a dispatcher can check"),
            inScope("itm_k3", "Read orders and driver hours from the planning database"),
            outOfScope("itm_k4", "Changing the planning database"),
            outOfScope("itm_k5", "Live re-routing during the day"),
          ],
          [
            criterion(
              "crt_k1",
              "Plans dispatchers accept with no changes",
              "plans accepted unchanged",
              "at_least",
              70,
              "%",
            ),
            criterion(
              "crt_k2",
              "Plans that break a driver-hours rule",
              "rule breaks in 500 sampled plans",
              "at_most",
              0,
              null,
            ),
            criterion("crt_k3", "Time to a draft plan", "minutes per depot", "at_most", 2, "min"),
          ],
          { by: "stk_k1", daysAgo: 21, current: true },
        ),
        access: [
          access(
            "acc_k1",
            "Read replica of the planning database",
            "sys_k1",
            "stk_k3",
            "granted",
            18,
            15,
          ),
          access("acc_k2", "Depot rules, read only", "sys_k2", "stk_k2", "in_progress", 6),
          access("acc_k3", "Telematics export", "sys_k3", "stk_k3", "denied", 9, 5),
        ],
        tasks: [
          task("tsk_k1", "Load depot rules into the context pack", "in_progress", 1, {
            due: 1,
            assignee: RIYA,
          }),
          task("tsk_k2", "Replay last month's orders through the planner", "todo", 2, {
            due: 0,
            assignee: RIYA,
          }),
          task("tsk_k3", "Add driver-hours checks to the eval suite", "todo", 3, {
            due: -2,
            assignee: JONAH,
          }),
          task("tsk_k4", "Agree the telematics alternative", "blocked", 3, {
            due: -1,
            assignee: RIYA,
            blocker: "Telematics export refused by the customer's security team",
          }),
          task("tsk_k5", "Dispatcher feedback session", "waiting_on_customer", 4, {
            due: 3,
            assignee: RIYA,
            waitingOn: "stk_k1",
            waitingDays: 4,
          }),
          task("tsk_k6", "Set up the sandbox with sample orders", "done", 12, {
            due: -12,
            assignee: JONAH,
          }),
          task("tsk_k7", "Sign the data processing terms with the customer", "done", 20, {
            assignee: RIYA,
          }),
          task("tsk_k8", "Pick the two pilot depots", "done", 16, { assignee: JONAH }),
          task("tsk_k9", "Write the first depot rules summary", "done", 9, { assignee: RIYA }),
          task("tsk_k10", "Run the first planner replay on sample orders", "done", 6, {
            assignee: JONAH,
          }),
          task("tsk_k11", "Share the pilot plan with the dispatchers", "done", 3, {
            assignee: RIYA,
          }),
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
    },
    {
      project: project(
        "prj_kestrel_claims",
        "cmp_kestrel",
        "Damage claims triage",
        "discover",
        30,
        "Sort incoming damage claims by likely cause and route them to the right team.",
      ),
      records: {
        ...NO_RECORDS,
        tasks: [
          task("tsk_kc1", "Interview the claims team lead", "waiting_on_customer", 1, {
            due: 2,
            assignee: RIYA,
            waitingOn: "stk_k2",
            waitingDays: 1,
          }),
          task("tsk_kc2", "Collect twenty anonymised sample claims", "todo", 1, {
            due: 5,
            assignee: RIYA,
          }),
        ],
      },
    },
    {
      project: project(
        "prj_bw_referrals",
        "cmp_brightwater",
        "Referral intake",
        "access",
        5,
        "Reads referral letters and fills the intake form for the clinic's coordinators.",
      ),
      records: {
        scope: scope(
          [
            inScope("itm_b1", "Extract patient-free fields from synthetic referral letters"),
            inScope("itm_b2", "Suggest the receiving clinic and urgency"),
            outOfScope("itm_b3", "Real patient records until the runner exists"),
            outOfScope("itm_b4", "Clinical advice"),
          ],
          [
            criterion(
              "crt_b1",
              "Fields extracted correctly",
              "fields correct on the 300-letter synthetic set",
              "at_least",
              95,
              "%",
            ),
            criterion(
              "crt_b2",
              "Urgency matches a coordinator",
              "agreement with coordinators",
              "at_least",
              90,
              "%",
            ),
          ],
          // Changed since the sponsor signed it, so it needs signing again.
          { by: "stk_b1", daysAgo: 8, current: false },
        ),
        access: [
          access("acc_b1", "Synthetic referral letters", null, "stk_b2", "granted", 7, 6),
          access("acc_b2", "Intake form API, staging", "sys_b1", "stk_b2", "requested", 5),
          access("acc_b3", "Clinic directory export", "sys_b2", "stk_b3", "in_progress", 11),
        ],
        tasks: [
          task("tsk_b1", "Answer the security questionnaire", "in_progress", 1, {
            due: 0,
            assignee: JONAH,
          }),
          task("tsk_b2", "Map intake form fields", "todo", 2, { due: -3, assignee: JONAH }),
          task("tsk_b3", "Staging credentials for the intake API", "blocked", 1, {
            due: 2,
            assignee: JONAH,
            blocker: "Waiting for the intake API access request",
            blockedBy: "acc_b2",
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
    },
    {
      project: project(
        "prj_lumen_forecast",
        "cmp_lumen",
        "Store demand forecasts",
        "evaluate",
        1,
        "Daily demand forecasts for fresh produce in forty stores, with reasons a buyer reads.",
      ),
      records: {
        scope: scope(
          [
            inScope("itm_l1", "Fresh produce in forty pilot stores"),
            inScope("itm_l2", "A daily forecast with three reasons a buyer reads"),
            outOfScope("itm_l3", "Automatic ordering"),
            outOfScope("itm_l4", "Promotions planning"),
          ],
          [
            criterion("crt_l1", "Forecast error on fresh produce", "MAPE", "at_most", 18, "%"),
            criterion(
              "crt_l2",
              "Buyers who find the reasons useful",
              "buyers out of five in review",
              "at_least",
              4,
              null,
            ),
          ],
          { by: "stk_l1", daysAgo: 40, current: true },
        ),
        access: [
          access(
            "acc_l1",
            "Sales history warehouse, read only",
            "sys_l1",
            "stk_l3",
            "granted",
            45,
            41,
          ),
        ],
        tasks: [
          task("tsk_l1", "Rewrite reasons in buyers' words", "in_progress", 1, {
            due: 1,
            assignee: RIYA,
          }),
          task("tsk_l2", "Buyer review of week 3 forecasts", "waiting_on_customer", 7, {
            due: -1,
            waitingOn: "stk_l2",
            waitingDays: 7,
          }),
          task("tsk_l3", "Publish eval results to the customer room", "todo", 2, {
            due: 0,
            assignee: RIYA,
          }),
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
    },
    {
      project: project(
        "prj_atlas_fnol",
        "cmp_atlas",
        "First notice of loss assistant",
        "scope",
        50,
        "Helps call handlers capture a claim's first notice in one pass.",
      ),
      records: {
        scope: scope(
          [
            inScope("itm_a1", "Home claims by phone"),
            inScope("itm_a2", "A checklist that adapts to the loss type"),
            outOfScope("itm_a3", "Motor claims"),
            outOfScope("itm_a4", "Fraud scoring"),
          ],
          [
            criterion(
              "crt_a1",
              "Calls with every required field",
              "calls with every required field",
              "at_least",
              98,
              "%",
            ),
            criterion(
              "crt_a2",
              "Average handling time",
              "change from the baseline",
              "at_most",
              -15,
              "%",
            ),
          ],
        ),
        access: [access("acc_a1", "Redacted call recordings", "sys_a1", "stk_a2", "requested", 3)],
        tasks: [
          task("tsk_a1", "Scope sign-off meeting", "waiting_on_customer", 2, {
            due: 4,
            assignee: JONAH,
            waitingOn: "stk_a1",
            waitingDays: 2,
          }),
          task("tsk_a2", "Draft the loss-type checklist", "in_progress", 2, {
            due: 6,
            assignee: JONAH,
          }),
        ],
        decisions: [],
      },
    },
    {
      project: project(
        "prj_cobalt_outage",
        "cmp_cobalt",
        "Outage report summaries",
        "operate",
        20,
        "Summarises overnight outage reports for the morning operations call.",
      ),
      records: {
        scope: scope(
          [
            inScope("itm_c1", "Overnight reports from the outage log"),
            inScope("itm_c2", "A one-page summary by 7am"),
            outOfScope("itm_c3", "Customer notifications"),
          ],
          [
            criterion(
              "crt_c1",
              "Summaries ready by 7am",
              "weekdays with the summary on time",
              "at_least",
              100,
              "%",
            ),
            criterion(
              "crt_c2",
              "Facts that match the log",
              "spot checks that match the log",
              "at_least",
              100,
              "%",
            ),
          ],
          { by: "stk_c1", daysAgo: 120, current: true },
        ),
        access: [
          access("acc_c1", "Outage log, read only", "sys_c1", "stk_c2", "granted", 130, 125),
        ],
        tasks: [
          task("tsk_c1", "Monthly accuracy spot check", "todo", 3, { due: 0, assignee: JONAH }),
          task("tsk_c2", "Handoff notes for the operations team", "done", 30, {
            due: -30,
            assignee: RIYA,
          }),
        ],
        decisions: [
          decision(
            "dec_c1",
            "Operations owns the summary from this month",
            "Handoff complete; the FDE keeps a monthly check.",
            "Arjun Nair",
            14,
          ),
        ],
      },
    },
    {
      project: project(
        "prj_cobalt_field",
        "cmp_cobalt",
        "Field crew handbook search",
        "deploy",
        8,
        "Lets field crews search safety procedures from a phone, offline-first.",
      ),
      records: {
        scope: scope(
          [
            inScope("itm_f1", "The 2026 safety handbook"),
            inScope("itm_f2", "Search on crew phones"),
            outOfScope("itm_f3", "Older handbooks"),
            outOfScope("itm_f4", "Writing new procedures"),
          ],
          [
            criterion(
              "crt_f1",
              "Right procedure in the top three",
              "questions answered in the top three",
              "at_least",
              92,
              "%",
            ),
          ],
          { by: "stk_c1", daysAgo: 60, current: true },
        ),
        access: [
          access(
            "acc_f1",
            "Mobile device management enrolment",
            "sys_c2",
            "stk_c2",
            "in_progress",
            9,
          ),
          access("acc_f2", "Crew roster export", null, "stk_c3", "revoked", 30, 2),
        ],
        tasks: [
          task("tsk_f1", "Roll out to the north depot crews", "blocked", 4, {
            due: -4,
            assignee: JONAH,
            blocker: "Mobile device management access still in progress",
          }),
          task("tsk_f2", "Crew training video", "in_progress", 1, { due: 7, assignee: JONAH }),
        ],
        decisions: [],
      },
    },
  ]

  const me: z.input<typeof Me> = {
    user: { id: RIYA, name: "Riya Kapoor" },
    organisation: { id: "org_northlight", name: "Northlight FDE" },
    role: "admin",
  }
  return { me, companies, projects, runs: seedRuns() }
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

/** An answer as the API writes it: JSON, and a copy, so callers never share mock state. */
const json = (body: unknown, status = 200) => Response.json(structuredClone(body), { status })
const refuse = (status: number, error: string) => Response.json({ error }, { status })

const projectsOf = (companyId: string) =>
  state.projects.filter((p) => p.project.company === companyId)

/** The caller's role at a company: a member's, or `admin` for an organisation admin who is not one. */
function roleAt(c: CompanySeed): S["CallerRole"] | null {
  const own = c.members.find((m) => m.user === state.me.user.id)?.role
  return own ?? (state.me.role === "admin" ? "admin" : null)
}

/** `GET /v1/companies`: each company with the caller's role and its project summaries. */
function companyList(): Array<S["CompanySummaryOut"]> {
  return state.companies.map((c) => ({
    ...c.company,
    role: roleAt(c),
    projects: projectsOf(c.company.id).map(({ project: p }) => ({
      id: p.id,
      name: p.name,
      stage: p.stage,
    })),
  }))
}

/** `GET /v1/today`: tasks not done and access not granted, with names to show them by. */
function today(): S["TodayOut"] {
  const items = state.companies.flatMap((c) =>
    projectsOf(c.company.id).flatMap(({ project: p, records }) => {
      const where = {
        company: { id: c.company.id, name: c.company.name },
        project: { id: p.id, name: p.name },
      }
      const name = (id: string | null | undefined) =>
        c.stakeholders.find((s) => s.id === id)?.name ?? null
      return [
        ...records.tasks
          .filter((t) => t.status !== "done")
          .map((t): S["TodayItemOut"] => ({ kind: "task", task: t, ...where })),
        ...records.access
          .filter((a) => a.status !== "granted")
          .map((a): S["TodayItemOut"] => ({
            kind: "access_request",
            access: a,
            owner: name(a.owner),
            ...where,
          })),
      ]
    }),
  )
  return { items }
}

const TASK_STATES = ["todo", "in_progress", "waiting_on_customer", "blocked", "done"] as const
let taskCount = 0

// A plain string of 1 to `max` characters, as the API's `Name` and `Text` types take it.
const plain = (value: unknown, max: number, lines: boolean) =>
  typeof value === "string" &&
  [...value.trim()].length >= 1 &&
  [...value.trim()].length <= max &&
  // eslint-disable-next-line no-control-regex
  !(lines ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value.trim())

/** `POST`, `PUT` and `DELETE` on a project's tasks, with the checks the API makes on a task. */
async function taskRoutes(
  method: string,
  taskId: string | undefined,
  found: CompanySeed,
  records: Records,
  request: Request,
) {
  const tasks = records.tasks
  const at = taskId === undefined ? -1 : tasks.findIndex((t) => t.id === taskId)
  if (method === "DELETE" && taskId !== undefined) {
    if (at < 0) return refuse(404, "not_found")
    tasks.splice(at, 1)
    return new Response(null, { status: 204 })
  }
  const adding = method === "POST" && taskId === undefined
  if (!adding && !(method === "PUT" && taskId !== undefined)) return null
  const body = (await request.json().catch(() => null)) as Partial<S["TaskBody"]> | null
  if (!body) return refuse(400, "invalid")
  const status = TASK_STATES.find((one) => one === body.status)
  if (!plain(body.title, 200, false)) return refuse(400, "invalid_title")
  if (!status) return refuse(400, "invalid_status")
  const blocker = body.blocker ?? null
  if (blocker !== null && !plain(blocker, 4000, true)) return refuse(400, "invalid_blocker")
  const due = body.due_on ?? null
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return refuse(400, "invalid_due_on")
  const assignee = body.assignee ?? null
  if (assignee !== null && !found.members.some((m) => m.user === assignee))
    return refuse(400, "invalid_assignee")
  const waitingOn = body.waiting_on ?? null
  if (waitingOn !== null && !found.stakeholders.some((x) => x.id === waitingOn))
    return refuse(400, "invalid_waiting_on")
  const blockedBy = body.blocked_by ?? null
  if (status === "blocked" && blocker === null) return refuse(409, "rejected_blocker_required")
  if (blockedBy !== null && status !== "blocked")
    return refuse(409, "rejected_blocked_by_needs_blocked")
  // The API takes only an access request of this project; one that is missing or another's is a 400.
  if (blockedBy !== null && !records.access.some((a) => a.id === blockedBy))
    return refuse(400, "invalid_blocked_by")
  if (!adding && at < 0) return refuse(404, "not_found")

  const now = new Date().toISOString()
  const before = adding ? undefined : tasks[at]
  const saved: S["TaskOut"] = {
    id: before?.id ?? `tsk_new${++taskCount}`,
    title: body.title!.trim(),
    status,
    blocker: blocker?.trim() ?? null,
    due_on: due,
    assignee,
    waiting_on: waitingOn,
    // The API keeps the first time a task started waiting.
    waiting_since: status === "waiting_on_customer" ? (before?.waiting_since ?? now) : null,
    blocked_by: blockedBy,
    created_at: before?.created_at ?? now,
    updated_at: now,
  }
  if (before) tasks[at] = saved
  else tasks.push(saved)
  return json(saved, adding ? 201 : 200)
}

const ACCESS_STATES = ["requested", "in_progress", "granted", "denied", "revoked"] as const

/** `PUT` on an access request: the API replaces it, stamps a status change and sets or clears `granted_at`. */
async function accessRoutes(
  method: string,
  id: string | undefined,
  found: CompanySeed,
  records: Records,
  request: Request,
) {
  if (method !== "PUT" || id === undefined) return null
  const body = (await request.json().catch(() => null)) as Partial<S["AccessRequestBody"]> | null
  if (!body) return refuse(400, "invalid")
  const status = ACCESS_STATES.find((one) => one === body.status)
  if (!status) return refuse(400, "invalid_status")
  if (!plain(body.description, 4000, true)) return refuse(400, "invalid_description")
  const owner = body.owner ?? null
  if (owner !== null && !found.stakeholders.some((x) => x.id === owner))
    return refuse(400, "invalid_owner")
  const systemId = body.system ?? null
  if (systemId !== null && !found.systems.some((x) => x.id === systemId))
    return refuse(400, "invalid_system")
  const at = records.access.findIndex((a) => a.id === id)
  const before = records.access[at]
  if (!before) return refuse(404, "not_found")

  const now = new Date().toISOString()
  const changed = before.status !== status
  const open = status === "requested" || status === "in_progress"
  const changedAt = changed ? now : before.status_changed_at
  const grantedAt = !changed
    ? before.granted_at
    : status === "granted"
      ? now
      : open
        ? null
        : before.granted_at
  const saved: S["AccessRequestOut"] = {
    id,
    description: body.description!.trim(),
    system: systemId,
    owner,
    status,
    requested_at: before.requested_at,
    status_changed_at: changedAt,
    granted_at: grantedAt,
    days_waiting: Math.floor(
      (Date.parse(open ? now : (grantedAt ?? changedAt)) - Date.parse(before.requested_at)) /
        86_400_000,
    ),
  }
  records.access[at] = saved
  // The API's rules put the tasks blocked on a request that is granted back to do, a moment later.
  if (changed && status === "granted")
    records.tasks.forEach((t, i) => {
      if (t.blocked_by !== id) return
      records.tasks[i] = { ...t, status: "todo", blocker: null, blocked_by: null, updated_at: now }
    })
  return json(saved)
}

/** Answers a request to `/api/v1/companies/...`, given the path's parts after `companies`. */
async function companyRoutes(method: string, parts: Array<string>, request: Request) {
  const [companyId, collection, projectId, record, ...rest] = parts
  if (companyId === undefined) return method === "GET" ? json(companyList()) : null
  // The API checks permission before it looks: anything not the FDE's is a 403.
  const found = state.companies.find((c) => c.company.id === companyId)
  if (!found) return refuse(403, "forbidden")
  if (method === "GET" && collection === undefined) return json(found.company)
  if (method === "GET" && projectId === undefined) {
    if (collection === "members") return json(found.members)
    if (collection === "stakeholders") return json(found.stakeholders)
    if (collection === "systems") return json(found.systems)
    if (collection === "projects") return json(projectsOf(companyId).map((p) => p.project))
    return null
  }
  if (collection !== "projects" || projectId === undefined) return null
  const p = projectsOf(companyId).find((x) => x.project.id === projectId)
  if (!p) return refuse(403, "forbidden")
  if (record === "agent-runs")
    return runRoutes((state.runs[projectId] ??= []), method, rest, request, state.me.user.id)
  if (method === "GET") {
    if (record === undefined) return json(p.project)
    if (record === "scope") return json(p.records.scope)
    if (record === "access-requests") return json(p.records.access)
    if (record === "tasks") return json(p.records.tasks)
    if (record === "decisions") return json(p.records.decisions)
    // The company's lists, read through the project, as assignees do.
    if (record === "stakeholders") return json(found.stakeholders)
    if (record === "systems") return json(found.systems)
    return null
  }
  if (record === "tasks") return taskRoutes(method, rest[0], found, p.records, request)
  if (record === "access-requests") return accessRoutes(method, rest[0], found, p.records, request)
  if (method === "PUT" && record === "stage") {
    const body = (await request.json().catch(() => null)) as Partial<S["StageBody"]> | null
    const to = STAGES.find((stage) => stage === body?.stage)
    if (!to) return refuse(400, "invalid_stage")
    if (!canMove(p.project.stage, to)) return refuse(409, "rejected_stage_transition")
    p.project.stage = to
    p.project.updated_at = new Date().toISOString()
    return json(p.project)
  }
  return null
}

async function answer(request: Request): Promise<Response> {
  if (LATENCY_MS) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
  const { pathname } = new URL(request.url)
  const { method } = request
  if (pathname === "/auth/logout" && method === "POST") {
    setSession(false)
    return new Response(null, { status: 204 })
  }
  if (!pathname.startsWith("/api/v1/")) return refuse(404, "not_found")
  if (!hasSession()) return refuse(401, "unauthorized")
  // Dev and test only, like everything here: `globalThis.__fdeMockFailWrites = true` makes every write
  // answer 503, so the failed-save states can be seen and tested. A production build has no mock.
  if (method !== "GET" && (globalThis as Record<string, unknown>).__fdeMockFailWrites === true)
    return refuse(503, "unavailable")
  const [root, ...parts] = pathname.slice("/api/v1/".length).split("/")
  if (method === "GET" && parts.length === 0 && root === "me") return json(state.me)
  if (method === "GET" && parts.length === 0 && root === "today") return json(today())
  const answered = root === "companies" ? await companyRoutes(method, parts, request) : null
  return answered ?? refuse(404, "not_found")
}

export const mockApi: Transport = {
  fetch: answer,
  async signIn() {
    setSession(true)
  },
}

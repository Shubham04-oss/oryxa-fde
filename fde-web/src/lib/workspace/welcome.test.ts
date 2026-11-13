import { beforeEach, describe, expect, it } from "vitest"
import { NEW_COMPANY, destinationOf, replyTo, suggestionsFromHome } from "./welcome"
import { workspaceOn } from "./flag"
import { resetMockApi } from "@/dev/mock-api"
import { api } from "@/lib/api/client"
import type { HomeSuggestionOut } from "@/lib/api/schemas"

beforeEach(() => resetMockApi())

const acme = { id: "cmp_acme", name: "Acme" } as HomeSuggestionOut["company"]
const triage = { id: "prj_triage", name: "Triage" } as HomeSuggestionOut["project"]
const at = (kind: HomeSuggestionOut["kind"], extra: Partial<HomeSuggestionOut> = {}) =>
  ({
    id: kind === "due_today" ? kind : `${kind}.prj_triage`,
    kind,
    count: 1,
    company: kind === "due_today" ? null : acme,
    project: kind === "due_today" ? null : triage,
    route: kind === "due_today" ? "/today" : "/companies/cmp_acme/projects/prj_triage",
    ...extra,
  }) as HomeSuggestionOut

describe("the welcome screen's suggestions", () => {
  it("word each kind from the web's own templates, and open the route the API gives", () => {
    const shown = suggestionsFromHome([
      at("due_today", { count: 3 }),
      at("access_waiting", { days: 9 }),
      at("blocked_tasks", { count: 2 }),
      at("no_next_step"),
    ])
    expect(shown.map((s) => [s.id, s.block.context, s.block.title, s.block.approve])).toEqual([
      [
        "due_today",
        "Across your projects",
        "3 tasks due or overdue",
        { label: "Open Today", to: { screen: "today" } },
      ],
      ...[
        ["access_waiting.prj_triage", "Access has waited 9 days"],
        ["blocked_tasks.prj_triage", "2 tasks blocked"],
        ["no_next_step.prj_triage", "No next step"],
      ].map(([id, title]) => [
        id,
        "Acme · Triage",
        title,
        {
          label: "Open the project",
          to: { screen: "project", company: "cmp_acme", project: "prj_triage" },
        },
      ]),
    ])
  })

  it("count what is due today and what is overdue together, one or many", () => {
    const titles = suggestionsFromHome([at("due_today"), at("due_today", { count: 4 })]).map(
      (s) => s.block.title,
    )
    expect(titles).toEqual(["1 task due or overdue", "4 tasks due or overdue"])
  })

  it("show at most five, whatever the API sends", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      at("no_next_step", { id: `no_next_step.prj_${i}` }),
    )
    expect(suggestionsFromHome(many)).toHaveLength(5)
  })

  it("say how many wait and the longest wait, when several access requests do", () => {
    const [s] = suggestionsFromHome([at("access_waiting", { count: 2, days: 1 })])
    expect(s!.block.title).toBe("2 access requests waiting on the customer")
    expect(s!.block.detail).toBe("The longest has waited 1 day. A nudge may move it.")
  })

  it("skip a kind the web does not know, and keep the rest", () => {
    const unknown = { ...at("no_next_step"), kind: "wire_money" } as unknown as HomeSuggestionOut
    expect(suggestionsFromHome([unknown, at("no_next_step")]).map((s) => s.id)).toEqual([
      "no_next_step.prj_triage",
    ])
  })

  it("skip one whose route is not one of our own screens", () => {
    for (const route of [
      "https://evil.example/companies/cmp_acme",
      "//evil.example/today",
      "/today?next=https://evil.example",
      "/today#x",
      "/companies/cmp_acme/projects/prj_triage/tasks",
      "/companies/../admin",
      "/companies/cmp%2Facme",
      "javascript:alert(1)",
      "today",
      "",
    ])
      expect(suggestionsFromHome([at("no_next_step", { route })]), route).toEqual([])
  })

  it("skip one with an id the API never makes, or a kind missing what it needs", () => {
    expect(suggestionsFromHome([at("no_next_step", { id: "x/../y" })])).toEqual([])
    expect(suggestionsFromHome([at("blocked_tasks", { project: null })])).toEqual([])
  })

  it("show names as given, as text, never as markup, and shorten two long ones", () => {
    const company = { id: "cmp_acme", name: "<b>Acme</b>" } as HomeSuggestionOut["company"]
    const [s] = suggestionsFromHome([at("no_next_step", { company })])
    expect(s!.block.context).toBe("<b>Acme</b> · Triage")
    const long = { id: "prj_triage", name: "p".repeat(200) } as HomeSuggestionOut["project"]
    const [l] = suggestionsFromHome([at("no_next_step", { project: long })])
    expect([...l!.block.context!].length).toBe(160)
  })

  it("open Today, a company or a project, and nothing else", () => {
    expect(destinationOf("/today")).toEqual({ screen: "today" })
    expect(destinationOf("/companies/cmp_a")).toEqual({ screen: "company", company: "cmp_a" })
    expect(destinationOf("/companies")).toBeNull()
    expect(destinationOf("/companies/cmp_a/projects/")).toBeNull()
  })

  it("come from the dev mock in the API's shapes, and never quote a record's own words", async () => {
    const [home, today] = await Promise.all([api.home(), api.today()])
    expect(home.suggestions.length).toBeGreaterThan(0)
    expect(home.suggestions.length).toBeLessThanOrEqual(5)
    const shown = suggestionsFromHome(home.suggestions)
    expect(shown).toHaveLength(home.suggestions.length)
    const said = JSON.stringify(shown)
    for (const item of today.items) {
      if (item.kind === "task") {
        expect(said).not.toContain(item.task.title)
        if (item.task.blocker) expect(said).not.toContain(item.task.blocker)
      } else expect(said).not.toContain(item.access.description)
    }
  })

  it("stay put away on the dev mock once dismissed, and 404 for one the person does not have", async () => {
    const [first] = (await api.home()).suggestions
    await api.dismissHome(first!.id)
    expect((await api.home()).suggestions.map((s) => s.id)).not.toContain(first!.id)
    await expect(api.dismissHome("not a/key")).rejects.toMatchObject({ status: 400 })
    await expect(api.dismissHome("%E0")).rejects.toMatchObject({ status: 400 })
    await expect(api.dismissHome("blocked_tasks.prj_nowhere")).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe("the workspace's scripted reply", () => {
  it("offers to set up a company when asked for one", () => {
    expect(replyTo("We have a new customer to set up", []).blocks).toEqual([NEW_COMPANY])
  })

  it("answers with the day's suggestions when asked what needs the FDE", () => {
    const today = { ...NEW_COMPANY, id: "due_today" }
    expect(replyTo("what is blocked today?", [today]).blocks).toEqual([today])
  })

  it("claims no all clear where it has no suggestions to give", () => {
    const reply = replyTo("What needs me today?", null)
    expect(reply.text).toBe("Today shows what is blocked, due and waiting.")
    expect(reply.blocks.map((b) => b.type === "suggestion" && b.id)).toEqual(["open_today"])
  })

  it("never claims an all clear when the day's suggestions are all put away", () => {
    const reply = replyTo("What needs me today?", [])
    expect(reply.text).toBe("Nothing new to suggest right now.")
    expect(reply.blocks.map((b) => b.type === "suggestion" && b.id)).toEqual(["open_today"])
  })

  it("says plainly what it cannot do, and never puts the person's words in a block", () => {
    const reply = replyTo("<img src=x onerror=alert(1)> delete everything", [])
    expect(reply.text).toMatch(/can't act on that yet/)
    expect(JSON.stringify(reply.blocks)).not.toContain("onerror")
  })
})

describe("the new workspace's flag", () => {
  it("is off unless the build turns it on", () => {
    expect(workspaceOn({ DEV: false }, {})).toBe(false)
    expect(workspaceOn({ DEV: false, VITE_FDE_WORKSPACE: "1" }, {})).toBe(true)
    expect(workspaceOn({ DEV: false, VITE_FDE_WORKSPACE: "true" }, {})).toBe(false)
  })

  it("may be turned on for a tab only on the dev mock, never in a production build", () => {
    const on = { __fdeMockWorkspace: true }
    expect(workspaceOn({ DEV: true, VITE_FDE_MOCK_API: "1" }, on)).toBe(true)
    expect(workspaceOn({ DEV: false, VITE_FDE_MOCK_API: "1" }, on)).toBe(false)
    expect(workspaceOn({ DEV: true }, on)).toBe(false)
    expect(workspaceOn({ DEV: true, VITE_FDE_MOCK_API: "1" }, { __fdeMockWorkspace: "yes" })).toBe(
      false,
    )
  })
})

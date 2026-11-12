import { beforeEach, describe, expect, it } from "vitest"
import { NEW_COMPANY, replyTo, suggestionsFrom } from "./welcome"
import { workspaceOn } from "./flag"
import { resetMockApi } from "@/dev/mock-api"
import { api } from "@/lib/api/client"
import { localDay } from "@/lib/time"

beforeEach(() => resetMockApi())

describe("the welcome screen's suggestions", () => {
  it("are at most three, each approved by going to one of our own screens", async () => {
    const [today, list] = await Promise.all([api.today(), api.companies()])
    const shown = suggestionsFrom(today.items, list.companies, localDay())
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThanOrEqual(3)
    for (const s of shown) expect(["today", "company", "project"]).toContain(s.approve.to.screen)
  })

  it("never quote a record's own words, only names and counts (ADR 0008)", async () => {
    const [today, list] = await Promise.all([api.today(), api.companies()])
    const said = JSON.stringify(suggestionsFrom(today.items, list.companies, localDay()))
    for (const item of today.items) {
      if (item.kind === "task") {
        expect(said).not.toContain(item.task.title)
        if (item.task.blocker) expect(said).not.toContain(item.task.blocker)
      } else {
        expect(said).not.toContain(item.access.description)
        if (item.owner) expect(said).not.toContain(item.owner)
      }
    }
  })

  it("offer a first project for a company with none, when little else needs the FDE", async () => {
    const list = await api.companies()
    const bare = { ...list.companies[0]!, projects: [] }
    expect(suggestionsFrom([], [bare], localDay())).toMatchObject([
      {
        title: "Start the first project",
        approve: { to: { screen: "company", company: bare.id } },
      },
    ])
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

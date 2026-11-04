import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { AppShell } from "./app-shell"
import { matchTargets, switchTargets } from "./quick-switch"
import type { Me } from "@/lib/api/schemas"
import { Me as MeSchema } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"

const me: Me = MeSchema.parse({
  user: { id: "usr_riya", name: "Riya Kapoor" },
  organisation: { id: "org_northlight", name: "Northlight FDE" },
  role: "admin",
})

function renderShell() {
  return renderWithRouter(
    <AppShell me={me}>
      <p>Canvas</p>
    </AppShell>,
  )
}

const options = () => screen.getAllByRole("option").map((option) => option.textContent)

describe("Jump to", () => {
  it("opens from the keyboard with Ctrl K, with the search field focused", async () => {
    renderShell()
    await screen.findByText("Canvas")

    await userEvent.keyboard("{Control>}k{/Control}")

    const search = await screen.findByRole("combobox", { name: "Jump to a company or project" })
    await waitFor(() => expect(search).toHaveFocus())
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(12))
  })

  it("also opens with ⌘ K", async () => {
    renderShell()
    await screen.findByText("Canvas")

    await userEvent.keyboard("{Meta>}k{/Meta}")

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("filters as you type, moves with the arrows and opens the choice with Enter", async () => {
    const { router } = renderShell()
    await screen.findByText("Canvas")
    await userEvent.keyboard("{Control>}k{/Control}")
    const search = await screen.findByRole("combobox")
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0))

    await userEvent.type(search, "lumen")
    expect(options()).toEqual([
      "Lumen Grocers1 project",
      "Store demand forecastsLumen Grocers · Evaluate",
    ])
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true")

    await userEvent.keyboard("{ArrowDown}")
    const second = screen.getAllByRole("option")[1]!
    expect(second).toHaveAttribute("aria-selected", "true")
    expect(search).toHaveAttribute("aria-activedescendant", second.id)
    await userEvent.keyboard("{Enter}")

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/companies/cmp_lumen/projects/prj_lumen_forecast",
      ),
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("wraps around with the arrows", async () => {
    const { router } = renderShell()
    await screen.findByText("Canvas")
    await userEvent.keyboard("{Control>}k{/Control}")
    await userEvent.type(await screen.findByRole("combobox"), "kestrel")
    await waitFor(() => expect(options()).toHaveLength(3))

    await userEvent.keyboard("{ArrowUp}{Enter}")

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/companies/cmp_kestrel/projects/prj_kestrel_claims",
      ),
    )
  })

  it("opens a company, and says when nothing matches", async () => {
    const { router } = renderShell()
    await screen.findByText("Canvas")
    await userEvent.keyboard("{Control>}k{/Control}")
    const search = await screen.findByRole("combobox")

    await userEvent.type(search, "zzz")
    expect(await screen.findByText("Nothing matches “zzz”.")).toBeInTheDocument()
    await userEvent.keyboard("{Enter}")
    expect(router.state.location.pathname).toBe("/")

    await userEvent.clear(search)
    await userEvent.type(search, "cobalt grid{Enter}")
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/cmp_cobalt"))
  })

  it("closes with Escape and goes nowhere", async () => {
    const { router } = renderShell()
    await screen.findByText("Canvas")
    await userEvent.keyboard("{Control>}k{/Control}")
    await screen.findByRole("combobox")

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(router.state.location.pathname).toBe("/")
  })

  it("opens from the sidebar too", async () => {
    renderShell()

    await userEvent.click(
      await screen.findByRole("button", { name: "Jump to a company or project" }),
    )

    expect(await screen.findByRole("combobox")).toBeInTheDocument()
  })
})

describe("matchTargets", () => {
  it("matches every word typed, in any order, against the company and project names", async () => {
    const targets = switchTargets([
      {
        id: "cmp_a" as never,
        name: "Cobalt Grid",
        role: "lead",
        created_at: "2026-11-03T10:00:00Z",
        updated_at: "2026-11-03T10:00:00Z",
        projects: [
          {
            id: "prj_a" as never,
            company: "cmp_a" as never,
            name: "Field crew handbook search",
            stage: "deploy",
            created_at: "2026-11-03T10:00:00Z",
            updated_at: "2026-11-03T10:00:00Z",
          },
        ],
      },
    ])
    const names = (query: string) =>
      matchTargets(targets, query).map((t) =>
        t.kind === "company" ? t.company.name : t.project.name,
      )

    expect(names("")).toEqual(["Cobalt Grid", "Field crew handbook search"])
    expect(names("FIELD cobalt")).toEqual(["Field crew handbook search"])
    expect(names("grid")).toEqual(["Cobalt Grid", "Field crew handbook search"])
    expect(names("deploy")).toEqual([])
  })
})

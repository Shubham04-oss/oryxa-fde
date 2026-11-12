import { waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { NewCompanyConversation } from "./new-company"
import type { SetupBody } from "@/lib/api/client"
import { releaseKey } from "@/lib/workspace/setup"
import type * as Setup from "@/lib/workspace/setup"
import { press, savedList, toReview } from "@/test/conversation"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// The review shows the arguments themselves (ADR 0008): its list is drawn from the body Create company
// sends, so a change to how the answers become that body changes what the review says. Here the
// mapping is changed on purpose, and the list must follow it, never the answers.

vi.mock("@/lib/workspace/setup", async (original) => {
  const real = await original<typeof Setup>()
  return {
    ...real,
    setupBody: (...args: Parameters<typeof real.setupBody>): SetupBody | null => {
      const body = real.setupBody(...args)
      return (
        body && {
          ...body,
          company: { ...body.company, name: "Mapped differently" },
          stakeholders: [],
          main_contact: null,
          criteria: [],
          plan: (body.plan ?? []).slice(0, 2).map((step) => ({ ...step, criterion: null })),
        }
      )
    },
  }
})

beforeAll(installWire)
afterEach(() => {
  resetWire()
  releaseKey()
})

describe("the review", () => {
  it("lists what the body sends, not what was answered", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    const saved = savedList()
    expect(within(saved).getByText("Mapped differently")).toBeInTheDocument()
    expect(within(saved).queryByText("Orion Rail")).toBeNull()
    expect(within(saved).getByText("No one named.")).toBeInTheDocument()
    expect(within(saved).queryByText("Dana Ortiz")).toBeNull()
    expect(within(saved).getByText("None yet. Add one on the project.")).toBeInTheDocument()
    expect(within(saved).getByText(/^2 tasks, in this order/)).toBeInTheDocument()
    expect(within(saved).getAllByRole("listitem")).toHaveLength(2)

    // And what is sent is that same body.
    await press("Create company")
    await waitFor(() => expect(wire.sent).toHaveLength(1))
    expect(wire.sent[0]?.body).toMatchObject({ company: { name: "Mapped differently" } })
  })
})

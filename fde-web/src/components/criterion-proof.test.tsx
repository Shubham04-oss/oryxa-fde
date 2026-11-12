import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// A criterion's baseline and how it will be proven (#238, #244): written in the criterion's form, sent
// on every save (a PUT clears what it is not sent), shown on the card and on Proof. Both are part of
// what is signed, so changing either on a signed-off scope says so before it saves.

beforeAll(installWire)
afterEach(resetWire)

/** Signed off, and up to date. */
const DISPATCH = {
  company: CompanyId.parse("cmp_kestrel"),
  project: ProjectId.parse("prj_kestrel_dispatch"),
}
/** Written, never signed off. */
const FNOL = { company: CompanyId.parse("cmp_atlas"), project: ProjectId.parse("prj_atlas_fnol") }

const dialog = (name: string) => screen.findByRole("dialog", { name })
async function fill(box: HTMLElement, label: string, text: string) {
  const input = within(box).getByLabelText(label)
  await userEvent.clear(input)
  if (text) await userEvent.type(input, text)
}
const click = (box: HTMLElement, name: string) =>
  userEvent.click(within(box).getByRole("button", { name }))
const criteriaCard = () => screen.findByRole("region", { name: "Success criteria" })
const puts = () => wire.sent.filter((w) => w.method === "PUT")
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

async function edit(scope: typeof DISPATCH, criterion: RegExp) {
  renderWithRouter(<ProjectPage scope={scope} />)
  await userEvent.click(await screen.findByRole("button", { name: criterion }))
  return dialog("Edit success criterion")
}

describe("a criterion's baseline and proof", () => {
  it("are on the card: the baseline in the target's unit, and how it will be proven", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await criteriaCard()
    expect(within(card).getByText("Baseline 45 min.")).toBeInTheDocument()
    expect(
      within(card).getByText(
        "How we will prove it: Timed by the dispatchers at both pilot depots for a week",
      ),
    ).toBeInTheDocument()
  })

  it("say quietly when a criterion has no baseline yet", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    expect((await screen.findAllByText("No baseline measured yet.")).length).toBeGreaterThan(0)
  })

  it("are written in the form and sent with every other field", async () => {
    const box = await edit(FNOL, /^Edit: Calls with every required field/)
    await fill(box, "Baseline", "0.61")
    await fill(box, "How we will prove it", "  Fifty calls a week, checked by the claims lead ")
    // No sign-off yet, so nothing to say about one.
    expect(within(box).queryByRole("note")).toBeNull()
    expect(within(box).getByText(/Baseline 0\.61/)).toBeInTheDocument()
    await click(box, "Save")
    await closed()
    expect(puts()).toHaveLength(1)
    expect(puts()[0]!.body).toMatchObject({
      baseline: 0.61,
      proof: "Fifty calls a week, checked by the claims lead",
    })
    expect(
      within(await criteriaCard()).getByText(
        "How we will prove it: Fifty calls a week, checked by the claims lead",
      ),
    ).toBeInTheDocument()
  })

  it("are cleared by choice, sent as null, and another edit keeps them", async () => {
    let box = await edit(DISPATCH, /^Edit: Time to a draft plan/)
    await fill(box, "Target", "3")
    await click(box, "Save")
    await closed()
    expect(puts()[0]!.body).toMatchObject({
      baseline: 45,
      proof: "Timed by the dispatchers at both pilot depots for a week",
    })
    await userEvent.click(screen.getByRole("button", { name: /^Edit: Time to a draft plan/ }))
    box = await dialog("Edit success criterion")
    await fill(box, "Baseline", "")
    await fill(box, "How we will prove it", "")
    await click(box, "Save")
    await closed()
    expect(puts()[1]!.body).toMatchObject({ baseline: null, proof: null })
  })

  it("on a signed-off scope, say before saving that changing them means signing off again", async () => {
    const box = await edit(DISPATCH, /^Edit: Time to a draft plan/)
    expect(within(box).getByRole("note")).toHaveTextContent(
      "This scope is signed off. Saving a change means it needs signing off again.",
    )
    await fill(box, "Baseline", "40")
    expect(within(box).getByRole("note")).toHaveTextContent(
      "the baseline and how it will be proven are part of what was signed",
    )
    await click(box, "Save")
    await closed()
    const scope = screen.getByRole("region", { name: "Scope" })
    await waitFor(() => expect(scope).toHaveTextContent("Changed since sign-off"))
  })

  it("are checked before they are sent: a baseline is a number, a proof up to 500 characters", async () => {
    const box = await edit(DISPATCH, /^Edit: Time to a draft plan/)
    await fill(box, "Baseline", "about 45")
    await click(box, "Save")
    expect(
      await within(box).findByText(
        "The baseline must be a number, in the same unit as the target.",
      ),
    ).toBeInTheDocument()
    await fill(box, "Baseline", "45")
    const proof = within(box).getByLabelText("How we will prove it")
    await userEvent.clear(proof)
    await userEvent.click(proof)
    await userEvent.paste("x".repeat(501))
    await click(box, "Save")
    expect(
      await within(box).findByText("How it will be proven is plain text, up to 500 characters."),
    ).toBeInTheDocument()
    expect(puts()).toEqual([])
  })
})

describe("Proof", () => {
  it("reads baseline, current and target in one line, and says how it will be proven", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const proof = await screen.findByRole("region", { name: /^Proof/ })
    await waitFor(() => expect(proof).toHaveTextContent("from a baseline of 0.42"))
    expect(proof).toHaveTextContent(/against at least 0\.7, from a baseline of 0\.42/)
    expect(proof).toHaveTextContent(
      "How we will prove it: The plan acceptance eval suite, on last month's orders",
    )
  })
})

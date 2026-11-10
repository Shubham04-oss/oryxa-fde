import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ProjectPage } from "./project-page"
import { api } from "@/lib/api/client"
import type { ApiError } from "@/lib/api/client"
import { CompanyId, ProjectId, StakeholderId } from "@/lib/api/schemas"
import { resetMockApi } from "@/dev/mock-api"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(resetWire)

const scopeOf = (company: string, project: string) => ({
  company: CompanyId.parse(company),
  project: ProjectId.parse(project),
})
/** Signed off by the sponsor, and up to date. */
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
/** Signed off, then changed once. */
const REFERRALS = scopeOf("cmp_brightwater", "prj_bw_referrals")
/** Written, never signed off; no stakeholder is a sponsor. */
const FNOL = scopeOf("cmp_atlas", "prj_atlas_fnol")
/** Nothing written in it at all. */
const CLAIMS = scopeOf("cmp_kestrel", "prj_kestrel_claims")
const base = (s: { company: string; project: string }) =>
  `/companies/${s.company}/projects/${s.project}/scope`
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 })

const dialog = (name: string) => screen.findByRole("dialog", { name })
const field = (box: HTMLElement, label: string) => within(box).getByLabelText(label)
async function fill(box: HTMLElement, label: string, text: string) {
  const input = field(box, label)
  await userEvent.clear(input)
  if (text) await userEvent.type(input, text)
}
/** `hidden`: with a dialog open the page behind it is hidden from the accessibility tree. */
const scopeCard = (hidden = false) => screen.findByRole("region", { name: "Scope", hidden })
const criteriaCard = (hidden = false) =>
  screen.findByRole("region", { name: "Success criteria", hidden })
const click = (box: HTMLElement, name: string) =>
  userEvent.click(within(box).getByRole("button", { name }))
const writes = () => wire.sent.map(({ method, path }) => `${method} ${path}`)
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

describe("what a good scope looks like, before there is one", () => {
  it("says what to write, in a line each, and offers no sign-off of nothing", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const scope = await scopeCard()
    expect(within(scope).getByText(/Start with the outcome/)).toBeInTheDocument()
    expect(within(scope).getByText(/Say what is not included/)).toBeInTheDocument()
    expect(within(scope).queryByRole("button", { name: /sign/i })).toBeNull()
    expect(within(scope).getByText("Not signed off")).toBeInTheDocument()
    const criteria = await criteriaCard()
    expect(within(criteria).getByText(/Say how done is measured/)).toBeInTheDocument()
  })
})

describe("scope items", () => {
  it("are added on the side whose Add was pressed, and shown once the API has confirmed", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const scope = await scopeCard()
    await userEvent.click(within(scope).getByRole("button", { name: "Add out of scope" }))
    const box = await dialog("Add to scope")
    expect(field(box, "Listed as")).toHaveValue("out")
    await fill(box, "Description", "Changing the claims system")
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await click(box, "Add")
    expect(await within(box).findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(within(scope).queryByText("Changing the claims system")).toBeNull()
    answered()
    await closed()

    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: base(CLAIMS) + "/items",
      body: { kind: "out", description: "Changing the claims system" },
    })
    const out = within(scope).getByRole("list", { name: "Out of scope" })
    expect(within(out).getByText("Changing the claims system")).toBeInTheDocument()
    // It is a scope now, and can be signed off: the sponsor is the only one to choose.
    expect(within(scope).getByRole("button", { name: "Record sign-off" })).toBeInTheDocument()
  })

  it("need words, and a long one has room and keeps its lines", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await scopeCard()).getByRole("button", { name: "Add in scope" }))
    const box = await dialog("Add to scope")
    await click(box, "Add")
    expect(within(box).getByRole("alert")).toHaveTextContent("Write what is in scope.")
    expect(wire.sent).toEqual([])
    const long = "Read orders from the planning database.\nDo not write to it."
    await userEvent.type(field(box, "Description"), long)
    await click(box, "Add")
    await closed()
    expect(wire.sent[0]).toMatchObject({ body: { kind: "in", description: long } })
  })

  it("are edited with every field, and can move to the other side", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: /^Edit: Motor claims/ }))
    const box = await dialog("Edit scope item")
    expect(field(box, "Description")).toHaveValue("Motor claims")
    await userEvent.selectOptions(field(box, "Listed as"), "in")
    await click(box, "Save")
    await closed()
    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "PUT",
      path: base(FNOL) + "/items/itm_a3",
      body: { kind: "in", description: "Motor claims" },
    })
    const inScope = within(await scopeCard()).getByRole("list", { name: "In scope" })
    expect(within(inScope).getByText("Motor claims")).toBeInTheDocument()
  })

  it("send nothing when nothing changed, so a signed-off scope stays signed off", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Changing the planning database/ }),
    )
    const box = await dialog("Edit scope item")
    await click(box, "Save")
    await closed()
    expect(wire.sent).toEqual([])
    expect(within(await scopeCard()).getByText(/Signed off by Mara Lindqvist/)).toBeInTheDocument()
  })

  it("do not undo a teammate's change that lands while the form is open", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: /^Edit: Fraud scoring/ }))
    const box = await dialog("Edit scope item")
    // A teammate rewrites it, and the page reads it again behind the form.
    await api.updateScopeItem(FNOL, "itm_a4" as never, {
      kind: "out",
      description: "Fraud scoring and referral",
    })
    wire.sent = []
    await click(box, "Save")
    await closed()
    // Untouched: the form compares with the item it opened with, so nothing is sent over theirs.
    expect(wire.sent).toEqual([])
    expect((await api.project(FNOL)).scope.items.find((i) => i.id === "itm_a4")?.description).toBe(
      "Fraud scoring and referral",
    )
  })

  it("are removed only after asking, and focus goes back to the section's Add", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: /^Edit: Fraud scoring/ }))
    const box = await dialog("Edit scope item")
    await click(box, "Remove item")
    const ask = within(box).getByRole("group", { name: "Confirm the removal" })
    expect(within(ask).getByRole("button", { name: "Keep it" })).toHaveFocus()
    expect(ask).toHaveTextContent("This cannot be undone.")
    expect(writes()).toEqual([])
    await userEvent.click(within(ask).getByRole("button", { name: "Remove" }))
    await closed()
    expect(writes()).toEqual([`DELETE ${base(FNOL)}/items/itm_a4`])
    expect(screen.queryByRole("button", { name: /^Edit: Fraud scoring/ })).toBeNull()
    // The row that opened the dialog is gone: focus lands on the Add of its section, not on the page.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add out of scope" })).toHaveFocus(),
    )
  })

  it("keep an item whose removal the API refuses, and say why in the dialog", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: /^Edit: Fraud scoring/ }))
    const box = await dialog("Edit scope item")
    await click(box, "Remove item")
    wire.refuse = forbidden()
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the removal" })).getByRole("button", {
        name: "Remove",
      }),
    )
    expect(await within(box).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(
      screen.getByRole("button", { name: /^Edit: Fraud scoring/, hidden: true }),
    ).toBeInTheDocument()
  })

  it("show the API's refusal of a save, and keep what was typed and the scope as it was", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await scopeCard()).getByRole("button", { name: "Add in scope" }))
    const box = await dialog("Add to scope")
    await fill(box, "Description", "Sort claims by cause")
    wire.refuse = forbidden()
    await click(box, "Add")
    expect(await within(box).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(field(box, "Description")).toHaveValue("Sort claims by cause")
    expect(within(await scopeCard(true)).queryByText("Sort claims by cause")).toBeNull()
  })

  it("say the item is gone when a teammate removed it first", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: /^Edit: Fraud scoring/ }))
    const box = await dialog("Edit scope item")
    await api.removeScopeItem(FNOL, "itm_a4" as never)
    await fill(box, "Description", "Fraud scoring, later")
    await click(box, "Save")
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "The scope item is no longer there.",
    )
  })
})

describe("success criteria", () => {
  it("are added as a sentence the customer would agree to, shown as it will read", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(
      within(await criteriaCard()).getByRole("button", { name: "Add criterion" }),
    )
    const box = await dialog("Add success criterion")
    await fill(box, "What must be true", "Claims go to the right team first time")
    await fill(box, "What is measured", "claims routed correctly")
    await userEvent.selectOptions(field(box, "Passes when it is"), "at_least")
    await fill(box, "Target", "85")
    await fill(box, "Unit", "%")
    expect(within(box).getByText("Met when claims routed correctly is at least 85%.")).toBeVisible()
    await click(box, "Add criterion")
    await closed()

    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: base(CLAIMS) + "/criteria",
      body: {
        description: "Claims go to the right team first time",
        metric: "claims routed correctly",
        comparator: "at_least",
        target: 85,
        unit: "%",
      },
    })
    const criteria = await criteriaCard()
    expect(within(criteria).getByText("Claims go to the right team first time")).toBeVisible()
    expect(
      within(criteria).getByText("Met when claims routed correctly is at least 85%."),
    ).toBeVisible()
  })

  it("say what is missing before anything is sent", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(
      within(await criteriaCard()).getByRole("button", { name: "Add criterion" }),
    )
    const box = await dialog("Add success criterion")
    await click(box, "Add criterion")
    expect(within(box).getByRole("alert")).toHaveTextContent("Say what must be true.")
    await fill(box, "What must be true", "Fast enough")
    await click(box, "Add criterion")
    expect(within(box).getByRole("alert")).toHaveTextContent("Say what is measured.")
    await fill(box, "What is measured", "seconds per claim")
    await click(box, "Add criterion")
    expect(within(box).getByRole("alert")).toHaveTextContent("The target must be a number.")
    await fill(box, "Target", "ten")
    await click(box, "Add criterion")
    expect(within(box).getByRole("alert")).toHaveTextContent("The target must be a number.")
    expect(wire.sent).toEqual([])
    // A target of zero is a target.
    await fill(box, "Target", "0")
    await click(box, "Add criterion")
    await closed()
    expect(wire.sent[0]).toMatchObject({ body: { target: 0, unit: null } })
  })

  it("are edited with every field, and a cleared unit is sent as none", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Time to a draft plan/ }),
    )
    const box = await dialog("Edit success criterion")
    expect(field(box, "Unit")).toHaveValue("min")
    await fill(box, "Unit", "")
    await fill(box, "Target", "3")
    await userEvent.selectOptions(field(box, "Passes when it is"), "at_least")
    await click(box, "Save")
    await closed()
    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "PUT",
      path: base(DISPATCH) + "/criteria/crt_k3",
      body: {
        description: "Time to a draft plan",
        metric: "minutes per depot",
        comparator: "at_least",
        target: 3,
        unit: null,
      },
    })
    expect(
      within(await criteriaCard()).getByText("Met when minutes per depot is at least 3."),
    ).toBeVisible()
  })

  it("send nothing when nothing changed", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Time to a draft plan/ }),
    )
    await click(await dialog("Edit success criterion"), "Save")
    await closed()
    expect(wire.sent).toEqual([])
  })

  it("are removed after asking, even once results could exist: the API does not stop it", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Calls with every required field/ }),
    )
    const box = await dialog("Edit success criterion")
    await click(box, "Remove criterion")
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the removal" })).getByRole("button", {
        name: "Remove",
      }),
    )
    await closed()
    expect(writes()).toEqual([`DELETE ${base(FNOL)}/criteria/crt_a1`])
    expect(
      screen.queryByRole("button", { name: /^Edit: Calls with every required field/ }),
    ).toBeNull()
    await waitFor(() => expect(screen.getByRole("button", { name: "Add criterion" })).toHaveFocus())
  })

  it("show a refusal of a save in the dialog, with what was typed", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Time to a draft plan/ }),
    )
    const box = await dialog("Edit success criterion")
    await fill(box, "Target", "5")
    wire.refuse = Response.json({ error: "unavailable" }, { status: 503 })
    await click(box, "Save")
    expect(await within(box).findByRole("alert")).toHaveTextContent("briefly unavailable")
    expect(field(box, "Target")).toHaveValue("5")
    expect(
      within(await criteriaCard(true)).getByText("Met when minutes per depot is at most 2 min."),
    ).toBeInTheDocument()
  })
})

describe("the three sign-off states", () => {
  it("not signed off: says so, and offers to record it", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    const scope = await scopeCard()
    expect(within(scope).getByText("Not signed off", { selector: "span" })).toBeInTheDocument()
    expect(within(scope).getByText(/When Atlas Mutual agrees to this scope/)).toBeInTheDocument()
    expect(within(scope).getByRole("button", { name: "Record sign-off" })).toBeInTheDocument()
  })

  it("signed off: says by whom and when, who recorded it, and that a change needs signing again", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const scope = await scopeCard()
    expect(within(scope).getByText(/Signed off by Mara Lindqvist, /)).toBeInTheDocument()
    expect(within(scope).getByText(/Recorded by you\./)).toBeInTheDocument()
    expect(within(scope).getByText(/will need signing off again/)).toBeInTheDocument()
    expect(within(scope).queryByRole("button", { name: /sign off|sign-off/i })).toBeNull()
  })

  it("changed since sign-off: says who signed, how many changes since, and offers to sign again", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const scope = await scopeCard()
    expect(within(scope).getByText("Changed since sign-off")).toBeInTheDocument()
    expect(
      within(scope).getByText(/Dr Helen Achebe signed off an earlier version on /),
    ).toBeInTheDocument()
    expect(within(scope).getByText(/has had 1 change since/)).toBeInTheDocument()
    expect(within(scope).getByRole("button", { name: "Sign off again" })).toBeInTheDocument()
  })
})

describe("editing a signed-off scope", () => {
  it("warns first, and afterwards the scope reads as changed since sign-off", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Changing the planning database/ }),
    )
    const box = await dialog("Edit scope item")
    expect(within(box).getByRole("note")).toHaveTextContent("needs signing off again")
    await fill(box, "Description", "Changing the planning database schema")
    await click(box, "Save")
    await closed()

    const scope = await scopeCard()
    expect(within(scope).getByText("Changed since sign-off")).toBeInTheDocument()
    expect(
      within(scope).getByText(/Mara Lindqvist signed off an earlier version/),
    ).toBeInTheDocument()
    expect(within(scope).getByText(/has had 1 change since/)).toBeInTheDocument()
    // The API keeps the sign-off on record: it is what the card says changed.
    expect((await api.project(DISPATCH)).scope).toMatchObject({
      signed_off: false,
      sign_off: { stakeholder: "stk_k1" },
    })
  })

  it("warns before adding or removing too", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(await screen.findByRole("button", { name: "Add criterion" }))
    expect(within(await dialog("Add success criterion")).getByRole("note")).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await closed()
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Time to a draft plan/ }),
    )
    const box = await dialog("Edit success criterion")
    await click(box, "Remove criterion")
    expect(within(box).getByRole("group", { name: "Confirm the removal" })).toHaveTextContent(
      "The scope will need signing off again.",
    )
  })

  it("has nothing more to warn about once the scope already needs signing again", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    await userEvent.click(await screen.findByRole("button", { name: "Add criterion" }))
    expect(within(await dialog("Add success criterion")).queryByRole("note")).toBeNull()
  })

  it("puts focus back on the row that was edited, and on the scope's new state after a sign-off", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: /^Edit: Motor claims/ }))
    await userEvent.keyboard("{Escape}")
    await closed()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Edit: Motor claims/ })).toHaveFocus(),
    )
    await userEvent.click(screen.getByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    await userEvent.selectOptions(field(box, "Signed off by"), "stk_a2")
    await click(box, "Record sign-off")
    await closed()
    // The button that opened it is gone: focus is on the sentence that says what happened.
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Scope" })).getByText(/Daniel Osei agreed/),
      ).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(screen.getByText(/Daniel Osei agreed/).closest("[tabindex='-1']")).toHaveFocus(),
    )
  })
})

describe("recording a sign-off", () => {
  it("asks who, offering sponsors first, and shows it once the API has recorded it", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    expect(box).toHaveTextContent("2 in scope, 2 out of scope, 2 success criteria")
    // Nobody at Atlas is the sponsor, so no one is chosen for them.
    const who = field(box, "Signed off by")
    expect(who).toHaveValue("")
    await click(box, "Record sign-off")
    expect(within(box).getByRole("alert")).toHaveTextContent("Choose who signed off.")
    expect(wire.sent).toEqual([])
    await userEvent.selectOptions(who, "stk_a2")
    await click(box, "Record sign-off")
    await closed()

    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: base(FNOL) + "/sign-offs",
      body: { stakeholder: "stk_a2" },
    })
    const scope = await scopeCard()
    expect(within(scope).getByText(/Signed off by Daniel Osei, /)).toBeInTheDocument()
    expect(within(scope).getByText(/Recorded by you\./)).toBeInTheDocument()
    expect(within(scope).queryByRole("button", { name: /sign/i })).toBeNull()
  })

  it("chooses the only sponsor for them, and the one who signed before when signing again", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    await userEvent.click(await screen.findByRole("button", { name: "Sign off again" }))
    const box = await dialog("Sign off again")
    expect(field(box, "Signed off by")).toHaveValue("stk_b1")
    const options = within(field(box, "Signed off by")).getAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a stakeholder",
      "Dr Helen Achebe, Sponsor",
      "Owen Price, IT",
      "Sana Qureshi, Security",
    ])
    await click(box, "Record sign-off")
    await closed()
    expect(wire.sent[0]).toMatchObject({ body: { stakeholder: "stk_b1" } })
    expect(
      within(await scopeCard()).getByText(/Signed off by Dr Helen Achebe, /),
    ).toBeInTheDocument()
  })

  it("says what the scope still lacks, without refusing it", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await api.addScopeItem(CLAIMS, { kind: "in", description: "Sort claims by cause" })
    // The page was read before; read it again as a teammate's addition would show.
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    await userEvent.click(await screen.findByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    expect(box).toHaveTextContent("Nothing is listed as out of scope.")
    expect(box).toHaveTextContent("No success criteria are written yet.")
    expect(box).toHaveTextContent("1 in scope, 0 out of scope, 0 success criteria")
  })

  it("chooses a lone sponsor, but records nothing until the person confirms", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await api.addScopeItem(CLAIMS, { kind: "in", description: "Sort claims by cause" })
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    wire.sent = []
    await userEvent.click(await screen.findByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    // Mara Lindqvist is Kestrel's only sponsor.
    expect(field(box, "Signed off by")).toHaveValue("stk_k1")
    expect(writes().some((w) => w.includes("sign-offs"))).toBe(false)
    await userEvent.click(within(box).getByRole("button", { name: "Cancel" }))
    await closed()
    expect(writes().some((w) => w.includes("sign-offs"))).toBe(false)
    expect((await api.scope(CLAIMS)).sign_off).toBeFalsy()
  })

  it("refuses, and signs nothing, when the scope cannot be read again first", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    await userEvent.selectOptions(field(box, "Signed off by"), "stk_a2")
    const reread = vi.spyOn(api, "scope").mockRejectedValueOnce(new TypeError("Failed to fetch"))
    try {
      await click(box, "Record sign-off")
      expect(await within(box).findByRole("alert")).toHaveTextContent("Check your connection")
    } finally {
      reread.mockRestore()
    }
    expect(writes().some((w) => w.includes("sign-offs"))).toBe(false)
    expect(
      within(await scopeCard(true)).getByText("Not signed off", { selector: "span" }),
    ).toBeInTheDocument()
  })

  it("refuses a scope that changed while the dialog was open, and signs nothing", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    await userEvent.selectOptions(field(box, "Signed off by"), "stk_a2")
    // A teammate adds something the person has not read.
    await api.addScopeItem(FNOL, { kind: "in", description: "Windscreen claims" })
    wire.sent = []
    await click(box, "Record sign-off")
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "The scope changed while this was open",
    )
    expect(writes().some((w) => w.includes("sign-offs"))).toBe(false)
    // The card has the new item behind the dialog now, so reading it again shows what changed.
    await userEvent.click(within(box).getByRole("button", { name: "Cancel" }))
    await closed()
    expect(within(await scopeCard()).getByText("Windscreen claims")).toBeInTheDocument()
    expect(
      within(await scopeCard()).getByText("Not signed off", { selector: "span" }),
    ).toBeInTheDocument()
  })

  it("says so when this version was signed off a moment ago by someone else", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    await userEvent.selectOptions(field(box, "Signed off by"), "stk_a2")
    wire.refuse = Response.json({ error: "conflict" }, { status: 409 })
    await click(box, "Record sign-off")
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "This version of the scope has already been signed off",
    )
    expect(
      within(await scopeCard(true)).getByText("Not signed off", { selector: "span" }),
    ).toBeInTheDocument()
  })

  it("shows the API's refusal, and keeps the choice", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Record sign-off" }))
    const box = await dialog("Record sign-off")
    await userEvent.selectOptions(field(box, "Signed off by"), "stk_a1")
    wire.refuse = forbidden()
    await click(box, "Record sign-off")
    expect(await within(box).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(field(box, "Signed off by")).toHaveValue("stk_a1")
  })
})

describe("who may write the scope", () => {
  it("is anyone who works on the project: an engineer sees and uses every control", async () => {
    // The API's `work` guards each scope route, read or write; there is no `manage` one.
    renderWithRouter(<ProjectPage scope={REFERRALS} />, { engineer: true })
    const scope = await scopeCard()
    expect(within(scope).getByRole("button", { name: "Add in scope" })).toBeInTheDocument()
    expect(within(scope).getByRole("button", { name: "Sign off again" })).toBeInTheDocument()
    await userEvent.click(within(scope).getByRole("button", { name: "Add out of scope" }))
    const box = await dialog("Add to scope")
    await fill(box, "Description", "Clinical advice to patients")
    await click(box, "Add")
    await closed()
    expect(wire.sent[0]).toMatchObject({ method: "POST" })
  })
})

describe("the API mock's scope routes", () => {
  const refused = async (work: Promise<unknown>) => {
    try {
      await work
    } catch (e) {
      return e as ApiError
    }
    throw new Error("expected a refusal")
  }

  it("refuses what the API refuses", async () => {
    resetMockApi()
    const long = "x".repeat(201)
    const item = { kind: "in", description: "Something" } as const
    expect(await refused(api.addScopeItem(FNOL, { ...item, description: " " }))).toMatchObject({
      status: 400,
      code: "invalid_description",
    })
    expect(
      await refused(api.addScopeItem(FNOL, { ...item, description: "x".repeat(4001) })),
    ).toMatchObject({ code: "invalid_description" })
    const crit = {
      description: "Fast",
      metric: "seconds",
      comparator: "at_most",
      target: 2,
      unit: null,
    } as const
    expect(await refused(api.addCriterion(FNOL, { ...crit, metric: long }))).toMatchObject({
      code: "invalid_metric",
    })
    expect(await refused(api.addCriterion(FNOL, { ...crit, unit: long }))).toMatchObject({
      code: "invalid_unit",
    })
    expect(await refused(api.addCriterion(FNOL, { ...crit, target: Number.NaN }))).toMatchObject({
      status: 400,
    })
    // Not there: 404, after the body has been checked.
    expect(await refused(api.updateScopeItem(FNOL, "itm_nope" as never, item))).toMatchObject({
      status: 404,
    })
    expect(await refused(api.removeCriterion(FNOL, "crt_nope" as never))).toMatchObject({
      status: 404,
    })
  })

  it("counts every save as a change, even one that says the same, and clears nothing it should keep", async () => {
    resetMockApi()
    const before = (await api.project(DISPATCH)).scope
    expect(before).toMatchObject({ signed_off: true })
    const first = before.items[0]!
    await api.updateScopeItem(DISPATCH, first.id, {
      kind: first.kind,
      description: first.description,
    })
    const after = (await api.project(DISPATCH)).scope
    expect(after.version).toBe(before.version + 1)
    expect(after).toMatchObject({ signed_off: false, sign_off: { version: before.version } })
  })

  it("signs one version once, refuses an empty scope and a stranger, and covers the version it signed", async () => {
    resetMockApi()
    expect(await refused(api.signOffScope(CLAIMS, StakeholderId.parse("stk_k1")))).toMatchObject({
      status: 409,
      code: "rejected_empty_scope",
    })
    expect(await refused(api.signOffScope(FNOL, StakeholderId.parse("stk_k1")))).toMatchObject({
      status: 400,
      code: "invalid_stakeholder",
    })
    const signed = await api.signOffScope(FNOL, StakeholderId.parse("stk_a1"))
    expect(signed).toMatchObject({ stakeholder: "stk_a1", recorded_by: "usr_riya" })
    expect((await api.project(FNOL)).scope).toMatchObject({
      signed_off: true,
      sign_off: { version: signed.version },
    })
    expect(await refused(api.signOffScope(FNOL, StakeholderId.parse("stk_a2")))).toMatchObject({
      status: 409,
      message: expect.stringContaining("already been signed off") as string,
    })
  })
})

import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "../ui/button"
import { useGo } from "./blocks"
import { api, queries } from "@/lib/api/client"
import type { CompanySummary } from "@/lib/api/schemas"
import { attempt, commitCompanyCreated, companyBody } from "@/lib/records"
import type { Destination } from "@/lib/workspace/blocks"
import type { Proposal, ProposalState } from "@/lib/workspace/wire"

// A change the assistant proposes (ADR 0008), shown in plain words taken from its arguments, never from
// the model's own description, with each record by the name the person reads for it through the API.
// Nothing runs until the person confirms; then this screen calls the API's own route with their
// session, as any form does. The assistant never runs it.

/** Where a screen is, in words, or null when it names a record the person cannot read. */
export function placeOf(to: Destination, companies: Array<CompanySummary> | undefined) {
  switch (to.screen) {
    case "today":
      return "Today"
    case "companies":
      return "your companies"
    case "new-company":
      return "a new company's setup"
    case "company":
      return companies?.find((c) => c.id === to.company)?.name ?? null
    case "project": {
      const company = companies?.find((c) => c.id === to.company)
      const project = company?.projects.find((p) => p.id === to.project)
      return company && project ? `${project.name} at ${company.name}` : null
    }
  }
}

const DONE: Record<Proposal["action"], string> = {
  create_company: "Created",
  open_route: "Opened",
}

export function ProposalCard({
  proposal,
  state,
  onSettle,
}: {
  proposal: Proposal
  state: ProposalState
  onSettle: (outcome: "confirmed" | "dismissed") => void
}) {
  const companies = useQuery(queries.companies())
  const client = useQueryClient()
  const navigate = useNavigate()
  const go = useGo()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState("")

  const place =
    proposal.action === "open_route" ? placeOf(proposal.args.to, companies.data?.companies) : null
  const title =
    proposal.action === "create_company"
      ? "Create a company"
      : place === null
        ? "Open a record you can't see"
        : `Open ${place}`
  const detail =
    proposal.action === "create_company"
      ? `It will be saved as “${proposal.args.name}”, with nothing else set yet.`
      : place === null
        ? "This names a company or project you have no access to, so it can't be opened."
        : null

  async function confirm() {
    setBusy(true)
    setProblem("")
    if (proposal.action === "open_route") {
      onSettle("confirmed")
      await go(proposal.args.to)
      return
    }
    const name = proposal.args.name
    const failed = await attempt(async () => {
      const created = await api.createCompany(
        companyBody({ name, industry: "", region: "", summary: "" }),
      )
      await commitCompanyCreated(client, created)
      onSettle("confirmed")
      await navigate({ to: "/companies/$companyId", params: { companyId: created.id } })
    }, "company")
    if (failed) setProblem(failed)
    setBusy(false)
  }

  return (
    <article aria-label={`Proposed: ${title}`} className="grid gap-3 px-5 py-4 max-[560px]:px-4">
      <div className="grid gap-1">
        <p className="text-micro text-muted-foreground">
          Proposed. Nothing happens until you confirm.
        </p>
        <h3 className="text-body font-semibold text-pretty break-words">{title}</h3>
        {detail && <p className="text-meta break-words text-muted-foreground">{detail}</p>}
      </div>
      {state === "waiting" ? (
        <div className="flex flex-wrap items-center gap-2">
          {(proposal.action === "create_company" || place !== null) && (
            <Button onClick={() => void confirm()} disabled={busy}>
              {proposal.action === "create_company" ? "Create company" : "Open"}
            </Button>
          )}
          <Button variant="outline" onClick={() => onSettle("dismissed")} disabled={busy}>
            Not now
          </Button>
        </div>
      ) : (
        <p role="status" className="text-meta text-soft">
          {state === "confirmed" ? DONE[proposal.action] : "Put away"}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-meta text-destructive">
          {problem}
        </p>
      )}
    </article>
  )
}

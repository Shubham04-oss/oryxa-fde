import { useEffect, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CompanyPage } from "@/components/company-page"
import { NotFound } from "@/components/page"
import { CompanyId } from "@/lib/api/schemas"

export const Route = createFileRoute("/_app/companies/$companyId/")({
  // `?add=stakeholder` opens Add stakeholder: where a project's checklist sends the FDE to name someone.
  validateSearch: (search: Record<string, unknown>): { add?: "stakeholder" } =>
    search.add === "stakeholder" ? { add: "stakeholder" } : {},
  component: CompanyRoute,
})

function CompanyRoute() {
  const { add } = Route.useSearch()
  const navigate = useNavigate()
  // Kept from the first render: the address is cleared below, long before the company has loaded.
  const [addStakeholder] = useState(add === "stakeholder")
  // The dialog opens once; the address goes back to the company's own, so a reload does not reopen it.
  useEffect(() => {
    if (add) void navigate({ to: ".", search: {}, replace: true })
  }, [add, navigate])
  // The address is untrusted: an id that breaks the id rule never reaches a call.
  const id = CompanyId.safeParse(Route.useParams().companyId)
  return id.success ? (
    <CompanyPage key={id.data} companyId={id.data} addStakeholder={addStakeholder} />
  ) : (
    <NotFound what="company" />
  )
}

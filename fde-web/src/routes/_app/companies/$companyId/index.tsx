import { createFileRoute } from "@tanstack/react-router"
import { CompanyPage } from "@/components/company-page"
import { NotFound } from "@/components/page"
import { CompanyId } from "@/lib/api/schemas"

export const Route = createFileRoute("/_app/companies/$companyId/")({ component: CompanyRoute })

function CompanyRoute() {
  // The address is untrusted: an id that breaks the id rule never reaches a call.
  const id = CompanyId.safeParse(Route.useParams().companyId)
  return id.success ? (
    <CompanyPage key={id.data} companyId={id.data} />
  ) : (
    <NotFound what="company" />
  )
}

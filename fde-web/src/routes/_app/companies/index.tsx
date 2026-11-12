import { Navigate, createFileRoute } from "@tanstack/react-router"
import { CompaniesHome } from "@/components/companies-home"
import { newWorkspace } from "@/lib/workspace/flag"

export const Route = createFileRoute("/_app/companies/")({ component: AllCompanies })

/** Every company, once the welcome screen has `/`; without the new workspace they are at `/`. */
function AllCompanies() {
  return newWorkspace() ? <CompaniesHome /> : <Navigate to="/" replace />
}

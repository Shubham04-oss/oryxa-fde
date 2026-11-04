import { createFileRoute } from "@tanstack/react-router"
import { CompaniesHome } from "@/components/companies-home"

export const Route = createFileRoute("/_app/")({ component: CompaniesHome })

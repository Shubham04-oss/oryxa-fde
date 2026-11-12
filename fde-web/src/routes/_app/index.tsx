import { createFileRoute } from "@tanstack/react-router"
import { CompaniesHome } from "@/components/companies-home"
import { Welcome } from "@/components/workspace/welcome"
import { newWorkspace } from "@/lib/workspace/flag"

export const Route = createFileRoute("/_app/")({ component: Home })

/** The welcome screen with the new workspace on (issue #209); the companies otherwise. */
export function Home() {
  return newWorkspace() ? <Welcome /> : <CompaniesHome />
}

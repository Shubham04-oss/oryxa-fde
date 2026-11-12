import { CompaniesHome } from "./companies-home"
import { Welcome } from "./workspace/welcome"
import { newWorkspace } from "@/lib/workspace/flag"

/** The welcome screen with the new workspace on (issue #209); the companies otherwise. */
export function Home() {
  return newWorkspace() ? <Welcome /> : <CompaniesHome />
}

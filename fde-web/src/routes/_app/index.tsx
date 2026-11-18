import { createFileRoute } from "@tanstack/react-router"
import { SignedIn } from "@/components/signed-in"

// The component lives in its own file: a route file that exports anything else is not split.
export const Route = createFileRoute("/_app/")({ component: SignedIn })

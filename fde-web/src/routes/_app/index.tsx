import { createFileRoute } from "@tanstack/react-router"
import { Home } from "@/components/home"

// The component lives in its own file: a route file that exports anything else is not split.
export const Route = createFileRoute("/_app/")({ component: Home })

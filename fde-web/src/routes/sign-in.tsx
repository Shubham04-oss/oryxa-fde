import { createFileRoute } from "@tanstack/react-router"
import { SignIn } from "@/components/sign-in"
import { safeReturnTo } from "@/lib/api/client"

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>) => ({
    return_to: safeReturnTo(search.return_to),
  }),
  component: SignInRoute,
})

function SignInRoute() {
  const { return_to } = Route.useSearch()
  return <SignIn returnTo={return_to} />
}

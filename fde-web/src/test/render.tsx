import { QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import type { AnyRouter } from "@tanstack/react-router"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"
import { resetMockApi } from "@/dev/mock-api"
import { createQueryClient } from "@/lib/session"

/**
 * Renders `ui` at the address `at`, on fresh sample data and a fresh cache, in a router where
 * every path renders it. Links and navigation work, and `router.state.location` says where they
 * went, so a component is tested against the same mock API as `pnpm dev:mock`. The query client
 * is the app's own, so a 401 sends the test to sign-in as it would the app.
 */
export function renderWithRouter(
  ui: ReactNode,
  {
    at = "/",
    signedIn = true,
    keep = false,
    ...mock
  }: {
    at?: string
    signedIn?: boolean
    /** Keep the sample data as it is: the test already called `resetMockApi` and changed it. */
    keep?: boolean
    engineer?: boolean
    empty?: boolean
  } = {},
) {
  if (!keep) resetMockApi({ signedIn, ...mock })
  const current: { router?: AnyRouter } = {}
  const queryClient = createQueryClient(() => current.router, {
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  })
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/" }),
    createRoute({ getParentRoute: () => root, path: "$" }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  current.router = router
  const view = render(
    <QueryClientProvider client={queryClient}>
      {/* The app registers its own route tree's type; this one accepts every path. */}
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
  return { ...view, router, queryClient }
}

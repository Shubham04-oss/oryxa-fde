import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"
import { resetMockApi } from "@/dev/mock-api"

/**
 * Renders `ui` at the address `at`, on fresh sample data and a fresh cache, in a router where
 * every path renders it. Links and navigation work, and `router.state.location` says where they
 * went, so a component is tested against the same mock API as `pnpm dev:mock`.
 */
export function renderWithRouter(
  ui: ReactNode,
  { at = "/", signedIn = true }: { at?: string; signedIn?: boolean } = {},
) {
  resetMockApi({ signedIn })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
  const view = render(
    <QueryClientProvider client={queryClient}>
      {/* The app registers its own route tree's type; this one accepts every path. */}
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
  return { ...view, router, queryClient }
}

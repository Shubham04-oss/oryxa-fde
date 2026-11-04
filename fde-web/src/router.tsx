import { createRouter } from "@tanstack/react-router"
import type { AnyRouter } from "@tanstack/react-router"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"
import { getGlobalStartContext } from "@tanstack/react-start"
import { routeTree } from "./routeTree.gen"
import { createQueryClient } from "./lib/session"

/**
 * The Worker's per-request CSP nonce (src/server.ts), so the scripts a server render writes may
 * run. Undefined in the browser, and when missing the policy blocks those scripts: it fails closed.
 */
export function requestNonce(): string | undefined {
  try {
    const context = getGlobalStartContext() as { nonce?: unknown } | undefined
    return typeof context?.nonce === "string" ? context.nonce : undefined
  } catch {
    return undefined
  }
}

export function getRouter() {
  // Start calls getRouter per request, so each SSR request gets its own cache.
  const current: { router?: AnyRouter } = {}
  const queryClient = createQueryClient(() => current.router, {
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    ssr: { nonce: requestNonce() },
  })
  current.router = router
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

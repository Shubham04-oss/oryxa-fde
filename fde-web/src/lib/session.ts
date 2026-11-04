import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"
import type { QueryClientConfig } from "@tanstack/react-query"
import type { AnyRouter } from "@tanstack/react-router"
import { ApiError, safeReturnTo } from "./api/client"

/**
 * The app's query client. A 401 on any read or write sends the FDE to sign-in, to come back to
 * the address they were at when the session was found gone, not where they first arrived.
 */
export function createQueryClient(
  router: () => AnyRouter | undefined,
  config: QueryClientConfig = {},
) {
  function onError(error: unknown) {
    if (!(error instanceof ApiError) || error.status !== 401) return
    const current = router()
    // Only a browser calls the API, and only a browser can be sent anywhere.
    if (!current || typeof window === "undefined") return
    const here = current.state.location
    if (here.pathname === "/sign-in") return
    void current.navigate({
      to: "/sign-in",
      search: { return_to: safeReturnTo(here.href) },
      replace: true,
    })
  }
  return new QueryClient({
    ...config,
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
  })
}

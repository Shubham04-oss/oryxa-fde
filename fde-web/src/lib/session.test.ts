import { describe, expect, it, vi } from "vitest"
import type { AnyRouter } from "@tanstack/react-router"
import { ApiError } from "./api/client"
import { createQueryClient } from "./session"

/** A router at `href`, recording where it is sent. */
function routerAt(href: string) {
  const navigate = vi.fn(async () => {})
  const pathname = href.split(/[?#]/)[0]
  const router = { state: { location: { href, pathname } }, navigate } as unknown as AnyRouter
  return { router, navigate }
}

const reject = (error: unknown) => () => Promise.reject(error)

describe("createQueryClient", () => {
  it("sends a 401 on any read to sign-in, back to where the FDE is now", async () => {
    const { router, navigate } = routerAt("/companies/cmp_1/projects/prj_1?tab=tasks")
    const client = createQueryClient(() => router, {
      defaultOptions: { queries: { retry: false } },
    })

    await client
      .fetchQuery({ queryKey: ["tasks"], queryFn: reject(new ApiError(401, "unauthorized")) })
      .catch(() => {})

    expect(navigate).toHaveBeenCalledWith({
      to: "/sign-in",
      search: { return_to: "/companies/cmp_1/projects/prj_1?tab=tasks" },
      replace: true,
    })
  })

  it("does the same for a 401 on a write", async () => {
    const { router, navigate } = routerAt("/today")
    const client = createQueryClient(() => router)

    await client
      .getMutationCache()
      .build(client, { mutationFn: reject(new ApiError(401, "unauthorized")) })
      .execute(undefined)
      .catch(() => {})

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { return_to: "/today" } }),
    )
  })

  it("leaves every other failure to the screen, and never loops on sign-in itself", async () => {
    const elsewhere = routerAt("/today")
    const client = createQueryClient(() => elsewhere.router, {
      defaultOptions: { queries: { retry: false } },
    })
    for (const error of [
      new ApiError(403, "forbidden"),
      new ApiError(500, "internal"),
      new TypeError(),
    ])
      await client.fetchQuery({ queryKey: [String(error)], queryFn: reject(error) }).catch(() => {})
    expect(elsewhere.navigate).not.toHaveBeenCalled()

    const signIn = routerAt("/sign-in?return_to=%2Ftoday")
    const onSignIn = createQueryClient(() => signIn.router, {
      defaultOptions: { queries: { retry: false } },
    })
    await onSignIn
      .fetchQuery({ queryKey: ["me"], queryFn: reject(new ApiError(401, "unauthorized")) })
      .catch(() => {})
    expect(signIn.navigate).not.toHaveBeenCalled()
  })
})

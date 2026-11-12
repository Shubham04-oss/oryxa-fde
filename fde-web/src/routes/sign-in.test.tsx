import { QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Route, tokenOf } from "./sign-in"
import { carried } from "@/components/auth/flow"
import { resetMockApi } from "@/dev/mock-api"
import { createQueryClient } from "@/lib/session"
import { LATER } from "@/lib/api/sign-in-api"
import type * as SignInModule from "@/lib/api/sign-in-api"

// The flag is a build-time constant; here it is switched per test, read live by the route.
const flag = vi.hoisted(() => ({ on: false }))
vi.mock("@/lib/api/sign-in-api", async (original) => {
  const real = await original<typeof SignInModule>()
  return {
    ...real,
    get ownSignIn() {
      return flag.on
    },
  }
})

const validate = (search: Record<string, unknown>) => {
  const fn = Route.options.validateSearch as (s: Record<string, unknown>) => unknown
  return fn(search)
}

/** The real `/sign-in` route (its own component and `validateSearch`) at `at`. */
function open(at: string) {
  resetMockApi({ signedIn: false })
  const queryClient = createQueryClient(() => undefined, {
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute()
  // The same path, so the same id: `Route.useSearch()` in the component finds this match.
  const signIn = createRoute({
    getParentRoute: () => root,
    path: "/sign-in",
    validateSearch: Route.options.validateSearch,
    component: Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([signIn]),
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
  return router
}

/** The ways in as this build has them: the served ones on, the ones still to come off. */
const SERVED = { ...LATER }

/** Turns on the emailed-link steps, as when their API routes are served. */
function withLinks() {
  beforeEach(() => {
    LATER.reset = true
    LATER.invite = true
  })
}

afterEach(() => {
  flag.on = false
  Object.assign(LATER, SERVED)
  carried.token = ""
  carried.tokenFor = null
})

describe("tokenOf", () => {
  it("keeps a plain token", () => {
    expect(tokenOf("reset-sample")).toBe("reset-sample")
    expect(tokenOf("A.b_c~d-9")).toBe("A.b_c~d-9")
    expect(tokenOf("x".repeat(512))).toBe("x".repeat(512))
  })

  it.each([
    ["a number", 12345],
    ["an array", ["abc"]],
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["513 characters", "x".repeat(513)],
    ["a slash", "abc/def"],
    ["a percent", "abc%2Fdef"],
    ["a space", "abc def"],
    ["a <", "abc<def"],
    ["a newline", "abc\ndef"],
  ])("refuses %s", (_, value) => {
    expect(tokenOf(value)).toBe("")
  })
})

describe("validateSearch, while the emailed-link routes are still to come", () => {
  it.each(["forgot", "reset", "invite"])("drops step=%s and any token", (step) => {
    expect(validate({ step, token: "t-1", return_to: "/today" })).toEqual({ return_to: "/today" })
  })

  it("keeps the steps the API serves, never with a token", () => {
    expect(validate({ step: "code", token: "t-1" })).toEqual({ step: "code", return_to: "/" })
    expect(validate({ step: "verify-email", token: "t-1" })).toEqual({
      step: "verify-email",
      return_to: "/",
    })
    expect(validate({ step: "organisation" })).toEqual({ step: "organisation", return_to: "/" })
  })
})

describe("validateSearch", () => {
  withLinks()

  it("keeps a known step, a known outcome, a good token and a local return_to", () => {
    expect(
      validate({ step: "reset", token: "t-1", error: "no_organisation", return_to: "/today?x=1" }),
    ).toEqual({ step: "reset", token: "t-1", error: "no_organisation", return_to: "/today?x=1" })
  })

  it("drops an unknown step, and the default step", () => {
    expect(validate({ step: "admin" })).toEqual({ return_to: "/" })
    expect(validate({ step: "password" })).toEqual({ return_to: "/" })
    expect(validate({ step: "__proto__" })).toEqual({ return_to: "/" })
  })

  it.each(["__proto__", "toString", "constructor", "hasOwnProperty", "unauthorized", ""])(
    "drops the error %j",
    (error) => {
      expect(validate({ error })).toEqual({ return_to: "/" })
    },
  )

  it("drops a bad token", () => {
    expect(validate({ step: "reset", token: "a/b" })).toEqual({ step: "reset", return_to: "/" })
    expect(validate({ step: "invite", token: 7 })).toEqual({ step: "invite", return_to: "/" })
  })

  it.each([
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
    "evil",
  ])("sends return_to %j home", (return_to) => {
    expect(validate({ return_to })).toEqual({ return_to: "/" })
  })
})

describe("the /sign-in route", () => {
  it("with the flag off, is today's sign-in, with the outcome explained and no password field", async () => {
    open("/sign-in?step=reset&token=t&error=no_organisation")

    expect(
      await screen.findByRole("heading", { name: "Sign in to your FDE workspace" }),
    ).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your account is not part of an organisation yet",
    )
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument()
    expect(document.querySelector("input[type=password]")).toBeNull()
    // With the flag off the token is neither read nor kept.
    expect(carried.token).toBe("")
  })

  it("with the flag on, shows the first screen for a reset link until its route is served", async () => {
    flag.on = true
    const router = open("/sign-in?step=reset&token=reset-sample&return_to=%2Ftoday")

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("token"))
    expect(router.state.location.href).not.toContain("reset-sample")
    expect(carried.token).toBe("")
  })

  it("with the flag on, reads a reset link's token and takes it out of the address", async () => {
    flag.on = true
    LATER.reset = true
    const router = open("/sign-in?step=reset&token=reset-sample&return_to=%2Ftoday")

    expect(await screen.findByLabelText("New password")).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("token"))
    expect(router.state.location.search).toEqual({ step: "reset", return_to: "/today" })
    expect(carried).toMatchObject({ token: "reset-sample", tokenFor: "reset" })
  })

  it("with the flag on, never offers one step's token to another", async () => {
    flag.on = true
    LATER.invite = true
    carried.token = "reset-sample"
    carried.tokenFor = "reset"
    open("/sign-in?step=invite")

    // No invite token: the invite screen says the link has expired, without asking the API.
    expect(await screen.findByRole("alert")).toHaveTextContent("This link has expired")
  })

  it("with the flag on, an outcome wins over any step", async () => {
    flag.on = true
    open("/sign-in?step=code&error=sso_required")
    expect(
      await screen.findByRole("heading", { name: "We could not finish signing you in" }),
    ).toBeInTheDocument()
  })
})

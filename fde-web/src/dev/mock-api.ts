// A stand-in for the FDE API, for `pnpm dev:mock` and the tests only, so sign-in and the signed-in
// page can be clicked through with no backend. It answers the spec's routes in the browser, typed
// from fde-api.gen.ts so it follows the spec, and keeps the one rule the screens depend on: a
// session. src/lib/api/client.ts loads it only in a dev build with VITE_FDE_MOCK_API=1;
// mock-excluded.test.ts proves a production build leaves it out.
//
// Sample data only: every person and organisation here is invented.

import type { Transport } from "../lib/api/client"
import type { components } from "../lib/api/fde-api.gen"
import { resetMockSignIn, signInRoutes } from "./mock-sign-in"

/** What the production-build test looks for. Logged once so it is never tree-shaken away. */
export const MOCK_MARKER = "fde-dev-mock-api"
if (import.meta.env.MODE !== "test") console.info(`[${MOCK_MARKER}] answering from sample data`)

// Kept for the tab, so a reload stays signed in. Delete it to see sign-in again.
const SESSION_KEY = "fde.mock.session"

const ADMIN: components["schemas"]["MeOut"] = {
  user: { id: "usr_riya", name: "Riya Kapoor" },
  organisation: { id: "org_northlight", name: "Northlight FDE" },
  role: "admin",
}

let me = ADMIN

/** Tests only: signed in or out, as an organisation admin or (`engineer: true`) a member. */
export function resetMockApi({
  signedIn = true,
  engineer = false,
}: { signedIn?: boolean; engineer?: boolean } = {}) {
  me = engineer ? { ...ADMIN, role: "member" } : ADMIN
  setSession(signedIn)
  resetMockSignIn()
}

function setSession(on: boolean) {
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, "1")
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Blocked storage: the mock session lasts until the next load.
  }
}

function hasSession() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1"
  } catch {
    return false
  }
}

const LATENCY_MS = import.meta.env.MODE === "test" ? 0 : 150

const refuse = (status: number, error: string) => Response.json({ error }, { status })

async function answer(request: Request): Promise<Response> {
  if (LATENCY_MS) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
  const { pathname } = new URL(request.url)
  const { method } = request
  if (pathname === "/auth/logout" && method === "POST") {
    setSession(false)
    resetMockSignIn()
    return new Response(null, { status: 204 })
  }
  const signedIn = await signInRoutes(pathname, method, request, setSession)
  if (signedIn) return signedIn
  if (!pathname.startsWith("/api/v1/")) return refuse(404, "not_found")
  if (!hasSession()) return refuse(401, "unauthorized")
  if (method === "GET" && pathname === "/api/v1/me") return Response.json(structuredClone(me))
  return refuse(404, "not_found")
}

export const mockApi: Transport = {
  fetch: answer,
  async signIn() {
    setSession(true)
  },
  /** Google, on the mock: it comes back at once, signed in. */
  async leave() {
    setSession(true)
  },
}

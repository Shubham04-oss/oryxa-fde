// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import server from "./server"

const page = vi.hoisted(() => vi.fn(() => new Response("<!doctype html>", { status: 200 })))
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: page } }))

describe("the Worker", () => {
  it("serves every path through the app, with the security headers", async () => {
    for (const path of ["/", "/today", "/companies/cmp_1", "/api/v1/companies"]) {
      // workers-types' Request carries Cloudflare's `cf` properties; the DOM one does not.
      const request = new Request(`https://fde.example.test${path}`) as Parameters<
        typeof server.fetch
      >[0]
      const response = await server.fetch(request)
      expect(response.status).toBe(200)
      expect(response.headers.get("X-Frame-Options")).toBe("DENY")
      expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'")
    }
    expect(page).toHaveBeenCalledTimes(4)
  })
})

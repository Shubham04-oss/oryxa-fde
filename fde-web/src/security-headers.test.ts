import { describe, expect, it } from "vitest"
import { securityHeaders, withSecurityHeaders } from "./security-headers"

const page = "https://fde.example.test/"

/** A policy's directives by name: `{ "default-src": ["'self'"], … }`. */
function directives(policy: string): Record<string, Array<string>> {
  return Object.fromEntries(
    policy.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/)
      return [name, sources]
    }),
  )
}

describe("securityHeaders", () => {
  const headers = securityHeaders(new URL(page))

  it("sets HSTS, nosniff, a referrer policy and frame protection", () => {
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains")
    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin")
    expect(headers["X-Frame-Options"]).toBe("DENY")
  })

  it("enforces a strict policy: this origin only, no eval, no framing, no plugins", () => {
    const policy = directives(headers["Content-Security-Policy"]!)

    expect(policy["default-src"]).toEqual(["'self'"])
    expect(policy["script-src"]).toEqual(["'self'", "'unsafe-inline'"])
    expect(policy["style-src"]).toEqual(["'self'", "'unsafe-inline'"])
    expect(policy["img-src"]).toEqual(["'self'", "data:"])
    expect(policy["font-src"]).toEqual(["'self'"])
    expect(policy["connect-src"]).toEqual(["'self'", "wss://fde.example.test"])
    expect(policy["frame-src"]).toEqual(["'none'"])
    expect(policy["frame-ancestors"]).toEqual(["'none'"])
    expect(policy["form-action"]).toEqual(["'self'"])
    expect(policy["object-src"]).toEqual(["'none'"])
    expect(policy["base-uri"]).toEqual(["'self'"])
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-eval")
    expect(headers["Content-Security-Policy"]).not.toContain("https:")
    // Enforced, not merely reported.
    expect(headers).not.toHaveProperty("Content-Security-Policy-Report-Only")
  })

  it("names the page's own socket origin, whatever host and scheme serve it", () => {
    const socketOf = (url: string) =>
      directives(securityHeaders(new URL(url))["Content-Security-Policy"]!)["connect-src"]

    expect(socketOf("https://fde.example.test:8443/x")).toContain("wss://fde.example.test:8443")
    expect(socketOf("http://localhost:3000/")).toContain("ws://localhost:3000")
  })

  it("sends HSTS only over https, where a browser reads it", () => {
    const plain = securityHeaders(new URL("http://localhost:3000/"))

    expect(plain["Strict-Transport-Security"]).toBeUndefined()
    expect(plain["X-Frame-Options"]).toBe("DENY")
    expect(plain["Content-Security-Policy"]).toBeDefined()
  })
})

describe("withSecurityHeaders", () => {
  const request = new Request(page)

  it("adds them to a page and keeps everything else about it", async () => {
    const original = new Response("<!doctype html><p>hi</p>", {
      status: 200,
      statusText: "Fine",
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    })

    const response = withSecurityHeaders(original, request)

    for (const [name, value] of Object.entries(securityHeaders(new URL(page)))) {
      expect(response.headers.get(name)).toBe(value)
    }
    expect(response.status).toBe(200)
    expect(response.statusText).toBe("Fine")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.text()).toBe("<!doctype html><p>hi</p>")
  })

  it("adds them to an API refusal, and to an answer with no body", async () => {
    const refusal = withSecurityHeaders(
      Response.json({ error: "session_ended" }, { status: 401 }),
      request,
    )
    const empty = withSecurityHeaders(new Response(null, { status: 204 }), request)

    for (const response of [refusal, empty]) {
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'")
    }
    expect(refusal.status).toBe(401)
    expect(await refusal.json()).toEqual({ error: "session_ended" })
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
  })

  it("sets its own over any the response came with", () => {
    const response = withSecurityHeaders(
      new Response("x", {
        headers: {
          "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "frame-ancestors *",
        },
      }),
      request,
    )

    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'")
  })

  it("keeps every Set-Cookie", () => {
    const original = new Response("x")
    original.headers.append("Set-Cookie", "a=1; Path=/; HttpOnly")
    original.headers.append("Set-Cookie", "b=2; Path=/; Secure")

    expect(withSecurityHeaders(original, request).headers.getSetCookie()).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; Secure",
    ])
  })

  it("copes with a redirect whose headers cannot be changed", () => {
    const redirect = Response.redirect("https://fde.example.test/sign-in", 302)
    expect(() => redirect.headers.set("X-Test", "1")).toThrow(TypeError)

    const response = withSecurityHeaders(redirect, request)

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("https://fde.example.test/sign-in")
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
  })
})

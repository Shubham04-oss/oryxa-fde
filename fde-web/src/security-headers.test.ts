// @vitest-environment node
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ASSET_POLICY, newNonce, securityHeaders, withSecurityHeaders } from "./security-headers"

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
  const headers = securityHeaders(new URL(page), "bm9uY2U=")

  it("sets HSTS, nosniff, a referrer policy and frame protection", () => {
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains")
    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin")
    expect(headers["X-Frame-Options"]).toBe("DENY")
  })

  it("sends no Referer from sign-in pages, which may carry an emailed link's token", () => {
    for (const path of ["/sign-in", "/sign-in?step=reset&token=t", "/sign-in/x"])
      expect(securityHeaders(new URL(path, page))["Referrer-Policy"]).toBe("no-referrer")
    for (const path of ["/", "/sign-inx", "/today?next=/sign-in"])
      expect(securityHeaders(new URL(path, page))["Referrer-Policy"]).toBe(
        "strict-origin-when-cross-origin",
      )
  })

  it("enforces a strict policy: this origin only, no eval, no framing, no plugins", () => {
    const policy = directives(headers["Content-Security-Policy"]!)

    expect(policy["default-src"]).toEqual(["'self'"])
    // Inline scripts run only with this response's nonce.
    expect(policy["script-src"]).toEqual(["'self'", "'nonce-bm9uY2U='"])
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

  it("allows no inline script at all without a nonce", () => {
    const policy = directives(securityHeaders(new URL(page))["Content-Security-Policy"]!)

    expect(policy["script-src"]).toEqual(["'self'"])
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

describe("newNonce", () => {
  it("is 128 random bits in base64, new every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce))

    expect(nonces.size).toBe(50)
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  })
})

describe("public/_headers", () => {
  /** The headers the file sets on every static asset. */
  function assetHeaders(): Record<string, string> {
    const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
    const lines = file.split("\n").filter((line) => line.trim() && !line.startsWith("#"))
    expect(lines[0]).toBe("/*")
    return Object.fromEntries(
      lines.slice(1).map((line) => {
        const at = line.indexOf(":")
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }),
    )
  }

  it("gives static assets the Worker's headers, with a policy that lets an asset do nothing", () => {
    const { "Content-Security-Policy": pagePolicy, ...rest } = securityHeaders(new URL(page))

    expect(pagePolicy).toBeDefined()
    expect(assetHeaders()).toEqual({ ...rest, "Content-Security-Policy": ASSET_POLICY })
    expect(directives(ASSET_POLICY)["default-src"]).toEqual(["'none'"])
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

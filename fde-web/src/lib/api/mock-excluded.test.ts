// @vitest-environment node
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { build } from "vite"
import type { Rollup } from "vite"
import { MOCK_MARKER } from "@/dev/mock-api"

/** Bundles the API client as `vite build` would for `nodeEnv`, with the mock's flag set. */
async function clientBundle(nodeEnv: "production" | "development") {
  const saved = { NODE_ENV: process.env.NODE_ENV, flag: process.env.VITE_FDE_MOCK_API }
  process.env.NODE_ENV = nodeEnv
  process.env.VITE_FDE_MOCK_API = "1"
  try {
    const output = (await build({
      configFile: false,
      root: fileURLToPath(new URL("../../..", import.meta.url)),
      mode: nodeEnv,
      logLevel: "silent",
      build: {
        lib: { entry: "src/lib/api/client.ts", formats: ["es"] },
        write: false,
        rollupOptions: { external: [/^@tanstack\//, "zod", "openapi-fetch"] },
      },
    })) as Rollup.RollupOutput | Array<Rollup.RollupOutput>
    return [output]
      .flat()
      .flatMap((result) => result.output)
      .map((file) => (file.type === "chunk" ? `${file.fileName}\n${file.code}` : ""))
      .join("\n")
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV
    if (saved.flag === undefined) delete process.env.VITE_FDE_MOCK_API
    else process.env.VITE_FDE_MOCK_API = saved.flag
  }
}

const SWITCHES = [
  "__fdeMockFailWrites",
  "__fdeMockNoCompanies",
  "__fdeMockStaleChecklist",
  "__fdeMockSomeoneElse",
  "__fdeMockPendingStep",
  // The sample sign-in accounts' password (src/dev/mock-sign-in.ts).
  "sample-password",
]

describe("the mock API", () => {
  it("is left out of a production build, even with its flag set", async () => {
    const code = await clientBundle("production")

    // The network transport ships instead: sign-in goes to AuthKit through the API.
    expect(code).toContain("/auth/login?return_to=")
    expect(code).not.toContain(MOCK_MARKER)
    expect(code).not.toContain("mock-api")
    // The dev and test switches live in the mock, so they go with it.
    for (const flag of SWITCHES) expect(code, flag).not.toContain(flag)
  }, 30_000)

  it("is in a development build, so the check above can fail", async () => {
    const code = await clientBundle("development")
    expect(code).toContain(MOCK_MARKER)
    for (const flag of SWITCHES) expect(code, flag).toContain(flag)
  }, 30_000)
})

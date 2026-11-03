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
        rollupOptions: { external: [/^@tanstack\//, "zod"] },
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

describe("the mock API", () => {
  it("is left out of a production build, even with its flag set", async () => {
    const code = await clientBundle("production")

    expect(code).toContain("api_not_connected")
    expect(code).not.toContain(MOCK_MARKER)
    expect(code).not.toContain("mock-api")
  }, 30_000)

  it("is in a development build, so the check above can fail", async () => {
    expect(await clientBundle("development")).toContain(MOCK_MARKER)
  }, 30_000)
})

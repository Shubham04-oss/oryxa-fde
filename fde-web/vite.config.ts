/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import { cloudflare } from "@cloudflare/vite-plugin"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Vitest runs in Node: the Cloudflare plugin refuses its SSR settings there.
const worker = process.env.VITEST ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } })]

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [...worker, tailwindcss(), tanstackStart(), viteReact()],
  test: {
    environment: "jsdom",
    // An origin, so jsdom gives the app localStorage and history.
    environmentOptions: { jsdom: { url: "http://localhost:3000/" } },
    setupFiles: ["./src/test/setup.ts"],
    // Components are tested against the same mock API as `pnpm dev:mock`.
    env: { VITE_FDE_MOCK_API: "1" },
  },
})

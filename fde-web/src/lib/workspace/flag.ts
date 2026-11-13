import { mockApiOn } from "@/lib/api/client"

type Env = { DEV: boolean; VITE_FDE_MOCK_API?: string; VITE_FDE_WORKSPACE?: string }

/**
 * Whether this build shows the new workspace (issue #209): the welcome screen at `/` and a new
 * company made in a conversation. Off unless the build sets `VITE_FDE_WORKSPACE=1`, like our own
 * sign-in screens; on, it works against the real API too (the new company is saved in one setup
 * call, issue #249). On the dev mock only, `globalThis.__fdeMockWorkspace = true` (set before the app
 * loads) turns it on for one tab, so `pnpm shots` can photograph both; a production build drops it.
 */
export function workspaceOn(env: Env, global: Record<string, unknown> = globalThis) {
  if (env.VITE_FDE_WORKSPACE === "1") return true
  return mockApiOn(env) && global.__fdeMockWorkspace === true
}

/** This build's answer, read when a screen renders. */
export function newWorkspace() {
  // `import.meta.env.DEV` is the literal `false` in a production build, so only the build flag is left.
  return workspaceOn({
    DEV: import.meta.env.DEV,
    VITE_FDE_MOCK_API: import.meta.env.VITE_FDE_MOCK_API as string | undefined,
    VITE_FDE_WORKSPACE: import.meta.env.VITE_FDE_WORKSPACE as string | undefined,
  })
}

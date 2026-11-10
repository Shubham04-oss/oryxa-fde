// `pnpm shots`: renders the screens in screens.mjs on the dev mock and writes PNGs, so a change to
// a screen can be looked at before review (DESIGN.md, "Looking at a screen").
//
//   pnpm shots [--out DIR] [--only NAME[,NAME]] [--url URL]
//
// It uses a `pnpm dev:mock` already running at --url (default http://127.0.0.1:3000), or starts one
// and stops it afterwards. The browser is Playwright's official Docker image, pinned below, run
// on the host network and thrown away afterwards: nothing is installed on the host, the repo has no
// Playwright dependency, and none of this is in the production build. PNGs go to --out (default
// `<tmpdir>/fde-shots`). Exits non-zero when a screen fails to render.
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, readdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

// Keep these two together: the image's browsers are the ones this Playwright version drives.
const PLAYWRIGHT = "1.56.1"
const IMAGE = `mcr.microsoft.com/playwright:v${PLAYWRIGHT}-noble`
// Containers are named with this prefix and the pid of the run that owns them.
const PREFIX = "fde-shots-"

const { values } = parseArgs({
  options: {
    out: { type: "string", default: path.join(tmpdir(), "fde-shots") },
    only: { type: "string", default: "" },
    url: { type: "string", default: "http://127.0.0.1:3000" },
  },
})
const out = path.resolve(values.out)
const here = path.dirname(fileURLToPath(import.meta.url))
const container = `${PREFIX}${process.pid}`
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" })

function removeOwn() {
  docker("rm", "--force", container)
}

/** Containers left by a run that was killed: theirs, named with a pid that is gone. */
function removeStale() {
  const listed = docker("ps", "--all", "--filter", `name=${PREFIX}`, "--format", "{{.Names}}")
  for (const name of listed.stdout.split("\n").filter((n) => /^fde-shots-\d+$/.test(n))) {
    const pid = Number(name.slice(PREFIX.length))
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch (error) {
      // EPERM: the process exists but is someone else's, so its container is not stale.
      alive = error.code === "EPERM"
    }
    if (!alive) docker("rm", "--force", name)
  }
}

async function reachable(url) {
  try {
    return (await fetch(`${url}/sign-in`, { signal: AbortSignal.timeout(3000) })).ok
  } catch {
    return false
  }
}

let server = null
function stopServer() {
  // The dev server is a process group (pnpm, vite, workerd): stop all of it.
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM")
    } catch {
      // Already gone.
    }
  }
  server = null
}

function cleanup() {
  removeOwn()
  stopServer()
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
process.on("exit", cleanup)

async function main() {
  if (docker("version", "--format", "{{.Server.Version}}").status !== 0)
    throw new Error("Docker is not running: pnpm shots needs it for the browser.")
  removeStale()

  if (!(await reachable(values.url))) {
    const { port, hostname } = new URL(values.url)
    console.log(`Starting the dev mock on ${values.url} ...`)
    // `dev:mock` on --url's host and port, via the app's own vite (pnpm may not be on PATH), in its own
    // process group so it can be stopped whole.
    server = spawn(
      path.join(here, "../../node_modules/.bin/vite"),
      ["dev", "--host", hostname, "--port", port || "3000", "--strictPort"],
      {
        env: { ...process.env, VITE_FDE_MOCK_API: "1" },
        stdio: "ignore",
        detached: true,
      },
    )
    server.on("exit", () => (server = null))
    server.on("error", () => (server = null))
    const until = Date.now() + 180_000
    while (!(await reachable(values.url))) {
      if (!server) throw new Error("The dev mock stopped before it answered.")
      if (Date.now() > until) throw new Error("The dev mock did not answer in 3 minutes.")
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  mkdirSync(out, { recursive: true })
  // The user's own cache, not the shared temp dir, where another user could plant a driver that runs.
  const cache = path.join(
    process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
    "fde-shots",
    PLAYWRIGHT,
  )
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  const config = JSON.stringify({
    url: values.url,
    out: "/out",
    only: values.only.split(",").filter(Boolean),
  })
  const install = `[ -d /pw/node_modules/playwright-core ] || npm install --prefix /pw --ignore-scripts --no-audit --no-fund --no-save playwright-core@${PLAYWRIGHT}`
  console.log(`Rendering in ${IMAGE} to ${out}`)
  const run = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      // Room for Chromium's shared memory without sharing the host's IPC namespace.
      "--shm-size=1g",
      "--network",
      "host",
      "--name",
      container,
      "--user",
      `${uid}:${gid}`,
      "-e",
      "HOME=/tmp",
      "-e",
      `FDE_SHOTS=${config}`,
      "-v",
      `${here}:/shots:ro`,
      "-v",
      `${out}:/out`,
      "-v",
      `${cache}:/pw`,
      IMAGE,
      "sh",
      "-c",
      `${install} && node /shots/capture.mjs`,
    ],
    { stdio: "inherit" },
  )
  const code = await new Promise((resolve) => run.on("exit", (c) => resolve(c ?? 1)))
  const pngs = readdirSync(out).filter((f) => f.endsWith(".png")).length
  console.log(`${pngs} PNGs in ${out}`)
  return code
}

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(error.message)
}
cleanup()
process.exit(code)

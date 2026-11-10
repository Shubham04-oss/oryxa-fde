import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import { chown, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { AGENT } from "./users.js";

/** Where a run's directories go: OpenCode's root-owned config under `config`, every run's home under `run`. */
export const RUN_ROOTS = { config: "/etc/oryxa", run: "/tmp" } as const;
/** Each backend's prefix for its runs' homes under `RUN_ROOTS.run`. */
export const HOME_PREFIXES = { claude: "oryxa-claude-", opencode: "oryxa-opencode-" } as const;
/** OpenCode's config directories under `RUN_ROOTS.config`; the context packs (`runs/`) are not run directories. */
export const CONFIG_PREFIX = "opencode-";

/** The agent's processes, as root sees them. */
export interface AgentProcesses {
  /** Live processes running as `agent` under any of their user ids. */
  list(): Promise<number[]>;
  /** Sends SIGKILL to every one of them. */
  killAll(): Promise<void>;
}

type Spawn = (command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;

/**
 * The agent's processes in the sandbox. `killAll` runs one `kill(-1)` as `agent`: the kernel signals every process of
 * that user in one pass that no fork can slip past, and a pid reused by another user's process is never hit.
 */
export function agentProcesses(spawn: Spawn = nodeSpawn, proc = "/proc"): AgentProcesses {
  return {
    list: () => agentPids(proc, AGENT.uid),
    killAll: async () => {
      const killer = spawn(process.execPath, ["-e", 'process.kill(-1, "SIGKILL")'], {
        uid: AGENT.uid,
        gid: AGENT.gid,
        env: {},
        cwd: "/",
        stdio: "ignore",
      });
      // Whether it worked is decided by `list`, not by how it exits: an agent process may have killed it first.
      await once(killer, "close").catch(() => {});
    },
  };
}

/**
 * Pids in `proc` with `uid` among their real, effective, saved and file system user ids. Zombies run nothing. Pid 1 is
 * the container's init, the image's `sleep infinity` (as `agent`, the image's user): the runtime starts it before any
 * run, nothing in the container can kill it, and kill(-1) never reaches it.
 */
export async function agentPids(proc: string, uid: number): Promise<number[]> {
  const pids: number[] = [];
  for (const name of await readdir(proc)) {
    // ponytail: init is trusted to be the image's; the image could start it as another user than `agent`.
    if (!/^[0-9]+$/.test(name) || name === "1") continue;
    let status: string;
    try {
      status = await readFile(join(proc, name, "status"), "utf8");
    } catch (cause) {
      // It ended between the listing and the read.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT" || (cause as NodeJS.ErrnoException).code === "ESRCH")
        continue;
      throw cause;
    }
    const uids = /^Uid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
    if (uids === undefined) throw new Error(`no user ids in the status of process ${name}`);
    const state = /^State:\s+(\S)/m.exec(status)?.[1];
    if (uids.includes(uid) && state !== "Z" && state !== "X") pids.push(Number(name));
  }
  return pids;
}

/** Kills the agent's processes until none is left, or throws: a run never starts beside one from an earlier run. */
export async function stopAgentProcesses(
  procs: AgentProcesses,
  { attempts = 5, waitMs = 200 }: { attempts?: number; waitMs?: number } = {},
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const left = await procs.list();
    if (left.length === 0) return;
    if (attempt === attempts) throw new Error(`${left.length} agent processes are still running`);
    await procs.killAll();
    await sleep(waitMs);
  }
}

/**
 * Removes every earlier run's directories. Names come from listing the two parents, so each path is one entry
 * directly under its parent, and `rm` removes a link itself, never what it points to.
 */
export async function removeRunDirs(roots: { config: string; run: string } = RUN_ROOTS): Promise<void> {
  const prefixes: [string, readonly string[]][] = [
    [roots.run, Object.values(HOME_PREFIXES)],
    [roots.config, [CONFIG_PREFIX]],
  ];
  for (const [parent, names] of prefixes)
    for (const name of await readdir(parent)) {
      if (!names.some((prefix) => name.startsWith(prefix))) continue;
      const path = join(parent, name);
      if (dirname(path) !== parent || basename(path) !== name) throw new Error(`not a run directory: ${name}`);
      await rm(path, { recursive: true, force: true });
    }
}

/**
 * Makes the sandbox clean for a run, as root, before the agent starts: first no process of `agent` is left, then no
 * earlier run's directories. In that order nothing of the agent's is alive from the cleanup until the harness starts
 * the agent itself, so nothing can race the removal or plant anything in the run's fresh directories.
 */
export async function startClean(
  procs: AgentProcesses = agentProcesses(),
  roots: { config: string; run: string } = RUN_ROOTS,
  limits?: Parameters<typeof stopAgentProcesses>[1],
): Promise<void> {
  await stopAgentProcesses(procs, limits);
  await removeRunDirs(roots);
}

/** The fresh directories under a run's home: XDG config, data, state and cache, and temp. */
const HOME_DIRS = [".config", ".local", ".local/share", ".local/state", ".cache", "tmp"];

/** A run's own home, fresh and owned by the agent. Runs as root. */
export async function freshHome(
  prefix: string,
  root: string = RUN_ROOTS.run,
  owner: (path: string) => Promise<void> = (path) => chown(path, AGENT.uid, AGENT.gid),
): Promise<string> {
  const home = await mkdtemp(join(root, prefix));
  const dirs = HOME_DIRS.map((dir) => join(home, dir));
  for (const dir of dirs) await mkdir(dir, { mode: 0o700 });
  // Home is handed over last: until then no agent process could plant a link in it for root's `chown` to follow.
  for (const dir of [...dirs.reverse(), home]) await owner(dir);
  return home;
}

/** Points everything a harness or a tool keeps between runs at the run's fresh home. */
export function homeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(home, "tmp"),
  };
}

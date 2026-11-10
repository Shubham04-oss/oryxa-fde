import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentProcesses,
  agentPids,
  agentProcesses,
  freshHome,
  HOME_PREFIXES,
  homeEnv,
  removeRunDirs,
  startClean,
  stopAgentProcesses,
} from "../src/clean.js";
import { AGENT } from "../src/users.js";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

// The raw `exit` syscall, which ends only the calling thread.
const SYS_EXIT = process.platform !== "linux" ? undefined : { x64: 60, arm64: 93 }[process.arch as string];
const hasPython = spawnSync("python3", ["-I", "-c", "import ctypes, threading"]).status === 0;

let root: string;
let roots: { config: string; run: string };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clean-"));
  roots = { config: join(root, "etc-oryxa"), run: join(root, "tmp") };
  await mkdir(join(roots.config, "runs"), { recursive: true });
  await mkdir(roots.run);
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** Agent processes that are gone once killed, or that survive every kill. */
function processes(alive: number[], survive = false): AgentProcesses & { kills: number } {
  let left = [...alive];
  return {
    kills: 0,
    list: async () => [...left],
    async killAll() {
      this.kills++;
      if (!survive) left = [];
    },
  };
}

describe("earlier runs' directories", () => {
  it("are all removed, and nothing else", async () => {
    // What earlier runs leave: OpenCode's database of transcripts, the Claude CLI's state, a root-owned config.
    const db = join(roots.run, "oryxa-opencode-AbC123", ".local/share/opencode");
    await mkdir(db, { recursive: true });
    await writeFile(join(db, "opencode.db"), "sample transcript");
    await mkdir(join(roots.run, "oryxa-claude-XyZ789/.claude"), { recursive: true });
    await writeFile(join(roots.run, "oryxa-claude-XyZ789/.claude.json"), "{}");
    await mkdir(join(roots.config, "opencode-Q1w2E3"));
    await writeFile(join(roots.config, "opencode-Q1w2E3/opencode.json"), "{}");
    // Not a run directory: the context packs, and anything else in /tmp.
    await writeFile(join(roots.config, "runs/run_sample_1.json"), "{}");
    await mkdir(join(roots.run, "oryxa-other"));
    await mkdir(join(roots.run, "opencode-not-here"));

    await removeRunDirs(roots);

    expect(await exists(join(roots.run, "oryxa-opencode-AbC123"))).toBe(false);
    expect(await exists(join(roots.run, "oryxa-claude-XyZ789"))).toBe(false);
    expect(await exists(join(roots.config, "opencode-Q1w2E3"))).toBe(false);
    expect(await readFile(join(roots.config, "runs/run_sample_1.json"), "utf8")).toBe("{}");
    expect(await exists(join(roots.run, "oryxa-other"))).toBe(true);
    expect(await exists(join(roots.run, "opencode-not-here"))).toBe(true);
  });

  it("lose a planted link without anything it points to being touched", async () => {
    const victim = join(root, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "keep"), "sample");
    // A link in /tmp named like a run directory, and links inside an earlier run's home, to a directory and a file.
    await symlink(victim, join(roots.run, "oryxa-opencode-link01"));
    const home = join(roots.run, "oryxa-claude-home01");
    await mkdir(join(home, ".cache"), { recursive: true });
    await symlink(victim, join(home, ".cache/dir-link"));
    await symlink(join(victim, "keep"), join(home, "file-link"));

    await removeRunDirs(roots);

    expect(await exists(join(roots.run, "oryxa-opencode-link01"))).toBe(false);
    expect(await exists(home)).toBe(false);
    expect(await readFile(join(victim, "keep"), "utf8")).toBe("sample");
  });

  it("are removed only once no agent process is left, and not at all while one is", async () => {
    await mkdir(join(roots.run, "oryxa-opencode-AbC123"));
    const stuck = processes([4242], true);
    await expect(startClean(stuck, roots, { attempts: 2, waitMs: 0 })).rejects.toThrow("still running");
    expect(await exists(join(roots.run, "oryxa-opencode-AbC123"))).toBe(true);

    const lingering = processes([4242]);
    await startClean(lingering, roots, { attempts: 2, waitMs: 0 });
    expect(lingering.kills).toBe(1);
    expect(await exists(join(roots.run, "oryxa-opencode-AbC123"))).toBe(false);
  });
});

describe("agent processes", () => {
  it("are killed once even when the scan finds none, so the kill does not rest on the scan", async () => {
    const none = processes([]);
    await stopAgentProcesses(none, { attempts: 3, waitMs: 0 });
    expect(none.kills).toBe(1);
  });

  it("are killed again until none is left, and the run refuses to start if one survives", async () => {
    let rounds = 0;
    // A process that forks a child just before it dies: the second kill gets the child.
    const forking: AgentProcesses = {
      list: async () => (rounds < 2 ? [100 + rounds] : []),
      killAll: async () => void rounds++,
    };
    await stopAgentProcesses(forking, { attempts: 3, waitMs: 0 });
    expect(rounds).toBe(2);
    const stuck = processes([4242], true);
    await expect(stopAgentProcesses(stuck, { attempts: 3, waitMs: 0 })).rejects.toThrow("still running");
    expect(stuck.kills).toBe(3);
  });

  it("are found in /proc by any of their user ids, pid 1 included, except zombies with no thread left running", async () => {
    const proc = join(root, "proc");
    const status = async (pid: string, uid: string, state = "S (sleeping)", threads: string | null = "1") => {
      await mkdir(join(proc, pid), { recursive: true });
      const lines = [`Name:\tsample`, `State:\t${state}`, ...(threads === null ? [] : [`Threads:\t${threads}`])];
      await writeFile(join(proc, pid, "status"), `${lines.join("\n")}\nUid:\t${uid}\nGid:\t0\t0\t0\t0\n`);
    };
    const a = AGENT.uid;
    // The container's init as `agent`, as the image ran it before #156: no pid is exempt, so it is listed.
    await status("1", `${a}\t${a}\t${a}\t${a}`);
    await status("19", "0\t0\t0\t0");
    await status("20", `${a}\t${a}\t${a}\t${a}`);
    // A setuid program the agent ran: root's effective id, the agent's real one.
    await status("21", `${a}\t0\t0\t0`);
    // An orphan waiting to be reaped runs nothing.
    await status("22", `${a}\t${a}\t${a}\t${a}`, "Z (zombie)");
    await status("23", `1002\t1002\t1002\t1002`);
    // A leader whose main thread exited alone shows as a zombie while its other threads run on.
    await status("25", `${a}\t${a}\t${a}\t${a}`, "Z (zombie)", "2");
    // No thread count to go by: alive.
    await status("26", `${a}\t${a}\t${a}\t${a}`, "Z (zombie)", null);
    await status("27", `${a}\t${a}\t${a}\t${a}`, "X (dead)", "garbled");
    // Gone between the listing and the read, and entries that are not processes.
    await mkdir(join(proc, "24"));
    await mkdir(join(proc, "net"));
    await writeFile(join(proc, "uptime"), "1 1");
    expect((await agentPids(proc, a)).sort((x, y) => x - y)).toEqual([1, 20, 21, 25, 26, 27]);
    // The image's init user is not the agent.
    await status("1", "1003\t1003\t1003\t1003");
    expect(await agentPids(proc, a)).not.toContain(1);
    await writeFile(join(proc, "19", "status"), "Name:\tsample\n");
    await expect(agentPids(proc, a)).rejects.toThrow("status");
  });

  it.skipIf(SYS_EXIT === undefined || !hasPython)(
    "include a real process whose main thread exited while another thread runs on",
    async () => {
      // The main thread leaves with the raw `exit` syscall, not `exit_group`: the leader shows as a zombie.
      const script = [
        "import ctypes, sys, threading, time",
        "threading.Thread(target=lambda: [time.sleep(0.05) for _ in iter(int, 1)]).start()",
        "ctypes.CDLL(None).syscall(int(sys.argv[1]), 0)",
      ].join("\n");
      const child = spawn("python3", ["-I", "-c", script, String(SYS_EXIT)], { stdio: "ignore" });
      const pid = child.pid ?? -1;
      const gone = new Promise((resolve) => child.once("exit", resolve));
      try {
        await vi.waitFor(
          async () => {
            const status = await readFile(`/proc/${pid}/status`, "utf8");
            expect(status).toMatch(/^State:\s+Z/m);
            expect(status).toMatch(/^Threads:\s+2$/m);
          },
          { timeout: 5000 },
        );
        expect(await agentPids("/proc", process.getuid?.() ?? -1)).toContain(pid);
      } finally {
        child.kill("SIGKILL");
      }
      await gone;
    },
  );

  it("include a real process left running, which is gone once killed", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const uid = process.getuid?.() ?? -1;
    const pid = child.pid ?? -1;
    const gone = new Promise((resolve) => child.once("exit", resolve));
    // Only this child: every process of the test's own user is the "agent" here.
    const lingering: AgentProcesses = {
      list: async () => (await agentPids("/proc", uid)).filter((p) => p === pid),
      killAll: async () => void child.kill("SIGKILL"),
    };
    expect(await lingering.list()).toEqual([pid]);
    await stopAgentProcesses(lingering, { attempts: 3, waitMs: 50 });
    await gone;
    expect(await lingering.list()).toEqual([]);
  });

  it("stop the run when pid 1 runs as agent, since no kill(-1) reaches it", async () => {
    const proc = join(root, "proc");
    await mkdir(join(proc, "1"), { recursive: true });
    const a = AGENT.uid;
    await writeFile(
      join(proc, "1", "status"),
      `Name:\tsleep\nState:\tS (sleeping)\nThreads:\t1\nUid:\t${a}\t${a}\t${a}\t${a}\n`,
    );
    await mkdir(join(roots.run, "oryxa-opencode-AbC123"));
    const init: AgentProcesses = { list: () => agentPids(proc, a), killAll: async () => {} };
    await expect(startClean(init, roots, { attempts: 2, waitMs: 0 })).rejects.toThrow("1 agent processes");
    expect(await exists(join(roots.run, "oryxa-opencode-AbC123"))).toBe(true);
  });

  it("are not waited on for ever when a process left running stops the killer", { timeout: 10_000 }, async () => {
    // The killer, stopped by a leftover agent process before it could signal anything.
    let exited: Promise<unknown[]> | undefined;
    const procs = agentProcesses(
      () => {
        const killer = spawn("sleep", ["30"], { stdio: "ignore" });
        exited = once(killer, "exit");
        killer.kill("SIGSTOP");
        return killer;
      },
      join(root, "proc"),
      100,
    );
    const started = Date.now();
    await procs.killAll();
    expect(Date.now() - started).toBeLessThan(5_000);
    // Root ends it, so it cannot run on after the scan.
    const [, signal] = (await exited) ?? [];
    expect(signal).toBe("SIGKILL");
  });

  it("are killed by one kill(-1) run as agent, so none can fork past it", async () => {
    const calls: unknown[] = [];
    const procs = agentProcesses(
      (command, args, options) => {
        calls.push({ command, args, options });
        const child = spawn("true");
        return child;
      },
      join(root, "proc"),
    );
    await procs.killAll();
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: ["-e", 'process.kill(-1, "SIGKILL")'],
        options: { uid: AGENT.uid, gid: AGENT.gid, env: {}, cwd: "/", stdio: "ignore" },
      },
    ]);
  });
});

describe("a run's home", () => {
  it("is fresh, owned by the agent, and handed over last", async () => {
    const owned: string[] = [];
    const home = await freshHome(HOME_PREFIXES.claude, roots.run, async (path) => void owned.push(path));
    expect(home.startsWith(join(roots.run, "oryxa-claude-"))).toBe(true);
    expect(owned).toHaveLength(7);
    expect(owned.every((p) => p.startsWith(home))).toBe(true);
    expect(owned.at(-1)).toBe(home);
    for (const path of owned) expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(await freshHome(HOME_PREFIXES.claude, roots.run, async () => {})).not.toBe(home);
  });

  it("holds the home, XDG and temp directories", () => {
    expect(homeEnv("/tmp/oryxa-claude-x")).toEqual({
      HOME: "/tmp/oryxa-claude-x",
      XDG_CONFIG_HOME: "/tmp/oryxa-claude-x/.config",
      XDG_DATA_HOME: "/tmp/oryxa-claude-x/.local/share",
      XDG_STATE_HOME: "/tmp/oryxa-claude-x/.local/state",
      XDG_CACHE_HOME: "/tmp/oryxa-claude-x/.cache",
      TMPDIR: "/tmp/oryxa-claude-x/tmp",
    });
  });
});

import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  it("are left alone when there are none", async () => {
    const none = processes([]);
    await stopAgentProcesses(none, { attempts: 3, waitMs: 0 });
    expect(none.kills).toBe(0);
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

  it("are found in /proc by any of their user ids, except zombies", async () => {
    const proc = join(root, "proc");
    const status = async (pid: string, uid: string, state = "S (sleeping)") => {
      await mkdir(join(proc, pid), { recursive: true });
      await writeFile(join(proc, pid, "status"), `Name:\tsample\nState:\t${state}\nUid:\t${uid}\nGid:\t0\t0\t0\t0\n`);
    };
    const a = AGENT.uid;
    // The container's init, the image's `sleep infinity` as `agent`: started before any run, and the kernel never
    // lets kill(-1) or the agent's own processes signal it.
    await status("1", `${a}\t${a}\t${a}\t${a}`);
    await status("19", "0\t0\t0\t0");
    await status("20", `${a}\t${a}\t${a}\t${a}`);
    // A setuid program the agent ran: root's effective id, the agent's real one.
    await status("21", `${a}\t0\t0\t0`);
    await status("22", `${a}\t${a}\t${a}\t${a}`, "Z (zombie)");
    await status("23", `1002\t1002\t1002\t1002`);
    // Gone between the listing and the read, and entries that are not processes.
    await mkdir(join(proc, "24"));
    await mkdir(join(proc, "net"));
    await writeFile(join(proc, "uptime"), "1 1");
    expect((await agentPids(proc, a)).sort()).toEqual([20, 21]);
    await writeFile(join(proc, "19", "status"), "Name:\tsample\n");
    await expect(agentPids(proc, a)).rejects.toThrow("status");
  });

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

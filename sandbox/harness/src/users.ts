import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/** The image's users (`sandbox/image/Dockerfile`): the agent's tools run as `agent`, the harness as `harness`. */
export const AGENT = { uid: 1001, gid: 1001 } as const;
export const HARNESS = { uid: 1002, gid: 1002 } as const;

export interface Privileges {
  getuid(): number;
  spawn(command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]): ChildProcess;
  setgroups(groups: number[]): void;
  setgid(id: number): void;
  setuid(id: number): void;
  diagnostics: NodeJS.WritableStream;
}

const nodePrivileges: Privileges = {
  getuid: () => process.getuid?.() ?? -1,
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  setgroups: (groups) => process.setgroups?.(groups),
  setgid: (id) => process.setgid?.(id),
  setuid: (id) => process.setuid?.(id),
  diagnostics: process.stderr,
};

/**
 * Starts the SDK's agent process as `agent`, then drops the harness from root to `harness` for good. The agent's
 * processes (its tool calls and anything they leave running) then run as another user than the harness: they cannot
 * open the harness's stdin through `/proc`, where approval decisions arrive, nor signal or trace it. Only one agent
 * process is started; the harness could not start another after the drop.
 */
export function agentSpawner(sys: Privileges = nodePrivileges): (options: SpawnOptions) => SpawnedProcess {
  let started = false;
  return ({ command, args, cwd, env, signal }) => {
    if (started) throw new Error("the agent process has already been started");
    started = true;
    if (sys.getuid() !== 0) throw new Error("the harness must start as root to run the agent as another user");
    // Fresh pipes for all three streams: the agent holds none of the harness's own descriptors.
    const child = sys.spawn(command, args, {
      cwd,
      env,
      signal,
      uid: AGENT.uid,
      gid: AGENT.gid,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The SDK reads stderr only from processes it spawns itself; these are diagnostics, never parsed.
    child.stderr?.pipe(sys.diagnostics, { end: false });
    try {
      sys.setgroups([]);
      sys.setgid(HARNESS.gid);
      sys.setuid(HARNESS.uid);
    } catch (cause) {
      child.kill("SIGKILL");
      throw cause;
    }
    return child as SpawnedProcess;
  };
}

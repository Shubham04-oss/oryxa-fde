import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { AGENT, agentSpawner, HARNESS, type Privileges } from "../src/users.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string | undefined;
  kill(signal: string) {
    this.killed = signal;
    return true;
  }
}

function system(uid: number, failOn?: "setuid") {
  const calls: string[] = [];
  const children: FakeChild[] = [];
  const diagnostics = new PassThrough();
  const sys: Privileges = {
    getuid: () => uid,
    spawn: (command, args, options) => {
      calls.push(
        `spawn ${command} ${args.join(" ")} as ${options?.uid}:${options?.gid} ${JSON.stringify(options?.stdio)}`,
      );
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<Privileges["spawn"]>;
    },
    setgroups: (groups) => void calls.push(`setgroups ${JSON.stringify(groups)}`),
    setgid: (id) => void calls.push(`setgid ${id}`),
    setuid: (id) => {
      if (failOn === "setuid") throw new Error("EPERM");
      calls.push(`setuid ${id}`);
    },
    diagnostics,
  };
  return { sys, calls, children, diagnostics };
}

const options = {
  command: "/opt/agent",
  args: ["--print"],
  cwd: "/workspace",
  env: {},
  signal: new AbortController().signal,
};

describe("agent spawner", () => {
  it("starts the agent as agent, with fresh pipes, then drops the harness to its own user", () => {
    const { sys, calls } = system(0);
    agentSpawner(sys)(options);
    expect(calls).toEqual([
      `spawn /opt/agent --print as ${AGENT.uid}:${AGENT.gid} ["pipe","pipe","pipe"]`,
      "setgroups []",
      `setgid ${HARNESS.gid}`,
      `setuid ${HARNESS.uid}`,
    ]);
    expect(HARNESS.uid).not.toBe(AGENT.uid);
  });

  it("starts one agent process only", () => {
    const { sys } = system(0);
    const spawn = agentSpawner(sys);
    spawn(options);
    expect(() => spawn(options)).toThrow("already");
  });

  it("refuses to run the agent as the harness's own user", () => {
    const { sys, calls } = system(AGENT.uid);
    expect(() => agentSpawner(sys)(options)).toThrow("root");
    expect(calls).toEqual([]);
  });

  it("kills the agent and fails when the harness cannot drop root", () => {
    const { sys, children } = system(0, "setuid");
    expect(() => agentSpawner(sys)(options)).toThrow("EPERM");
    expect(children[0]?.killed).toBe("SIGKILL");
  });

  it("passes the agent's diagnostics to stderr", async () => {
    const { sys, children, diagnostics } = system(0);
    agentSpawner(sys)(options);
    const seen = new Promise((resolve) => diagnostics.once("data", (d) => resolve(String(d))));
    children[0]?.stderr.write("warning\n");
    expect(await seen).toBe("warning\n");
  });
});

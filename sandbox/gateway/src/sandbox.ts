import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { Env } from "./env.js";
import { GatewayError } from "./errors.js";
import {
  execOptions,
  type ExecRequest,
  type ExecResult,
  type ExecStreamRequest,
  runBuffered,
  streamLines,
} from "./exec.js";
import { EMPTY_POLICY, OutboundPolicy } from "./policy.js";
import { type CompanyScope, sandboxName } from "./scope.js";

const POLICY_KEY = "outbound-policy";
const SCOPE_KEY = "scope";
const MAX_STDIN_WRITE = 1024 * 1024;

// `lite` and `basic` are too small for a coding agent, and the durable_object policy refuses `basic`.
export const InstanceType = z.enum(["standard-1", "standard-2", "standard-3", "standard-4"]);
export type InstanceType = z.infer<typeof InstanceType>;

export interface SandboxStatus {
  running: boolean;
}

export type SandboxContainer = Pick<
  Container,
  | "running"
  | "images"
  | "start"
  | "destroy"
  | "exec"
  | "setInactivityTimeout"
  | "interceptAllOutboundHttp"
  | "interceptOutboundHttps"
>;

/** One per company, named `<tenant>:<company>`; it owns the company's container and outbound policy. */
export class CompanySandbox extends DurableObject<Env> {
  readonly #stdin = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Each Durable Object instance sets the idle timeout again; it is not inherited across restarts.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(idleTimeoutMs(env)));
  }

  outboundPolicy(): OutboundPolicy {
    return OutboundPolicy.parse(this.ctx.storage.kv.get(POLICY_KEY) ?? EMPTY_POLICY);
  }

  setOutboundPolicy(scope: CompanyScope, policy: OutboundPolicy): OutboundPolicy {
    this.#bind(scope);
    const parsed = OutboundPolicy.parse(policy);
    this.ctx.storage.kv.put(POLICY_KEY, parsed);
    return parsed;
  }

  status(): SandboxStatus {
    return { running: this.container().running };
  }

  async start(scope: CompanyScope, instance: InstanceType): Promise<SandboxStatus> {
    this.#bind(scope);
    const outbound = this.ctx.exports.Outbound({ props: { tenant: scope.tenant, company: scope.company } });
    await startContainer(this.container(), scope, outbound, { instance, idleTimeoutMs: idleTimeoutMs(this.env) });
    return { running: true };
  }

  async stop(): Promise<SandboxStatus> {
    const container = this.container();
    if (container.running) await container.destroy();
    return { running: false };
  }

  exec(req: ExecRequest): Promise<ExecResult> {
    return runBuffered(this.#running(), req);
  }

  async execStream(req: ExecStreamRequest): Promise<ReadableStream<Uint8Array>> {
    const container = this.#running();
    const execId = crypto.randomUUID();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), req.timeoutMs);
    let process: ExecProcess;
    try {
      process = await container.exec(req.argv, execOptions(req, abort.signal, req.stdin));
    } catch (cause) {
      clearTimeout(timer);
      throw cause;
    }
    if (process.stdin !== null) this.#stdin.set(execId, process.stdin.getWriter());
    return streamLines(
      execId,
      process,
      () => abort.signal.aborted,
      () => {
        clearTimeout(timer);
        this.#stdin
          .get(execId)
          ?.close()
          .catch(() => {});
        this.#stdin.delete(execId);
      },
    );
  }

  async writeStdin(execId: string, data: Uint8Array): Promise<void> {
    const writer = this.#stdin.get(execId);
    if (writer === undefined) throw new GatewayError(404, "no running command with stdin has that id");
    if (data.byteLength > MAX_STDIN_WRITE) throw new GatewayError(413, "stdin write is too large");
    await writer.write(data);
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const response = await new Files(this.#running()).readFile(path);
    return response.body;
  }

  async writeFile(path: string, content: ReadableStream<Uint8Array>): Promise<void> {
    const files = new Files(this.#running());
    await files.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
    await files.writeFile(path, content);
  }

  /** The container attached to this object. A method, so tests can stand in a fake container. */
  container(): SandboxContainer {
    const container = this.ctx.container;
    if (container === undefined) throw new GatewayError(503, "no container is attached to this sandbox");
    return container;
  }

  #running(): SandboxContainer {
    const container = this.container();
    if (!container.running) throw new GatewayError(409, "the sandbox is not started");
    return container;
  }

  // A sandbox serves the first scope that used it, so a routing bug cannot point one company at another's sandbox.
  #bind(scope: CompanyScope): void {
    const name = sandboxName(scope);
    const bound = this.ctx.storage.kv.get<string>(SCOPE_KEY);
    if (bound === undefined) this.ctx.storage.kv.put(SCOPE_KEY, name);
    else if (bound !== name) throw new GatewayError(409, "this sandbox belongs to another company");
  }
}

export async function startContainer(
  container: SandboxContainer,
  scope: CompanyScope,
  outbound: Fetcher,
  options: { instance: InstanceType; idleTimeoutMs: number },
): Promise<void> {
  if (!container.running) {
    const image = container.images["sandbox"];
    if (image === undefined) throw new GatewayError(503, "the sandbox image is not configured");
    // No internet: only HTTP on 80 and HTTPS on 443 leave, and only through the intercepts below.
    container.start({
      image,
      instance: options.instance,
      enableInternet: false,
      labels: { tenant: scope.tenant, company: scope.company },
    });
  }
  // Intercepts last for this container run; installing them again on every start keeps the props current.
  await container.interceptAllOutboundHttp(outbound);
  await container.interceptOutboundHttps("*", outbound);
  await container.setInactivityTimeout(options.idleTimeoutMs);
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
// setInactivityTimeout() accepts at most six hours.
const MAX_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export function idleTimeoutMs(env: Pick<Env, "SANDBOX_IDLE_TIMEOUT_MS">): number {
  const ms = Number(env.SANDBOX_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS);
  return Number.isInteger(ms) && ms > 0 ? Math.min(ms, MAX_IDLE_TIMEOUT_MS) : DEFAULT_IDLE_TIMEOUT_MS;
}

export function defaultInstance(env: Pick<Env, "SANDBOX_INSTANCE">): InstanceType {
  return InstanceType.catch("standard-2").parse(env.SANDBOX_INSTANCE);
}

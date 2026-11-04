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
import {
  AGENT_USER,
  type Grant,
  type GrantRequest,
  harnessCommand,
  type HarnessRequest,
  packPath,
  ROOT_USER,
  sha256Hex,
} from "./runs.js";
import { type CompanyScope, sandboxName } from "./scope.js";

const POLICY_KEY = "outbound-policy";
const SCOPE_KEY = "scope";
const GRANT_PREFIX = "grant:";
/** The run whose harness this sandbox last started: only it may be granted anything. */
const HARNESS_RUN_KEY = "harness-run";
/**
 * Set from a harness's start until its process is seen to exit or the container stops. While set, no other harness
 * starts: a harness whose API task is gone (a deploy) keeps running until then, and a second one must never join
 * it. If the exit cannot be confirmed (waiting for it fails, or this object restarts), the sandbox must be stopped
 * first.
 */
const HARNESS_LIVE_KEY = "harness-live";
/**
 * The highest lease generation a call has carried. Every call that changes the sandbox carries its run's generation,
 * which the store raises whenever the sandbox passes to another run; a lower one is refused, so a run whose lease has
 * passed on can never touch the next run's container, however late its call arrives.
 */
const LEASE_KEY = "lease-generation";
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

  async start(scope: CompanyScope, instance: InstanceType, lease: number): Promise<SandboxStatus> {
    this.#bind(scope);
    this.#fence(lease);
    const outbound = this.ctx.exports.Outbound({ props: { tenant: scope.tenant, company: scope.company } });
    await startContainer(this.container(), scope, outbound, { instance, idleTimeoutMs: idleTimeoutMs(this.env) });
    return { running: true };
  }

  async stop(lease: number): Promise<SandboxStatus> {
    this.#fence(lease);
    const container = this.container();
    if (container.running) await container.destroy();
    // Approvals belong to the runs in this container; a new container starts with none.
    this.#closeAllGrants();
    this.ctx.storage.kv.delete(HARNESS_RUN_KEY);
    this.ctx.storage.kv.delete(HARNESS_LIVE_KEY);
    return { running: false };
  }

  exec(req: ExecRequest, lease: number): Promise<ExecResult> {
    this.#fence(lease);
    return runBuffered(this.#running(), req, AGENT_USER);
  }

  execStream(req: ExecStreamRequest, lease: number): Promise<ReadableStream<Uint8Array>> {
    this.#fence(lease);
    return this.#stream(req, AGENT_USER);
  }

  /**
   * Writes a run's context pack as root where only root can read it, then reads it back: the API compares this
   * digest with the pack it built before it starts the harness.
   */
  async writePack(scope: CompanyScope, run: string, pack: Uint8Array, lease: number): Promise<{ sha256: string }> {
    this.#bind(scope);
    this.#fence(lease);
    const files = new Files(this.#running());
    const path = packPath(run);
    await files.writeFile(path, pack, { user: ROOT_USER });
    const written = await files.readFile(path, { user: ROOT_USER });
    return { sha256: await sha256Hex(await written.arrayBuffer()) };
  }

  /**
   * Starts the harness as root on a written pack; it starts the agent as `agent` and then drops root itself. A new
   * run inherits no grant from an earlier one, and none starts while an earlier harness may still run.
   */
  async startHarness(
    scope: CompanyScope,
    run: string,
    req: HarnessRequest,
    lease: number,
  ): Promise<ReadableStream<Uint8Array>> {
    this.#bind(scope);
    this.#fence(lease);
    if (this.ctx.storage.kv.get<string>(HARNESS_LIVE_KEY) !== undefined)
      throw new GatewayError(409, "a harness may still be running in this sandbox; stop the sandbox first");
    const live = crypto.randomUUID();
    this.ctx.storage.kv.put(HARNESS_LIVE_KEY, live);
    this.#closeAllGrants();
    this.ctx.storage.kv.put(HARNESS_RUN_KEY, run);
    const exited = () => {
      if (this.ctx.storage.kv.get<string>(HARNESS_LIVE_KEY) === live) this.ctx.storage.kv.delete(HARNESS_LIVE_KEY);
    };
    // If starting it fails, it may still have started: it stays marked until the sandbox stops.
    return await this.#stream(harnessCommand(run, req), ROOT_USER, exited);
  }

  /**
   * Opens the hosts the outbound policy holds for `action` until the grant expires or is closed. An action no host
   * holds is refused: approving it would gate nothing at the network. So is a grant for any run but the one whose
   * harness is running here.
   */
  openGrant(scope: CompanyScope, action: string, req: GrantRequest, lease: number): Grant {
    this.#bind(scope);
    this.#fence(lease);
    if (!this.outboundPolicy().hosts.some((h) => h.approval === action))
      throw new GatewayError(409, "no host in the outbound policy is held for this action");
    if (this.ctx.storage.kv.get<string>(HARNESS_RUN_KEY) !== req.run)
      throw new GatewayError(409, "the grant's run is not the run whose harness is running");
    const grant = { action, approval: req.approval, run: req.run, expiresAt: Date.now() + req.ttlMs };
    this.ctx.storage.kv.put(`${GRANT_PREFIX}${action}`, grant);
    return grant;
  }

  /** Closes `action`'s grant if `approval` opened it; a later approval's grant stays open. */
  closeGrant(action: string, approval: string): void {
    const grant = this.ctx.storage.kv.get<Grant>(`${GRANT_PREFIX}${action}`);
    if (grant?.approval === approval) this.ctx.storage.kv.delete(`${GRANT_PREFIX}${action}`);
  }

  #closeAllGrants(): void {
    for (const [key] of this.ctx.storage.kv.list({ prefix: GRANT_PREFIX })) this.ctx.storage.kv.delete(key);
  }

  /** Whether an FDE's approval currently opens `action`'s hosts. */
  grantOpen(action: string): boolean {
    const grant = this.ctx.storage.kv.get<Grant>(`${GRANT_PREFIX}${action}`);
    return grant !== undefined && grant.expiresAt > Date.now();
  }

  async #stream(req: ExecStreamRequest, user: string, exited?: () => void): Promise<ReadableStream<Uint8Array>> {
    const container = this.#running();
    const execId = crypto.randomUUID();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), req.timeoutMs);
    let process: ExecProcess;
    try {
      process = await container.exec(req.argv, execOptions(req, abort.signal, req.stdin, user));
    } catch (cause) {
      clearTimeout(timer);
      throw cause;
    }
    if (process.stdin !== null) this.#stdin.set(execId, process.stdin.getWriter());
    // The process may outlive its reader: only its own, confirmed exit says it has ended. If waiting for it fails
    // (a dropped connection), it may still run, so it stays marked until the sandbox stops.
    if (exited !== undefined) void process.exitCode.then(exited, () => {});
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

  async writeStdin(execId: string, data: Uint8Array, lease: number): Promise<void> {
    this.#fence(lease);
    const writer = this.#stdin.get(execId);
    if (writer === undefined) throw new GatewayError(404, "no running command with stdin has that id");
    if (data.byteLength > MAX_STDIN_WRITE) throw new GatewayError(413, "stdin write is too large");
    await writer.write(data);
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const response = await new Files(this.#running()).readFile(path, { user: AGENT_USER });
    return response.body;
  }

  async writeFile(path: string, content: ReadableStream<Uint8Array>, lease: number): Promise<void> {
    this.#fence(lease);
    const files = new Files(this.#running());
    await files.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true, user: AGENT_USER });
    await files.writeFile(path, content, { user: AGENT_USER });
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

  // Checked in the same call as the change it guards, so no later run's call can come between the two.
  #fence(lease: number): void {
    const seen = this.ctx.storage.kv.get<number>(LEASE_KEY) ?? 0;
    if (lease < seen) throw new GatewayError(409, "a later run holds this sandbox");
    if (lease > seen) this.ctx.storage.kv.put(LEASE_KEY, lease);
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

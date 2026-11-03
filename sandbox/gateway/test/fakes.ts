import type { SandboxContainer } from "../src/sandbox.js";

export interface Intercept {
  kind: "http" | "https";
  addr: string;
  binding: Fetcher;
}

export interface FakeRun {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/** Stands in for `ctx.container` and records what the gateway asked of it. */
export class FakeContainer implements SandboxContainer {
  running = false;
  readonly images: Record<string, string> = { sandbox: "sandbox:test" };
  readonly started: ContainerStartupOptions[] = [];
  readonly intercepts: Intercept[] = [];
  readonly execs: { argv: string[]; options: ContainerExecOptions | undefined }[] = [];
  idleTimeoutMs: number | undefined;
  run: (argv: string[]) => FakeRun = () => ({ exitCode: 0 });

  start(options?: ContainerStartupOptions): void {
    if (options !== undefined) this.started.push(options);
    this.running = true;
  }

  async destroy(): Promise<void> {
    this.running = false;
  }

  async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
    this.idleTimeoutMs = Number(durationMs);
  }

  async interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    this.intercepts.push({ kind: "http", addr: "*", binding });
  }

  async interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    this.intercepts.push({ kind: "https", addr, binding });
  }

  async exec(argv: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    this.execs.push({ argv, options });
    if (options?.stdin === "pipe") return echoProcess();
    const { stdout = "", stderr = "", exitCode = 0 } = this.run(argv);
    return process(textStream(stdout), textStream(stderr), Promise.resolve(exitCode), null);
  }
}

export function textStream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

export async function readText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream === null ? "" : new Response(stream).text();
}

// Echoes stdin to stdout and exits 0 after reading "bye\n".
function echoProcess(): ExecProcess {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
  const exitCode = new Promise<number>((resolve) => (exit = resolve));
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      out.enqueue(chunk);
      if (new TextDecoder().decode(chunk) === "bye\n") {
        out.close();
        exit(0);
      }
    },
  });
  return process(stdout, textStream(""), exitCode, stdin);
}

function process(
  stdout: ReadableStream,
  stderr: ReadableStream,
  exitCode: Promise<number>,
  stdin: WritableStream | null,
): ExecProcess {
  return {
    stdin,
    stdout,
    stderr,
    pid: 1,
    isPty: false,
    exitCode,
    async output() {
      throw new Error("the gateway reads the streams itself");
    },
    kill() {},
    resize() {},
  };
}

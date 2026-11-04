import { z } from "zod";

export const WORKSPACE = "/workspace";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
export const MAX_BUFFERED_OUTPUT = 1024 * 1024;

// HTTPS leaves only through the outbound handler, which re-signs it with this ephemeral CA, and exec() does not
// inherit start()'s environment, so every command gets these. Callers cannot override them.
export const TRUST_ENV: Readonly<Record<string, string>> = {
  SSL_CERT_FILE: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  NODE_EXTRA_CA_CERTS: CA_PATH,
  REQUESTS_CA_BUNDLE: CA_PATH,
};

// Secrets never enter a sandbox. A caller bug that tries to pass one as an environment variable is refused here.
const CREDENTIAL_NAME = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)/i;

/** An absolute path inside the workspace, without `.`, `..` or empty segments. */
export function isWorkspacePath(path: string): boolean {
  if (path.includes("\0") || (path !== WORKSPACE && !path.startsWith(`${WORKSPACE}/`))) return false;
  return path
    .split("/")
    .slice(1)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const WorkspacePath = z
  .string()
  .max(4096)
  .refine(isWorkspacePath, `must be an absolute path under ${WORKSPACE}`);

const EnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "invalid environment variable name")
  .refine((name) => !CREDENTIAL_NAME.test(name), "credentials never enter a sandbox")
  .refine((name) => !Object.hasOwn(TRUST_ENV, name), "set by the gateway");

export const ExecRequest = z.strictObject({
  argv: z
    .array(
      z
        .string()
        .max(65_536)
        .regex(/^[^\0]*$/),
    )
    .min(1)
    .max(1_024),
  cwd: WorkspacePath.default(WORKSPACE),
  env: z
    .record(EnvName, z.string().max(65_536))
    .refine((env) => Object.keys(env).length <= 128, "at most 128 variables")
    .default({}),
  timeoutMs: z.int().min(1_000).max(MAX_TIMEOUT_MS).default(60_000),
});
export type ExecRequest = z.infer<typeof ExecRequest>;

/** A streamed command can also take stdin, written later with `writeStdin`. */
export const ExecStreamRequest = ExecRequest.extend({ stdin: z.boolean().default(false) });
export type ExecStreamRequest = z.infer<typeof ExecStreamRequest>;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export type ExecContainer = Pick<Container, "exec">;

/** `user` is `uid:gid`, always set: the image's default user is never relied on. */
export function execOptions(req: ExecRequest, signal: AbortSignal, stdin: boolean, user: string): ContainerExecOptions {
  return {
    cwd: req.cwd,
    env: { ...req.env, ...TRUST_ENV },
    user,
    signal,
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin ? { stdin: "pipe" as const } : {}),
  };
}

/** Runs a command to completion, keeping at most `maxBytes` of each stream. */
export async function runBuffered(
  container: ExecContainer,
  req: ExecRequest,
  user: string,
  maxBytes = MAX_BUFFERED_OUTPUT,
): Promise<ExecResult> {
  // Not AbortSignal.timeout(): it stays armed after the command exits. Clear the timer instead.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), req.timeoutMs);
  try {
    const process = await container.exec(req.argv, execOptions(req, abort.signal, false, user));
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(process.stdout, maxBytes),
      collect(process.stderr, maxBytes),
      process.exitCode.catch(() => null),
    ]);
    return {
      exitCode: abort.signal.aborted ? null : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut: abort.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type StreamLine =
  | { type: "started"; exec: string }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; code: number | null; timedOut: boolean };

/**
 * One JSON object per line: `started`, then `stdout`/`stderr` chunks as they arrive, then `exit`. `onExit` runs
 * once the process ends, before the stream closes.
 */
export function streamLines(
  execId: string,
  process: ExecProcess,
  timedOut: () => boolean,
  onExit: () => void,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (line: StreamLine) => writer.write(encoder.encode(`${JSON.stringify(line)}\n`));

  const pump = async (stream: ReadableStream | null, type: "stdout" | "stderr") => {
    if (stream === null) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream as ReadableStream<Uint8Array>) {
      const data = decoder.decode(chunk, { stream: true });
      if (data !== "") await write({ type, data });
    }
    const tail = decoder.decode();
    if (tail !== "") await write({ type, data: tail });
  };

  void (async () => {
    try {
      await write({ type: "started", exec: execId });
      await Promise.all([pump(process.stdout, "stdout"), pump(process.stderr, "stderr")]);
      const code = await process.exitCode.catch(() => null);
      await write({ type: "exit", code: timedOut() ? null : code, timedOut: timedOut() });
      await writer.close();
    } catch (cause) {
      await writer.abort(cause).catch(() => {});
    } finally {
      onExit();
    }
  })();
  return readable;
}

async function collect(stream: ReadableStream | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: "", truncated: false };
  const kept: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  // Keep draining after the cap, so a chatty command is not blocked on a full pipe.
  for await (const chunk of stream as ReadableStream<Uint8Array>) {
    const room = maxBytes - size;
    if (room <= 0) {
      truncated = true;
      continue;
    }
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    truncated ||= part.byteLength < chunk.byteLength;
    kept.push(part);
    size += part.byteLength;
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return { text: new TextDecoder().decode(all), truncated };
}

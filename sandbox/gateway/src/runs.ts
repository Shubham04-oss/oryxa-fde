import { z } from "zod";

import { MAX_TIMEOUT_MS, WORKSPACE } from "./exec.js";

/**
 * The image's users (`sandbox/image/Dockerfile`), as `uid:gid` for exec and the file API. Every command and file
 * operation the API asks for runs as `agent`. Only the two run routes below use root: one writes the context pack
 * where the agent cannot reach it, the other starts the harness, which drops root itself once the agent runs.
 */
export const AGENT_USER = "1001:1001";
export const ROOT_USER = "0:0";

/** Root-only (0700): the agent can neither read a pack nor replace one, including from a process left running. */
export const PACK_DIR = "/etc/oryxa/runs";
/** `oryxa_fde_agent::context::MAX_PACK_BYTES`. */
export const MAX_PACK_BYTES = 1024 * 1024;
const HARNESS = "/usr/local/bin/oryxa-harness";
const HARNESS_HOME = "/home/harness";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "must be 1..=128 chars of [A-Za-z0-9_-]");
export const RunId = Id;
/** The name on the approval list (`deploy`, `customer_send`), as `oryxa_fde_agent::ApprovalRule::action`. */
export const ApprovalAction = Id;

export function packPath(run: string): string {
  return `${PACK_DIR}/${RunId.parse(run)}.json`;
}

/** Starts the harness on a pack written earlier; its SHA-256 goes on the command line, out of the agent's reach. */
export const HarnessRequest = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256"),
  timeoutMs: z.int().min(1_000).max(MAX_TIMEOUT_MS),
});
export type HarnessRequest = z.infer<typeof HarnessRequest>;

export function harnessCommand(run: string, req: HarnessRequest) {
  return {
    argv: [HARNESS, "--pack", packPath(run), "--sha256", req.sha256],
    cwd: WORKSPACE,
    env: { HOME: HARNESS_HOME },
    timeoutMs: req.timeoutMs,
    stdin: true,
  };
}

const DEFAULT_GRANT_MS = 15 * 60 * 1_000;
const MAX_GRANT_MS = 60 * 60 * 1_000;

/** Opens the hosts the outbound policy holds for `action`, after an FDE approved request `approval`. */
export const GrantRequest = z.strictObject({
  approval: Id,
  ttlMs: z.int().min(1_000).max(MAX_GRANT_MS).default(DEFAULT_GRANT_MS),
});
export type GrantRequest = z.infer<typeof GrantRequest>;

export interface Grant {
  action: string;
  approval: string;
  expiresAt: number;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

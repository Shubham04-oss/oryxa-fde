import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.js";

// The assistant's limits (ADR 0008, "Limits"; issue #236). A refusal names which one it hit, and the web says
// so in plain words. Per organisation budgets wait for a real model.

/** Turns one person may start, across all their conversations, in a window. */
export const TURNS_PER_WINDOW = 10;
export const RATE_WINDOW_MS = 60_000;
/** Read-only tool calls one turn may make. */
export const MAX_TOOL_CALLS = 4;
/** Model steps one turn may take: each tool call needs one, and the answer one more. */
export const MAX_STEPS = MAX_TOOL_CALLS + 1;
/**
 * How long one turn may run, model and reads together. Past it the turn stops with a plain notice: the stream's
 * heartbeats would otherwise keep a stuck turn open, and the person's composer busy, for as long as it hangs.
 */
export const TURN_TIMEOUT_MS = 90_000;
/** The most bytes of a turn's request body (a message of `MAX_SAID` characters fits easily). */
export const MAX_BODY_BYTES = 16 * 1024;
/** The longest session header fde-web forwards. */
export const MAX_SESSION_BYTES = 16 * 1024;
/**
 * How long an idle conversation's working copy is kept. The record is the API's (ADR 0009); this copy is a
 * cache, deleted by an alarm once nobody has used it for this long.
 */
export const IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * One person's recent turns, named `<tenant>:<person>`, so the rate holds across their conversations. It stores
 * only timestamps, and its alarm deletes them once the window has passed.
 */
export class PersonTurns extends DurableObject<Env> {
  /** Counts a turn and answers true, or answers false when the window is full. */
  async take(now = Date.now()): Promise<boolean> {
    const recent = ((await this.ctx.storage.get<Array<number>>("turns")) ?? []).filter(
      (at) => at > now - RATE_WINDOW_MS,
    );
    if (recent.length >= TURNS_PER_WINDOW) return false;
    recent.push(now);
    await this.ctx.storage.put("turns", recent);
    await this.ctx.storage.setAlarm(now + RATE_WINDOW_MS);
    return true;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

import { z } from "zod";

import type { Binding } from "./auth.js";
import { parseBlocks } from "./catalogue/blocks.js";
import type { Block as BlockValue } from "./catalogue/blocks.js";
import {
  MAX_BLOCKS,
  MAX_PROPOSALS,
  MAX_REPLY,
  MAX_TURNS,
  Notice,
  Proposal,
  ProposalState,
  Said,
  TurnId,
} from "./catalogue/wire.js";
import type { Proposal as ProposalValue } from "./catalogue/wire.js";
import { API_ORIGIN } from "./tools.js";
import { mayPropose, mayShow } from "./turn.js";

// The record (ADR 0009, issue #279): every finished turn is written to the API's conversation, in Postgres in AWS,
// and a new object is rebuilt from it. The writes go over the API binding with the person's session, lent for the
// call that makes them and never kept. What is written is checked here first with the API's own rules
// (`crates/oryxa-fde-api/src/assistant.rs`), and test/record-shape.test.ts pins this shape to its openapi.json.

/** What fde-web lends for one call: the person's session, and its own origin, which the API asks of a write. */
export interface Lent {
  readonly session: string;
  readonly origin: string;
}

/** How a turn ends in the record (`FinishedState`); a live turn is never written. */
export const FINISHED = ["done", "failed"] as const;
/** What the person did with a proposal (`AnswerState`). */
export const ANSWERS = ["confirmed", "dismissed"] as const;
export type Answer = (typeof ANSWERS)[number];

const plain = (v: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
/** No lone surrogate: the API's JSON parser refuses one. */
const wellFormed = (v: string) => !/\p{Cs}/u.test(v);
/** Postgres' jsonb takes no NUL, in a key or a value; JSON text spells one only as this escape. */
const noNul = (v: unknown) => !JSON.stringify(v).includes("\\u0000");

/** What the person said, as stored: already trimmed, as the API trims it, and the wire's `Said`. */
const RecordSaid = z.string().refine((v) => v === v.trim() && Said.safeParse(v).success && wellFormed(v));
/** The reply: at most `MAX_REPLY` UTF-16 units, as the API counts (zod's `max` counts code points), plain text. */
const RecordText = z
  .string()
  .refine((v) => v.length <= MAX_REPLY)
  .refine(plain)
  .refine(wellFormed);

/** A finished turn exactly as the API's `TurnBody` takes it (`PUT .../turns/{n}`). */
export const TurnRecord = z
  .strictObject({
    id: TurnId,
    said: RecordSaid,
    text: RecordText,
    blocks: z.array(z.unknown()).max(MAX_BLOCKS),
    proposals: z.array(z.strictObject({ proposal: Proposal, state: z.literal("waiting") })).max(MAX_PROPOSALS),
    notice: Notice.nullable(),
    state: z.enum(FINISHED),
  })
  .refine((r) => new Set(r.proposals.map((p) => p.proposal.id)).size === r.proposals.length, "proposal ids")
  .refine((r) => r.blocks.length === parseBlocks(r.blocks).length, "blocks")
  .refine((r) => noNul(r.blocks) && noNul(r.proposals), "no NUL");
export type TurnRecord = z.infer<typeof TurnRecord>;

/** The API's answer body (`AnswerBody`). */
export const AnswerRecord = z.strictObject({ state: z.enum(ANSWERS) });

/** A turn of the working copy, folded. */
export interface Folded {
  readonly id: string;
  readonly said: string;
  readonly text: string;
  readonly blocks: ReadonlyArray<unknown>;
  readonly proposals: ReadonlyArray<unknown>;
  readonly notice: string | null;
  readonly state: string;
}

/**
 * Whether the record of a conversation in this scope takes `block`: the home conversation holds list-level
 * blocks only (`HOME_BLOCK_TYPES` in the API), and never a project's screen, which it cannot name.
 */
function recordable(home: boolean, value: BlockValue | ProposalValue): boolean {
  if (!noNul(value)) return false;
  if (!home) return true;
  if ("type" in value && value.type !== "suggestion") return false;
  return !names(value, "project");
}

/** Whether `value` holds a destination (an object with a `screen`, as the API finds them), of `screen` if given. */
function names(value: unknown, screen?: string): boolean {
  if (Array.isArray(value)) return value.some((v) => names(v, screen));
  if (typeof value !== "object" || value === null) return false;
  const s = (value as { screen?: unknown }).screen;
  if (s !== undefined && (screen === undefined || s === screen)) return true;
  return Object.values(value).some((v) => names(v, screen));
}

/**
 * The record of a finished turn: what was said and shown, each proposal `waiting` (only the answer route records an
 * answer), or null when it does not pass the API's rules. A part the scope's record does not take is left out of it.
 * ponytail: the home conversation shows a brief block the API's record does not take at home (issue #279).
 */
export function recordOf(turn: Folded, home: boolean): TurnRecord | null {
  const blocks = parseBlocks(turn.blocks).filter((b) => recordable(home, b));
  const proposals = turn.proposals.flatMap((raw) => {
    const p = Proposal.safeParse(raw);
    return p.success && recordable(home, p.data) ? [{ proposal: p.data, state: "waiting" as const }] : [];
  });
  const parsed = TurnRecord.safeParse({
    id: turn.id,
    said: turn.said,
    text: turn.text,
    blocks,
    proposals,
    notice: turn.notice,
    state: turn.state,
  });
  return parsed.success ? parsed.data : null;
}

/** The same record without any part that names a destination: what is left when the API refuses one it names. */
export function withoutDestinations(record: TurnRecord): TurnRecord {
  return {
    ...record,
    blocks: record.blocks.filter((b) => !names(b)),
    proposals: record.proposals.filter((p) => !names(p.proposal)),
  };
}

/** How many times a write is tried on a timeout or a 5xx, how long each may take, and the pause between. */
export const RECORD_TRIES = 3;
export const RECORD_TIMEOUT_MS = 10_000;
export const RECORD_BACKOFF_MS = 200;

export interface Tries {
  readonly tries?: number;
  readonly timeoutMs?: number;
  readonly backoffMs?: number;
}

const ERROR_CODE = /^[a-z_]{1,64}$/;

/** One call to the API as the person, tried again on a timeout, a dropped connection or a 5xx; null if none answered. */
async function send(
  api: Fetcher,
  method: "GET" | "PUT",
  path: string,
  lent: { session: string; origin?: string },
  body: unknown,
  { tries = RECORD_TRIES, timeoutMs = RECORD_TIMEOUT_MS, backoffMs = RECORD_BACKOFF_MS }: Tries,
): Promise<{ status: number; code: string | null; body: unknown } | null> {
  const headers: Record<string, string> = { accept: "application/json", cookie: lent.session };
  if (method === "PUT") {
    headers["content-type"] = "application/json";
    // The API's proof of a write from the web app, whose origin fde-web lent: the person's own write.
    headers["x-oryxa-request"] = "1";
    if (lent.origin !== undefined) headers.origin = lent.origin;
  }
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await api.fetch(
        new Request(`${API_ORIGIN}${path}`, {
          method,
          headers,
          ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      if (response.status < 500) {
        const answer: unknown = await response.json().catch(() => null);
        const error = (answer as { error?: unknown } | null)?.error;
        return {
          status: response.status,
          code: typeof error === "string" && ERROR_CODE.test(error) ? error : null,
          body: answer,
        };
      }
      await response.body?.cancel();
    } catch {
      // A timeout or a dropped connection: tried again, as a 5xx is.
    }
    if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
  }
  return null;
}

/**
 * What became of a write: `written` (stored now or before: the API answers the same turn again with 200), `later`
 * (no answer, or the session no longer lets it: kept and tried at the next turn), `full` (the conversation holds
 * all the turns it may), `destination` (it names a record the API refuses), or `refused` (anything else).
 */
export type Written = "written" | "later" | "full" | "destination" | "refused";

const turnsPath = (conversation: string) => `/v1/assistant/conversations/${conversation}`;

/** Writes one finished turn at place `n`, as the person. */
export async function writeTurn(
  api: Fetcher,
  lent: Lent,
  conversation: string,
  n: number,
  record: TurnRecord,
  tries: Tries = {},
): Promise<Written> {
  const got = await send(api, "PUT", `${turnsPath(conversation)}/turns/${n}`, lent, record, tries);
  if (got === null) return "later";
  if (got.status === 200 || got.status === 201) return "written";
  if (got.status === 409 && got.code === "rejected_turn_limit") return "full";
  if (got.status === 400 && got.code === "invalid_destination") return "destination";
  // Signed out, no longer allowed, gone or slowed down: nothing is wrong with the turn itself.
  if ([401, 403, 404, 429].includes(got.status)) return "later";
  return "refused";
}

/** Records the person's answer to proposal `proposal` of turn `n`. It only records: no action runs (ADR 0008). */
export async function writeAnswer(
  api: Fetcher,
  lent: Lent,
  conversation: string,
  n: number,
  proposal: string,
  state: Answer,
  tries: Tries = {},
): Promise<"recorded" | "later" | "dropped"> {
  const body = AnswerRecord.parse({ state });
  const got = await send(api, "PUT", `${turnsPath(conversation)}/turns/${n}/proposals/${proposal}`, lent, body, tries);
  if (got === null || got.status === 401 || got.status === 403 || got.status === 429) return "later";
  // 200, the same answer again included; anything else (answered the other way, not in the record) is not retried.
  return got.status === 200 ? "recorded" : "dropped";
}

/** A stored turn as the API reads it back (`TurnOut`), checked before it fills a working copy. */
const RecordedTurn = z.object({
  n: z.int().min(1).max(MAX_TURNS),
  id: TurnId,
  said: RecordSaid,
  text: RecordText,
  blocks: z.array(z.unknown()).max(MAX_BLOCKS),
  proposals: z.array(z.object({ proposal: z.unknown(), state: ProposalState })).max(MAX_PROPOSALS),
  notice: Notice.nullable().optional(),
  state: z.enum(FINISHED),
});
const RecordedConversation = z.object({
  conversation: z.object({ id: z.string() }),
  turns: z.array(RecordedTurn).max(MAX_TURNS),
});

export interface Rebuilt {
  readonly turns: ReadonlyArray<{
    n: number;
    id: string;
    said: string;
    text: string;
    blocks: Array<BlockValue>;
    proposals: Array<{ proposal: ProposalValue; state: z.infer<typeof ProposalState> }>;
    notice: z.infer<typeof Notice> | null;
    state: (typeof FINISHED)[number];
  }>;
}

/**
 * The conversation's record, read as the person: its turns in order, each block and proposal checked as the wire
 * checks them and as the conversation may show them; `gone` when the API does not know it for this person, and
 * `error` for anything else, a record out of order included, so nothing is guessed.
 */
export async function readRecord(
  api: Fetcher,
  session: string,
  binding: Binding,
  tries: Tries = {},
): Promise<Rebuilt | "gone" | "error"> {
  const got = await send(api, "GET", turnsPath(binding.conversation), { session }, null, tries);
  if (got === null) return "error";
  if (got.status === 404) return "gone";
  if (got.status !== 200) return "error";
  const parsed = RecordedConversation.safeParse(got.body);
  if (!parsed.success || parsed.data.conversation.id !== binding.conversation) return "error";
  if (parsed.data.turns.some((t, i) => t.n !== i + 1)) return "error";
  return {
    turns: parsed.data.turns.map((t) => ({
      ...t,
      notice: t.notice ?? null,
      blocks: parseBlocks(t.blocks).filter((b) => mayShow(binding, b)),
      proposals: t.proposals.flatMap(({ proposal, state }) => {
        const p = Proposal.safeParse(proposal);
        return p.success && mayPropose(binding, p.data) ? [{ proposal: p.data, state }] : [];
      }),
    })),
  };
}

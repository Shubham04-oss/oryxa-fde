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
import { TURN_TIMEOUT_MS } from "./limits.js";
import { API_ORIGIN } from "./tools.js";
import { mayPropose, mayShow } from "./turn.js";

// The record (ADR 0009, issue #279): every finished turn is written to the API's conversation, in Postgres in AWS,
// and a new object is rebuilt from it. The writes go over the API binding with the person's session, lent for the
// call that makes them, held in memory for a short while after it, and never kept. What is written is checked here
// first with the API's own rules (`crates/oryxa-fde-api/src/assistant.rs`); test/record-shape.test.ts pins the
// fields, enums and error codes to its openapi.json.

/**
 * What fde-web lends for one call: the person's session and, for a call that may write (a turn, an answer), its own
 * origin, which the API asks of a write made with a session. A view lends the session alone, to rebuild.
 */
export interface Lent {
  readonly session: string;
  readonly origin: string | null;
}

/** A lent session as the object holds it in memory: until `until` (ms since the epoch), and not a moment longer. */
export interface Held extends Lent {
  readonly until: number;
}

/** How long a lent session may still be used after the call that lent it has ended: long enough for its writes. */
export const LEND_GRACE_MS = 15_000;
/** A turn lends its session for as long as it may run, and the grace after it. */
export const TURN_LEND_MS = TURN_TIMEOUT_MS + LEND_GRACE_MS;

/** How a turn ends in the record (`FinishedState`); a live turn is never written. */
export const FINISHED = ["done", "failed"] as const;
/** What the person did with a proposal (`AnswerState`). */
export const ANSWERS = ["confirmed", "dismissed"] as const;
export type Answer = (typeof ANSWERS)[number];

/**
 * The block types the API's record takes (`BLOCK_TYPES`, and `HOME_BLOCK_TYPES` at home).
 * ponytail: openapi.json does not name these as an enum yet, so test/record-shape.test.ts cannot pin them (#280).
 */
export const HOME_BLOCK_TYPES = ["suggestion"] as const;

const plain = (v: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
/** No lone surrogate: the API's JSON parser refuses one. */
const wellFormed = (v: string) => !/\p{Cs}/u.test(v);

/**
 * Whether every string and key in `v` can be stored: no NUL (Postgres' jsonb takes none) and no lone surrogate (the
 * API's JSON parser refuses one, and a model can write one).
 */
export function storable(v: unknown): boolean {
  if (typeof v === "string") return !v.includes("\u0000") && wellFormed(v);
  if (Array.isArray(v)) return v.every(storable);
  if (typeof v === "object" && v !== null) return Object.entries(v).every(([k, x]) => storable(k) && storable(x));
  return true;
}

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
  .refine((r) => storable(r.blocks) && storable(r.proposals), "storable");
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
 * Whether the record of a conversation in this scope takes `value`: the home conversation holds list-level blocks
 * only, and never a project's screen, which it cannot name.
 */
function recordable(home: boolean, value: BlockValue | ProposalValue): boolean {
  if (!storable(value)) return false;
  if (!home) return true;
  if ("type" in value && !(HOME_BLOCK_TYPES as ReadonlyArray<string>).includes(value.type)) return false;
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
 * ponytail: the home record leaves out the brief block the home conversation shows, until the API takes it (#280).
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

/**
 * The same record without any part that names a destination: what is written when the API refuses one it names.
 * ponytail: every such part goes, not only the refused one, so the record may hold fewer cards than the person saw.
 */
export function withoutDestinations(record: TurnRecord): TurnRecord {
  return {
    ...record,
    blocks: record.blocks.filter((b) => !names(b)),
    proposals: record.proposals.filter((p) => !names(p.proposal)),
  };
}

/**
 * What is written in place of a turn whose content the API refuses, so its place is kept and the turns after it can
 * still be written: what the person said, and that the turn failed. Null when even that does not pass.
 */
export function fallbackOf(turn: Pick<Folded, "id" | "said">): TurnRecord | null {
  const parsed = TurnRecord.safeParse({
    id: turn.id,
    said: turn.said,
    text: "",
    blocks: [],
    proposals: [],
    notice: "failed",
    state: "failed",
  });
  return parsed.success ? parsed.data : null;
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

/** The API's error codes the Worker acts on (`put_turn` and `answer_proposal` in openapi.json name each). */
export const TURN_LIMIT = "rejected_turn_limit";
export const TURN_TAKEN = "rejected_turn_taken";
export const BAD_DESTINATION = "invalid_destination";
export const ANSWERED = "rejected_answered";

const ERROR_CODE = /^[a-z_]{1,64}$/;

/**
 * One call to the API as the person, tried again on a timeout, a dropped connection or a 5xx; null if none answered
 * or the session's time is up. No try starts, nor runs, past `held.until`.
 */
async function send(
  api: Fetcher,
  method: "GET" | "PUT",
  path: string,
  held: Pick<Held, "session" | "until"> & { origin?: string | null },
  body: unknown,
  { tries = RECORD_TRIES, timeoutMs = RECORD_TIMEOUT_MS, backoffMs = RECORD_BACKOFF_MS }: Tries,
): Promise<{ status: number; code: string | null; body: unknown } | null> {
  const headers: Record<string, string> = { accept: "application/json", cookie: held.session };
  if (method === "PUT") {
    if (held.origin === null || held.origin === undefined) return null;
    headers["content-type"] = "application/json";
    // The API's proof of a write from the web app, whose origin fde-web lent: the person's own write.
    headers["x-oryxa-request"] = "1";
    headers.origin = held.origin;
  }
  for (let attempt = 1; attempt <= tries; attempt++) {
    const left = held.until - Date.now();
    if (left <= 0) return null;
    try {
      const response = await api.fetch(
        new Request(`${API_ORIGIN}${path}`, {
          method,
          headers,
          ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
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
 * (no answer, the session's time is up, or it no longer lets the write: kept and tried with the next session),
 * `full` (the conversation holds all the turns it may), `taken` (another turn is at that place, or it is not the
 * next: the record is read again before anything more is written), `destination` (it names a record the API
 * refuses), or `refused` (the API refuses its content).
 */
export type Written = "written" | "later" | "full" | "taken" | "destination" | "refused";

const turnsPath = (conversation: string) => `/v1/assistant/conversations/${conversation}`;

/** Writes one finished turn at place `n`, as the person. */
export async function writeTurn(
  api: Fetcher,
  held: Held,
  conversation: string,
  n: number,
  record: TurnRecord,
  tries: Tries = {},
): Promise<Written> {
  const got = await send(api, "PUT", `${turnsPath(conversation)}/turns/${n}`, held, record, tries);
  if (got === null) return "later";
  if (got.status === 200 || got.status === 201) return "written";
  if (got.status === 409 && got.code === TURN_LIMIT) return "full";
  if (got.status === 409 && got.code === TURN_TAKEN) return "taken";
  if (got.status === 400 && got.code === BAD_DESTINATION) return "destination";
  // Signed out, no longer allowed, gone or slowed down: nothing is wrong with the turn itself.
  if ([401, 403, 404, 429].includes(got.status)) return "later";
  return "refused";
}

/** Records the person's answer to proposal `proposal` of turn `n`. It only records: no action runs (ADR 0008). */
export async function writeAnswer(
  api: Fetcher,
  held: Held,
  conversation: string,
  n: number,
  proposal: string,
  state: Answer,
  tries: Tries = {},
): Promise<"recorded" | "later" | "dropped"> {
  const body = AnswerRecord.parse({ state });
  const got = await send(api, "PUT", `${turnsPath(conversation)}/turns/${n}/proposals/${proposal}`, held, body, tries);
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
  conversation: z.object({ id: z.string(), company: z.string().nullable().optional() }),
  turns: z.array(RecordedTurn).max(MAX_TURNS),
});
/** Only the places and ids of the stored turns, to line the working copy up with the record again. */
const RecordedPlaces = z.object({
  conversation: z.object({ id: z.string() }),
  turns: z.array(z.object({ n: z.int().min(1).max(MAX_TURNS), id: TurnId })).max(MAX_TURNS),
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

/** Whether `turns` are numbered 1, 2, 3 and so on, as the record keeps them. */
const inOrder = (turns: ReadonlyArray<{ n: number }>) => turns.every((t, i) => t.n === i + 1);

/**
 * The conversation's record, read as the person: its turns in order, each block and proposal checked as the wire
 * checks them and as the conversation may show them; `gone` when the API does not know it for this person, and
 * `error` for anything else (another conversation or company, turns out of order, an id twice in a turn), so nothing
 * is guessed.
 */
export async function readRecord(
  api: Fetcher,
  held: Pick<Held, "session" | "until">,
  binding: Binding,
  tries: Tries = {},
): Promise<Rebuilt | "gone" | "error"> {
  const got = await send(api, "GET", turnsPath(binding.conversation), held, null, tries);
  if (got === null) return "error";
  if (got.status === 404) return "gone";
  if (got.status !== 200) return "error";
  const parsed = RecordedConversation.safeParse(got.body);
  if (!parsed.success) return "error";
  const { conversation, turns } = parsed.data;
  // fde-web checked this binding with the API on this call; the record is held to it all the same.
  if (conversation.id !== binding.conversation || (conversation.company ?? null) !== binding.company) return "error";
  if (!inOrder(turns)) return "error";
  const rebuilt = turns.map((t) => ({
    ...t,
    notice: t.notice ?? null,
    blocks: parseBlocks(t.blocks).filter((b) => mayShow(binding, b)),
    proposals: t.proposals.flatMap(({ proposal, state }) => {
      const p = Proposal.safeParse(proposal);
      return p.success && mayPropose(binding, p.data) ? [{ proposal: p.data, state }] : [];
    }),
  }));
  const twice = rebuilt.some((t) => new Set(t.proposals.map((p) => p.proposal.id)).size !== t.proposals.length);
  return twice ? "error" : { turns: rebuilt };
}

/** The places and ids of the record's turns, or null when they cannot be read or trusted. */
export async function readPlaces(
  api: Fetcher,
  held: Held,
  conversation: string,
  tries: Tries = {},
): Promise<Array<{ n: number; id: string }> | null> {
  const got = await send(api, "GET", turnsPath(conversation), held, null, tries);
  if (got === null || got.status !== 200) return null;
  const parsed = RecordedPlaces.safeParse(got.body);
  if (!parsed.success || parsed.data.conversation.id !== conversation || !inOrder(parsed.data.turns)) return null;
  return parsed.data.turns;
}

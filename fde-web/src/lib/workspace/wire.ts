import { z } from "zod"
import { Block, Destination, PartId, line, parseBlocks, text } from "./blocks"

// The assistant's wire format, version 1 (issue #236, ADR 0008): what the assistant Worker streams for
// one turn, and what it answers for a whole conversation. Like blocks.ts it is copied into the Worker
// (`assistant/scripts/catalogue.mjs`), so it imports nothing but zod and blocks.ts. The Worker checks each
// event before it stores it and the web checks it again before it renders: anything unknown or
// malformed is dropped, never guessed at.

export const WIRE_VERSION = 1

/** The longest message a person may send: the welcome box's own limit. */
export const MAX_SAID = 2000
/** The most text one reply may hold. */
export const MAX_REPLY = 8000
/** The most turns one conversation holds. */
export const MAX_TURNS = 50
/** The most blocks, and proposals, one reply may carry. */
export const MAX_BLOCKS = 6
export const MAX_PROPOSALS = 3
/** A company's name as the API takes it (`MAX_NAME` in `records.ts`). */
const MAX_NAME = 200

/** What the person said: plain text, several lines allowed. */
export const Said = text(MAX_SAID)

/** Part of a reply as it streams: any text but control characters other than tab and newline. */
const Delta = z
  .string()
  .min(1)
  .max(MAX_REPLY)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "plain text")

export const TurnId = z.string().regex(/^t_[A-Za-z0-9_-]{1,64}$/)

/**
 * A change the assistant proposes (ADR 0008): an action from this fixed catalogue, with its exact
 * arguments. Nothing runs until the person confirms; then the web calls the API's own route with
 * their session. A screen describes it from these arguments only, never from the model's words.
 */
export const Proposal = z.discriminatedUnion("action", [
  z.strictObject({
    id: PartId,
    action: z.literal("create_company"),
    args: z.strictObject({ name: line(MAX_NAME) }),
  }),
  z.strictObject({
    id: PartId,
    action: z.literal("open_route"),
    args: z.strictObject({ to: Destination }),
  }),
])
export type Proposal = z.infer<typeof Proposal>

/** Why a reply stopped short, which the screen says plainly. */
export const NOTICES = ["tool_limit", "reply_limit", "timed_out", "failed"] as const
export const Notice = z.enum(NOTICES)
export type Notice = z.infer<typeof Notice>

/** Why a turn was refused before it started (the error code of the refusal), said plainly too. */
export const REFUSALS = [
  "too_long",
  "rate_limited",
  "turn_limit",
  "busy",
  "model_unavailable",
] as const
export type Refusal = (typeof REFUSALS)[number]

/** One event of a turn's stream, in order: `turn` first, then text, blocks, proposals and notices. */
export const WireEvent = z.discriminatedUnion("type", [
  z.strictObject({ v: z.literal(WIRE_VERSION), type: z.literal("turn"), turn: TurnId, said: Said }),
  z.strictObject({ v: z.literal(WIRE_VERSION), type: z.literal("text"), delta: Delta }),
  z.strictObject({ v: z.literal(WIRE_VERSION), type: z.literal("block"), block: Block }),
  z.strictObject({ v: z.literal(WIRE_VERSION), type: z.literal("proposal"), proposal: Proposal }),
  z.strictObject({ v: z.literal(WIRE_VERSION), type: z.literal("notice"), notice: Notice }),
])
export type WireEvent = z.infer<typeof WireEvent>

/** One event, or null when it is unknown or malformed. */
export function parseEvent(input: unknown): WireEvent | null {
  const parsed = WireEvent.safeParse(input)
  return parsed.success ? parsed.data : null
}

export const PROPOSAL_STATES = ["waiting", "confirmed", "dismissed"] as const
export const ProposalState = z.enum(PROPOSAL_STATES)
export type ProposalState = z.infer<typeof ProposalState>

/** What the web tells the Worker once the person has answered a proposal. */
export const Settle = z.strictObject({ outcome: z.enum(["confirmed", "dismissed"]) })

/**
 * A conversation as the Worker holds it: each turn folded, and the live one, which a screen then
 * follows on its stream. Blocks and proposals are checked one by one, so a bad one is dropped
 * rather than the turn.
 */
export const ConversationView = z.strictObject({
  v: z.literal(WIRE_VERSION),
  turns: z
    .array(
      z.strictObject({
        id: TurnId,
        said: Said,
        state: z.enum(["live", "done", "failed"]),
        text: z.string().max(MAX_REPLY),
        blocks: z.array(z.unknown()).max(MAX_BLOCKS),
        proposals: z
          .array(z.strictObject({ proposal: z.unknown(), state: ProposalState }))
          .max(MAX_PROPOSALS),
        notice: Notice.nullable(),
      }),
    )
    .max(MAX_TURNS),
})

export type Turn = {
  id: string
  said: string
  state: "live" | "done" | "failed"
  text: string
  blocks: Array<Block>
  proposals: Array<{ proposal: Proposal; state: ProposalState }>
  notice: Notice | null
}

/** The conversation's turns, each block and proposal checked; null when the answer itself is malformed. */
export function parseView(input: unknown): Array<Turn> | null {
  const parsed = ConversationView.safeParse(input)
  if (!parsed.success) return null
  return parsed.data.turns.map((turn) => ({
    ...turn,
    blocks: parseBlocks(turn.blocks),
    proposals: turn.proposals.flatMap(({ proposal, state }) => {
      const checked = Proposal.safeParse(proposal)
      return checked.success ? [{ proposal: checked.data, state }] : []
    }),
  }))
}

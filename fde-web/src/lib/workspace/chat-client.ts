import { HEADERS, selected } from "@/lib/api/client"
import { followTurn, sendTurn } from "./assistant"
import type { Ended } from "./assistant"
import { z } from "zod"
import { ConversationId, ConversationList, parseChatEvent, parseChatView } from "./chat"
import type { ChatEvent, ChatTurn, ConversationSummary, Scope } from "./chat"

// The conversation prototype's calls (issue #263), over this app's `/assistant/*` routes like
// assistant.ts. The stream is read by assistant.ts's own reader, with the prototype's parser, so the
// caps, the deadline and resuming from `Last-Event-ID` are the welcome screen's. The list, a new
// conversation and stop are PROPOSED routes: only the dev mock answers them today.

const base = "/assistant/conversations"

async function send(target: string, init: RequestInit = {}) {
  const transport = await selected()
  return transport.fetch(new Request(`${globalThis.location.origin}${target}`, init))
}

const post = (target: string, body: unknown) =>
  send(target, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

/** The person's conversations, newest first; null when they could not be read. */
export async function listConversations(): Promise<Array<ConversationSummary> | null> {
  try {
    const response = await send(base)
    if (response.status !== 200) return null
    const parsed = ConversationList.safeParse(await response.json())
    return parsed.success ? parsed.data.conversations : null
  } catch {
    return null
  }
}

/** A new conversation bound to `scope`, its id; null when it could not be made. */
export async function startConversation(scope: Scope): Promise<string | null> {
  try {
    const response = await post(base, { scope })
    if (response.status !== 201) return null
    const body: unknown = await response.json()
    const parsed = z.object({ id: ConversationId }).safeParse(body)
    return parsed.success ? parsed.data.id : null
  } catch {
    return null
  }
}

/** A conversation's turns; null when it could not be read. */
export async function readConversation(id: string): Promise<Array<ChatTurn> | null> {
  try {
    const response = await send(`${base}/${id}`)
    if (response.status !== 200) return null
    return parseChatView(await response.json())
  } catch {
    return null
  }
}

export const sendChatTurn = (
  id: string,
  text: string,
  onEvent: (event: ChatEvent) => void,
): Promise<Ended> => sendTurn(id, text, onEvent, undefined, parseChatEvent)

export const followChatTurn = (id: string, turn: string, onEvent: (event: ChatEvent) => void) =>
  followTurn(id, turn, null, onEvent, undefined, parseChatEvent)

/** Asks the assistant to end a turn. The screen stops taking its events whatever this answers. */
export async function stopTurn(id: string, turn: string) {
  try {
    return (await post(`${base}/${id}/turns/${turn}/stop`, {})).status === 204
  } catch {
    return false
  }
}

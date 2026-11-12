import { describe, expect, it } from "vitest"
import { readStream } from "./assistant"
import { parseEvent, parseView } from "./wire"
import type { WireEvent } from "./wire"
import { MAX_NAME } from "@/lib/records"

// The web checks what the assistant sends before it renders it (ADR 0008): the Worker checked it too,
// but nothing it sends is trusted here either.

const brief = { type: "brief", items: [{ label: "Company", value: "Kestrel Logistics" }] }
const create = { id: "p_1", action: "create_company", args: { name: "Kestrel Logistics" } }

describe("wire events", () => {
  it("keep text, a block from the catalogue and a proposal from the catalogue", () => {
    expect(parseEvent({ v: 1, type: "text", delta: "Hello, " })).toEqual({
      v: 1,
      type: "text",
      delta: "Hello, ",
    })
    expect(parseEvent({ v: 1, type: "block", block: brief })).not.toBeNull()
    expect(parseEvent({ v: 1, type: "proposal", proposal: create })).not.toBeNull()
    const open = { id: "p_2", action: "open_route", args: { to: { screen: "today" } } }
    expect(parseEvent({ v: 1, type: "proposal", proposal: open })).not.toBeNull()
  })

  it("drop unknown and malformed blocks, events and versions", () => {
    for (const event of [
      { v: 1, type: "block", block: { type: "html", html: "<b>x</b>" } },
      { v: 1, type: "block", block: { type: "suggestion", id: "s", title: "No approve" } },
      { v: 1, type: "markup", html: "<script>alert(1)</script>" },
      { v: 2, type: "text", delta: "From a version we do not speak" },
      { v: 1, type: "text", delta: "bell\u0007" },
      { v: 1, type: "text", delta: "x", extra: "field" },
      null,
      "text",
    ])
      expect(parseEvent(event), JSON.stringify(event)).toBeNull()
  })

  it("drop a proposal outside the catalogue or with other arguments than it names", () => {
    for (const proposal of [
      { id: "p_1", action: "delete_company", args: { company: "cmp_1" } },
      { id: "p_1", action: "create_company", args: { name: "Acme", industry: "Extra" } },
      { id: "p_1", action: "create_company", args: { name: "x".repeat(MAX_NAME + 1) } },
      { id: "p_1", action: "create_company", args: { name: "Line\nbreak" } },
      { id: "p_1", action: "open_route", args: { to: { screen: "https://evil.example" } } },
      { id: "p_1", action: "open_route", args: { to: "/companies" } },
      { id: "p 1", action: "create_company", args: { name: "Acme" } },
    ])
      expect(parseEvent({ v: 1, type: "proposal", proposal }), JSON.stringify(proposal)).toBeNull()
    expect(
      parseEvent({
        v: 1,
        type: "proposal",
        proposal: { ...create, args: { name: "x".repeat(MAX_NAME) } },
      }),
    ).not.toBeNull()
  })

  it("in a conversation's view drop a bad block or proposal, not the turn", () => {
    const turns = parseView({
      v: 1,
      turns: [
        {
          id: "t_1",
          said: "Set up Kestrel",
          state: "done",
          text: "Here it is.",
          blocks: [{ type: "html" }, brief],
          proposals: [
            { proposal: { id: "p_x", action: "delete_company", args: {} }, state: "waiting" },
            { proposal: create, state: "waiting" },
          ],
          notice: null,
        },
      ],
    })
    expect(turns).toHaveLength(1)
    expect(turns![0]!.blocks).toEqual([brief])
    expect(turns![0]!.proposals).toEqual([{ proposal: create, state: "waiting" }])
    expect(parseView({ v: 2, turns: [] })).toBeNull()
  })
})

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      // In two pieces, split mid-frame, as a network delivers it.
      const bytes = new TextEncoder().encode(text)
      controller.enqueue(bytes.slice(0, 40))
      controller.enqueue(bytes.slice(40))
      controller.close()
    },
  })
const frame = (id: number, data: unknown) => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`

describe("a turn's stream", () => {
  it("hands on only the events that pass, and says how it ended", async () => {
    const got: Array<WireEvent> = []
    const read = await readStream(
      stream(
        frame(0, { v: 1, type: "turn", turn: "t_1", said: "Hello" }) +
          ": heartbeat\n\n" +
          frame(1, { v: 1, type: "text", delta: "Hi " }) +
          frame(2, { v: 1, type: "block", block: { type: "html", html: "<img src=x>" } }) +
          "id: 3\ndata: {not json\n\n" +
          frame(4, {
            v: 1,
            type: "proposal",
            proposal: { id: "p", action: "run_agent", args: {} },
          }) +
          frame(5, { v: 1, type: "proposal", proposal: create }) +
          "event: up-to-date\ndata: {}\n\n" +
          "event: done\ndata: {}\n\n",
      ),
      (event) => got.push(event),
    )
    expect(read).toEqual({ ended: "done", last: 5, turn: "t_1" })
    expect(got.map((e) => e.type)).toEqual(["turn", "text", "proposal"])
  })

  it("reports a failed turn, and a dropped connection with the last event it had", async () => {
    expect(
      await readStream(
        stream(
          `${frame(0, { v: 1, type: "text", delta: "a" })}event: error\ndata: {"reason":"failed"}\n\n`,
        ),
        () => {},
      ),
    ).toMatchObject({ ended: "failed" })
    expect(
      await readStream(
        stream(
          frame(0, { v: 1, type: "turn", turn: "t_9", said: "Hi" }) +
            frame(1, { v: 1, type: "text", delta: "a" }),
        ),
        () => {},
      ),
    ).toEqual({ ended: "dropped", last: 1, turn: "t_9" })
  })
})

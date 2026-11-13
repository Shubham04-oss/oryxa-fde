import { describe, expect, it } from "vitest"
import { MAX_PENDING, budget, readStream } from "./assistant"
import { MAX_BLOCKS, MAX_PROPOSALS, MAX_REPLY, parseEvent, parseView } from "./wire"
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

/** A stream that sends `text` and then stays open, sending a heartbeat every `everyMs` if given. */
const open = (text: string, everyMs?: number) => {
  let timer: ReturnType<typeof setInterval> | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      if (everyMs)
        timer = setInterval(
          () => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")),
          everyMs,
        )
    },
    cancel() {
      clearInterval(timer)
    },
  })
}
const turnFrame = frame(0, { v: 1, type: "turn", turn: "t_1", said: "Hello" })

describe("a turn's stream, held to the reply's own limits", () => {
  it("cuts it off at the reply's length, across the whole turn", async () => {
    const got: Array<WireEvent> = []
    const half = "a".repeat(MAX_REPLY / 2)
    const read = await readStream(
      open(
        turnFrame +
          frame(1, { v: 1, type: "text", delta: half }) +
          frame(2, { v: 1, type: "text", delta: half }) +
          frame(3, { v: 1, type: "text", delta: "!" }) +
          frame(4, { v: 1, type: "text", delta: "never" }),
      ),
      (event) => got.push(event),
    )
    expect(read).toEqual({ ended: "cut", last: 2, turn: "t_1" })
    expect(got.map((e) => e.type)).toEqual(["turn", "text", "text"])
  })

  it("cuts it off past the blocks or the proposals a reply may carry", async () => {
    const blocks: Array<WireEvent> = []
    const many = (n: number, data: unknown) =>
      Array.from({ length: n }, (_, i) => frame(i + 1, data)).join("")
    expect(
      await readStream(
        open(turnFrame + many(MAX_BLOCKS + 1, { v: 1, type: "block", block: brief })),
        (event) => blocks.push(event),
      ),
    ).toMatchObject({ ended: "cut", last: MAX_BLOCKS })
    expect(blocks.filter((e) => e.type === "block")).toHaveLength(MAX_BLOCKS)

    const proposals: Array<WireEvent> = []
    expect(
      await readStream(
        open(turnFrame + many(MAX_PROPOSALS + 1, { v: 1, type: "proposal", proposal: create })),
        (event) => proposals.push(event),
      ),
    ).toMatchObject({ ended: "cut", last: MAX_PROPOSALS })
    expect(proposals.filter((e) => e.type === "proposal")).toHaveLength(MAX_PROPOSALS)
  })

  it("counts what an earlier connection carried, so a reconnect cannot start the caps again", async () => {
    const given = budget()
    const block = (id: number) => frame(id, { v: 1, type: "block", block: brief })
    const first = Array.from({ length: MAX_BLOCKS }, (_, i) => block(i + 1)).join("")
    expect(await readStream(stream(turnFrame + first), () => {}, given)).toMatchObject({
      ended: "dropped",
    })
    expect(await readStream(open(block(MAX_BLOCKS + 1)), () => {}, given)).toMatchObject({
      ended: "cut",
    })
  })

  it("cuts off a frame that never ends instead of holding all of it", async () => {
    const got: Array<WireEvent> = []
    const read = await readStream(
      open(`${turnFrame}id: 1\ndata: "${"x".repeat(MAX_PENDING)}`),
      (e) => got.push(e),
    )
    expect(read).toEqual({ ended: "cut", last: 0, turn: "t_1" })
    expect(got.map((e) => e.type)).toEqual(["turn"])
  })

  it("counts the frame it holds in bytes, so text in another script is cut at the same size", async () => {
    // Three bytes a character: under the limit in characters, over it in bytes.
    const wide = "界".repeat(MAX_PENDING / 2)
    const read = await readStream(open(`${turnFrame}id: 1\ndata: "${wide}`), () => {})
    expect(read).toEqual({ ended: "cut", last: 0, turn: "t_1" })
  })
})

describe("a turn's stream, in time", () => {
  it("drops a connection that has gone quiet, heartbeats and all, so it can reconnect", async () => {
    const read = await readStream(open(turnFrame), () => {}, { ...budget(), idleMs: 20 })
    expect(read).toEqual({ ended: "dropped", last: 0, turn: "t_1" })
  })

  it("gives up on a turn past its deadline, even while heartbeats keep it open", async () => {
    const started = Date.now()
    const read = await readStream(open(turnFrame, 5), () => {}, {
      ...budget(),
      idleMs: 1_000,
      until: Date.now() + 60,
    })
    expect(read).toEqual({ ended: "timed_out", last: 0, turn: "t_1" })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

import { mockApi } from "@/dev/mock-api"

// Lets a test watch the API's writes, hold one on the wire, or have it refused, before the mock
// answers. The client reads `mockApi.fetch` when it first connects, so this wrapper is in place
// before any call. Call `useWire()` once at the top of a test file.

export type Wire = {
  /** Holds every write until it resolves. */
  hold: Promise<void> | null
  /** Answers every write with this, as the API would. */
  refuse: Response | null
  /** Holds every read's answer, already taken, so it arrives late with what was true when it was asked. */
  holdReads: Promise<void> | null
  /** Answers every read whose path ends with `ending` with `response`, as the API would (held like any read). */
  refuseReads: { ending: string; response: Response } | null
  /** Every write sent, in order. */
  sent: Array<{ method: string; path: string; body: unknown }>
  /** Each write's `Idempotency-Key` and exact body text, in the order sent (null for none). */
  keys: Array<{ key: string | null; text: string }>
  /** Lets the API act on this many writes, then loses each answer as a dropped connection does. */
  lose: number
  /** Lets the API act on every write, then holds its answer until this resolves or the caller gives up. */
  holdAnswers: Promise<void> | null
  /** The path of every read made, in order. */
  reads: Array<string>
}

export const wire: Wire = {
  hold: null,
  refuse: null,
  holdReads: null,
  refuseReads: null,
  sent: [],
  keys: [],
  lose: 0,
  holdAnswers: null,
  reads: [],
}

const answer = mockApi.fetch
const sendFile = mockApi.upload
let installed = false

export function resetWire() {
  wire.hold = null
  wire.refuse = null
  wire.holdReads = null
  wire.refuseReads = null
  wire.sent = []
  wire.keys = []
  wire.lose = 0
  wire.holdAnswers = null
  wire.reads = []
}

/** Puts the wrapper in place once. */
export function installWire() {
  if (installed) return
  installed = true
  mockApi.fetch = async (request) => {
    const write = request.method !== "GET"
    if (write) {
      const text = await request.clone().text()
      wire.sent.push({
        method: request.method,
        path: new URL(request.url).pathname.replace("/api/v1", ""),
        body: text ? (JSON.parse(text) as unknown) : null,
      })
      wire.keys.push({ key: request.headers.get("idempotency-key"), text })
    }
    if (!write) wire.reads.push(new URL(request.url).pathname.replace("/api/v1", ""))
    if (write && wire.hold) await wire.hold
    if (write && wire.refuse) return wire.refuse.clone()
    if (
      !write &&
      wire.refuseReads &&
      new URL(request.url).pathname.endsWith(wire.refuseReads.ending)
    ) {
      // A served answer arrives late too, when reads are held.
      if (wire.holdReads) await wire.holdReads
      return wire.refuseReads.response.clone()
    }
    const response = await answer(request)
    if (write && wire.lose > 0) {
      wire.lose -= 1
      throw new TypeError("Failed to fetch")
    }
    if (write && wire.holdAnswers) {
      const signal = request.signal
      await Promise.race([
        wire.holdAnswers,
        new Promise((_, reject) => {
          const gaveUp = () => reject(new DOMException("The operation was aborted.", "AbortError"))
          if (signal.aborted) gaveUp()
          signal.addEventListener("abort", gaveUp, { once: true })
        }),
      ])
    }
    if (!write && wire.holdReads) await wire.holdReads
    return response
  }
  // A file is a write too, but not JSON: what is recorded is what the API would see of it, never its bytes.
  mockApi.upload = async (request) => {
    const url = new URL(request.url)
    wire.sent.push({
      method: "POST",
      path: url.pathname.replace("/api/v1", ""),
      body: {
        name: url.searchParams.get("name"),
        contentType: request.headers["Content-Type"],
        csrf: request.headers["X-Oryxa-Request"],
        size: request.body.size,
      },
    })
    if (wire.hold) await wire.hold
    if (wire.refuse) return wire.refuse.clone()
    return sendFile(request)
  }
}

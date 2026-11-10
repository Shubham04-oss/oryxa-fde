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
  /** Answers every read whose path ends with `ending` with `response`, as the API would. */
  refuseReads: { ending: string; response: Response } | null
  /** Every write sent, in order. */
  sent: Array<{ method: string; path: string; body: unknown }>
  /** The path of every read made, in order. */
  reads: Array<string>
}

export const wire: Wire = {
  hold: null,
  refuse: null,
  holdReads: null,
  refuseReads: null,
  sent: [],
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
    }
    if (!write) wire.reads.push(new URL(request.url).pathname.replace("/api/v1", ""))
    if (write && wire.hold) await wire.hold
    if (write && wire.refuse) return wire.refuse.clone()
    if (
      !write &&
      wire.refuseReads &&
      new URL(request.url).pathname.endsWith(wire.refuseReads.ending)
    )
      return wire.refuseReads.response.clone()
    const response = await answer(request)
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

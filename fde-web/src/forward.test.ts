// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RETRY_PAUSE_MS, forward } from "./forward"

const APP = "https://fde.example.test"

/** An API that answers each call with the next of `answers`: a status, or an error it throws. */
function apiAnswering(...answers: Array<number | Error>) {
  const fetch = vi.fn(async (_request: Request) => {
    const answer = answers.shift() ?? 200
    if (answer instanceof Error) throw answer
    return Response.json({ status: answer }, { status: answer })
  })
  return { api: { fetch, origin: "http://api.internal" }, fetch }
}

/** Runs a forward to completion, letting the retry's pause pass, and returns its answer or what it threw. */
async function settle(call: Promise<Response>): Promise<Response | Error> {
  const outcome = call.then(
    (response) => response,
    (error: Error) => error,
  )
  await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS)
  return outcome
}

describe("forward's one retry", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const status of [502, 503, 504]) {
    it(`repeats a read that the link answered ${status}, once, after a pause`, async () => {
      const { api, fetch } = apiAnswering(status, 200)

      const call = forward(new Request(`${APP}/api/v1/companies?x=1`), "/v1/companies", api)
      await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS - 1)
      expect(fetch).toHaveBeenCalledTimes(1)
      const response = await settle(call)

      expect(fetch).toHaveBeenCalledTimes(2)
      expect((response as Response).status).toBe(200)
      expect(fetch.mock.calls[1]![0].url).toBe("http://api.internal/v1/companies?x=1")
    })
  }

  it("repeats a read whose connection failed, and a HEAD", async () => {
    const { api, fetch } = apiAnswering(new TypeError("network connection lost"), 200, 502, 200)

    const read = await settle(forward(new Request(`${APP}/api/v1/companies`), "/v1/companies", api))
    const head = await settle(
      forward(new Request(`${APP}/api/v1/companies`, { method: "HEAD" }), "/v1/companies", api),
    )

    expect((read as Response).status).toBe(200)
    expect((head as Response).status).toBe(200)
    expect(fetch.mock.calls.map(([request]) => request.method)).toEqual([
      "GET",
      "GET",
      "HEAD",
      "HEAD",
    ])
  })

  it("passes a second failure through unchanged", async () => {
    const { api, fetch } = apiAnswering(
      502,
      503,
      new TypeError("lost"),
      new TypeError("lost again"),
    )

    const answered = await settle(
      forward(new Request(`${APP}/api/v1/companies`), "/v1/companies", api),
    )
    const thrown = await settle(
      forward(new Request(`${APP}/api/v1/companies`), "/v1/companies", api),
    )

    expect(fetch).toHaveBeenCalledTimes(4)
    expect((answered as Response).status).toBe(503)
    expect(await (answered as Response).json()).toEqual({ status: 503 })
    expect((thrown as Error).message).toBe("lost again")
  })

  for (const status of [400, 401, 403, 404, 409, 429, 500]) {
    it(`never repeats a read the API answered ${status}`, async () => {
      const { api, fetch } = apiAnswering(status, 200)

      const response = await settle(
        forward(new Request(`${APP}/api/v1/companies`), "/v1/companies", api),
      )

      expect(fetch).toHaveBeenCalledTimes(1)
      expect((response as Response).status).toBe(status)
    })
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`never repeats a ${method}, whatever the link answered`, async () => {
      const { api, fetch } = apiAnswering(502, new TypeError("lost"), 200)
      const write = () =>
        new Request(`${APP}/api/v1/companies`, {
          method,
          headers: { Origin: APP, "Idempotency-Key": "k_1" },
          body: JSON.stringify({ name: "Kestrel" }),
        })

      const answered = await settle(forward(write(), "/v1/companies", api))
      const thrown = await settle(forward(write(), "/v1/companies", api))

      expect(fetch).toHaveBeenCalledTimes(2)
      expect((answered as Response).status).toBe(502)
      expect((thrown as Error).message).toBe("lost")
    })
  }

  // The path forward() is given is the API's: `/auth/x` from `/auth/x`, and also from `/api/auth/x`.
  const signIn = [
    "/auth/callback",
    "/auth/login",
    "/auth//callback",
    "//auth/callback",
    "/AUTH/callback",
    "/%61uth/callback",
    "/auth%2Fcallback",
    "/%E0%A4%A/callback",
  ]
  for (const path of signIn) {
    it(`never repeats a read of ${path}, whatever the link answered`, async () => {
      const { api, fetch } = apiAnswering(502, 503, 504, new TypeError("lost"), 200)
      const read = () => forward(new Request(`${APP}/auth/callback?code=c_1&state=s_1`), path, api)

      const answers = []
      for (let i = 0; i < 3; i++) answers.push(await settle(read()))
      const thrown = await settle(read())

      expect(fetch).toHaveBeenCalledTimes(4)
      expect(answers.map((answer) => (answer as Response).status)).toEqual([502, 503, 504])
      expect((thrown as Error).message).toBe("lost")
    })
  }

  it("still repeats a read whose path only starts like the sign-in routes", async () => {
    const { api, fetch } = apiAnswering(502, 200)

    const response = await settle(forward(new Request(`${APP}/api/authors`), "/authors", api))

    expect(fetch).toHaveBeenCalledTimes(2)
    expect((response as Response).status).toBe(200)
  })
})

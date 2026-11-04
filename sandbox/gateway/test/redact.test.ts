import { describe, expect, it } from "vitest";

import { redactResponse, redactStream, redactText } from "../src/redact.js";
import { readText, textStream } from "./fakes.js";

const SECRET = "sample-secret-0123456789";

describe("redaction", () => {
  it("replaces a secret split across chunks", async () => {
    for (const size of [1, 2, 3, 5, 8, 13, 64]) {
      const body = textStream(`a ${SECRET} b ${SECRET}${SECRET} c`, size);
      expect(await readText(redactStream(body, [SECRET])), `chunk size ${size}`).toBe(
        "a [redacted] b [redacted][redacted] c",
      );
    }
  });

  it("replaces several secrets and keeps a partial match", async () => {
    const other = "sample-other-secret";
    const body = textStream(`${other}:${SECRET}:sample-secret-01`, 4);
    expect(await readText(redactStream(body, [SECRET, other]))).toBe("[redacted]:[redacted]:sample-secret-01");
  });

  it("passes a body without secrets unchanged", async () => {
    const text = "x".repeat(10_000);
    expect(await readText(redactStream(textStream(text, 333), [SECRET]))).toBe(text);
  });

  it("redacts headers and drops the stale content length", async () => {
    const response = redactResponse(
      new Response(`token=${SECRET}`, { headers: { "x-echo": `Bearer ${SECRET}`, "content-length": "30" } }),
      [SECRET],
    );
    expect(response.headers.get("x-echo")).toBe("Bearer [redacted]");
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.text()).toBe("token=[redacted]");
  });

  it("ignores empty secrets", () => {
    expect(redactText("abc", [""])).toBe("abc");
  });
});

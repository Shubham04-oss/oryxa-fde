import { describe, expect, it } from "vitest";

import { sign } from "../src/sigv4.js";
import suite from "./fixtures/sigv4-suite.json";

interface Case {
  name: string;
  context: {
    credentials: { access_key_id: string; secret_access_key: string; token?: string };
    region: string;
    service: string;
    timestamp: string;
    sign_body: boolean;
    omit_session_token?: boolean;
  };
  request: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

// A request as the suite writes it: the request line, headers (a line starting with whitespace continues the one
// before), a blank line, then the body.
function parse(text: string) {
  const [head = "", body = ""] = text.split(/\n\n/, 2);
  const [line = "", ...rest] = head.split("\n");
  // The path can hold a space, so the target is everything between the method and the protocol.
  const method = line.slice(0, line.indexOf(" "));
  const target = line.slice(line.indexOf(" ") + 1, line.lastIndexOf(" HTTP/"));
  const headers: [string, string][] = [];
  for (const raw of rest) {
    if (raw === "") continue;
    const last = headers.at(-1);
    if (/^\s/.test(raw) && last !== undefined) last[1] += ` ${raw.trim()}`;
    else headers.push([raw.slice(0, raw.indexOf(":")), raw.slice(raw.indexOf(":") + 1)]);
  }
  const at = target.indexOf("?");
  return {
    method,
    path: at === -1 ? target : target.slice(0, at),
    query: at === -1 ? "" : target.slice(at + 1),
    headers,
    body: new TextEncoder().encode(body),
  };
}

describe("SigV4 against AWS's test suite", () => {
  const cases = (suite as { cases: Case[] }).cases;

  it("covers the suite", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of cases) {
    it(c.name, async () => {
      const signed = await sign(parse(c.request), {
        service: c.context.service,
        region: c.context.region,
        credentials: {
          accessKeyId: c.context.credentials.access_key_id,
          secretAccessKey: c.context.credentials.secret_access_key,
          sessionToken: c.context.credentials.token,
        },
        date: new Date(c.context.timestamp),
        signBody: c.context.sign_body,
        omitSessionToken: c.context.omit_session_token ?? false,
      });
      expect(signed.canonicalRequest).toBe(c.canonicalRequest);
      expect(signed.stringToSign).toBe(c.stringToSign);
      expect(signed.signature).toBe(c.signature);
      const authorization = signed.headers.find(([n]) => n === "authorization")?.[1];
      expect(authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, /,
      );
      expect(authorization).toContain(`Signature=${c.signature}`);
    });
  }
});

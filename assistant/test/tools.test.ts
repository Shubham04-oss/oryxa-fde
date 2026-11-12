import { describe, expect, it } from "vitest";

import type { Binding } from "../src/auth.js";
import { MAX_API_BYTES, MAX_TOOL_ANSWER_BYTES, READS, apiReader, companiesAnswer, todayAnswer } from "../src/tools.js";
import type { ReadPath } from "../src/tools.js";

const HOME: Binding = { conversation: "c_tools", tenant: "org_sample", person: "user_riya", company: null };
const SESSION = "__Host-fde_session=sample-session-for-the-reader";

/** An API binding that records each request and answers with `answer`. */
function api(answer: (request: Request) => Response = () => Response.json([])) {
  const seen: Array<Request> = [];
  const fetcher = {
    fetch: (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push(request);
      return Promise.resolve(answer(request));
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

describe("the API reader", () => {
  it("reads only the listed routes, as the person, from the API and nowhere else", async () => {
    const { fetcher, seen } = api();
    const read = apiReader(fetcher, SESSION);
    for (const path of READS) expect(await read(path)).toEqual([]);
    expect(seen.map((r) => r.url)).toEqual(["http://api.internal/v1/companies", "http://api.internal/v1/today"]);
    expect(seen.every((r) => r.method === "GET" && r.headers.get("cookie") === SESSION)).toBe(true);
    expect(seen.every((r) => r.redirect === "manual")).toBe(true);
  });

  it("refuses any other path without calling the API", async () => {
    const { fetcher, seen } = api();
    const read = apiReader(fetcher, SESSION);
    for (const path of ["/v1/companies/cmp_1/documents", "https://evil.example/", "//evil.example/v1/today"]) {
      expect(await read(path as ReadPath)).toBeNull();
    }
    expect(seen).toEqual([]);
  });

  it("answers null for a refusal, a redirect, an answer too large or not JSON, or no API at all", async () => {
    const answers = [
      () => Response.json({ error: "forbidden" }, { status: 403 }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      () => new Response(`"${"x".repeat(MAX_API_BYTES)}"`),
      () => new Response("<html>"),
    ];
    for (const answer of answers) expect(await apiReader(api(answer).fetcher, SESSION)("/v1/companies")).toBeNull();
    expect(await apiReader(undefined, SESSION)("/v1/companies")).toBeNull();
  });
});

describe("tool answers", () => {
  const companies = [
    {
      id: "cmp_a",
      name: "Kestrel",
      summary: "A record's own text",
      industry: "Logistics",
      projects: [{ id: "prj_1", name: "Dispatch", stage: "build" }],
    },
    { id: "cmp_b", name: "Harbor", projects: [] },
    { id: "bad id", name: "Dropped" },
  ];

  it("keep the companies list to names, projects and stages, and a company's conversation to its own", () => {
    expect(companiesAnswer(HOME, companies)).toEqual({
      found: [
        { id: "cmp_a", name: "Kestrel", projects: [{ id: "prj_1", name: "Dispatch", stage: "build" }] },
        { id: "cmp_b", name: "Harbor", projects: [] },
      ],
      truncated: false,
    });
    expect(companiesAnswer({ ...HOME, company: "cmp_b" }, companies)).toEqual({
      found: [{ id: "cmp_b", name: "Harbor", projects: [] }],
      truncated: false,
    });
    expect(companiesAnswer(HOME, null)).toEqual({ unreadable: true });
  });

  it("keep today's work to kinds, states and places, never a task's title or a request's text", () => {
    const where = { company: { id: "cmp_a", name: "Kestrel" }, project: { id: "prj_1", name: "Dispatch" } };
    const answer = todayAnswer(HOME, {
      items: [
        { kind: "task", task: { title: "Secret title", blocker: "Secret", status: "blocked", due_on: null }, ...where },
        {
          kind: "access_request",
          access: { description: "Secret text", status: "pending", days_waiting: 3 },
          owner: "Secret name",
          ...where,
        },
        { kind: "signal", ...where },
      ],
    });
    expect(answer).toEqual({
      found: [
        { kind: "task", status: "blocked", due_on: null, ...where },
        { kind: "access_request", status: "pending", days_waiting: 3, ...where },
      ],
      truncated: false,
    });
    expect(JSON.stringify(answer)).not.toContain("Secret");
  });

  it("are cut to their size limit, and say so", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `cmp_${i}`, name: "N".repeat(200), projects: [] }));
    const answer = companiesAnswer(HOME, many);
    expect("found" in answer && answer.truncated).toBe(true);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_TOOL_ANSWER_BYTES + 100);
  });

  it("counts the cap in bytes, so names in other scripts are cut to it too", () => {
    // 200 characters of three bytes each: under the cap in UTF-16 units, three times over it in bytes.
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `cmp_${i}`, name: "界".repeat(200), projects: [] }));
    expect(JSON.stringify(many).length).toBeLessThan(MAX_TOOL_ANSWER_BYTES);
    const answer = companiesAnswer(HOME, many);
    expect("found" in answer && answer.truncated).toBe(true);
    const found = "found" in answer ? answer.found : [];
    expect(found.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(found)).byteLength).toBeLessThanOrEqual(MAX_TOOL_ANSWER_BYTES);
  });
});

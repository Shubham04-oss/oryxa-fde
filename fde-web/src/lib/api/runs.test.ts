// @vitest-environment node
import { readFileSync } from "node:fs"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import type { components } from "./agent-runs.gen"
import * as R from "./runs"

type Spec = components["schemas"]

// The harness's recorded session, which the Rust contract test parses too.
const RECORDED = readFileSync(
  new URL("../../../../sandbox/harness/test/fixtures/session.events.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as unknown)

describe("run schemas", () => {
  // Checked by `pnpm typecheck`. The schemas are narrower than the spec where the spec says only "string"
  // (a run's state, a decision's outcome), so they must fit inside it and name the same fields.
  it("follow the agent run spec", () => {
    // Same fields as the spec, and every value the schema accepts is one the spec allows.
    type Run = z.input<typeof R.RunOut>
    expectTypeOf<keyof Run>().toEqualTypeOf<keyof Spec["RunOut"]>()
    expectTypeOf<Run>().toExtend<Spec["RunOut"]>()
    type Approval = z.input<typeof R.ApprovalOut>
    expectTypeOf<keyof Approval>().toEqualTypeOf<keyof Spec["ApprovalOut"]>()
    expectTypeOf<Approval>().toExtend<Spec["ApprovalOut"]>()
    expectTypeOf<z.input<typeof R.EventsOut>>().toEqualTypeOf<Spec["EventsOut"]>()
    expectTypeOf<z.input<typeof R.Repository>>().toEqualTypeOf<Spec["Repository"]>()
    expectTypeOf<z.input<typeof R.Usage>>().toEqualTypeOf<Spec["UsageOut"]>()
    expectTypeOf<z.input<typeof R.Delivery>>().toExtend<Spec["Delivery"]>()
    expectTypeOf<R.CreateRun>().toEqualTypeOf<Spec["CreateRun"]>()
  })
})

describe("harness events", () => {
  it("parse every line of the harness's recorded session", () => {
    const { events, skipped } = R.parseEvents(RECORDED)

    expect(skipped).toBe(0)
    expect(events).toHaveLength(RECORDED.length)
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(["message", "plan", "tool_call", "file_change", "command", "result"]),
    )
  })

  it("sum up what the review screen shows", () => {
    const summary = R.summarize(R.parseEvents(RECORDED).events)

    expect(summary.plan.every((entry) => entry.status === "completed")).toBe(true)
    expect(summary.changes).toEqual([
      { path: "/workspace/repo/src/server.mjs", change: "modified" },
      // Created, then edited: listed once, as created then modified, with its last change.
      { path: "/workspace/repo/test/healthz.test.mjs", change: "modified" },
    ])
    expect(summary.commands.map((c) => [c.command, c.status])).toEqual([
      ["cd repo && npm test", "failed"],
      ["cd repo && npm test", "completed"],
    ])
    expect(summary.result?.outcome).toBe("success")
    expect(summary.messages).toHaveLength(2)
  })

  it("count a line they cannot read instead of failing the run", () => {
    const { events, skipped } = R.parseEvents([
      { v: 1, seq: 0, type: "message", text: "hi" },
      { v: 1, seq: 1, type: "telemetry", data: 1 },
      { v: 2, seq: 2, type: "message", text: "from a newer harness" },
      "not an object",
    ])

    expect(events.map((e) => e.seq)).toEqual([0])
    expect(skipped).toBe(3)
  })

  it("merge stored and live lines once each, in order", () => {
    const [a, b, c] = R.parseEvents(RECORDED).events
    expect(R.mergeEvents([a!, c!], [b!, c!]).map((e) => e.seq)).toEqual([0, 1, 2])
  })
})

describe("pullRequestUrl", () => {
  const pr = (url: string): R.Delivery => ({ status: "pull_request", number: 7, url })

  it("links only to a pull request page on github.com", () => {
    expect(R.pullRequestUrl(pr("https://github.com/acme/app/pull/7"))).toBe(
      "https://github.com/acme/app/pull/7",
    )
    for (const bad of [
      "http://github.com/acme/app/pull/7",
      "https://github.com.evil.example/acme/app/pull/7",
      "https://evil.example/acme/app/pull/7",
      "javascript:alert(1)",
      "https://github.com/acme/app/pull/7/../../../settings",
      "not a url",
    ])
      expect(R.pullRequestUrl(pr(bad)), bad).toBeNull()
    expect(R.pullRequestUrl({ status: "no_changes" })).toBeNull()
  })
})

describe("what a run may start from", () => {
  const repo = (owner: string, name: string, base: string) => ({ owner, name, base })

  it("takes the repositories and branches the API takes", () => {
    expect(R.repositoryProblem(repo("kestrel-freight", "dispatch-copilot", "main"))).toBeNull()
    expect(R.repositoryProblem(repo("a", "x.y_z", "release/2026.11"))).toBeNull()
  })

  it("names the first part the API would refuse", () => {
    expect(R.repositoryProblem(repo("-acme", "app", "main"))).toBe("owner")
    expect(R.repositoryProblem(repo("acme-", "app", "main"))).toBe("owner")
    expect(R.repositoryProblem(repo("a".repeat(40), "app", "main"))).toBe("owner")
    expect(R.repositoryProblem(repo("acme", ".hidden", "main"))).toBe("name")
    expect(R.repositoryProblem(repo("acme", "app;rm", "main"))).toBe("name")
    for (const base of ["-x", "/x", ".x", "x/", "x.", "x.lock", "a..b", "a//b", "a/.b", "a b", ""])
      expect(R.repositoryProblem(repo("acme", "app", base)), base).toBe("base")
  })

  it("takes a task of plain text up to 64 KiB", () => {
    expect(R.taskOk("Add a test.\n\tThen open a pull request.")).toBe(true)
    expect(R.taskOk("   ")).toBe(false)
    expect(R.taskOk("x\u0000")).toBe(false)
    expect(R.taskOk("x".repeat(64 * 1024 + 1))).toBe(false)
  })
})

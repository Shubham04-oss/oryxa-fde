import { describe, expect, it } from "vitest";

import { ExecRequest, isWorkspacePath, runBuffered, TRUST_ENV } from "../src/exec.js";
import { FakeContainer } from "./fakes.js";

describe("exec requests", () => {
  it("keep paths inside the workspace", () => {
    for (const ok of ["/workspace", "/workspace/repo/src/a.ts", "/workspace/.oryxa/context.json"]) {
      expect(isWorkspacePath(ok), ok).toBe(true);
    }
    for (const bad of [
      "/",
      "/etc/passwd",
      "/workspace/../etc",
      "/workspace/./a",
      "/workspace//a",
      "/workspace/",
      "/workspaces/a",
      "workspace/a",
      "/workspace/a\0b",
    ]) {
      expect(isWorkspacePath(bad), bad).toBe(false);
    }
  });

  it("refuse credentials passed as environment variables", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "ANTHROPIC_API_KEY",
      "DB_PASSWORD",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "secret",
    ]) {
      expect(ExecRequest.safeParse({ argv: ["true"], env: { [name]: "x" } }).success, name).toBe(false);
    }
  });

  it("allow ordinary variables and refuse overriding the CA trust", () => {
    expect(
      ExecRequest.safeParse({ argv: ["true"], env: { AWS_REGION: "eu-west-1", MAX_TOKENS: "8", RUN_ID: "run_1" } })
        .success,
    ).toBe(true);
    expect(ExecRequest.safeParse({ argv: ["true"], env: { SSL_CERT_FILE: "/tmp/ca.pem" } }).success).toBe(false);
  });

  it("refuse an empty argv and unknown fields", () => {
    expect(ExecRequest.safeParse({ argv: [] }).success).toBe(false);
    expect(ExecRequest.safeParse({ argv: ["true"], user: "root" }).success).toBe(false);
  });
});

describe("buffered exec", () => {
  it("returns output and exit code, and runs with the CA trust", async () => {
    const container = new FakeContainer();
    container.run = () => ({ stdout: "hello\n", stderr: "warn\n", exitCode: 3 });
    const result = await runBuffered(
      container,
      ExecRequest.parse({ argv: ["sh", "-c", "echo hello"], env: { RUN_ID: "r1" } }),
    );
    expect(result).toEqual({ exitCode: 3, stdout: "hello\n", stderr: "warn\n", truncated: false, timedOut: false });
    expect(container.execs[0]?.options?.env).toEqual({ RUN_ID: "r1", ...TRUST_ENV });
    expect(container.execs[0]?.options?.cwd).toBe("/workspace");
  });

  it("caps each stream", async () => {
    const container = new FakeContainer();
    container.run = () => ({ stdout: "x".repeat(100) });
    const result = await runBuffered(container, ExecRequest.parse({ argv: ["yes"] }), 10);
    expect(result.stdout).toBe("x".repeat(10));
    expect(result.truncated).toBe(true);
  });
});

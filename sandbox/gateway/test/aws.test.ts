import { describe, expect, it, vi } from "vitest";

import {
  AssumeRoleSource,
  CredentialsUnavailable,
  MIN_VALIDITY_MS,
  parseAssumeRole,
  REFRESH_BEFORE_MS,
} from "../src/aws.js";
import { companyScope } from "../src/scope.js";
import { DevSecretResolver } from "../src/secrets.js";
import { sign } from "../src/sigv4.js";

const A = companyScope("org_a", "cmp_1");
const B = companyScope("org_b", "cmp_1");
const T0 = Date.parse("2026-11-04T12:00:00Z");
// Sample values in AWS's documented example format; none is a real key.
const BASE = {
  roleArn: "arn:aws:iam::123456789012:role/fde-bedrock-invoke",
  accessKeyId: "AKIASAMPLEBASEKEY0001",
  secretAccessKey: "sample/secret+access+key/base/0123456789",
};
const TEMP = {
  accessKeyId: "ASIASAMPLETEMPKEY0001",
  secretAccessKey: "sample/temp+secret/0123456789",
  sessionToken: "SampleSessionToken+/=",
};

function stsAnswer(expiresAt: number, n = 1) {
  return `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>
<AccessKeyId>${TEMP.accessKeyId.replace("0001", `000${n}`)}</AccessKeyId><SecretAccessKey>${TEMP.secretAccessKey}</SecretAccessKey>
<SessionToken>${TEMP.sessionToken}</SessionToken><Expiration>${new Date(expiresAt).toISOString()}</Expiration>
</Credentials></AssumeRoleResult></AssumeRoleResponse>`;
}

function setup(secrets: Record<string, Record<string, string>> = { "org_a/cmp_1": { bedrock: JSON.stringify(BASE) } }) {
  let now = T0;
  let n = 0;
  const requests: Request[] = [];
  const answers: (() => Response)[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request.clone());
    n += 1;
    return answers.shift()?.() ?? new Response(stsAnswer(now + 3600_000, n));
  });
  const source = new AssumeRoleSource({
    secrets: new DevSecretResolver(JSON.stringify(secrets)),
    fetch,
    now: () => now,
  });
  return { source, fetch, requests, answers, advance: (ms: number) => (now += ms) };
}

describe("assumed-role credentials", () => {
  it("assume the company's role with a signed STS call, for an hour, limited to invoking models", async () => {
    const { source, requests } = setup();
    const creds = await source.credentials(A, "bedrock", "eu-west-1");
    expect(creds).toMatchObject({ accessKeyId: "ASIASAMPLETEMPKEY0001", sessionToken: TEMP.sessionToken });
    expect(creds.expiration?.toISOString()).toBe(new Date(T0 + 3600_000).toISOString());

    const request = requests[0]!;
    expect(request.url).toBe("https://sts.eu-west-1.amazonaws.com/");
    const params = new URLSearchParams(await request.text());
    expect(params.get("Action")).toBe("AssumeRole");
    expect(params.get("RoleArn")).toBe(BASE.roleArn);
    expect(params.get("RoleSessionName")).toBe("fde-org_a-cmp_1");
    expect(params.get("DurationSeconds")).toBe("3600");
    expect(JSON.parse(params.get("Policy")!).Statement[0].Action).toEqual([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]);
    // The signature is the one SigV4 gives for exactly this request, with the base key.
    const expected = await sign(
      {
        method: "POST",
        path: "/",
        query: "",
        headers: [
          ["host", "sts.eu-west-1.amazonaws.com"],
          ["content-type", request.headers.get("content-type")!],
        ],
        body: new TextEncoder().encode(params.toString()),
      },
      { service: "sts", region: "eu-west-1", credentials: BASE, date: new Date(T0) },
    );
    expect(request.headers.get("authorization")).toBe(expected.headers.find(([n]) => n === "authorization")![1]);
    expect(request.headers.get("authorization")).toContain(
      `Credential=${BASE.accessKeyId}/20261104/eu-west-1/sts/aws4_request`,
    );
  });

  it("reuse credentials until they are close to expiry, then refresh them", async () => {
    const { source, fetch, advance } = setup();
    const first = await source.credentials(A, "bedrock", "eu-west-1");
    advance(3600_000 - REFRESH_BEFORE_MS - 1_000);
    expect(await source.credentials(A, "bedrock", "eu-west-1")).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(2_000);
    const second = await source.credentials(A, "bedrock", "eu-west-1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.accessKeyId).toBe("ASIASAMPLETEMPKEY0002");
  });

  it("keep still-valid credentials through a failed refresh, and refuse once they expire", async () => {
    const { source, answers, advance } = setup();
    const first = await source.credentials(A, "bedrock", "eu-west-1");
    advance(3600_000 - REFRESH_BEFORE_MS + 1_000);
    answers.push(() => new Response("<ErrorResponse/>", { status: 503 }));
    expect(await source.credentials(A, "bedrock", "eu-west-1")).toBe(first);
    advance(REFRESH_BEFORE_MS - MIN_VALIDITY_MS);
    answers.push(() => new Response("<ErrorResponse/>", { status: 503 }));
    await expect(source.credentials(A, "bedrock", "eu-west-1")).rejects.toBeInstanceOf(CredentialsUnavailable);
  });

  it("refuse credentials STS gives that are already about to expire", async () => {
    const { source, answers } = setup();
    answers.push(() => new Response(stsAnswer(T0 + MIN_VALIDITY_MS)));
    await expect(source.credentials(A, "bedrock", "eu-west-1")).rejects.toBeInstanceOf(CredentialsUnavailable);
  });

  it("resolve only the requesting company's reference", async () => {
    const { source, fetch } = setup();
    await expect(source.credentials(B, "bedrock", "eu-west-1")).rejects.toBeInstanceOf(CredentialsUnavailable);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("use temporary credentials given directly, but never a long-lived key or a malformed secret", async () => {
    const direct = { ...TEMP, expiration: new Date(T0 + 1800_000).toISOString() };
    const longLived = { accessKeyId: BASE.accessKeyId, secretAccessKey: BASE.secretAccessKey };
    const { source, fetch } = setup({
      "org_a/cmp_1": { direct: JSON.stringify(direct), long: JSON.stringify(longLived), bad: "not json" },
    });
    expect((await source.credentials(A, "direct", "eu-west-1")).sessionToken).toBe(TEMP.sessionToken);
    for (const ref of ["long", "bad", "missing"])
      await expect(source.credentials(A, ref, "eu-west-1"), ref).rejects.toBeInstanceOf(CredentialsUnavailable);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("read only the four credential values from STS's answer", () => {
    expect(() => parseAssumeRole("<Error><Code>AccessDenied</Code></Error>")).toThrow(CredentialsUnavailable);
    const noDate = stsAnswer(T0).replace(/<Expiration>[^<]*<\/Expiration>/, "<Expiration>soon</Expiration>");
    expect(() => parseAssumeRole(noDate)).toThrow(CredentialsUnavailable);
    expect(parseAssumeRole(stsAnswer(T0)).expiration?.getTime()).toBe(T0);
  });
});

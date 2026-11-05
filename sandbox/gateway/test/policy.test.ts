import { describe, expect, it } from "vitest";

import { OutboundPolicy, ruleFor } from "../src/policy.js";

const policy = OutboundPolicy.parse({
  hosts: [
    { host: "api.github.com", inject: [{ header: "Authorization", secret: "github", prefix: "Bearer " }] },
    { host: "*.github.com" },
    { host: "*.objects.github.com" },
    { host: "registry.npmjs.org" },
  ],
});

describe("outbound policy", () => {
  it("signs only for Bedrock's runtime host in the signing region, never alongside injected secrets", () => {
    const sign = { service: "bedrock", region: "eu-west-1", credentials: "bedrock" };
    const parse = (rule: unknown) => OutboundPolicy.safeParse({ hosts: [rule] }).success;
    expect(parse({ host: "bedrock-runtime.eu-west-1.amazonaws.com", sign })).toBe(true);
    expect(parse({ host: "bedrock-runtime-fips.eu-west-1.amazonaws.com", sign })).toBe(true);
    for (const host of ["bedrock-runtime.us-east-1.amazonaws.com", "*.amazonaws.com", "api.example.com"])
      expect(parse({ host, sign }), host).toBe(false);
    expect(parse({ host: "bedrock-runtime.eu-west-1.amazonaws.com", sign: { ...sign, service: "s3" } })).toBe(false);
    expect(parse({ host: "bedrock-runtime.eu-west-1.amazonaws.com", sign: { ...sign, region: "eu-west-1;x" } })).toBe(
      false,
    );
    const both = {
      host: "bedrock-runtime.eu-west-1.amazonaws.com",
      sign,
      inject: [{ header: "authorization", secret: "k" }],
    };
    expect(parse(both)).toBe(false);
  });

  it("holds a host for an action on the approval list", () => {
    const parse = (approval: unknown) => OutboundPolicy.safeParse({ hosts: [{ host: "a.example.com", approval }] });
    expect(parse("deploy").success).toBe(true);
    expect(parse("customer_send").success).toBe(true);
    for (const bad of ["", "de ploy", "a/b", "x".repeat(129), 1]) expect(parse(bad).success, String(bad)).toBe(false);
  });

  it("accepts exact hosts and narrow wildcards", () => {
    for (const host of ["api.example.com", "example.com", "*.example.com", "203.0.113.7", "a-b.example.co.uk"]) {
      expect(OutboundPolicy.safeParse({ hosts: [{ host }] }).success, host).toBe(true);
    }
  });

  it("refuses broad, malformed and single-label hosts", () => {
    for (const host of [
      "*",
      "*.com",
      "**.example.com",
      "api.*.com",
      "Example.com",
      "localhost",
      "a_b.com",
      "-a.com",
      "",
    ]) {
      expect(OutboundPolicy.safeParse({ hosts: [{ host }] }).success, host).toBe(false);
    }
  });

  it("refuses runtime-owned headers, bad references and unknown fields", () => {
    const parse = (rule: unknown) => OutboundPolicy.safeParse({ hosts: [rule] }).success;
    expect(parse({ host: "a.example.com", inject: [{ header: "Host", secret: "x" }] })).toBe(false);
    expect(parse({ host: "a.example.com", inject: [{ header: "content-length", secret: "x" }] })).toBe(false);
    expect(parse({ host: "a.example.com", inject: [{ header: "x-api-key", secret: "../x" }] })).toBe(false);
    expect(parse({ host: "a.example.com", inject: [{ header: "x-api-key", secret: "x", prefix: "a\nb" }] })).toBe(
      false,
    );
    expect(parse({ host: "a.example.com", value: "a raw secret" })).toBe(false);
  });

  it("adds secrets only for exact hosts", () => {
    const inject = [{ header: "authorization", secret: "aws", prefix: "Bearer " }];
    expect(() => OutboundPolicy.parse({ hosts: [{ host: "*.amazonaws.com", inject }] })).toThrow(/exact hosts/);
    expect(
      OutboundPolicy.parse({ hosts: [{ host: "bedrock-runtime.us-east-1.amazonaws.com", inject }] }).hosts,
    ).toHaveLength(1);
    expect(OutboundPolicy.parse({ hosts: [{ host: "*.npmjs.org" }] }).hosts).toHaveLength(1);
  });

  it("refuses the same host twice", () => {
    expect(OutboundPolicy.safeParse({ hosts: [{ host: "a.example.com" }, { host: "a.example.com" }] }).success).toBe(
      false,
    );
  });

  it("prefers the exact host, then the most specific wildcard", () => {
    expect(ruleFor(policy, "api.github.com")?.inject).toHaveLength(1);
    expect(ruleFor(policy, "uploads.github.com")?.host).toBe("*.github.com");
    expect(ruleFor(policy, "a.objects.github.com")?.host).toBe("*.objects.github.com");
    expect(ruleFor(policy, "API.GITHUB.COM.")?.host).toBe("api.github.com");
  });

  it("does not let a wildcard match its apex or a lookalike", () => {
    expect(ruleFor(policy, "github.com")).toBeUndefined();
    expect(ruleFor(policy, "evilgithub.com")).toBeUndefined();
    expect(ruleFor(policy, "api.github.com.attacker.example")).toBeUndefined();
    expect(ruleFor(policy, "registry.npmjs.org.attacker.example")).toBeUndefined();
  });

  it("refuses everything when empty", () => {
    expect(ruleFor({ hosts: [] }, "registry.npmjs.org")).toBeUndefined();
  });
});

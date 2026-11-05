import { z } from "zod";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// An exact host of two or more labels, or "*." before one: "*.github.com", never "*" or "*.com".
const HOST_PATTERN = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);

// Headers the runtime owns; injecting them would break framing or routing, not authenticate.
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade"]);

export const SecretRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/, "invalid secret reference");
export type SecretRef = z.infer<typeof SecretRef>;

const HostPattern = z
  .string()
  .max(253)
  .regex(HOST_PATTERN, "use a lowercase hostname of two or more labels, optionally starting with *.");

const HeaderName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "invalid header name")
  .transform((h) => h.toLowerCase())
  .refine((h) => !RESERVED_HEADERS.has(h), "header cannot be injected");

/** Adds `<prefix><secret>` as `header`. The policy holds the reference; the value is resolved per request. */
const Injection = z.strictObject({
  header: HeaderName,
  secret: SecretRef,
  prefix: z
    .string()
    .max(32)
    .regex(/^[\x20-\x7e]*$/, "prefix must be printable ASCII")
    .default(""),
});

/**
 * Signs requests with AWS Signature Version 4 using short-lived credentials from `credentials` (see `aws.ts`),
 * so the sandbox needs no Bedrock API key. Only Bedrock's runtime host in the named region can be signed for.
 */
const Signing = z.strictObject({
  service: z.literal("bedrock"),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "invalid AWS region"),
  credentials: SecretRef,
});

const HostRule = z
  .strictObject({
    host: HostPattern,
    inject: z.array(Injection).max(4).default([]),
    sign: Signing.optional(),
    /**
     * An action on the company's approval list (`deploy`, `customer_send`). Requests to this host are refused unless
     * an FDE approved that action and its grant is still open, so an agent that skips the approval prompt (an
     * obfuscated command, a background process) still cannot reach it.
     */
    approval: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/, "invalid approval action")
      .optional(),
  })
  // A wildcard covers hosts nobody has checked (`*.amazonaws.com` includes anyone's API Gateway), so secrets go
  // only to exact hosts.
  .refine((r) => r.inject.length === 0 || !r.host.startsWith("*."), "secrets are only added for exact hosts")
  .refine((r) => r.sign === undefined || r.inject.length === 0, "a host is signed or has secrets added, not both")
  .refine(
    (r) =>
      r.sign === undefined ||
      r.host === `bedrock-runtime.${r.sign.region}.amazonaws.com` ||
      r.host === `bedrock-runtime-fips.${r.sign.region}.amazonaws.com`,
    "requests are only signed for Bedrock's runtime host in the signing region",
  );
export type HostRule = z.infer<typeof HostRule>;

/** A company's outbound rules. Hosts not listed are refused. */
export const OutboundPolicy = z
  .strictObject({ hosts: z.array(HostRule).max(256) })
  .refine((p) => new Set(p.hosts.map((r) => r.host)).size === p.hosts.length, "each host may appear once");
export type OutboundPolicy = z.infer<typeof OutboundPolicy>;

export const EMPTY_POLICY: OutboundPolicy = { hosts: [] };

/** The rule for `hostname`: an exact match first, then the most specific wildcard; none means refuse. */
export function ruleFor(policy: OutboundPolicy, hostname: string): HostRule | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const exact = policy.hosts.find((r) => r.host === host);
  if (exact !== undefined) return exact;
  let best: HostRule | undefined;
  for (const rule of policy.hosts) {
    if (!rule.host.startsWith("*.") || !host.endsWith(rule.host.slice(1))) continue;
    if (best === undefined || rule.host.length > best.host.length) best = rule;
  }
  return best;
}

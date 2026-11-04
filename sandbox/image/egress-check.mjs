#!/usr/bin/env node
// Checks, from inside a sandbox, that nothing leaves except HTTP on 80 and HTTPS on 443 through the gateway's
// outbound handler: no other TCP port, no UDP, and no DNS that reaches the internet. Run it on a deployed sandbox:
//   POST /v1/sandboxes/<tenant>/<company>/exec  {"argv": ["oryxa-egress-check"], "timeoutMs": 120000}
// Each line is one check; the exit code is 0 only when every check passed. Uses only Node's standard library, so it
// adds no tools to the image.
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import net from "node:net";

const TIMEOUT_MS = 4_000;
const PUBLIC = ["1.1.1.1", "8.8.8.8"];
const results = [];

function record(check, observed, pass) {
  results.push({ check, observed, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}: ${observed}`);
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS });
    const done = (outcome) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.once("connect", () => done("connected"));
    socket.once("timeout", () => done("timed out"));
    socket.once("error", (e) => done(e.code ?? e.message));
  });
}

// A DNS query for a fresh random name: any answer means a resolver on the internet saw it.
function dnsQuery(name) {
  const id = randomBytes(2);
  const labels = name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const header = Buffer.from([id[0], id[1], 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

function udpDns(host, name) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => done("no answer"), TIMEOUT_MS);
    const done = (outcome) => {
      clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };
    socket.once("message", () => done("answered"));
    socket.once("error", (e) => done(e.code ?? e.message));
    socket.send(dnsQuery(name), 53, host, (e) => e && done(e.code ?? e.message));
  });
}

async function systemResolvers(name) {
  let servers = [];
  try {
    servers = [...readFileSync("/etc/resolv.conf", "utf8").matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]);
  } catch {
    // No resolv.conf: nothing to ask.
  }
  for (const server of servers) {
    const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    resolver.setServers([server]);
    const outcome = await resolver.resolve4(name).then(
      () => "answered",
      (e) => e.code,
    );
    // NXDOMAIN for a random name means the query reached the internet's authoritative servers.
    const leaked = outcome === "answered" || outcome === "ENOTFOUND";
    record(`DNS through ${server} for a random name`, outcome, !leaked);
  }
  if (servers.length === 0) record("DNS resolvers configured", "none", true);
}

async function http(url) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => e);
  if (response instanceof Error) return { observed: response.cause?.code ?? response.name, origin: false };
  // Only the gateway answers for a host that is not on the allowlist, with 403.
  return { observed: `HTTP ${response.status}`, origin: response.status !== 403 };
}

const name = `${randomBytes(8).toString("hex")}.example.com`;
for (const host of PUBLIC) {
  for (const port of [22, 53, 853, 8080, 8443]) {
    const outcome = await tcp(host, port);
    record(`TCP ${host}:${port}`, outcome, outcome !== "connected");
  }
  const outcome = await udpDns(host, name);
  record(`UDP DNS to ${host}:53`, outcome, outcome !== "answered");
}
await systemResolvers(name);
for (const url of ["http://example.com/", "https://example.com/", "http://1.1.1.1/"]) {
  const { observed, origin } = await http(url);
  record(`${url} (not on the allowlist)`, observed, !origin);
}

const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ checks: results.length, failed }));
process.exit(failed === 0 ? 0 : 1);

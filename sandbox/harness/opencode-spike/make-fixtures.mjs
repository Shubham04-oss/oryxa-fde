// Turns what the lab recorded ($LAB_DIR/cases/*) into the fixtures under test/fixtures/opencode/. Everything that
// is machine-specific or random is replaced: session and message ids, trace ids, signatures, dates, test timings,
// and the container's DNS search domains (the lab starts it with none, and any host name outside KNOWN_HOSTS or
// `*.example` stops the run, so a name from the recording machine cannot reach a fixture). Invented sample content only.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ONLY=hostile,sockets writes just those sections, for re-running part of the cases.
const ONLY = process.env.ONLY?.split(",");
const want = (section) => ONLY === undefined || ONLY.includes(section);
const LAB = process.env.LAB_DIR;
if (!LAB) throw new Error("set LAB_DIR");
const OUT = new URL("../test/fixtures/opencode/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const casePath = (name, file) => join(LAB, "cases", name, file);
const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean);
const jsonl = (path) => lines(path).map((l) => JSON.parse(l));

/** A scrubber that numbers each distinct id in order of first appearance, so a fixture reads the same every time. */
function scrubber() {
  const seen = new Map();
  const named = (prefix) => (id) => {
    const key = `${prefix}:${id}`;
    if (!seen.has(key)) seen.set(key, `${prefix}_sample${String(seen.size + 1).padStart(3, "0")}`);
    return seen.get(key);
  };
  const ses = named("ses");
  const msg = named("msg");
  return (text) =>
    text
      .replace(/ses_[A-Za-z0-9]{10,}/g, ses)
      .replace(/msg_[A-Za-z0-9]{10,}(:reasoning:\d+)?/g, (m) => msg(m))
      .replace(/\b[0-9a-f]{40}\b/g, "<project-hash>")
      .replace(/\b[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}\b/g, "<b3>")
      .replace(/00-[0-9a-f]{32}-[0-9a-f]{16}-01/g, "<traceparent>")
      .replace(/Signature=[0-9a-f]{64}/g, "Signature=<64 hex digits>")
      .replace(/\b2026\d{4}T\d{6}Z\b/g, "20260101T000000Z")
      .replace(/\/2026\d{4}\//g, "/20260101/")
      .replace(/\(\d+\.\d+ms\)/g, "(0.0ms)")
      .replace(/duration_ms \d+\.\d+/g, "duration_ms 0.0")
      .replace(/\b\d+\.\d{5,}\b/g, "0.0");
}

/** The ACP frames of a case, both directions, in order, as parsed JSON. */
function session(name) {
  const scrub = scrubber();
  const frames = jsonl(casePath(name, "frames.jsonl"))
    .filter((f) => f.d === "a2c" || f.d === "c2a")
    .map((f) =>
      JSON.parse(
        scrub(JSON.stringify({ dir: f.d === "a2c" ? "agent->client" : "client->agent", msg: JSON.parse(f.line) })),
      ),
    );
  writeFileSync(
    join(OUT, `${name.replace(/^s-/, "session-")}.acp.jsonl`),
    frames.map((f) => JSON.stringify(f)).join("\n") + "\n",
  );
  return frames;
}
if (want("sessions"))
  for (const name of [
    "s-healthz",
    "s-reject",
    "s-always",
    "s-once",
    "s-cancel",
    "s-readonly",
    "s-readonly-rg",
    "s-forbidden",
    "s-usage",
  ])
    session(name);

const KNOWN_HOSTS = new Set([
  "models.opencode.ai",
  "opencode.ai",
  "mcp.exa.ai",
  "search.parallel.ai",
  "agent.tinyfish.ai",
  "example.com",
  "github.com",
  "registry.npmjs.org",
  "bedrock-runtime.us-east-1.amazonaws.com",
]);

// Hosts a case reached: the A lookups, TLS server names and HTTP Host headers the sink recorded.
function hosts(name) {
  const sink = casePath(name, "sink.jsonl");
  if (!existsSync(sink)) return [];
  const names = jsonl(sink)
    .filter((e) => (e.kind === "dns" && e.qtype === 1) || e.kind === "tls" || e.kind === "http")
    .map((e) => e.name ?? e.sni ?? e.host)
    .filter(Boolean);
  for (const host of names) {
    if (!KNOWN_HOSTS.has(host) && !host.endsWith(".example")) throw new Error(`unexpected host in ${name}: ${host}`);
  }
  return [...new Set(names)].sort();
}
const egress = {};
for (const name of readdirSync(join(LAB, "cases"))) egress[name] = hosts(name);
const wanted = [
  "default",
  "models-fetch-off",
  "websearch-on",
  "share-auto",
  "plugin-npm",
  "mcp-remote",
  "mcp-local",
  "otel",
  "intended",
  "bedrock-host",
  "s-readonly",
  "s-readonly-rg",
  "hostile-open",
  "hostile-protected",
  "s-healthz",
];
if (want("egress"))
  writeFileSync(
    join(OUT, "egress.json"),
    `${JSON.stringify(Object.fromEntries(wanted.map((n) => [n, egress[n] ?? []])), null, 2)}\n`,
  );

// Bedrock: the request's headers (names, and values with anything variable scrubbed), per credential style.
function bedrock(name) {
  const scrub = scrubber();
  const req = jsonl(casePath(name, "model.jsonl")).find((e) => e.kind === "bedrock");
  if (!req) return { request: null };
  const headers = [];
  for (let i = 0; i < req.headers.length; i += 2) {
    const [k, v] = [req.headers[i], req.headers[i + 1]];
    if (/^(host|content-length|connection|accept|accept-encoding)$/i.test(k)) continue;
    headers.push([k.toLowerCase(), scrub(v)]);
  }
  return {
    method: req.method,
    path: scrub(req.url),
    headers: Object.fromEntries(headers.sort((a, b) => a[0].localeCompare(b[0]))),
  };
}
const nocreds = () => jsonl(casePath("bedrock-nocreds", "model.jsonl")).some((e) => e.kind === "bedrock");
if (want("bedrock"))
  writeFileSync(
    join(OUT, "bedrock-wire.json"),
    `${JSON.stringify(
      {
        note: "Headers of the request OpenCode 2.2.7 sent to the stub standing in for Bedrock Runtime. Placeholder credentials only.",
        access_keys: bedrock("bedrock-keys"),
        access_keys_with_session_token: bedrock("bedrock-token"),
        bearer_token: bedrock("bedrock-bearer"),
        no_credentials_sent_a_request: nocreds(),
      },
      null,
      2,
    )}\n`,
  );

// Hostile repository and home.
function hostile(name) {
  const dir = join(LAB, "cases", name);
  const chats = jsonl(casePath(name, "model.jsonl")).filter((e) => e.kind === "chat");
  const bodies = chats.map((c) => JSON.stringify(c.body ?? {}));
  const tools = chats.find((c) => c.hasTools)?.toolNames ?? [];
  const markers = [...new Set(bodies.join("\n").match(/HOSTILE-[A-Z-]*MARKER/g) ?? [])].sort();
  const executed = existsSync(join(dir, "markers.txt")) ? lines(join(dir, "markers.txt")).sort() : [];
  const sys = (c) => JSON.stringify(c.body?.messages?.[0]?.content ?? "");
  return {
    files_created_by_hostile_code: [...new Set(executed)],
    hosts_reached: hosts(name),
    models_requested: [...new Set(chats.map((c) => c.model))].sort(),
    tools_offered: tools,
    hostile_text_in_requests: markers,
    system_prompt_length: chats.length > 0 ? sys(chats[0]).length : null,
  };
}
const clean = hostile("clean");
const hp = hostile("hostile-protected");
if (want("hostile"))
  writeFileSync(
    join(OUT, "hostile.json"),
    `${JSON.stringify(
      {
        note: "One healthz session against a repository and a home holding hostile config, plugins, MCP servers, instructions and skills (opencode-spike/hostile-seed.sh).",
        clean_reference: clean,
        hostile_with_intended_settings: hp,
        hostile_without_protections_stub_model_kept: hostile("hostile-open-instructions"),
        hostile_with_intended_settings_and_skills_offered: hostile("hostile-skill-ask"),
        hostile_with_intended_settings_skills_offered_fresh_home: hostile("hostile-skill-ask-fresh-home"),
        hostile_without_protections: hostile("hostile-open"),
        identical_to_clean:
          JSON.stringify({ ...hp, system_prompt_length: 0 }) ===
            JSON.stringify({ ...clean, system_prompt_length: 0 }) &&
          hp.system_prompt_length === clean.system_prompt_length,
        home_auth_json_overrides_config_key: (() => {
          const h = (name) => jsonl(casePath(name, "model.jsonl")).find((e) => e.kind === "chat")?.headers ?? [];
          const auth = (name) => h(name)[h(name).indexOf("Authorization") + 1];
          return { default_home: auth("home-auth"), fresh_home_and_xdg_dirs: auth("home-fresh") };
        })(),
      },
      null,
      2,
    )}\n`,
  );

// Paths the process opened or probed under the home, the config directory and the repository, with intended settings
// and a hostile home and repository in place (from strace). "ENOENT" marks a path that was looked for and absent.
if (want("hostile")) {
  const seen = new Map();
  for (const line of lines(casePath("strace-hostile", "strace.txt"))) {
    const m =
      /^\d+\s+(openat|statx|newfstatat|readlink|access)\(AT_FDCWD, "([^"]+)".*\) += (-?\d+)(?: (E[A-Z]+))?/.exec(line);
    if (!m) continue;
    const path = m[2];
    if (
      !/^(\/home\/agent|\/etc\/oryxa-spike|\/workspace\/repo\/\.|\/workspace\/repo\/(AGENTS|CLAUDE|opencode|EVIL))/.test(
        path,
      )
    )
      continue;
    seen.set(path, m[4] ?? "ok");
  }
  const rows = [...seen]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, result]) => `${result.padEnd(6)} ${path}`);
  writeFileSync(join(OUT, "home-reads.txt"), `${rows.join("\n")}\n`);
}

// Forged answers.
const forge = (name) =>
  existsSync(casePath(name, `forge-${name.includes("http") ? "http" : "stdin"}.txt`))
    ? jsonl(casePath(name, `forge-${name.includes("http") ? "http" : "stdin"}.txt`))
    : [];
const wrote = (name, mode) =>
  existsSync(casePath(name, "markers.txt")) &&
  readFileSync(casePath(name, "markers.txt"), "utf8").includes(`FORGED-${mode}`);
if (want("forged"))
  writeFileSync(
    join(OUT, "forged-answers.json"),
    `${JSON.stringify(
      Object.fromEntries(
        ["http-readable", "stdin-readable", "http-execonly", "stdin-execonly"].map((k) => {
          const [mode, perm] = k.split("-");
          const name = `forge-${mode}-${perm}`;
          return [k, { steps: forge(name).map(({ step, ...rest }) => ({ step, ...rest })) }];
        }),
      ),
      null,
      2,
    )}\n`,
  );

// Sockets while a prompt ran.
const sockets = existsSync(casePath("sockets", "sockets.txt"))
  ? readFileSync(casePath("sockets", "sockets.txt"), "utf8")
  : "";
if (want("sockets"))
  writeFileSync(
    join(OUT, "sockets.txt"),
    `${[
      ...new Set(
        sockets
          .split("\n")
          .filter((l) => /^(tcp|udp)\s+(LISTEN|UNCONN)|^probe/.test(l))
          .map((l) =>
            l
              .replace(/\s+/g, " ")
              .trim()
              .replace(/(\d+\.\d+\.\d+\.\d+):\d{4,5}/g, "$1:<port>"),
          ),
      ),
    ].join("\n")}\n`,
  );
console.error("fixtures written to", OUT);

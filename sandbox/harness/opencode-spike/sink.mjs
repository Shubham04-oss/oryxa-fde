// Egress sink for the OpenCode spike. Runs on an isolated Docker network with no route out. The OpenCode container
// uses it as its DNS server, so every name it looks up resolves to this container, which then logs what the client
// asks for: DNS queries, the Host header of plain HTTP on port 80, and the SNI of TLS on port 443. Nothing is
// forwarded and no TLS is terminated. One JSON object per line to $LOG.
import { appendFileSync } from "node:fs";
import dgram from "node:dgram";
import net from "node:net";

const LOG = process.env.LOG ?? "/scratch/logs/sink.jsonl";
const SELF = process.env.SELF_IP ?? "10.123.0.2";
const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);

// DNS: answer every A query with this container's address and everything else with an empty answer.
const dns = dgram.createSocket("udp4");
dns.on("message", (msg, rinfo) => {
  let offset = 12;
  const labels = [];
  while (msg[offset] !== 0 && offset < msg.length) {
    labels.push(msg.subarray(offset + 1, offset + 1 + msg[offset]).toString("latin1"));
    offset += msg[offset] + 1;
  }
  const qtype = msg.readUInt16BE(offset + 1);
  const question = msg.subarray(12, offset + 5);
  log({ kind: "dns", name: labels.join("."), qtype });
  const header = Buffer.from(msg.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(qtype === 1 ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const parts = [header, question];
  if (qtype === 1) {
    parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4, ...SELF.split(".").map(Number)]));
  }
  dns.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
dns.bind(53, "0.0.0.0");

// Plain HTTP on 80: record the request line and header names, then answer 503 so nothing proceeds.
net
  .createServer((socket) => {
    let raw = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
      if (!raw.includes("\r\n\r\n")) return;
      const [requestLine, ...headers] = raw.split("\r\n\r\n")[0].split("\r\n");
      const host = headers
        .find((h) => h.toLowerCase().startsWith("host:"))
        ?.slice(5)
        .trim();
      log({
        kind: "http",
        port: 80,
        request: requestLine,
        host,
        header_names: headers.map((h) => h.split(":")[0].toLowerCase()),
      });
      socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    });
  })
  .listen(80, "0.0.0.0");

// TLS on 443: read the ClientHello, record the SNI, hang up.
net
  .createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (hello) => {
      log({ kind: "tls", port: 443, sni: sni(hello) });
      socket.destroy();
    });
  })
  .listen(443, "0.0.0.0");

function sni(hello) {
  try {
    let o = 5 + 4 + 2 + 32; // record header, handshake header, version, random
    o += 1 + hello[o]; // session id
    o += 2 + hello.readUInt16BE(o); // cipher suites
    o += 1 + hello[o]; // compression
    const end = o + 2 + hello.readUInt16BE(o);
    o += 2;
    while (o + 4 <= end) {
      const type = hello.readUInt16BE(o);
      const length = hello.readUInt16BE(o + 2);
      if (type === 0) return hello.subarray(o + 9, o + 4 + length).toString("latin1");
      o += 4 + length;
    }
  } catch {
    // fall through
  }
  return null;
}
log({ kind: "sink_started" });

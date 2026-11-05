// AWS Signature Version 4, with WebCrypto, for the Bedrock and STS requests the gateway signs. Checked against
// AWS's own test suite (test/fixtures/sigv4-suite.json).

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  /** When the credentials stop working; temporary credentials always have one. */
  readonly expiration?: Date | undefined;
}

export interface SigningRequest {
  readonly method: string;
  /** The path as it appears on the request line: raw or percent-encoded. */
  readonly path: string;
  /** The query string, without `?`. */
  readonly query: string;
  /** The headers to sign, as sent. `host` must be among them. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

export interface SigningOptions {
  readonly service: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  readonly date: Date;
  /** Adds `x-amz-content-sha256` and signs it. */
  readonly signBody?: boolean;
  /** Adds the session token after signing, for services that want it unsigned. */
  readonly omitSessionToken?: boolean;
}

export interface Signed {
  /** The headers to add to the request, `authorization` included. */
  readonly headers: [string, string][];
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/** RFC 3986: only unreserved characters stay as they are. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Resolves `.` and `..`, collapses repeated slashes, keeps a trailing one; then encodes each segment once more, so a
// path already percent-encoded on the wire is encoded twice, as AWS requires for every service but S3.
function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(uriEncode(segment));
  }
  const trailing = path.endsWith("/") && segments.length > 0 ? "/" : "";
  return `/${segments.join("/")}${trailing}`;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function canonicalQuery(query: string): string {
  if (query === "") return "";
  const pairs = query
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const at = p.indexOf("=");
      const [k, v] = at === -1 ? [p, ""] : [p.slice(0, at), p.slice(at + 1)];
      return [uriEncode(decode(k)), uriEncode(decode(v))] as const;
    });
  pairs.sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Signs `request` and returns the headers to add, `x-amz-date` and `authorization` among them. */
export async function sign(request: SigningRequest, options: SigningOptions): Promise<Signed> {
  const date = amzDate(options.date);
  const day = date.slice(0, 8);
  const payloadHash = await sha256Hex(request.body);
  const token = options.credentials.sessionToken;
  const added: [string, string][] = [["x-amz-date", date]];
  if (options.signBody) added.push(["x-amz-content-sha256", payloadHash]);
  if (token !== undefined && !options.omitSessionToken) added.push(["x-amz-security-token", token]);

  // Names lowercased; values trimmed with inner whitespace collapsed; repeated headers joined with commas.
  const canonical = new Map<string, string[]>();
  for (const [name, value] of [...request.headers, ...added]) {
    const key = name.toLowerCase();
    const values = canonical.get(key) ?? [];
    values.push(value.trim().replace(/\s+/g, " "));
    canonical.set(key, values);
  }
  const names = [...canonical.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.path),
    canonicalQuery(request.query),
    ...names.map((n) => `${n}:${canonical.get(n)?.join(",") ?? ""}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${options.credentials.secretAccessKey}`), day);
  for (const part of [options.region, options.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  const headers: [string, string][] = [...added];
  if (token !== undefined && options.omitSessionToken) headers.push(["x-amz-security-token", token]);
  headers.push([
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  ]);
  return { headers, canonicalRequest, stringToSign, signature };
}

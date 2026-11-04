// An upstream can reflect a credential back (an echo endpoint, an error message). The sandbox must never read it,
// so every response to a request that carried a secret has the secret's bytes replaced on the way back.
// ponytail: matches the exact bytes only; a body that re-encodes the secret (base64, JSON escapes) passes unchanged.

const REPLACEMENT = "[redacted]";
const encoder = new TextEncoder();
const REPLACEMENT_BYTES = encoder.encode(REPLACEMENT);

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join(REPLACEMENT);
  return out;
}

export function redactResponse(response: Response, secrets: readonly string[]): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, redactText(value, secrets));
  // Replacing a secret changes the body's length.
  headers.delete("content-length");
  const body = response.body === null ? null : redactStream(response.body, secrets);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** Replaces each secret in `body`, including one split across chunks. Holds back at most the longest secret - 1. */
export function redactStream(body: ReadableStream<Uint8Array>, secrets: readonly string[]): ReadableStream<Uint8Array> {
  const needles = secrets.filter((s) => s.length > 0).map((s) => encoder.encode(s));
  const hold = Math.max(1, ...needles.map((n) => n.length)) - 1;
  let carry = new Uint8Array(0);
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const buf = new Uint8Array(carry.length + chunk.length);
        buf.set(carry);
        buf.set(chunk, carry.length);
        let i = 0;
        for (let m = nextMatch(buf, i, needles); m !== undefined; m = nextMatch(buf, i, needles)) {
          if (m.at > i) controller.enqueue(buf.slice(i, m.at));
          controller.enqueue(REPLACEMENT_BYTES.slice());
          i = m.at + m.length;
        }
        // No complete secret remains after i; keep a tail that could be the start of one.
        const emitEnd = buf.length - Math.min(hold, buf.length - i);
        if (emitEnd > i) controller.enqueue(buf.slice(i, emitEnd));
        carry = buf.slice(emitEnd);
      },
      flush(controller) {
        if (carry.length > 0) controller.enqueue(carry);
      },
    }),
  );
}

function nextMatch(buf: Uint8Array, from: number, needles: readonly Uint8Array[]) {
  let best: { at: number; length: number } | undefined;
  for (const needle of needles) {
    const at = indexOf(buf, needle, from);
    if (at === -1) continue;
    if (best === undefined || at < best.at || (at === best.at && needle.length > best.length)) {
      best = { at, length: needle.length };
    }
  }
  return best;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

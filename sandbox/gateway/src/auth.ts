// A shorter configured token is treated as unset, so a placeholder never opens the API.
const MIN_TOKEN_LENGTH = 32;
const encoder = new TextEncoder();

/** True only for `Authorization: Bearer <SERVICE_TOKEN>`; fails closed when the token is unset or weak. */
// ponytail: one static token; rotation means a redeploy. Move to a list or the platform's internal tokens later.
export async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (token === undefined || token.length < MIN_TOKEN_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // Equal-length digests, so the comparison is constant-time whatever was presented.
  const [a, b] = await Promise.all([digest(presented), digest(token)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

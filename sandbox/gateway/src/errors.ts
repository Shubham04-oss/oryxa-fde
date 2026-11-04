/**
 * An expected failure with the HTTP status the API should see. Durable Object RPC keeps an error's name and own
 * fields but not its class, so the router recognises it by those.
 */
export class GatewayError extends Error {
  override readonly name = "GatewayError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isGatewayError(cause: unknown): cause is GatewayError {
  return (
    cause instanceof Error &&
    cause.name === "GatewayError" &&
    typeof (cause as { status?: unknown }).status === "number"
  );
}

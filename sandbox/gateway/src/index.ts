import { SandboxFileError } from "@cloudflare/sandbox";
import { z } from "zod";

import { authorized } from "./auth.js";
import type { Env } from "./env.js";
import { isGatewayError } from "./errors.js";
import { ExecRequest, ExecStreamRequest, WorkspacePath } from "./exec.js";
import { OutboundPolicy } from "./policy.js";
import { defaultInstance, InstanceType } from "./sandbox.js";
import { companyScope, type CompanyScope, sandboxName, ScopeError } from "./scope.js";

export { Outbound } from "./outbound.js";
export { CompanySandbox } from "./sandbox.js";

const StartRequest = z.strictObject({ instance: InstanceType.optional() });
const STDIN_ROUTE = /^exec\/([0-9a-f-]{36})\/stdin$/;

/**
 * The internal API `oryxa-fde-api` calls, behind a service credential. Every route is under
 * `/v1/sandboxes/<tenant>/<company>/`, and the pair picks the company's own sandbox; the API checks the FDE's
 * permission on that company before calling.
 */
export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env.SERVICE_TOKEN))) return text(401, "unauthorized");
    const url = new URL(request.url);
    // Not URI-decoded: ids are [A-Za-z0-9_-], so an encoded "/" or ":" stays in and is refused.
    const [, version, collection, tenant, company, ...rest] = url.pathname.split("/");
    if (version !== "v1" || collection !== "sandboxes" || tenant === undefined || company === undefined) {
      return text(404, "not found");
    }
    let scope: CompanyScope;
    try {
      scope = companyScope(tenant, company);
    } catch (cause) {
      if (cause instanceof ScopeError) return text(400, cause.message);
      throw cause;
    }
    const route = rest.join("/");
    try {
      return await dispatch(request, url, route, scope, env);
    } catch (cause) {
      return errorResponse(cause, scope, route);
    }
  },
} satisfies ExportedHandler<Env>;

async function dispatch(request: Request, url: URL, route: string, scope: CompanyScope, env: Env): Promise<Response> {
  const sandbox = env.SANDBOX.getByName(sandboxName(scope));
  switch (`${request.method} ${route}`) {
    case "GET ":
      return Response.json(await sandbox.status());
    case "POST start": {
      const { instance } = await parseBody(request, StartRequest);
      return Response.json(await sandbox.start(scope, instance ?? defaultInstance(env)));
    }
    case "POST stop":
      return Response.json(await sandbox.stop());
    case "POST exec":
      return Response.json(await sandbox.exec(await parseBody(request, ExecRequest)));
    case "POST exec/stream": {
      const lines = await sandbox.execStream(await parseBody(request, ExecStreamRequest));
      return new Response(lines, { headers: { "content-type": "application/x-ndjson" } });
    }
    case "GET files": {
      const body = await sandbox.readFile(WorkspacePath.parse(url.searchParams.get("path")));
      return new Response(body, { headers: { "content-type": "application/octet-stream" } });
    }
    case "PUT files":
      await sandbox.writeFile(WorkspacePath.parse(url.searchParams.get("path")), request.body ?? emptyBody());
      return new Response(null, { status: 204 });
    case "GET outbound-policy":
      return Response.json(await sandbox.outboundPolicy());
    case "PUT outbound-policy":
      return Response.json(await sandbox.setOutboundPolicy(scope, await parseBody(request, OutboundPolicy)));
  }
  const stdin = STDIN_ROUTE.exec(route);
  if (stdin?.[1] !== undefined && request.method === "POST") {
    await sandbox.writeStdin(stdin[1], new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 204 });
  }
  return text(404, "not found");
}

function errorResponse(cause: unknown, scope: CompanyScope, route: string): Response {
  if (cause instanceof z.ZodError) return text(400, z.prettifyError(cause));
  if (cause instanceof SyntaxError) return text(400, "body is not valid JSON");
  if (isGatewayError(cause)) return text(cause.status, cause.message);
  if (SandboxFileError.is(cause))
    return text(cause.code === "ENOENT" ? 404 : 400, `file operation failed: ${cause.code}`);
  // Ids and the route only: request bodies can hold customer content.
  console.error({
    event: "gateway.failed",
    tenant: scope.tenant,
    company: scope.company,
    route,
    error: describe(cause),
  });
  return text(500, "sandbox request failed");
}

// An empty body is an empty object, so `start` needs no body.
async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const body = await request.text();
  return schema.parse(body === "" ? {} : JSON.parse(body));
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new Blob([]).stream();
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });
}

// Structured logs drop an Error's message and stack because they are not enumerable.
function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

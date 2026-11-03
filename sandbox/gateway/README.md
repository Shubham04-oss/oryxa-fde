# Sandbox gateway

A Cloudflare Worker on the Sandbox SDK (`@cloudflare/sandbox` 1.0). It gives each customer company one sandbox,
a Durable Object named `<tenant>:<company>` that owns one container, and an internal API that `oryxa-fde-api`
calls. Every HTTP and HTTPS request a sandbox makes goes through the outbound handler. The handler refuses by
default, allows only the company's hosts, and adds secrets to allowed requests there, so the sandbox never
holds them.

## Internal API

Every call needs `Authorization: Bearer <SERVICE_TOKEN>`. Without it, or when the Worker's token is unset or
shorter than 32 characters, the call gets `401` and no sandbox is touched. `oryxa-fde-api` checks the FDE's
permission on the company before it calls. The tenant and company ids follow the platform's id rules.

| Method and path under `/v1/sandboxes/<tenant>/<company>` | Does                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                                                  | `{ "running": bool }`                                                                                                                |
| `POST /start`                                            | Starts the container. Optional body `{ "instance": "standard-1".."standard-4" }`; the default is `SANDBOX_INSTANCE`.                 |
| `POST /stop`                                             | Destroys the container. Its disk is lost.                                                                                            |
| `POST /exec`                                             | `{ argv, cwd?, env?, timeoutMs? }`. Returns `{ exitCode, stdout, stderr, truncated, timedOut }`, keeping up to 1 MiB of each stream. |
| `POST /exec/stream`                                      | Same body plus `stdin?: bool`. Responds with JSON lines: `started` (with the `exec` id), then `stdout`/`stderr` chunks, then `exit`. |
| `POST /exec/<exec>/stdin`                                | Writes the body to a streamed command's stdin. The harness reads approval decisions here.                                            |
| `GET /files?path=` and `PUT /files?path=`                | Reads or writes one file under `/workspace`. A write creates the parent directories.                                                 |
| `GET /outbound-policy` and `PUT /outbound-policy`        | Reads or replaces the company's outbound policy.                                                                                     |

`cwd` and file paths must be absolute paths under `/workspace`, with no `.` or `..` segments. An `env` name that
looks like a credential (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, `*CREDENTIALS*`) is refused.

## Outbound policy

```json
{
  "hosts": [
    { "host": "registry.npmjs.org" },
    { "host": "*.githubusercontent.com" },
    { "host": "api.github.com", "inject": [{ "header": "authorization", "secret": "github", "prefix": "Bearer " }] }
  ]
}
```

- A host that matches no rule gets `403`. An exact host wins over a wildcard, and the most specific wildcard
  wins over the others. `*.example.com` does not match `example.com`, and patterns as broad as `*` or `*.com`
  are refused.
- `inject` names a secret reference, never a value. The value is resolved per request, inside the Worker, for
  that company only. A host with `inject` is reachable over HTTPS only. If the secret is missing, the request
  is refused and never forwarded.
- Responses to requests that carried a secret have its bytes replaced with `[redacted]`, in headers and body,
  so an upstream that echoes the credential cannot hand it to the sandbox.
- Redirects are returned to the sandbox, not followed. The next request goes through the policy again.
- Only HTTP on port 80 and HTTPS on port 443 leave the container (`enableInternet: false`), and a request that
  names any other port is refused. Logs record ids, host and decision, never headers, paths or bodies.

## Secrets

`SecretResolver` turns a company's reference into a value. Dev uses `DevSecretResolver`, which reads the
Worker secret `DEV_SECRETS`:

```json
{ "<tenant>/<company>": { "<reference>": "<value>" } }
```

Production will fetch the references from AWS Secrets Manager. A malformed `DEV_SECRETS` resolves nothing.

## Configuration

| Name                      | Kind                    | Default                                                 |
| ------------------------- | ----------------------- | ------------------------------------------------------- |
| `SERVICE_TOKEN`           | Worker secret           | none (all calls refused)                                |
| `DEV_SECRETS`             | Worker secret, dev only | none                                                    |
| `SANDBOX_INSTANCE`        | var                     | `standard-2` (1 vCPU, 6 GiB, 12 GB disk)                |
| `SANDBOX_IDLE_TIMEOUT_MS` | var                     | `1800000` (30 minutes; Cloudflare's maximum is 6 hours) |

The container image is built from `../image/Dockerfile`, with `sandbox/` as its build context. It must run `sandbox-shim`, which the `Files` API needs, and
trust the ephemeral CA that HTTPS interception creates at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`.
Every exec also points `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS` and
`REQUESTS_CA_BUNDLE` at that CA.

## Develop

```bash
npm ci
npm run check   # tsc
npm test        # Vitest in the Workers runtime (@cloudflare/vitest-plugin)
```

The tests run the real Worker and Durable Objects in Miniflare with a fake container in place of
`ctx.container`. They drive the outbound handler that each company's Durable Object installs.

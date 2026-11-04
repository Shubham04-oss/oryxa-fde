# realtime

A Cloudflare Worker with Durable Objects for live views (ADR 0003). For now it carries agent run output to the
review screen; the canvas (#26) adds its own object here.

One `RunChannel` object per run, named `<tenant>:<company>:<project>:<run>`. It keeps the newest 500 lines (at most
2 MiB) in memory only: nothing is written to Durable Object storage. The API's stored transcript is the record;
this is only the live view, so a browser reads the transcript first and then follows the channel, dropping any
`seq` it already has.

## Routes

Both are under `/internal/v1/tenants/<tenant>/companies/<company>/projects/<project>/agent-runs/<run>/`, with the
platform's id rules. Each caller has its own token; a token unset or shorter than 32 characters refuses everyone.

| Method and path        | Caller                                                                          | Does                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST events`          | `oryxa-fde-api`, `Authorization: Bearer <PUBLISH_TOKEN>` (its `REALTIME_TOKEN`) | Takes harness lines as `application/x-ndjson` (each `{"v":1,"seq":n,"type":…}`, at most 1 MiB a line and 4 MiB a batch), drops a `seq` already seen, and sends the rest to every browser on the run. `202`. |
| `GET live` (WebSocket) | fde-web, `Authorization: Bearer <SUBSCRIBE_TOKEN>`                              | Sends the kept lines, then each new one. fde-web asks the API whether the FDE may see the run before it calls; browsers never reach this Worker directly.                                                   |

## Deploy

`wrangler deploy` from this directory (infra's `deploy-workers`). It needs:

- Worker secrets `PUBLISH_TOKEN` and `SUBSCRIBE_TOKEN`, each at least 32 random characters
  (`npx wrangler secret put PUBLISH_TOKEN`).
- A route the API can reach for `POST events`, set as `REALTIME_URL` in the API's environment, with
  `REALTIME_TOKEN` equal to `PUBLISH_TOKEN`.
- fde-web's service binding `REALTIME` to this Worker, and fde-web's secret `REALTIME_SUBSCRIBE_TOKEN` equal to
  `SUBSCRIBE_TOKEN`.

## Develop

```bash
npm ci
npm run check   # prettier and tsc
npm test        # vitest in workerd: tokens, limits, ids, and WebSockets end to end
```

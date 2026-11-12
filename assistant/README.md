# assistant

The workspace assistant (ADR 0008, ADR 0009, issue #236): a Cloudflare Worker with one Durable Object per
conversation, built on Cloudflare's Agents SDK (`agents`: its `Lifecycle`, the `Streams` capability for resumable
streams, and the job queue for the idle alarm) with the Vercel AI SDK (`ai`) for the model loop. This slice enables
only a scripted model (`src/model/fake.ts`): no model provider is reached and no model credential exists.

## Who reaches it

Only fde-web's server, by service binding. There is no workers.dev URL, no preview URL and no route, and the Agents
SDK's default routing by name (`routeAgentRequest`) is not used: the Worker reaches each object over RPC, and the
object answers no HTTP of its own.

On every call (a turn, a reconnect, a view, a proposal's answer) fde-web asks the API who the person is
(`/v1/me`) and, for a company's conversation, reads the company; then it signs a binding and calls with:

| Header                                  | What                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <SERVICE_TOKEN>` | fde-web's `ASSISTANT_SERVICE_TOKEN`. Unset or shorter than 32 characters here: everyone is refused.                             |
| `x-assistant-binding`                   | `base64url(JSON).base64url(HMAC-SHA256)` under `BINDING_KEY`: `{v:1, conv, tenant, person, company or null, exp}`, a minute.    |
| `x-assistant-session`                   | On a turn only: the person's session cookie alone (`__Host-fde_session=…`). Held in memory for that turn's reads, then dropped. |

The first turn binds the conversation to its person, organisation and company (or none, for the home conversation);
any later binding that names another is refused, as is one for another conversation, an expired one, or one that
lives longer than two minutes.

## Routes

All under `/internal/v1/conversations/<conversation>`, ids with the platform's rule.

| Method and path             | Does                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET`                       | The conversation so far (`ConversationView` in the wire format), or 404 `no_conversation`.                             |
| `POST turns`                | `{ "text": … }`: starts a turn and answers with its stream (SSE).                                                      |
| `GET turns/<turn>/events`   | The turn's stream again, after `Last-Event-ID` (or from `?from=`): a dropped connection resumes, a second tab replays. |
| `POST proposals/<proposal>` | `{ "outcome": "confirmed" \| "dismissed" }`: the person has answered it. Nothing runs here.                            |

## The wire format (version 1)

`fde-web/src/lib/workspace/blocks.ts` and `wire.ts`, copied into `src/catalogue/` by `npm run catalogue`
(`npm run check` fails when a copy is stale). Each SSE frame is one event, `id:` its sequence number:

- `turn` (the turn's id and what the person said), then any number of `text` deltas, `block`s from the web's
  catalogue, `proposal`s from the action catalogue (`create_company`, `open_route`) with exact arguments, and a
  `notice` when a reply stopped short (`tool_limit`, `reply_limit`, `timed_out`, `failed`);
- then the SDK's control frames: `up-to-date`, and `done` or `error`.

The Worker checks every event before it stores it, and the web checks it again before it renders: an unknown or
malformed event, block or proposal is dropped. A proposal's id is the Worker's, never the model's.

## Limits

`src/limits.ts`: ten turns a minute per person (a `PersonTurns` object per person), 50 turns a conversation, four
tool calls a turn, 90 seconds a turn, 2,000 characters a message, 8,000 a reply, 16 KiB (UTF-8) of each tool answer.
A refusal names the limit and the web says it plainly; a turn that runs out of time ends with the `timed_out` notice.
The web holds the stream to the same caps, reconnects when a read hears nothing (heartbeats included) for 45 seconds,
and gives up on a turn after 120. The working copy is deleted after 24 hours idle. A limit per organisation waits for a
real model (ADR 0009 leaves budgets per organisation open).

## Deploy

Not yet: the deploy workflow is a follow-up. It will need the Worker secrets `SERVICE_TOKEN` and `BINDING_KEY`
(each at least 32 random characters), the API's `vpc_services` binding named `API`, and fde-web's service binding
`ASSISTANT` with `ASSISTANT_SERVICE_TOKEN` and `ASSISTANT_BINDING_KEY` equal to them.

## Develop

```bash
npm ci
npm run check   # prettier, tsc, eslint, and that src/catalogue matches fde-web
npm test        # vitest in workerd: auth, the turn, resume, the idle alarm, limits, drops, injection, privacy
```

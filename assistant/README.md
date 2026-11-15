# assistant

The workspace assistant (ADR 0008, ADR 0009, issue #236): a Cloudflare Worker with one Durable Object per
conversation, built on Cloudflare's Agents SDK (`agents`: its `Lifecycle`, the `Streams` capability for resumable
streams, and the job queue for the idle alarm) with the Vercel AI SDK (`ai`) for the model loop. `ASSISTANT_MODEL`
picks the model (`src/model/provider.ts`): `fake`, the scripted model (`src/model/fake.ts`) and the default, or
`vertex:<model id>`, Gemini on Vertex AI through the AI SDK's Vertex provider in its edge form (issue #260). Vertex
needs every setting below, well formed, or each turn is refused; it is never swapped for another model. Its requests
go only to the one Vertex host for the configured location and Google's token endpoint, over https, enforced in code.

## Who reaches it

Only fde-web's server, by service binding. There is no workers.dev URL, no preview URL and no route, and the Agents
SDK's default routing by name (`routeAgentRequest`) is not used: the Worker reaches each object over RPC, and the
object answers no HTTP of its own.

On every call (a turn, a reconnect, a view, a stop, a proposal's answer) fde-web asks the API who the person is
(`/v1/me`) and whether they hold this conversation, bound to this company or to home, and may still use it
(`/v1/assistant/conversations/{id}/check`); anything but its 204 refuses, and someone else's conversation gets the
same answer as one that does not exist. A new conversation is made by the API, as the person, before its first turn,
so the API alone decides the binding. Then fde-web signs a binding and calls with:

| Header                                  | What                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <SERVICE_TOKEN>` | fde-web's `ASSISTANT_SERVICE_TOKEN`. Unset or shorter than 32 characters here: everyone is refused.                          |
| `x-assistant-binding`                   | `base64url(JSON).base64url(HMAC-SHA256)` under `BINDING_KEY`: `{v:1, conv, tenant, person, company or null, exp}`, a minute. |
| `x-assistant-session`                   | On a turn, a view and an answer: the person's session cookie alone (`__Host-fde_session=…`), lent for that call. See below.  |
| `x-assistant-origin`                    | With the session on a turn or an answer: fde-web's own origin, which the API asks of a write; `WEB_ORIGIN` when that is set. |

The first call with a session binds the conversation to its person, organisation and company (or none, for the home
conversation); any later binding that names another is refused, as is one for another conversation, an expired one, or
one that lives longer than two minutes.

## The record

The API holds the conversation's record (ADR 0009, issue #279); the object's storage is a working copy. A session is
lent with a turn, a view and an answer. The object holds the newest one lent by a turn or an answer in memory only, for
as long as the turn may run and 15 seconds after the call (`LEND_GRACE_MS`), and never writes it to storage, a log or a
prompt. No write starts, or runs, past that deadline; what is left waits for the next session lent. A view lends the
session alone, to rebuild, and never writes.

- **Each finished turn** (done, or with a notice: `tool_limit`, `reply_limit`, `timed_out`, `failed`, `stopped`) is
  written with `PUT /v1/assistant/conversations/{id}/turns/{n}` after the stream has ended, so the stream never waits
  on it, one at a time and in order, each at the record's next place. Step events are not written. What is written is
  checked first with the API's rules (`src/record.ts`): a part the record does not take in the conversation's scope,
  or that holds a NUL or a lone surrogate, is left out. Every block type is kept in every scope, and so is every part
  naming a destination, a project at home included: the API checks that the person may work on it. A turn names at
  most 16 distinct destinations (the lists count as one, each company and project once), as the API takes; past that,
  the extra parts are left out, blocks first and then proposals, and the drop is logged by turn id.
- **A write is tried three times** on a timeout, a dropped connection or a 5xx. One that cannot be made (or that the
  session no longer allows) stays marked in the working copy and is written at the start of the next turn. The API
  answers a retry of a stored turn with 200, so a write is never doubled.
- **A refused turn never stops the record.** A part naming a record the API refuses (`invalid_destination`) is left out
  on a second try; a turn whose content the API refuses is written as a plain failed turn in its place (what the person
  said, `failed`), so the turns after it keep their places. `409 rejected_turn_taken` stops the writes and leaves the
  turns waiting; with the next session the record's places are read first and the writes follow its last.
  `409 rejected_turn_limit` ends the conversation (the next turn is refused `turn_limit`).
- **An answer to a proposal** is recorded with `PUT .../turns/{n}/proposals/{p}` once its turn is written, with the
  session the answer lent, or at the next turn. Recording performs nothing: the web has already called the action's
  own route, or not (ADR 0008).
- **An object that holds nothing** is rebuilt from `GET /v1/assistant/conversations/{id}` on the first call that lends
  a session (a view or a turn); without one a view answers `no_conversation`. A record the API does not know for this
  person answers `404 unknown_conversation`; one it cannot read, that names another company, or with no API binding at
  all, `503 record_unavailable`: it never starts empty over a record it could not read.
- **A working copy made before the record** gains its columns when it starts, and a proposal answered before then owes
  its answer, so it is sent and never shown as waiting after a rebuild. The idle deletion logs, by ids, any turn or
  answer it takes before the record has it.
- **`WEB_ORIGIN`**, when the deploy sets it, is the only origin taken with a lent session; unset, only its shape is
  checked (https, or http on localhost).
- Logs carry ids and an outcome only.

## Routes

All under `/internal/v1/conversations/<conversation>`, ids with the platform's rule.

| Method and path             | Does                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET`                       | The conversation so far (`ConversationView` in the wire format), or 404 `no_conversation`; rebuilt from the record.    |
| `POST turns`                | `{ "text": … }`: starts a turn and answers with its stream (SSE).                                                      |
| `GET turns/<turn>/events`   | The turn's stream again, after `Last-Event-ID` (or from `?from=`): a dropped connection resumes, a second tab replays. |
| `POST proposals/<proposal>` | `{ "outcome": "confirmed" \| "dismissed" }`: the person has answered it. Nothing runs here.                            |
| `POST turns/<turn>/stop`    | Stops the turn if it is the one running: it ends with the `stopped` notice, keeping what it said. Otherwise a no-op.   |

## The wire format (version 1)

`fde-web/src/lib/workspace/blocks.ts` and `wire.ts`, copied into `src/catalogue/` by `npm run catalogue`
(`npm run check` fails when a copy is stale). Each SSE frame is one event, `id:` its sequence number:

- `turn` (the turn's id and what the person said), then any number of `step`s, `text` deltas, `block`s from the
  web's catalogue, `proposal`s from the action catalogue (`create_company`, `open_route`) with exact arguments, and a
  `notice` when a reply stopped short (`tool_limit`, `reply_limit`, `timed_out`, `failed`, `stopped`);
- a `step` is one read starting and ending: `{id, tool, state, count?}`, the tool from a fixed list
  (`list_companies`, `read_today`), the state `running`, `done` or `failed`, and at most how many records came back
  (capped). Never the read's arguments or what it read. A read still running when the turn ends ends as `failed`;
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
`ASSISTANT` with `ASSISTANT_SERVICE_TOKEN` and `ASSISTANT_BINDING_KEY` equal to them, and the var `WEB_ORIGIN` set to
fde-web's origin (`deploy-workers` sets it to `https://<WEB_HOSTNAME>`, infra/README.md, Deploys).
For Gemini on Vertex it also sets the var `ASSISTANT_MODEL` to
`vertex:<model id>` (for example `vertex:gemini-2.5-flash`), the secrets
`VERTEX_CLIENT_EMAIL` (a service account's email) and `VERTEX_PRIVATE_KEY` (its PKCS #8 PEM key, escaped newlines
accepted), and the vars `VERTEX_PROJECT` and `VERTEX_LOCATION` (`global` or one region). Sample data only (ADR 0009).

## Develop

```bash
npm ci
npm run check   # prettier, tsc, eslint, and that src/catalogue matches fde-web
npm test        # vitest in workerd: auth, the turn, resume, the idle alarm, limits, drops, injection, privacy, record
```

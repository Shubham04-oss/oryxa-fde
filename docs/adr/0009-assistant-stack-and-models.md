# 0009: The assistant's stack, and which models we prefer

Status: accepted, 12 November 2026. Builds on ADR 0008 (how the assistant may act). Amends ADR 0003's
"Bedrock first" and ADR 0004's "Bedrock is the first model path for both": the preferred model path
is now the one below.

## Context
The product now has two places a model works: the workspace assistant (ADR 0008) and the coding
agent in the sandbox (ADR 0004). Many tools could serve either: the Vercel AI SDK, TanStack AI,
the Claude Agent SDK, OpenCode, CopilotKit, a vendor's hosted agents, or a loop of our own. The
founder asked for one clear stack, with one tool for each job, and prefers Gemini models for now
because the company holds Google Cloud credits. The standing rule is to use a maintained
open-source piece before building our own, and to keep our adapters thin.

## Decision
| Job | What we use |
| --- | --- |
| Workspace assistant, the engine | The Vercel AI SDK (open source) for the model loop, run by Cloudflare's Agents SDK (open source) on Durable Objects, one object per conversation |
| Workspace assistant, the live session | That conversation's Durable Object: the stream, reconnects, several tabs, approvals waiting on a person |
| Workspace assistant, the record | Postgres in AWS, written through the API |
| Workspace assistant, the screens | The AI SDK's chat hooks and shadcn-style components, inside the TanStack Start app |
| Coding agent in the sandbox | OpenCode first, the Claude Agent SDK second (ADR 0004, unchanged) |
| Models | Gemini through Google Vertex AI, preferred for now; Claude through AWS Bedrock as the second path |
| Evals | `oryxa-fde-evals`, for the coding agent and for the assistant |

- **The assistant holds no authority (ADR 0008).** It has no database access, no SpiceDB access
  and no service token for the API. Each of its tools is a call to an existing API route made with
  the signed-in person's session, over the private link the web already uses, so validation,
  `oryxa-authz` checks, company scope and limits apply as for any call.
- **One Durable Object per conversation holds the live session.** The object is named for the
  conversation, and the conversation is bound to one company and one person (ADR 0008); the Worker
  in front checks the person's session and that binding with the API before it routes to the
  object, and fails closed. The object keeps the session well: a dropped connection resumes the
  same stream, a second tab sees the same state, and a proposal waiting on a person survives the
  object sleeping. This is the same runtime as presence and live agent output (ADR 0003).
- **AWS holds the record; the object holds a working copy.** Every finished turn is written through
  the API to Postgres in AWS, which is the conversation's history, the thing evals and audit read,
  and what a new object is rebuilt from. The object's own storage is a cache: it is deleted when
  the conversation has been idle for a set time, and nothing reads it as the record.
- **Residency.** Durable Objects cannot be kept in India today: the jurisdictions offered are the
  EU, the US and FedRAMP, and a location hint is best effort. So, as with sandboxes (ADR 0003's
  amendment), the assistant on Cloudflare handles sample data only. Before real customer data, the
  lead records one of: the working copy is held in memory only and never stored; or the engine
  moves to a service in AWS (the AI SDK and the API contract stay the same, so this is a move, not
  a rewrite); or Cloudflare offers a jurisdiction that the customer's terms accept.
- **It is reachable only through the product's own host,** behind the same origin and session
  checks as the API.
- **Its outbound hosts are an explicit list:** the API, Vertex AI and Bedrock. Nothing else.
- **Model credentials stay out of code and out of the browser.** They are Worker secrets, set by
  the deploy and never in config, logs, a sandbox or the object's storage, as the sandbox's
  outbound handler already holds model credentials. Each is scoped to calling models and nothing
  else.
- **Prompts and answers are not logged on Cloudflare either** (ADR 0008). If Cloudflare's AI
  Gateway is put in front of the models for spend limits and fallback, its request logging is
  switched off.
- **Gemini is preferred for now, for both jobs.** The assistant uses a Gemini model through Vertex
  by default. OpenCode in the sandbox prefers Gemini through Vertex once the outbound handler can
  sign for Vertex (ADR 0004 lists that as later work); until then its runs stay on Bedrock. Claude
  through Bedrock stays configured as the second path and for steps where an eval shows it does
  clearly better. A company's config may choose between the allowed models; it cannot add a host.
- **A model is chosen by name in config, pinned, and changed only after the eval suites pass**
  (ADR 0008 for the assistant, ADR 0004 for the coding agent). The AI SDK's provider layer is the
  only place a provider is named, so changing provider is a config change.
- **No personal logins.** A Claude Code, Gemini or other subscription sign-in belongs to one
  person's own work. The product never authenticates through one, for the assistant or the coding
  agent.
- **Not used for the assistant:** the Claude Agent SDK and OpenCode (coding harnesses built around
  a working directory and a shell, kept for the sandbox); TanStack AI (newer than the AI SDK, and
  one family is enough); CopilotKit and vendor-hosted agents (each takes over the loop or stores
  it with another vendor); the Anthropic and Google consumer APIs called directly
  (the same models, with a second set of keys and bills).
- **Dependencies** are pinned exactly, permissively licensed, and checked like the rest of the
  workspace. The assistant's code lives with the web stream beside `realtime/`; its deployment
  lives with infra.

## Before real customer data
The rules of ADR 0003 hold: sample data only until per-company keys exist. In addition, before any
real customer data is sent to a model, the lead records in this ADR, for each model in use: the
region where prompts are processed, the provider's terms on retention and on training, and the
price. Processing in India is preferred where a suitable model is served there. None of that is
confirmed yet, so nothing here permits real data.

## Consequences
- No new service in AWS: the assistant runs on the Cloudflare account we already deploy to, and is
  billed by use.
- The assistant gains a mature tool loop, streaming and typed output without our writing them, and
  moving between Gemini and Claude is a config change, measured by the same evals.
- The Vertex key is the first Google credential the product holds, and it needs rotation and an
  owner. Real customer data waits on the residency choice above as well as on per-company keys.
- OpenCode on Gemini waits for Vertex signing in the outbound handler. There is no hurry: the
  founder set no date.

## Not decided here
The exact model names; whether AI Gateway is used; how long an idle conversation's working copy is
kept; budgets per organisation.

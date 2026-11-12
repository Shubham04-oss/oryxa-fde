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
| Workspace assistant, the engine | The Vercel AI SDK (open source), in a small TypeScript service of ours in AWS beside the API |
| Workspace assistant, the screens | The AI SDK's chat hooks and shadcn-style components, inside the TanStack Start app |
| Coding agent in the sandbox | OpenCode first, the Claude Agent SDK second (ADR 0004, unchanged) |
| Models | Gemini through Google Vertex AI, preferred for now; Claude through AWS Bedrock as the second path |
| Evals | `oryxa-fde-evals`, for the coding agent and for the assistant |

- **The assistant service holds no authority (ADR 0008).** It has no database access, no SpiceDB
  access and no service token for the API. Each of its tools is a call to an existing API route
  made with the signed-in person's session, which the web passes through, so validation,
  `oryxa-authz` checks, company scope and limits apply as for any call. It keeps no state of its
  own: conversation history is read and written through the API and stored in Postgres in AWS.
- **It is reachable only through the product's own host,** behind the same origin and session
  checks as the API, and it runs in the private network in AWS. It is not a Cloudflare Worker,
  because it assembles prompts from company records and holds model credentials, and both stay in
  AWS.
- **Its outbound hosts are an explicit list:** the API, Vertex AI and Bedrock. Nothing else.
- **Model credentials stay out of code and out of the browser.** Bedrock is reached with the
  task's IAM role. Vertex is reached with a Google service account whose key is held in AWS
  Secrets Manager and referenced, never copied into config, logs or a sandbox.
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
  one family is enough); CopilotKit, Cloudflare's agent kit and vendor-hosted agents (each runs or
  stores the loop outside our AWS account); the Anthropic and Google consumer APIs called directly
  (the same models, with a second set of keys and bills).
- **Dependencies** are pinned exactly, permissively licensed, and checked like the rest of the
  workspace. The service's code lives with the web stream; its deployment lives with infra.

## Before real customer data
The rules of ADR 0003 hold: sample data only until per-company keys exist. In addition, before any
real customer data is sent to a model, the lead records in this ADR, for each model in use: the
region where prompts are processed, the provider's terms on retention and on training, and the
price. Processing in India is preferred where a suitable model is served there. None of that is
confirmed yet, so nothing here permits real data.

## Consequences
- One more small service to build, deploy and watch, for a few dollars a month in dev.
- The assistant gains a mature tool loop, streaming and typed output without our writing them, and
  moving between Gemini and Claude is a config change, measured by the same evals.
- Two cloud accounts carry model traffic. The Vertex key is the first Google credential the
  product holds, and it needs rotation and an owner.
- OpenCode on Gemini waits for Vertex signing in the outbound handler. There is no hurry: the
  founder set no date.

## Not decided here
The exact model names; the streaming transport between the web and the service; whether the
service is its own ECS service or a second container in the API's task; budgets per organisation.

# 0003: Where each part runs

Status: accepted, 3 November 2026. Amended 12 November 2026 by ADR 0009: Gemini through Vertex is the
preferred model path for now, Bedrock the second, and the workspace assistant runs on Durable Objects.

| Part | Runs on |
| --- | --- |
| DNS, WAF, bot protection | Cloudflare |
| `fde-web` | Cloudflare Workers with static assets (TanStack Start, like the platform web app) |
| Realtime: presence, agent output, notifications | Cloudflare Durable Objects |
| Sandboxes | Cloudflare Sandboxes, with outbound Workers for the allowlist and secret injection |
| `oryxa-fde-api` and workers | Rust on AWS ECS Fargate, reached from Workers over a private link |
| Database | RDS PostgreSQL 17 with pgvector |
| Permissions | SpiceDB on Fargate |
| Files | S3, one prefix per company; one KMS key per company from P1 (real customer data), the environment key in P0 |
| Events | EventBridge v2 custom bus `oryxa-fde-<env>`, FIFO subscribers into SQS FIFO with a DLQ each, fed by an outbox |
| Secrets | AWS Secrets Manager; records hold references only |
| Models | Bedrock first; vendor providers through config later |

Customer data at rest stays in AWS. Fargate, not Lambda, because agent runs and live streams outlast
Lambda's limits. The bus has no OpenTofu resource yet, so it is created by script, as in the platform.

## Amendment, 4 November 2026: sandbox residency

The sandbox gateway work (#5, #13) found that a Cloudflare Sandbox SDK 1.0 sandbox cannot be pinned
to a region or jurisdiction: placement constraints exist only on the `default` scheduling policy,
and the SDK requires the `durable_object` policy. Sandbox disk is also ephemeral.

Decision:
- Cloudflare sandboxes run on sample data only, as already required for P0. No customer data, and
  nothing a customer's residency terms cover, enters them.
- Work leaves a sandbox only by push to the project's Git or upload to S3 in AWS before it stops.
  No R2 backups.
- Work on real or region-bound data runs on the runner in the customer's cloud (P1), never in a
  Cloudflare sandbox.
- Revisit when the Sandbox SDK supports placement constraints.

## Amendment, 4 November 2026: per-company keys

P0 encrypts company files with the environment key, because P0 holds sample data only. Isolation
between companies in S3 rests on the company prefix with the API role limited to it, the
`CompanyScope` check on every request, and CloudTrail data events.

Per-company keys arrive before the first real customer data (P1):
- a provisioning step, never the API at request time, creates one key per company, tagged with the
  tenant and company and aliased `alias/oryxa-fde-<env>/companies/<company>`, with a fixed key policy
  that allows use only through S3 by the roles that serve that company;
- writes name the company's key, and the bucket policy refuses a write under a company prefix that
  names any other key;
- offboarding a company schedules its key for deletion, which makes its objects, versions and
  backups unreadable.

Proposed by the infra stream in #34.

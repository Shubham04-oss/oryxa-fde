# 0003: Where each part runs

Status: accepted, 3 November 2026.

| Part | Runs on |
| --- | --- |
| DNS, WAF, bot protection | Cloudflare |
| `fde-web` | Cloudflare Workers with static assets (TanStack Start, like the platform web app) |
| Realtime: presence, agent output, notifications | Cloudflare Durable Objects |
| Sandboxes | Cloudflare Sandboxes, with outbound Workers for the allowlist and secret injection |
| `oryxa-fde-api` and workers | Rust on AWS ECS Fargate, reached from Workers over a private link |
| Database | RDS PostgreSQL 17 with pgvector |
| Permissions | SpiceDB on Fargate |
| Files | S3, one prefix and KMS key per company |
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

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

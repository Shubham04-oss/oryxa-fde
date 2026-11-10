# infra: the dev environment in OpenTofu

AWS and Cloudflare for `oryxa-fde`, following ADR 0003. **Nothing here has been applied.** Only
the owner applies, from their own machine, in the order below. CI runs `fmt`, `validate` and a
plan on mock providers with no credentials.

Patterns come from the platform's `infra/modules` and `docs/deploy.md` (oryxa-platform `2b064a3`).
The S3, SQS FIFO and EventBridge modules and the VPC are adapted from there, and each file says so.

## What it builds

```
Browser -> Cloudflare (DNS, Access on admin.) -> fde-web Worker (app.<domain>)
  -> vpc_services binding (Workers VPC) -> Cloudflare Tunnel -> cloudflared on Fargate (private subnet)
  -> internal ALB -> oryxa-fde-api on Fargate
       -> RDS PostgreSQL 17 + pgvector    (IAM database auth, TLS, private)
       -> SpiceDB on Fargate              (spicedb.oryxa-fde-dev.internal:50051, Cloud Map, private)
       -> S3 data bucket                  (KMS, tenants/<tenant>/companies/<company>/ prefix per company)
       -> EventBridge v2 bus oryxa-fde-dev -> per-consumer SQS FIFO + DLQ + undelivered queue
Everything outbound (AWS APIs, image pulls, WorkOS, the tunnel) leaves through one fck-nat instance.
CloudTrail logs management events and object access on the data bucket.
```

Nothing in AWS accepts traffic from the internet. No security group has a CIDR ingress rule wider
than the VPC, and the API has no public hostname. Only Workers in this Cloudflare account that
are bound to the VPC service reach it, through the tunnel.

| Path | What |
| --- | --- |
| `modules/vpc` | VPC `10.50.0.0/16`, public and private subnets in two AZs, fck-nat instance, S3 gateway endpoint, optional interface endpoints |
| `modules/postgres` | RDS for PostgreSQL 17, encrypted, IAM auth, `rds.force_ssl`, master password managed by RDS in Secrets Manager |
| `modules/fargate_service` | One ARM64 container: task definition, log group, execution and task roles, security group, optional ECS service |
| `modules/internal_alb` | Internal ALB, target group (`ip`), HTTP listener reachable from named security groups only |
| `modules/s3` | Private bucket: KMS, versioned, public access blocked, TLS only; `force_destroy` for teardown only |
| `modules/sqs_fifo` | FIFO queue, FIFO DLQ, optional undelivered queue (names and attributes match the platform's consumer kit) |
| `modules/eventbridge` | Delivery role for bus subscribers and the publish policy (the bus itself is created by script) |
| `modules/cloudtrail` | Multi-region trail with its own bucket and key, log file validation, data events on the data bucket |
| `modules/cloudflare` | DNS for `app.` and `admin.`, the tunnel, the Workers VPC service to the ALB, Access on `admin.` |
| `envs/dev` | The composition, variables, outputs, lock file and `tests/plan.tftest.hcl` (with `tests/contract`, which reads the API environment contract below); `deploy.tf` holds the GitHub deploy role and the deploy parameters |
| `docker/oryxa-fde-api.Dockerfile` | The API image: the prebuilt ARM64 `oryxa-fde-api` and `oryxa-fde-ops` on distroless Debian 13, nonroot |
| `scripts/create-event-bus.sh` | Creates the EventBridge v2 bus `oryxa-fde-<env>` in a named region (no OpenTofu resource yet) |
| `scripts/run-task.sh` | One-off tasks in the private subnets: bootstrap SQL, the store's migrations, SpiceDB migrate, SpiceDB schema write |
| `sql/01-bootstrap.sql` | pgvector, the IAM logins `oryxa_fde_migrator`, `oryxa_fde_api` and `spicedb`, the NOLOGIN roles the API reaches through `oryxa_fde_runtime`, the `spicedb` database, and a check that nothing the API reaches has owner powers |
| `sql/02-api-owns-nothing.sql` | Once, only on a database the first bootstrap let `oryxa_fde_api` own: hands its objects to the migrator and drops its old grants |

Names: the ECS service is `oryxa-fde-api` and its ECR repository is `oryxa-fde-api`. Everything
else is `oryxa-fde-<env>-…`: the cluster `oryxa-fde-dev`, SpiceDB `oryxa-fde-dev-spicedb`, the
one-off tasks `oryxa-fde-dev-migrate`, `-db-admin` and `-zed`, the bus `oryxa-fde-dev`, and the
queues `oryxa-fde-dev-<consumer>.fifo`, `-dlq.fifo` and `-undelivered`.

## Variables

Set in `envs/dev/terraform.tfvars` (gitignored; start from `terraform.tfvars.example`). None of
them is a secret. The Cloudflare API token comes from `CLOUDFLARE_API_TOKEN` in the environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `env` | `dev` | Environment name in every resource name (`oryxa-fde-<env>`); 2 to 10 lowercase letters or digits |
| `aws_account_id` | required | The only account the AWS provider will touch (`allowed_account_ids`) |
| `aws_region` | `us-west-2` | The platform's region, until the first region is decided (plan, open decisions) |
| `cloudflare_account_id` | required | Account for the tunnel, the Workers VPC service and Access |
| `cloudflare_zone_id` | required | Zone holding `domain` |
| `domain` | required | Base hostname for dev; `app.<domain>` (fde-web) and `admin.<domain>` hang off it |
| `admin_emails` | required | Who may open `admin.<domain>` through Cloudflare Access |
| `workos_client_id` | required | WorkOS client id (public); the API key is a secret |
| `event_bus_arn` | required | Printed by `scripts/create-event-bus.sh`; must be the `oryxa-fde-<env>` v2 bus in `aws_account_id` and `aws_region` (plan fails otherwise) |
| `event_signing_kid` | `k1` | Key id of the API's event signing key (`EVENT_SIGNING_KID`); change it when the key rotates |
| `data_bucket_name` | required | Globally unique name for the customer data bucket |
| `cloudtrail_bucket_name` | required | Globally unique name for the CloudTrail log bucket |
| `api_image_tag` | required | Seeds `/oryxa-fde-<env>/api-image-tag` on the first apply (any value while nothing runs); after that `deploy-api` owns the tag (Deploys) |
| `github_repository` | `Shubham04-oss/oryxa-fde` | The repository whose `environment: <env>` jobs may assume the deploy role |
| `github_oidc_provider_arn` | `null` | The account's GitHub OIDC provider, if it already has one; null creates it |
| `start_services` | `false` | `false`: every service runs 0 tasks. Set `true` once the image and every secret value exist |
| `consumers` | `["lifecycle", "context-ingestion"]` | Event consumers; each gets a FIFO queue, a DLQ and an undelivered queue |
| `api_port` | `8080` | Port `oryxa-fde-api` listens on (`LISTEN_ADDR`) |
| `api_health_check_path` | `/healthz` | Path the ALB polls; must answer 200 without auth |
| `api_cpu` | `256` | API task CPU units (0.25 vCPU) |
| `api_memory` | `512` | API task memory in MiB |
| `spicedb_image` | `authzed/spicedb:v1.56.2` | Same version as CI |
| `cloudflared_image` | `cloudflare/cloudflared:2026.10.7` | Tunnel connector |
| `db_instance_class` | `db.t4g.micro` | RDS instance class |
| `allow_destroy` | `false` | Set `true` only to tear the environment down: lifts RDS deletion protection and lets `destroy` empty both buckets and the ECR repository |
| `vpc_cidr` | `10.50.0.0/16` | Distinct from the platform's `10.40.0.0/16`, so the two can be peered later |
| `interface_endpoints` | `[]` | PrivateLink endpoints for AWS APIs (about $7.30/month each); empty means the NAT carries that traffic |
| `log_retention_days` | `14` | CloudWatch retention for every task's logs |
| `embedding_model` | `amazon.titan-embed-text-v2:0` | Bedrock foundation model that embeds text (`EMBEDDING_MODEL`); the API's role may invoke this model only, in `aws_region` |
| `sandbox_gateway_url` | `null` | Gateway Worker's URL (`SANDBOX_GATEWAY_URL`), known after `deploy-workers`. Null: agent and eval routes are not mounted, and the next three are unused |
| `agent_model` | `null` | Bedrock model or inference profile for agents (`AGENT_MODEL`); required with `sandbox_gateway_url` |
| `agent_region` | `null` | Its region (`AGENT_REGION`); null means `aws_region` |
| `realtime_url` | `null` | Realtime Worker's URL (`REALTIME_URL`); null: output is stored, not streamed |
| `github_app` | `null` | `{ app_id, slug, client_id }` of the GitHub App (all public). Null: GitHub routes answer 503 |
| `slack_client_id` | `null` | The Slack app's client id (public). Null: Slack routes answer 503 |

The state backend takes `bucket` and `region` at `tofu init` (step 1); the state key is
`oryxa-fde/dev/terraform.tfstate`.

## Secrets

Secrets Manager holds one secret per value. OpenTofu creates each secret empty, encrypted with
the environment key, and grants read access by exact ARN to the tasks that use it. The owner
sets the values by hand, so no value passes through OpenTofu config, plan or state. ECS injects
them as env vars when a task starts, and a task cannot start until its secrets have values.

| Secret (`oryxa-fde-dev/…`) | Env name | Read by |
| --- | --- | --- |
| `api/workos-api-key` | `WORKOS_API_KEY` | oryxa-fde-api |
| `api/event-signing-key` | `EVENT_SIGNING_KEY` | oryxa-fde-api (outbox relay) |
| `api/session-password` | `SESSION_PASSWORD` | oryxa-fde-api (seals the session cookie) |
| `api/sandbox-gateway-token` | `SANDBOX_GATEWAY_TOKEN` | oryxa-fde-api, only with `sandbox_gateway_url` |
| `api/realtime-token` | `REALTIME_TOKEN` | oryxa-fde-api, only with `realtime_url` |
| `api/github-app-private-key`, `api/github-client-secret`, `api/github-webhook-secret` | `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` | oryxa-fde-api, only with `github_app` |
| `api/slack-client-secret`, `api/slack-signing-secret` | `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | oryxa-fde-api, only with `slack_client_id` |
| `api/install-state-key` | `INSTALL_STATE_KEY` | oryxa-fde-api, with `github_app` or `slack_client_id` |
| `shared/spicedb-preshared-key` | `SPICEDB_PRESHARED_KEY` (API), `SPICEDB_GRPC_PRESHARED_KEY` (SpiceDB), `ZED_TOKEN` (zed task) | oryxa-fde-api, SpiceDB, the zed task |
| `cloudflared/tunnel-token` | `TUNNEL_TOKEN` | cloudflared |
| RDS master (created by RDS) | `PGUSER`, `PGPASSWORD` | the db-admin task only |

A secret exists only while the feature that reads it is switched on (`tofu output secrets` lists the
ones that do). How to fill the new ones: `api/session-password` is 64 hex characters
(`openssl rand -hex 32`); `api/install-state-key` is at least 32 random bytes (`openssl rand -base64 48`);
`api/sandbox-gateway-token` is the same value as the gateway Worker's `SERVICE_TOKEN`;
`api/realtime-token` the same as the realtime Worker's token; the GitHub and Slack values come from
those apps' settings pages (the private key is the App's PEM; the webhook secret at least 32 bytes,
the Slack signing secret at least 16).

Slack bot tokens are not in this list: the API creates one secret per workspace at run time under
`oryxa-fde/<env>/slack/` (`SLACK_SECRET_PREFIX`), and its role may touch that prefix only. Teardown
leaves them behind; delete them by hand.

No service has a database password: the API, the migrate task and SpiceDB connect with IAM
database auth, as `oryxa_fde_api`, `oryxa_fde_migrator` and `spicedb`, and each task role may
`rds-db:connect` as its own user only.

## Database logins

| Login | Used by | May |
| --- | --- | --- |
| `oryxa_fde_migrator` | the one-off migrate task (`oryxa-fde-ops migrate`) | own and change the FDE tables; grant `oryxa_fde_app`, `oryxa_fde_relay` and `oryxa_fde_grants` onward (admin option), no CREATEROLE; nothing else connects as it |
| `oryxa_fde_api` | the API service | member of `oryxa_fde_runtime` only: `SET LOCAL ROLE` to `oryxa_fde_app`, `oryxa_fde_relay` or `oryxa_fde_grants` per transaction, inheriting none; `connect` and `usage` only; owns nothing, creates nothing |
| `spicedb` | SpiceDB | its own `spicedb` database only |
| RDS master | the db-admin task | the bootstrap SQL |

The NOLOGIN roles come from the bootstrap, so no login needs CREATEROLE: `oryxa_fde_app` and
`oryxa_fde_relay` (each transaction's role), `oryxa_fde_grants` (the SpiceDB grant reconciler's) and
`oryxa_fde_runtime`, which migration 0003 makes a member of the other three without inheritance.

The API can never reach table ownership, CREATEROLE or BYPASSRLS: its login is not a member of the
migrator or the master, and its task role cannot connect as the migrator (`tests/plan.tftest.hcl`
pins both IAM sides). The bootstrap ends with a check over the API login and every role it can
reach by `SET ROLE` or inheritance, and stops if any of them is a superuser, may create roles or
databases, bypasses row-level security, is the migrator, the master or a predefined role, owns a
relation, a schema or the database, may create in `public`, or holds an admin option. A query the
API runs outside a scoped transaction is refused, because it inherits no table rights.

**A database the first bootstrap set up** (the API owned its tables because it migrated at
startup) needs this once, before the first deploy of the non-owner API (#39):
1. `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql`: creates the new logins and roles, then
   stops at the check, naming what the API still holds.
2. `infra/scripts/run-task.sh sql infra/sql/02-api-owns-nothing.sql`: as the master,
   `reassign owned by oryxa_fde_api to oryxa_fde_migrator`, then revokes the API's `create` on
   `public` and its direct grants of `oryxa_fde_app` and `oryxa_fde_relay`.
3. `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql` again: the check passes.

## The API environment contract

Read from the code, not from memory (each `Read at` is `file:line` in `crates/`, checked against
`main` at `039df45`), and compared with what `envs/dev` sets. `tests/plan.tftest.hcl` reads these
tables: every `always` variable of the API must be on its task definition, every variable the
task definition sets must be in the table, and a secret must be injected from Secrets Manager, never set as plain
config. Add or change a variable in the code, and the table and `envs/dev` change in the same PR.

Columns. **Needed**: `always`; a feature the variable belongs to (`agent`, `realtime`, `github`,
`slack`: needed when that feature is on, and the first row of each is its switch); `optional` (the code has
a default); `local only` (tests and laptops). **Kind**: `config` (plain, visible in the task definition),
`secret` (a value; ECS injects it from Secrets Manager), `reference` (a Secrets Manager name or KMS key
ARN, not a value). Every task also gets its AWS identity from the task role: the SDK reads
`AWS_REGION` and the container credentials ECS provides (`aws_config::load_from_env`).

### `oryxa-fde-api`

The service, entrypoint `/usr/local/bin/oryxa-fde-api` (deployed). A variable that is missing, or
not valid, stops startup. The agent and eval routes mount only when `SANDBOX_GATEWAY_URL` is set;
GitHub only when `GITHUB_APP_ID` is; Slack only when `SLACK_CLIENT_ID` is.

| Variable | Needed | Kind | Default | Read at | Infra |
| --- | --- | --- | --- | --- | --- |
| `DB_HOST` | always | config | none | `oryxa-fde-store/src/iam.rs:82` | RDS address |
| `DB_PORT` | always | config | none | `iam.rs:82` | RDS port |
| `DB_NAME` | always | config | none | `iam.rs:82` | `oryxa_fde` |
| `DB_USER` | always | config | none | `iam.rs:82` | `oryxa_fde_api` |
| `AWS_REGION` | always | config | none | `iam.rs:133`, `oryxa-fde-context/src/lib.rs:102`, `oryxa-events/src/lib.rs:210` | `aws_region` |
| `SPICEDB_ENDPOINT` | always | config | none | `oryxa-fde-api/src/main.rs:45` | Cloud Map name |
| `SPICEDB_PRESHARED_KEY` | always | secret | none | `main.rs:46` | `shared/spicedb-preshared-key` |
| `WORKOS_API_KEY` | always | secret | none | `main.rs:50` | `api/workos-api-key` |
| `WORKOS_CLIENT_ID` | always | config | none | `main.rs:51` | `workos_client_id` |
| `WEB_ORIGIN` | always | config | none | `main.rs:64`, `main.rs:77` | `https://app.<domain>` |
| `SESSION_PASSWORD` | always | secret | none | `main.rs:65` | `api/session-password` |
| `EVENT_SIGNING_KID` | always | config | none | `main.rs:72` | `event_signing_kid` |
| `EVENT_SIGNING_KEY` | always | secret | none | `main.rs:72` | `api/event-signing-key` |
| `EVENT_BUS_ARN` | always | config | none | `main.rs:73` | `event_bus_arn` |
| `DOCUMENTS_BUCKET` | always | config | none | `oryxa-fde-context/src/lib.rs:103` | the data bucket |
| `LISTEN_ADDR` | optional | config | `0.0.0.0:8080` | `main.rs:81` | `0.0.0.0:<api_port>` |
| `EMBEDDING_PROVIDER` | optional | config | `bedrock` (`fake` for tests) | `context/src/lib.rs:104` | `bedrock` |
| `EMBEDDING_MODEL` | optional | config | `amazon.titan-embed-text-v2:0` (`embed.rs:12`) | `context/src/lib.rs:108` | `embedding_model` |
| `EMBEDDING_REPLACES` | optional | config | none | `context/src/lib.rs:113` | not set |
| `WORKOS_ISSUER` | optional | config | `https://api.workos.com/` | `main.rs:55` | not set |
| `SESSION_PASSWORD_PREVIOUS` | optional | secret | none | `main.rs:68` | not set; add a secret when rotating |
| `RUST_LOG` | optional | config | `info` | `main.rs:40` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:301` | never set |
| `SANDBOX_GATEWAY_URL` | agent | config | none: agent routes off | `oryxa-fde-agent/src/prod.rs:124` | `sandbox_gateway_url` |
| `SANDBOX_GATEWAY_TOKEN` | agent | secret | none | `prod.rs:128` | `api/sandbox-gateway-token` |
| `AGENT_MODEL` | agent | config | none | `prod.rs:149` | `agent_model` |
| `AGENT_REGION` | agent | config | none | `prod.rs:150` | `agent_region`, else `aws_region` |
| `REALTIME_URL` | realtime | config | none: output not streamed | `prod.rs:130` | `realtime_url` |
| `REALTIME_TOKEN` | realtime | secret | none; both or neither | `prod.rs:130` | `api/realtime-token` |
| `AGENT_MAX_TURNS` | optional | config | `100` | `prod.rs:151` | not set |
| `AGENT_APPROVALS` | optional | config | deploys and customer sends (JSON) | `prod.rs:142` | not set |
| `AGENT_RUN_MAX_MINUTES` | optional | config | `60` | `prod.rs:168` | not set |
| `AGENT_BUDGET_MINUTES` | optional | config | `600` | `prod.rs:165` | not set |
| `AGENT_BUDGET_USD` | optional | config | `100` | `prod.rs:166` | not set |
| `AGENT_PRICE_INPUT_USD_PER_MTOK` | optional | config | `15` | `prod.rs:161` | not set |
| `AGENT_PRICE_OUTPUT_USD_PER_MTOK` | optional | config | `75` | `prod.rs:162` | not set |
| `EVAL_JUDGE_MODEL` | optional | config | `AGENT_MODEL` | `prod.rs:155` | not set |
| `EVAL_JUDGE_MAX_CALLS` | optional | config | `200` | `prod.rs:157` | not set |
| `GITHUB_APP_ID` | github | config | none: GitHub off | `oryxa-fde-api/src/integrations.rs:84` | `github_app.app_id` |
| `GITHUB_APP_SLUG` | github | config | none | `integrations.rs:89` | `github_app.slug` |
| `GITHUB_APP_PRIVATE_KEY` | github | secret | none (PEM) | `integrations.rs:90` | `api/github-app-private-key` |
| `GITHUB_CLIENT_ID` | github | config | none | `integrations.rs:91` | `github_app.client_id` |
| `GITHUB_CLIENT_SECRET` | github | secret | none | `integrations.rs:92` | `api/github-client-secret` |
| `GITHUB_WEBHOOK_SECRET` | github | secret | none (32+ bytes) | `integrations.rs:98` | `api/github-webhook-secret` |
| `SLACK_CLIENT_ID` | slack | config | none: Slack off | `integrations.rs:104` | `slack_client_id` |
| `SLACK_CLIENT_SECRET` | slack | secret | none | `integrations.rs:110` | `api/slack-client-secret` |
| `SLACK_SIGNING_SECRET` | slack | secret | none (16+ bytes) | `integrations.rs:124` | `api/slack-signing-secret` |
| `SLACK_SECRET_PREFIX` | slack | reference | none; `oryxa-fde/<env>/slack/` | `integrations.rs:118` | `oryxa-fde/<env>/slack/` |
| `SLACK_KMS_KEY_ID` | slack | reference | none | `integrations.rs:119` | the environment key's ARN |
| `INSTALL_STATE_KEY` | github, slack | secret | none (32+ bytes) | `integrations.rs:80` | `api/install-state-key` |

What the API's task role may do, from what the code calls:

| Permission | Why (`Read at`) | In dev |
| --- | --- | --- |
| `rds-db:connect` as `oryxa_fde_api` | the store (`iam.rs`) | granted |
| `events:PutEvents` on the bus | the outbox relay (`oryxa-events/src/lib.rs:234`) | granted |
| `s3:GetObject`, `s3:PutObject` on `tenants/*/companies/*` | documents (`context/src/blob.rs:65`, `:81`; the code never deletes or lists) | granted; delete and list removed |
| `kms:Decrypt`, `kms:GenerateDataKey`, only through S3 | the bucket's default encryption | granted |
| `bedrock:InvokeModel` on `foundation-model/<embedding_model>` in `aws_region` | embeddings (`context/src/embed.rs:95`) | granted |
| `secretsmanager:CreateSecret`, `TagResource`, `PutSecretValue`, `GetSecretValue`, `DeleteSecret` on `oryxa-fde/<env>/slack/*`, and `kms:Decrypt`, `kms:GenerateDataKey` only through Secrets Manager | Slack bot tokens (`integrations/src/secrets.rs:87`, `:99`, `:117`, `:134`) | only with `slack_client_id` |
| Bedrock for `AGENT_MODEL`, `EVAL_JUDGE_MODEL` | not the API: the judge is a `curl` run inside the sandbox (`agent/src/evals.rs:232`), signed by the gateway's outbound handler | not granted; the gateway's AWS identity is the agent stream's follow-up |

### `oryxa-fde-ops`

Entrypoint `/usr/local/bin/oryxa-fde-ops` in the API image.

| Subcommand | Variables (Read at) | In dev |
| --- | --- | --- |
| `migrate` | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` as `oryxa_fde_migrator`, and `AWS_REGION` (`store/src/lib.rs:261`, `iam.rs:82`); `MIGRATION_DATABASE_URL` for local runs only (`lib.rs:267`) | the `oryxa-fde-dev-migrate` task sets all five; its role may connect as the migrator only |
| `replay-dead-events [tenant]` | `DB_*` as the runtime login, and `AWS_REGION` (`store/src/lib.rs:293`, `ops.rs:30`) | not deployed: no task definition |

### Not deployed

These have no image and no task definition yet; the facts for the issue that adds them. Each also needs
`AWS_REGION` and `RUST_LOG` as above. None of them can be started on ECS until the code gap in the first row is closed.

| Binary | Variables (Read at) | Permissions it will need |
| --- | --- | --- |
| `oryxa-fde-ingest` | `DATABASE_URL` (`oryxa-fde-context/src/bin/ingest.rs:38`: **a password URL, no IAM auth; the API stream must switch it to `Store::from_env()`** before it can run on ECS), `DOCUMENTS_BUCKET` and `EMBEDDING_*` (`ingest.rs:39`, as the API), `EVENT_SIGNING_KID` (`:41`), `EVENT_PUBLIC_KEY` (`:43`, the public half of the API's signing key, plain config), `INGEST_QUEUE_URL` (`:45`, `queue_urls["context-ingestion"]`) | SQS `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on that queue (`oryxa-fde-events/src/inbox.rs:91`, `:147`, `:161`); `s3:GetObject` on the company prefix; `bedrock:InvokeModel` on the embedding model; `rds-db:connect` as a runtime login; the queue's bus subscriber |
| `oryxa-fde-lifecycle` | `DB_*` as the runtime login (`lifecycle.rs:45`), `EVENT_SIGNING_KID` (`:47`), `EVENT_PUBLIC_KEY` (`:49`), `UPDATE_MODEL` (`:52`, a Bedrock inference profile, no default), `LIFECYCLE_QUEUE_URL` (`:99`, `queue_urls["lifecycle"]`); optional `DIGEST_FROM` (`:54`, an SES identity; without it no digest) with `WEB_ORIGIN` (`:57`, required then), optional `SLACK_SECRET_PREFIX` (`:85`, read only) | SQS as above on the lifecycle queue; `bedrock:InvokeModel` on the profile and the foundation models behind it (`lifecycle/src/drafts.rs:102`); `ses:SendEmail` on the `DIGEST_FROM` identity (`digest.rs:90`); `secretsmanager:GetSecretValue` on `oryxa-fde/<env>/slack/*` (`secrets.rs:117`); `rds-db:connect` as a runtime login |
| `oryxa-fde-mcp` | `DATABASE_URL` (`oryxa-fde-mcp/src/bin/mcp.rs:27`: same code gap as ingest), `SPICEDB_ENDPOINT` (`:29`), `SPICEDB_PRESHARED_KEY` (`:30`), `WORKOS_API_KEY` (`:34`), `WORKOS_CLIENT_ID` (`:35`), `MCP_ALLOWED_HOSTS` (`:40`, hostnames agents reach it at), `DOCUMENTS_BUCKET` and `EMBEDDING_*` (`:39`); optional `WORKOS_ISSUER` (`:37`), `LISTEN_ADDR` (`:46`, default `0.0.0.0:8081`) | as the API's database, S3 read and embedding permissions; a route to it (its own ALB listener or service), which dev does not have |
| `oryxa-fde-ops replay-dead-events` | see above | `rds-db:connect` as a runtime login |

The two `DATABASE_URL` readers are a code change (`Store::connect` to `Store::from_env`), not a
rename; it is on issue #108 for the API stream. Until the ingest worker runs, nothing extracts, chunks or
embeds an uploaded document (only that worker does: `context/src/ingest.rs:1`, `context/src/lib.rs:124`),
so M1's "document search" step finds nothing for new uploads.

## Apply order

The owner needs an admin AWS login for the dev account, OpenTofu 1.11 or newer (CI uses 1.12.6),
AWS CLI 2.37.3 or newer (for `aws eventsv2`), `jq`, and `CLOUDFLARE_API_TOKEN` scoped to the account
and zone with these permissions, all Edit: Cloudflare Tunnel, Access: Apps and Policies, Workers VPC
(Connectivity Directory), and Zone DNS. Images and Workers are built and deployed by the two deploy
workflows (Deploys, below), not from the owner's machine.

1. **State.** Create a versioned, encrypted, private S3 bucket by hand, then run
   `tofu -chdir=infra/envs/dev init -backend-config="bucket=<state bucket>" -backend-config="region=us-west-2"`.
2. **Bus.** Run `infra/scripts/create-event-bus.sh dev <account id> us-west-2`, with the region you
   set as `aws_region`. It refuses any other account and prints the ARN for `event_bus_arn`.
3. **The protected `dev` environment, before the deploy role exists.** In GitHub, Settings,
   Environments, New environment `dev`: deployment branches, selected branches, `main` only. Add the
   `CLOUDFLARE_API_TOKEN` environment secret now or before step 12 (Deploys, below).
4. **First apply, nothing running.** Fill `terraform.tfvars` with `start_services = false` and any
   `api_image_tag`, then run `tofu -chdir=infra/envs/dev plan -out dev.tfplan` and
   `tofu -chdir=infra/envs/dev apply dev.tfplan`. This creates the network, keys, the database (about
   10 minutes), the empty secrets, ECR, the ALB, the cluster with every service at 0 tasks, queues,
   CloudTrail, the GitHub deploy role and its two SSM parameters (and the account's GitHub OIDC
   provider unless `github_oidc_provider_arn` is set), and on Cloudflare the DNS records, the
   tunnel, the VPC service and Access.
5. **Database bootstrap.** Run `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql`. It creates
   pgvector, the IAM logins, the API's roles and the `spicedb` database, and is safe to re-run. It
   stops with an error if anything the API can reach has owner powers (Database logins).
6. **Secret values**, by hand from files you delete afterwards, never typed on a command line:
   `aws secretsmanager put-secret-value --secret-id oryxa-fde-dev/<name> --secret-string file://<file>`
   for each name in `tofu output secrets`. The SpiceDB key is random (`openssl rand -base64 32`), the
   WorkOS key comes from the WorkOS dashboard, and the event signing key is an Ed25519 PEM
   (`openssl genpkey -algorithm ed25519`). Copy the tunnel token from the Cloudflare dashboard
   (Zero Trust, Networks, Tunnels, `oryxa-fde-dev-api`; output `tunnel_id`).
7. **SpiceDB datastore.** Run `infra/scripts/run-task.sh spicedb-migrate` (`datastore migrate head`,
   IAM auth).
8. **`dev` variables.** Add the six variables to the `dev` environment (Deploys, below).
9. **API image and migrations.** Run the `deploy-api` workflow on `main`. It pushes the image, runs
   the store's migrations as `oryxa_fde_migrator` in the migrate task, points the service (still at
   0 tasks) at the image, and records the sha for OpenTofu.
10. **Start.** Set `start_services = true`, then plan and apply. SpiceDB, cloudflared and the API
    each start one task, the API on the sha `deploy-api` recorded. The API registers with the ALB
    once `/healthz` answers 200.
11. **SpiceDB schema.** Run `infra/scripts/run-task.sh spicedb-schema schema/fde.zed`. Until this
    runs, every permission check fails closed.
12. **Workers.** Run the `deploy-workers` workflow on `main`. Then set the gateway's Worker secrets
    once, from `sandbox/gateway` (`npx wrangler secret put SERVICE_TOKEN`, and `DEV_SECRETS` per its
    README); until then the gateway refuses every call. Secrets survive later deploys.
13. **Smoke test.** The ALB target is healthy, `https://app.<domain>` reaches the API through the
    binding, `admin.<domain>` asks for an Access login, and CloudTrail delivers to its bucket.

When a consumer lands (wave 2), create its FIFO subscriber into `oryxa-fde-dev-<consumer>.fifo`,
with the `-undelivered` queue as its on-failure target and `tofu output eventbus_delivery_role_arn`
as its role (`aws eventsv2 create-subscriber`, or the platform kit's `provision` with env
`fde-dev`). Grant its service `ReceiveMessage` on that queue only; nothing reads the queues yet.

## Deploys

Two manual workflows, `workflow_dispatch` only, from `main` only, for `dev` only: every job that
deploys runs in the GitHub environment `dev`, and nothing else can use its credentials. Run them
from the Actions tab on `main`; on any other branch their jobs are skipped.

| Workflow | Does | Uses from `dev` |
| --- | --- | --- |
| `deploy-api` | Builds `oryxa-fde-api` for `linux/arm64`, pushes it to ECR, runs migrations as the one-off migrate task, rolls the service onto it | `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN` |
| `deploy-workers` | `wrangler deploy` for `sandbox/gateway` and `realtime/` (skipped until it exists), then `fde-web` with dev's route and API binding | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `WEB_HOSTNAME`, `API_VPC_SERVICE_ID` |

**What the lead adds once**, in Settings, Environments, New environment `dev`, before the first
apply (Apply order, step 3):
- **Deployment branches:** selected branches, `main`. Required reviewers are optional.
- **Variables** (none is a secret; none goes in the repository):

  | Variable | Value |
  | --- | --- |
  | `AWS_REGION` | `aws_region` from tfvars |
  | `AWS_DEPLOY_ROLE_ARN` | `tofu output -raw github_deploy_role_arn` |
  | `CLOUDFLARE_ACCOUNT_ID` | `cloudflare_account_id` from tfvars |
  | `CLOUDFLARE_ZONE_ID` | `cloudflare_zone_id` from tfvars |
  | `WEB_HOSTNAME` | `tofu output -raw web_hostname` |
  | `API_VPC_SERVICE_ID` | `tofu output -raw api_vpc_service_id` |
- **Environment secret** `CLOUDFLARE_API_TOKEN`, on `dev` only, never a repository secret: a token
  for this account and zone only, with Account: Workers Scripts Edit and Containers Edit (the
  gateway's sandbox image), and Zone: Workers Routes Edit. Not the OpenTofu token. Only the
  `wrangler deploy` steps see it; installs (`npm ci --ignore-scripts`) and builds run without it.

There is no AWS key anywhere. The `deploy` job of `deploy-api` gets a one-hour session for
`oryxa-fde-dev-github-deploy` through GitHub OIDC. Its trust needs both claims to match exactly:
`sub` is `repo:<github_repository>:environment:dev`, and `job_workflow_ref` is
`<github_repository>/.github/workflows/deploy-api.yml@refs/heads/main`. So no other workflow, branch
or environment gets in, even before the environment's branch rule exists. `deploy-workers` needs no
AWS access and cannot assume it. The role may push to the `oryxa-fde-api` repository, register task
definitions that run as the API's or the migrate task's roles only, run the migrate task, update the
`oryxa-fde-api` service, and read its deploy parameters (`tests/plan.tftest.hcl` pins all of it).

**deploy-api, step by step**
1. `build`, a release build, so never with shared caches (`docs/ci.md`): on a clean
   GitHub-hosted runner, with the toolchain `rust-toolchain.toml` pins, no sccache and a fresh
   `CARGO_HOME`, it cross-compiles `oryxa-fde-api` and `oryxa-fde-ops` for
   `aarch64-unknown-linux-gnu`. It fails if either needs a newer glibc than the image's base (2.41).
2. `deploy`, hosted, in `dev`: reads `/oryxa-fde-dev/deploy` (names, subnets, the migrate task's
   security group; written by OpenTofu) and pushes the image tagged with the commit sha. Tags are
   immutable: a sha already in ECR is reused.
3. Registers new revisions of `oryxa-fde-dev-migrate` and `oryxa-fde-dev-api` that differ from the
   current ones only in the image, so env, secrets and roles stay as OpenTofu set them.
4. Runs the migrate task and stops on a non-zero exit, before the service changes. Migrations must
   therefore work with the image still running (add first, remove in a later deploy).
5. Updates the service, waits for it to settle, and fails if the circuit breaker rolled it back.
6. Writes the sha to `/oryxa-fde-dev/api-image-tag`. OpenTofu reads that parameter on every plan,
   so a later apply keeps the deployed image instead of rolling it back. To roll back, revert the
   change on `main` and run `deploy-api` again.

Without the workflow, the same steps by hand: push an image, put its sha in
`/oryxa-fde-dev/api-image-tag`, apply, and run `infra/scripts/run-task.sh migrate`.

**deploy-workers.** Each Worker deploys with the `wrangler` its own lockfile pins. `fde-web`'s
`wrangler.jsonc` stays local-only: after `pnpm build`, the workflow adds dev's settings to the built
config: the zone route `<WEB_HOSTNAME>/*` (OpenTofu owns that DNS record), the `API` binding to the
Workers VPC service, and `workers_dev` and preview URLs off, so `app.<domain>` is its only address.
Worker secrets are set by hand with `wrangler secret put` and are never in the workflow.

**Teardown.**

1. Set `allow_destroy = true`, then plan and apply. This only lifts RDS deletion protection and marks
   both buckets and the ECR repository for emptying on destroy; nothing is deleted yet.
2. Run `tofu -chdir=infra/envs/dev destroy`. It deletes every object version in the data and
   CloudTrail buckets and every image in ECR.
3. Delete the bus: `aws eventsv2 delete-event-bus --region us-west-2 --name oryxa-fde-dev`.

What stays behind:
- RDS keeps a final snapshot named `oryxa-fde-dev-final-<time the instance was created>`, so a
  second teardown never collides with the first. It is encrypted with the environment key, which
  is scheduled for deletion in 30 days: restore or copy it to another key before then, or it
  becomes unreadable.
- Secrets stay recoverable for 7 days. To rebuild within that window, restore them
  (`aws secretsmanager restore-secret`) and `tofu import` them, or the first apply fails on their names.

## Monthly dev cost estimate

us-west-2 list prices, 730 hours a month, dev traffic. Check against the AWS pricing calculator
before apply.

| Item | Assumption | $/month |
| --- | --- | --- |
| Fargate: oryxa-fde-api, SpiceDB, cloudflared | 3 tasks, each 0.25 vCPU + 0.5 GB ARM64, always on ($7.21 each) | 21.63 |
| Internal ALB | 730 h at $0.0225, under 1 LCU | 16.50 to 18.50 |
| RDS PostgreSQL | `db.t4g.micro` single-AZ ($11.68), 20 GB gp3 ($2.30), backups inside the free allowance | 14 |
| NAT instance | fck-nat on `t4g.nano` ($3.07), its public IPv4 ($3.65), root volume and transfer | 7 to 8.50 |
| Secrets Manager | 5 secrets + the RDS master secret at $0.40 (each switched-on feature adds 1 to 4) | 2.40 |
| KMS | environment key + CloudTrail key at $1, requests (S3 Bucket Keys on) | 2 to 2.50 |
| Cloud Map | private DNS namespace (a Route 53 zone, $0.50) + 1 instance | 0.60 |
| CloudWatch Logs | 14-day retention, low volume | 1 to 2 |
| CloudTrail | first trail's management events are free; data events on the data bucket at $0.10 per 100,000 | 0 to 0.50 |
| S3 (data, trail logs), ECR (under 1 GB) | low volume | 0.50 to 1 |
| SQS, EventBridge v2 | no consumer polls yet; low event volume | 0 to 1 |
| S3 gateway endpoint, one-off tasks | free; one-off tasks bill seconds | 0 |
| Cloudflare Workers Paid | needed for Sandboxes and Durable Objects anyway | 5 |
| Cloudflare Tunnel, Workers VPC, Access (under 50 users), DNS | free tiers; confirm Workers VPC pricing before apply | 0 |
| **Total** | excluding Bedrock tokens and sandbox container time | **about $70 to 78** |

With `start_services = false` the three tasks cost nothing, so the total is about $49 to 56. If the
account already has a CloudTrail trail, this trail's management events add about $2 to 5.

Compared with the platform's $38 to 50, the difference is the internal ALB ($16.50) and an
always-on API on Fargate plus an RDS instance instead of Lambda and scale-to-zero Aurora (ADR 0003
picks Fargate because agent runs and live streams outlast Lambda). Cuts, each with a cost:

- Drop the ALB and point the VPC service at the API task through Cloud Map: saves about $17, but
  loses health-checked rolling deploys. The issue asks for the ALB, so that is the lead's call.
- Fargate Spot for the three tasks, if ARM64 Spot is offered in the region: saves about $15, but
  tasks can be interrupted.
- Run cloudflared as a sidecar in the API task: saves $7.21, but ties the tunnel to API deploys and
  bypasses the ALB.
- Stop the RDS instance while unused (at most 7 days at a time): up to $11.68, prorated.

## Verify before apply

These could not be checked without an account. Each one is flagged at the place it is used.

- **EventBridge v2.** There is no OpenTofu resource, so the bus is created by script. The publish
  action `events:PutEvents` on the v2 bus ARN is inferred from the SDK's signing name, as in the
  platform. The CLI field names in `create-event-bus.sh` match `aws-sdk-eventbridgev2` 1.2.0.
- **Workers VPC.** `cloudflare_connectivity_directory_service` (provider 5.27) resolves the ALB's
  hostname through the tunnel (`resolver_network`). Confirm the service shows healthy and that
  fde-web's binding reaches `/healthz`.
- **fck-nat AMI owner** `568608671756`. Confirm it against fck-nat's docs, as in the platform.
- **zed task.** `authzed/zed:v1.14.0-debug` (busybox shell, ARM64 confirmed on ghcr.io) reads the
  key from `ZED_TOKEN` through zed's `ZED_` env flag binding. If zed reports no token, that binding
  did not apply.
- **Docker Hub pulls** (SpiceDB, cloudflared, zed) are anonymous and rate-limited per NAT IP. An ECR
  pull-through cache fixes it if it bites. Images are pinned by tag, not digest.
- **Deploy role.** `ecs:RegisterTaskDefinition` and `ecs:DescribeTaskDefinition` take `*` (not
  scoped to a family); `iam:PassRole` on four roles is what limits a new revision. If the account
  already has a GitHub OIDC provider, set `github_oidc_provider_arn` or the first apply fails on it.
  The trust's `job_workflow_ref` condition relies on STS validating that GitHub claim (supported for
  GitHub since 2025). If the first `deploy-api` run is refused at `AssumeRoleWithWebIdentity`, check
  that claim first; the failure is closed, never open.
- **Cloudflare token for deploys.** The permission names (Containers Edit for the sandbox image, and
  whether binding a Workers VPC service needs a Connectivity Directory permission too) are from the
  docs; the first `deploy-workers` run confirms them.

- **Secrets Manager with the environment key.** `CreateSecret` with `KmsKeyId` needs `kms:GenerateDataKey` and
  `kms:Decrypt` for the caller; AWS's reference may also list `kms:DescribeKey`. The Slack statement grants
  the first two, only through Secrets Manager. The first Slack install shows whether a third is needed.
- **Bedrock.** The API's role may `bedrock:InvokeModel` on `foundation-model/amazon.titan-embed-text-v2:0` in
  `aws_region`. Confirm the model is available there and enabled for the account (model access) before the first upload.
- **`WORKOS_ISSUER`.** The code's default is `https://api.workos.com/`, pinned against the token's `iss`
  (`oryxa-authn/src/workos_jwt.rs:57`). If the WorkOS environment uses a custom auth domain, the issuer is
  that domain and the API needs `WORKOS_ISSUER` (not set here; add it to the contract when it is known).
- **Gateway and realtime URLs** are known only after `deploy-workers`, so agent routes are switched on by a
  second apply (`sandbox_gateway_url`, `agent_model`), after the gateway's `SERVICE_TOKEN` and
  `api/sandbox-gateway-token` hold the same value.

## Known limits (dev only)

- `ponytail:` one NAT instance, single-AZ RDS and one SpiceDB task, with no failover.
- `ponytail:` plaintext hops inside the VPC, limited by security groups: cloudflared to the ALB to
  the API (HTTP), and the API to SpiceDB (gRPC). SpiceDB reaches RDS with `sslmode=require`, which
  does not verify the CA. Prod adds TLS on each hop and the RDS CA bundle.
- Tasks may reach any host on 443 through the NAT. The application's outbound allowlist
  (CLAUDE.md) is the control; a network firewall is a prod decision.
- **No per-company KMS keys in P0** (ADR 0003, amendment of 4 November). The bucket encrypts with
  the environment key, and the API's role is limited to `tenants/*/companies/*`. A provisioning step
  adds a key per company before the first real customer data (P1).
- ECR lives in the dev stack until a second environment needs it.

## Contracts with other streams

- **API (`crates/oryxa-fde-api`)** gets the env names its code reads, listed with file and line in
  The API environment contract above; `tests/plan.tftest.hcl` reads that table.
  - **The database: IAM authentication** (lead decision on #37), no stored passwords. Infra gives the
    service and the migrate task `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER` (`oryxa_fde_api` and
    `oryxa_fde_migrator`), and each task role may `rds-db:connect` as its own login only. The API
    and `oryxa-fde-ops` sign in with IAM tokens when those four are set (`store/src/iam.rs`); local
    and test runs keep `DATABASE_URL` (and `MIGRATION_DATABASE_URL`). The ingest worker and the MCP
    server do not yet (the table above).
  - **Migrations run as a one-off task, never at startup** (#32, #39). The migrate task runs
    `oryxa-fde-ops migrate` from the API's image (`/usr/local/bin/oryxa-fde-ops`, beside
    `/usr/local/bin/oryxa-fde-api`), connected as `oryxa_fde_migrator`, and exits 0 when done. The
    service connects as `oryxa_fde_api`, a member of `oryxa_fde_runtime` only, so every query runs
    inside a transaction that took `oryxa_fde_app`, `oryxa_fde_relay` or `oryxa_fde_grants`. The
    bootstrap creates those roles and `oryxa_fde_runtime`, so no login needs CREATEROLE, and the
    migrator holds the first three with admin option for migrations 0001 and 0003.
  - It serves `GET /healthz` without auth (it does), keeps files under
    `tenants/<tenant>/companies/<company>/`, and writes nothing to its root filesystem, which is
    read-only. Infra builds the image (`deploy-api`) from the `oryxa-fde-api` package's two binaries:
    `oryxa-fde-api` is the entrypoint, and the migrate task runs `/usr/local/bin/oryxa-fde-ops migrate`.
- **Web (`fde-web/`, `realtime/`).** `deploy-workers` adds the `API` binding (`env.API`, the Workers
  VPC service) and the zone route on `app.<domain>` to the built config at deploy time, so
  `wrangler.jsonc` keeps no dev values. `realtime/` deploys like the gateway: `npm ci` with a
  `package-lock.json`, `wrangler` in its devDependencies and `wrangler deploy` from its directory,
  before `fde-web`.
- **Agent (`sandbox/`)** The gateway deploys as its `wrangler.jsonc` says; its Worker secrets are set
  by hand. Its hostname and an AWS identity for the outbound handler's Bedrock calls are follow-ups
  when that stream needs them.

## Checks

```bash
tofu fmt -check -recursive infra
tofu -chdir=infra/envs/dev init -backend=false
tofu -chdir=infra/envs/dev validate
tofu -chdir=infra/envs/dev test      # mock providers: no credentials, no cloud calls; checks the API task against the contract table
shellcheck infra/scripts/*.sh
actionlint                            # the deploy workflows
```

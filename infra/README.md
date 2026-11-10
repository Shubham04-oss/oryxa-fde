# infra: the dev environment in OpenTofu

AWS and Cloudflare for `oryxa-fde`, following ADR 0003. **Nothing here has been applied.** Only
the owner applies, from their own machine, in the order below. CI runs `fmt`, `validate` and a
plan on mock providers with no credentials.

Patterns come from the platform's `infra/modules` and `docs/deploy.md` (oryxa-platform `2b064a3`).
The S3, SQS FIFO and EventBridge modules and the VPC are adapted from there, and each file says so.

## What it builds

```
Browser -> Cloudflare (DNS, Access on admin.) -> fde-web Worker (app.<domain>)
  -> vpc_services binding (Workers VPC) -> Cloudflare Tunnel
  -> one Fargate task in a private subnet: cloudflared (sidecar) -> 127.0.0.1:8080 -> oryxa-fde-api
       -> RDS PostgreSQL 17 + pgvector    (IAM database auth, TLS, private)
       -> SpiceDB on Fargate              (spicedb.oryxa-fde-dev.internal:50051, Cloud Map, private)
       -> S3 data bucket                  (KMS, <tenant>/<company>/ prefix per company)
       -> EventBridge v2 bus oryxa-fde-dev -> per-consumer SQS FIFO + DLQ + undelivered queue
Two more Fargate tasks, queue workers with no inbound network at all (they read SQS and call out):
  oryxa-fde-ingest    <- context-ingestion queue; S3 (read), Bedrock embeddings; RDS as oryxa_fde_ingest
  oryxa-fde-lifecycle <- lifecycle queue; Bedrock (drafts), SES (digest), Slack tokens (read); RDS as
                         oryxa_fde_lifecycle. Not deployed until a drafting model is chosen (update_model).
Everything outbound (AWS APIs, image pulls, WorkOS, the tunnel) leaves through one fck-nat instance.
CloudTrail logs management events and object access on the data bucket.
```

Nothing in AWS accepts traffic from the internet. No security group has a CIDR ingress rule wider
than the VPC, and the API has no public hostname. Only Workers in this Cloudflare account that
are bound to the VPC service reach it, through the tunnel. The workers listen on nothing, so no
security group admits anything to them either. The tunnel's connector is a second
container in the API's task, so it reaches the API on the task's loopback: the API listens on
`127.0.0.1` only, and no security group admits anything to it (#145; the path used to go through
a separate cloudflared service and an internal ALB, and "What the load balancer gave" in Deploys
says what replaced it).

| Path | What |
| --- | --- |
| `modules/vpc` | VPC `10.50.0.0/16`, public and private subnets in two AZs, fck-nat instance, S3 gateway endpoint, optional interface endpoints |
| `modules/postgres` | RDS for PostgreSQL 17, encrypted, IAM auth, `rds.force_ssl`, master password managed by RDS in Secrets Manager |
| `modules/fargate_service` | One ARM64 main container, with optional health check, stop timeout and sidecars: task definition, log group, execution and task roles, security group, optional ECS service. The API, both workers, SpiceDB and the one-off tasks are all this module |
| `modules/internal_alb` | Internal ALB, target group (`ip`), HTTP listener reachable from named security groups only. **Not used by `envs/dev` since #145**; kept, with its test, for a production environment that fronts a service with a load balancer (pair it with `fargate_service`'s `load_balancer`) |
| `modules/s3` | Private bucket: KMS, versioned, public access blocked, TLS only; `force_destroy` for teardown only |
| `modules/sqs_fifo` | FIFO queue, FIFO DLQ, optional undelivered queue (names and attributes match the platform's consumer kit) |
| `modules/eventbridge` | Delivery role for bus subscribers and the publish policy (the bus itself is created by script) |
| `modules/cloudtrail` | Multi-region trail with its own bucket and key, log file validation, data events on the data bucket |
| `modules/cloudflare` | DNS for `app.` and `admin.`, the tunnel, the Workers VPC service to the API on the loopback of the tunnel's connector, Access on `admin.` |
| `envs/dev` | The composition, variables, outputs, lock file and `tests/plan.tftest.hcl` (with `tests/contract`, which reads the environment contract tables below, one per binary); `deploy.tf` holds the GitHub deploy role and the deploy parameters |
| `docker/oryxa-fde-api.Dockerfile` | The backend image, one for every task: the prebuilt ARM64 `oryxa-fde-api`, `oryxa-fde-ops`, `oryxa-fde-ingest` and `oryxa-fde-lifecycle` on distroless Debian 13, nonroot, plus a static `busybox` that only the API's container health check runs (Deploys, The image) |
| `scripts/create-event-bus.sh` | Creates the EventBridge v2 bus `oryxa-fde-<env>` in a named region (no OpenTofu resource yet) |
| `scripts/create-subscriber.sh` | Creates (or refreshes the filter of) a worker's EventBridge v2 FIFO subscriber into its queue; `test-create-subscriber.sh` tests it against a fake `aws` and checks each filter against the events the worker's code handles |
| `scripts/run-task.sh` | One-off tasks in the private subnets: bootstrap SQL, the store's migrations, SpiceDB migrate, SpiceDB schema write |
| `sql/01-bootstrap.sql` | pgvector, the IAM logins `oryxa_fde_migrator`, `oryxa_fde_api`, `oryxa_fde_ingest`, `oryxa_fde_lifecycle`, `oryxa_fde_mcp` and `spicedb`, the NOLOGIN roles they reach, the `spicedb` database, and a check that nothing the API or a worker reaches has owner powers |
| `sql/02-api-owns-nothing.sql` | Once, only on a database the first bootstrap let `oryxa_fde_api` own: hands its objects to the migrator and drops its old grants |

Names: the ECS services are `oryxa-fde-api`, `oryxa-fde-ingest` and `oryxa-fde-lifecycle`, and the one
ECR repository, which holds the backend image all of them run, is `oryxa-fde-api`. Everything
else is `oryxa-fde-<env>-…`: the cluster `oryxa-fde-dev`, SpiceDB `oryxa-fde-dev-spicedb`, the
one-off tasks `oryxa-fde-dev-migrate`, `-db-admin` and `-zed`, the bus `oryxa-fde-dev`, the
queues `oryxa-fde-dev-<consumer>.fifo`, `-dlq.fifo` and `-undelivered`, and a worker's task definition,
roles and log group (`/ecs/oryxa-fde-dev-ingest`, `-lifecycle`).

## Variables

Set in `envs/dev/terraform.tfvars` (gitignored; start from `terraform.tfvars.example`). None of
them is a secret. The Cloudflare API token comes from `CLOUDFLARE_API_TOKEN` in the environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `env` | `dev` | Environment name in every resource name (`oryxa-fde-<env>`); 2 to 10 lowercase letters or digits |
| `aws_account_id` | required | The only account the AWS provider will touch (`allowed_account_ids`) |
| `aws_region` | `ap-south-1` | Mumbai, chosen by the founder to see real latency from the team and first customers (#144). Everything in AWS runs and rests here; what Mumbai does and does not offer is in Mumbai (ap-south-1) below |
| `cloudflare_account_id` | required | Account for the tunnel, the Workers VPC service and Access |
| `cloudflare_zone_id` | required | Zone holding `domain` |
| `domain` | required | Base hostname for dev; `app.<domain>` (fde-web) and `admin.<domain>` hang off it |
| `admin_emails` | required | Who may open `admin.<domain>` through Cloudflare Access |
| `workos_client_id` | required | WorkOS client id (public); the API key is a secret |
| `event_bus_arn` | required | Printed by `scripts/create-event-bus.sh`; must be the `oryxa-fde-<env>` v2 bus in `aws_account_id` and `aws_region` (plan fails otherwise) |
| `event_signing_kid` | `k1` | Key id of the API's event signing key (`EVENT_SIGNING_KID`); change it when the key rotates |
| `event_public_key` | required | The public half of that key as a PEM (`-----BEGIN PUBLIC KEY-----`): `EVENT_PUBLIC_KEY` on both workers, which verify every event with it. Not a secret. Make the pair before the first apply (Apply order, step 4); rotate it with `event_signing_kid` |
| `data_bucket_name` | required | Globally unique name for the customer data bucket |
| `cloudtrail_bucket_name` | required | Globally unique name for the CloudTrail log bucket |
| `api_image_tag` | required | Seeds `/oryxa-fde-<env>/api-image-tag` on the first apply (any value while nothing runs); after that `deploy-api` owns the tag (Deploys) |
| `github_repository` | `Shubham04-oss/oryxa-fde` | The repository whose `environment: <env>` jobs may assume the deploy role |
| `github_oidc_provider_arn` | `null` | The account's GitHub OIDC provider, if it already has one; null creates it |
| `start_services` | `false` | `false`: every service (SpiceDB, the API task, the workers) runs 0 tasks. Set `true` once the image and every secret value exist |
| `consumers` | `["lifecycle", "context-ingestion"]` | Event consumers; each gets a FIFO queue, a DLQ and an undelivered queue. Must include those two: the workers read them |
| `api_port` | `8080` | Port `oryxa-fde-api` listens on, on the task's loopback (`LISTEN_ADDR` is `127.0.0.1:<port>`); the health check and the Workers VPC service use it |
| `api_health_check_path` | `/healthz` | Path the API container's health check polls; must answer 200 without auth |
| `api_cpu` | `256` | CPU units of the API task, shared by the API and the cloudflared sidecar (0.25 vCPU) |
| `api_memory` | `512` | Memory of the API task in MiB, shared by both containers |
| `spicedb_image` | `authzed/spicedb:v1.56.2` | Same version as CI |
| `cloudflared_image` | `cloudflare/cloudflared@sha256:4955524aeaa3...` (2026.10.7) | Tunnel connector, the sidecar of the API task. Pinned by digest because it runs with the API task's role |
| `db_instance_class` | `db.t4g.micro` | RDS instance class |
| `allow_destroy` | `false` | Set `true` only to tear the environment down: lifts RDS deletion protection and lets `destroy` empty both buckets and the ECR repository |
| `vpc_cidr` | `10.50.0.0/16` | Distinct from the platform's `10.40.0.0/16`, so the two can be peered later |
| `interface_endpoints` | `[]` | PrivateLink endpoints for AWS APIs (about $7.30/month each); empty means the NAT carries that traffic |
| `log_retention_days` | `14` | CloudWatch retention for every task's logs |
| `embedding_model` | `amazon.titan-embed-text-v2:0` | Bedrock foundation model that embeds text (`EMBEDDING_MODEL`); the API's and the ingest worker's roles may invoke this model only, in `aws_region`. A foundation model id: an inference-profile id (`us.`, `eu.`, `global.`...) is refused, since the permission names the model's ARN |
| `workos_issuer` | `null` | `WORKOS_ISSUER` on the API: set it only when the WorkOS environment has a custom auth domain, because the API pins every token's `iss` to it. Null: the API's default, `https://api.workos.com/` |
| `ingest_cpu`, `ingest_memory` | `512`, `2048` | The ingest worker's task. It holds each document in memory and extracts its text in a child limited to 1 GiB of address space (`child.rs`), so memory is the figure to watch |
| `lifecycle_cpu`, `lifecycle_memory` | `256`, `512` | The lifecycle worker's task |
| `update_model` | `null` | The Bedrock inference profile that drafts the weekly updates (`UPDATE_MODEL`). **No default, and no model is chosen**: while it is null the lifecycle worker is not deployed (no task definition, role, service or Bedrock permission). Only a `global.` profile is accepted; read Where prompts are processed before setting it |
| `digest_from` | `null` | The address the weekly digest is sent from (`DIGEST_FROM`); null: no digest. Needs `update_model`, and the address or its domain must be a verified SES identity in `aws_region` (Verify before apply) |
| `sandbox_gateway_url` | `null` | Gateway Worker's URL (`SANDBOX_GATEWAY_URL`), known after `deploy-workers`. Null: agent and eval routes are not mounted, and the next three are unused |
| `agent_model` | `null` | Bedrock model or inference profile for agents (`AGENT_MODEL`); required with `sandbox_gateway_url`. In Mumbai the Claude models need an inference profile, and which one decides where prompts are processed (Where prompts are processed) |
| `agent_region` | `null` | The Region the agent's Bedrock calls start from (`AGENT_REGION`); null means `aws_region`. Set it only to call a geography profile from a Region inside that geography |
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
| `cloudflared/tunnel-token` | `TUNNEL_TOKEN` | the cloudflared sidecar of the API task only (ECS injects secrets per container: the API container does not see it, and cloudflared sees none of the API's) |
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

No service has a database password: the API, the workers, the migrate task and SpiceDB connect with IAM
database auth, as `oryxa_fde_api`, `oryxa_fde_ingest`, `oryxa_fde_lifecycle`, `oryxa_fde_migrator` and
`spicedb`, and each task role may `rds-db:connect` as its own user only (no worker connects as the API).

## Database logins

| Login | Used by | May |
| --- | --- | --- |
| `oryxa_fde_migrator` | the one-off migrate task (`oryxa-fde-ops migrate`) | own and change the FDE tables; grant `oryxa_fde_app`, `oryxa_fde_relay` and `oryxa_fde_grants` onward (admin option), no CREATEROLE; nothing else connects as it |
| `oryxa_fde_api` | the API service | member of `oryxa_fde_runtime` only: `SET LOCAL ROLE` to `oryxa_fde_app`, `oryxa_fde_relay` or `oryxa_fde_grants` per transaction, inheriting none; `connect` and `usage` only; owns nothing, creates nothing |
| `oryxa_fde_ingest` | the ingest worker | member of `oryxa_fde_app` only, not inherited: `SET LOCAL ROLE` per transaction; `connect` and `usage` only; owns nothing |
| `oryxa_fde_lifecycle` | the lifecycle worker | member of `oryxa_fde_app` and `oryxa_fde_grants` (its cross-tenant scan, `store/src/engine.rs:443`), neither inherited; otherwise as the ingest login |
| `oryxa_fde_mcp` | the MCP server (not deployed yet; its login exists so its service needs no bootstrap change) | member of `oryxa_fde_app` only, as the ingest login |
| `spicedb` | SpiceDB | its own `spicedb` database only |
| RDS master | the db-admin task | the bootstrap SQL |

The NOLOGIN roles come from the bootstrap, so no login needs CREATEROLE: `oryxa_fde_app` and
`oryxa_fde_relay` (each transaction's role), `oryxa_fde_grants` (the SpiceDB grant reconciler's) and
`oryxa_fde_runtime`, which migration 0003 makes a member of the other three without inheritance.

Every login is `login nosuperuser nocreaterole nocreatedb nobypassrls`, granted `rds_iam`, `connect` on
`oryxa_fde` and `usage` on `public`. The worker logins take their roles with `inherit false`, as
`oryxa_fde_runtime` does, and not `oryxa_fde_relay`: only the API's outbox relay publishes. `oryxa-fde-ops
replay-dead-events` stays on `oryxa_fde_api` (a one-off task).

The API and the workers can never reach table ownership, CREATEROLE or BYPASSRLS: none of their logins is a
member of the migrator or the master, and no task role can connect as the migrator or as another service's
login (`tests/plan.tftest.hcl` pins both IAM sides). The bootstrap ends with a check over the API login, each
worker login and every role any of them can reach by `SET ROLE` or inheritance, and stops if any of them is a superuser, may create roles or
databases, bypasses row-level security, is the migrator, the master or a predefined role, owns a
relation, a schema or the database, may create in `public`, or holds an admin option. A query the
API runs outside a scoped transaction is refused, because it inherits no table rights.

**A database bootstrapped before the workers** (#130) needs the first command only: run
`infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql` again (Apply order, step 5) before the first
worker starts. It is safe to re-run and adds the three worker logins; it makes no change to the others.

**A database the first bootstrap set up** (the API owned its tables because it migrated at
startup) needs this once, before the first deploy of the non-owner API (#39):
1. `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql`: creates the new logins and roles, then
   stops at the check, naming what the API still holds.
2. `infra/scripts/run-task.sh sql infra/sql/02-api-owns-nothing.sql`: as the master,
   `reassign owned by oryxa_fde_api to oryxa_fde_migrator`, then revokes the API's `create` on
   `public` and its direct grants of `oryxa_fde_app` and `oryxa_fde_relay`.
3. `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql` again: the check passes.

## The environment contract

Read from the code, not from memory (each `Read at` is `file:line` in `crates/`; the API's table was checked
against `main` at `039df45`, the workers' at `71c13b4`), and compared with what `envs/dev` sets. `tests/plan.tftest.hcl`
reads the tables of `oryxa-fde-api`, `oryxa-fde-ingest` and `oryxa-fde-lifecycle`: every `always` variable of the
binary must be on its task definition, every variable the task definition sets must be in the table, and a secret
must be injected from Secrets Manager, never set as plain config. Add or change a variable in the code, and the table and `envs/dev` change in the same PR.

Columns. **Needed**: `always`; a feature the variable belongs to (`agent`, `realtime`, `github`,
`slack`; for the lifecycle worker `digest`, `slack`: needed when that feature is on, and the first row of each is its switch); `optional` (the code has
a default); `local only` (tests and laptops). **Kind**: `config` (plain, visible in the task definition),
`secret` (a value; ECS injects it from Secrets Manager), `reference` (a Secrets Manager name or KMS key
ARN, not a value). Every task also gets its AWS identity from the task role: the SDK reads
`AWS_REGION` and the container credentials ECS provides (`aws_config::load_from_env`). The API's
task is two containers (the API and cloudflared), so the table below describes the `api` container
only; the sidecar has one variable, `TUNNEL_TOKEN`. A worker task is one container.

### `oryxa-fde-api`

The service, entrypoint `/usr/local/bin/oryxa-fde-api` (deployed), container `api` of the `oryxa-fde-api` task. A variable that is missing, or
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
| `LISTEN_ADDR` | optional | config | `0.0.0.0:8080` | `main.rs:81` | `127.0.0.1:<api_port>`: the tunnel sidecar is the only client |
| `EMBEDDING_PROVIDER` | optional | config | `bedrock` (`fake` for tests) | `context/src/lib.rs:104` | `bedrock` |
| `EMBEDDING_MODEL` | optional | config | `amazon.titan-embed-text-v2:0` (`embed.rs:12`) | `context/src/lib.rs:108` | `embedding_model` |
| `EMBEDDING_REPLACES` | optional | config | none | `context/src/lib.rs:113` | not set |
| `WORKOS_ISSUER` | optional | config | `https://api.workos.com/` | `main.rs:55` | `workos_issuer`; not set when null |
| `SESSION_PASSWORD_PREVIOUS` | optional | secret | none | `main.rs:68` | not set; add a secret when rotating |
| `RUST_LOG` | optional | config | `info` | `main.rs:40` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:301` | never set |
| `SANDBOX_GATEWAY_URL` | agent | config | none: agent routes off | `oryxa-fde-agent/src/prod.rs:124` | `sandbox_gateway_url` |
| `SANDBOX_GATEWAY_TOKEN` | agent | secret | none | `prod.rs:128` | `api/sandbox-gateway-token` |
| `AGENT_MODEL` | agent | config | none | `prod.rs:149` | `agent_model` (in Mumbai a profile id; Where prompts are processed) |
| `AGENT_REGION` | agent | config | none | `prod.rs:150` | `agent_region`, else `aws_region`; the test reads it from output `agent_model_target` |
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
| `s3:GetObject`, `s3:PutObject` on `*/*/documents/*` and `*/*/canvas/*` | documents and canvas snapshots at `<tenant>/<company>/documents/<id>` and `.../canvas/<id>` (`context/src/blob.rs:31`, `:37`, `:65`, `:81`; the code never deletes or lists) | granted; delete and list removed |
| `kms:Decrypt`, `kms:GenerateDataKey`, only through S3 | the bucket's default encryption | granted |
| `bedrock:InvokeModel` on `foundation-model/<embedding_model>` in `aws_region` | embeddings (`context/src/embed.rs:95`) | granted |
| `secretsmanager:CreateSecret`, `TagResource`, `PutSecretValue`, `GetSecretValue`, `DeleteSecret` on `oryxa-fde/<env>/slack/*`, and `kms:Decrypt`, `kms:GenerateDataKey` only through Secrets Manager | Slack bot tokens (`integrations/src/secrets.rs:87`, `:99`, `:117`, `:134`) | only with `slack_client_id` |
| Bedrock for `AGENT_MODEL`, `EVAL_JUDGE_MODEL` | not the API: the judge is a `curl` run inside the sandbox (`agent/src/evals.rs:232`), signed by the gateway's outbound handler | not granted; the gateway's AWS identity is the agent stream's follow-up |

### `oryxa-fde-ops`

Entrypoint `/usr/local/bin/oryxa-fde-ops` in the API image.

| Subcommand | Variables (Read at) | In dev |
| --- | --- | --- |
| `migrate` | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` as `oryxa_fde_migrator`, and `AWS_REGION` (`store/src/lib.rs:261`, `iam.rs:82`); `MIGRATION_DATABASE_URL` for local runs only (`lib.rs:267`) | the `oryxa-fde-dev-migrate` task sets all five; its role may connect as the migrator only |
| `replay-dead-events [tenant]` | `DB_*` as `oryxa_fde_api`, and `AWS_REGION` (`store/src/lib.rs:299`, `ops.rs:30`) | not deployed: no task definition. A one-off task, so it keeps the API's login |

### `oryxa-fde-ingest`

The ingest worker, entrypoint `/usr/local/bin/oryxa-fde-ingest` (the same image as the API), container `ingest` of the
`oryxa-fde-dev-ingest` task, service `oryxa-fde-ingest`. It reads `fde.document.uploaded.v1` events from its queue and,
for each, extracts the document's text, chunks it and stores embeddings (`context/src/ingest.rs`); only this
worker does, so until it runs, nothing extracts, chunks or embeds an upload and the document search finds
nothing for new ones. To extract text it runs its own binary as `extract <content-type>` in a child, by its own path, with
hard limits and no environment (`child.rs`), so the task's variables never reach a parser of customer files. A variable
that is missing, or not valid, stops startup.

| Variable | Needed | Kind | Default | Read at | Infra |
| --- | --- | --- | --- | --- | --- |
| `DB_HOST` | always | config | none | `oryxa-fde-store/src/iam.rs:82` | RDS address |
| `DB_PORT` | always | config | none | `iam.rs:82` | RDS port |
| `DB_NAME` | always | config | none | `iam.rs:82` | `oryxa_fde` |
| `DB_USER` | always | config | none | `iam.rs:82` | `oryxa_fde_ingest`, its own login |
| `AWS_REGION` | always | config | none | `iam.rs:133`, `oryxa-fde-context/src/lib.rs:102` | `aws_region` |
| `DOCUMENTS_BUCKET` | always | config | none | `context/src/lib.rs:103` | the data bucket |
| `EVENT_SIGNING_KID` | always | config | none | `context/src/bin/ingest.rs:42` | `event_signing_kid` |
| `EVENT_PUBLIC_KEY` | always | config | none (PEM) | `ingest.rs:44` | `event_public_key`: the public half of the API's signing key, so plain config |
| `INGEST_QUEUE_URL` | always | config | none | `ingest.rs:46` | the `context-ingestion` queue's url |
| `EMBEDDING_PROVIDER` | optional | config | `bedrock` (`fake` for tests) | `context/src/lib.rs:104` | `bedrock` |
| `EMBEDDING_MODEL` | optional | config | `amazon.titan-embed-text-v2:0` | `context/src/lib.rs:108` | `embedding_model` |
| `EMBEDDING_REPLACES` | optional | config | none | `context/src/lib.rs:113` | not set |
| `RUST_LOG` | optional | config | `info` | `ingest.rs:37` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:307` | never set |

What the ingest role may do, from what the code calls. It calls AWS only (S3, SQS, Bedrock):

| Permission | Why (`Read at`) | In dev |
| --- | --- | --- |
| `rds-db:connect` as `oryxa_fde_ingest` | the store (`iam.rs`) | granted |
| `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on the `context-ingestion` queue | long poll, delete when handled, extend the message's visibility while a handler runs (`oryxa-fde-events/src/inbox.rs:91`, `:147`, `:161`); never the dead-letter queue (SQS moves messages there) and never a send | granted |
| `s3:GetObject` on `*/*/documents/*` | the document at `<tenant>/<company>/documents/<id>` (`context/src/blob.rs:31`, `:81`; `ingest.rs:60`). The worker builds the same blob store as the API but only calls `get`: no put, no canvas, no list, no delete | granted |
| `kms:Decrypt` only through S3 | reading an object the bucket encrypted; no `GenerateDataKey`, since it never writes | granted |
| `bedrock:InvokeModel` on `foundation-model/<embedding_model>` in `aws_region` | embeddings (`context/src/embed.rs:95`) | granted |

### `oryxa-fde-lifecycle`

The lifecycle worker, entrypoint `/usr/local/bin/oryxa-fde-lifecycle`, container `lifecycle` of the
`oryxa-fde-dev-lifecycle` task, service `oryxa-fde-lifecycle`. It reads FDE events from its queue and applies the lifecycle
rules, and every hour drafts last week's update for each active project without one and mails each newly
approved update to the customer's sponsors (the weekly digest). **It is deployed only while `update_model` is set**:
`UPDATE_MODEL` has no default in the code, no model is chosen, and without one the process stops at start.

| Variable | Needed | Kind | Default | Read at | Infra |
| --- | --- | --- | --- | --- | --- |
| `DB_HOST` | always | config | none | `oryxa-fde-store/src/iam.rs:82` | RDS address |
| `DB_PORT` | always | config | none | `iam.rs:82` | RDS port |
| `DB_NAME` | always | config | none | `iam.rs:82` | `oryxa_fde` |
| `DB_USER` | always | config | none | `iam.rs:82` | `oryxa_fde_lifecycle`, its own login |
| `AWS_REGION` | always | config | none | `iam.rs:133`, `oryxa-fde-lifecycle/src/bin/lifecycle.rs:51` | `aws_region`; the Bedrock client is built from this alone, so the profile must be one this Region can call |
| `EVENT_SIGNING_KID` | always | config | none | `lifecycle.rs:47` | `event_signing_kid` |
| `EVENT_PUBLIC_KEY` | always | config | none (PEM) | `lifecycle.rs:49` | `event_public_key` |
| `UPDATE_MODEL` | always | config | none | `lifecycle.rs:52` | `update_model`: a `global.` profile (Where prompts are processed) |
| `LIFECYCLE_QUEUE_URL` | always | config | none | `lifecycle.rs:99` | the `lifecycle` queue's url |
| `DIGEST_FROM` | digest | config | none: no digest | `lifecycle.rs:54` | `digest_from` |
| `WEB_ORIGIN` | digest | config | none; required with `DIGEST_FROM` | `lifecycle.rs:57` | `https://app.<domain>` |
| `SLACK_SECRET_PREFIX` | slack | reference | none: no update posted to Slack | `lifecycle.rs:85` | `oryxa-fde/<env>/slack/`, set with `slack_client_id` |
| `RUST_LOG` | optional | config | `info` | `lifecycle.rs:43` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:307` | never set |

What the lifecycle role may do, from what the code calls (AWS: SQS, Bedrock, SES, Secrets Manager; and Slack's API, through the integrations' host allowlist, over the NAT):

| Permission | Why (`Read at`) | In dev |
| --- | --- | --- |
| `rds-db:connect` as `oryxa_fde_lifecycle` | the store (`iam.rs`) | granted with the worker |
| SQS `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on the `lifecycle` queue | as the ingest worker (`inbox.rs`) | granted with the worker |
| `bedrock:InvokeModel` for `update_model`, in AWS's three statements for a `global.` profile: the profile in `aws_region`, the foundation model in `aws_region` only through that profile, and the Region-less foundation model only through it with `aws:RequestedRegion` `unspecified` | the drafter calls `InvokeModel` (`lifecycle/src/drafts.rs:102`); the statements are from [AWS's IAM policy for global inference](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html) | granted with the worker; none exists without a model |
| `ses:SendEmail` on the identity of `digest_from` (the address and its domain) with `ses:FromAddress` equal to it | `SendEmail` of SES v2 (`lifecycle/src/digest.rs:90`) | only with `digest_from` |
| `secretsmanager:GetSecretValue` on `oryxa-fde/<env>/slack/*`, and `kms:Decrypt` only through Secrets Manager | reads a workspace's bot token, never writes (`integrations/src/secrets.rs:117`, `reader`) | only with `slack_client_id` |

Nothing else: no S3, no secret written, no SQS send, no other model.

### Not deployed

`oryxa-fde-mcp` has no task definition yet, and `oryxa-fde-ops replay-dead-events` is a one-off task nobody has
needed to define. Both reach the database as the API does (`Store::from_env`, `store/src/lib.rs:299`): IAM tokens when
`DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER` are all set (they win over `DATABASE_URL`), else `DATABASE_URL` for
local runs only; a half-set `DB_*` or a missing token stops startup. Each also needs `AWS_REGION` and `RUST_LOG`.

| Binary | Variables (Read at) | Permissions it will need |
| --- | --- | --- |
| `oryxa-fde-mcp` | `DB_*` as `oryxa_fde_mcp` (`oryxa-fde-mcp/src/bin/mcp.rs:28`), `SPICEDB_ENDPOINT` (`:30`), `SPICEDB_PRESHARED_KEY` (`:31`), `WORKOS_API_KEY` (`:35`), `WORKOS_CLIENT_ID` (`:36`), `MCP_ALLOWED_HOSTS` (`:41`, hostnames agents reach it at), `DOCUMENTS_BUCKET` and `EMBEDDING_*` (`:40`); optional `WORKOS_ISSUER` (`:38`), `LISTEN_ADDR` (`:47`, default `0.0.0.0:8081`) | the API's S3 read and embedding permissions; `rds-db:connect` as `oryxa_fde_mcp` only; a route to it (below) |
| `oryxa-fde-ops replay-dead-events` | see above | `rds-db:connect` as `oryxa_fde_api` |

**How the MCP server could be reached, the smallest option** (not built: the next part of #130). It cannot ride the API's
sidecar: that connector reaches the API on the task's loopback, and the MCP server needs its own task role and
login (no worker connects as `oryxa_fde_api`), so it is its own task, in its own network namespace. The smallest
route that adds no connector, no load balancer and no public hostname: run it as its own service registered in
Cloud Map like SpiceDB (`mcp.<namespace>`), admit port 8081 from the API task's security group only (where the
connector already runs), and add a second Workers VPC service on the same tunnel with that hostname
(`resolver_network` the tunnel, `http_port` 8081) for the sandbox gateway Worker to bind. The cost is a Cloud Map
instance ($0.10) and the gateway's binding. Not confirmed: that Workers VPC accepts a hostname resolved through the
tunnel, the same open question as the loopback address (Verify before apply). The other option, running it as a second
container in the API task, was rejected: it would share the API's role and database login.

## Apply order

The owner needs an admin AWS login for the dev account, OpenTofu 1.11 or newer (CI uses 1.12.6),
AWS CLI 2.37.3 or newer (for `aws eventsv2`), `jq`, and `CLOUDFLARE_API_TOKEN` scoped to the account
and zone with these permissions, all Edit: Cloudflare Tunnel, Access: Apps and Policies, Workers VPC
(Connectivity Directory), and Zone DNS. Images and Workers are built and deployed by the two deploy
workflows (Deploys, below), not from the owner's machine.

1. **State.** Create a versioned, encrypted, private S3 bucket by hand, then run
   `tofu -chdir=infra/envs/dev init -backend-config="bucket=<state bucket>" -backend-config="region=ap-south-1"` (the state bucket is in `aws_region`).
2. **Bus.** Run `infra/scripts/create-event-bus.sh dev <account id> ap-south-1`, with the region you
   set as `aws_region`. It refuses any other account and prints the ARN for `event_bus_arn`.
3. **The protected `dev` environment, before the deploy role exists.** In GitHub, Settings,
   Environments, New environment `dev`: deployment branches, selected branches, `main` only. Add the
   `CLOUDFLARE_API_TOKEN` environment secret now or before step 13 (Deploys, below).
4. **First apply, nothing running.** Fill `terraform.tfvars` with `start_services = false` and any
   `api_image_tag`, and `event_public_key`: make the event key pair now (`openssl genpkey -algorithm ed25519 -out event-key.pem`,
   `openssl pkey -in event-key.pem -pubout`), put the public PEM in `terraform.tfvars` (a heredoc), and keep the private
   file for step 6. Leave `update_model` and `digest_from` unset (Not deployed: the lifecycle worker waits for a model).
   Then run `tofu -chdir=infra/envs/dev plan -out dev.tfplan` and
   `tofu -chdir=infra/envs/dev apply dev.tfplan`. This creates the network, keys, the database (about
   10 minutes), the empty secrets, ECR, the cluster with every service at 0 tasks (SpiceDB, the API and the
   ingest worker), the queues, the event bus's delivery role, CloudTrail, the GitHub deploy role and its two SSM parameters (and the account's GitHub OIDC
   provider unless `github_oidc_provider_arn` is set), and on Cloudflare the DNS records, the
   tunnel, the VPC service and Access.
5. **Database bootstrap.** Run `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql`. It creates
   pgvector, the IAM logins (the API's, the workers' and SpiceDB's), their roles and the `spicedb` database, and is safe to
   re-run: **run it again after #130 on a database it already set up**, for the worker logins. It stops with an error if
   anything the API or a worker can reach has owner powers (Database logins).
6. **Secret values**, by hand from files you delete afterwards, never typed on a command line:
   `aws secretsmanager put-secret-value --secret-id oryxa-fde-dev/<name> --secret-string file://<file>`
   for each name in `tofu output secrets`. The SpiceDB key is random (`openssl rand -base64 32`), the
   WorkOS key comes from the WorkOS dashboard, and the event signing key is the private PEM of the pair
   made in step 4 (its public half is `event_public_key`, which the workers verify events with). Copy the tunnel token from the Cloudflare dashboard
   (Zero Trust, Networks, Tunnels, `oryxa-fde-dev-api`; output `tunnel_id`).
7. **SpiceDB datastore.** Run `infra/scripts/run-task.sh spicedb-migrate` (`datastore migrate head`,
   IAM auth).
8. **`dev` variables.** Add the six variables to the `dev` environment (Deploys, below).
9. **Backend image and migrations.** Run the `deploy-api` workflow on `main`. It pushes the one backend image
   (the API, the ingest and lifecycle workers and the migrations' binary), runs the store's migrations as
   `oryxa_fde_migrator` in the migrate task, points the API service (still at 0 tasks) at the image, and records the
   sha for OpenTofu. The workers are not rolled by it (Deploys, The image): they take that sha when OpenTofu applies.
10. **Start.** Set `start_services = true`, then plan and apply. SpiceDB, the API and the ingest worker each start one
    task, on the sha `deploy-api` recorded. The API task starts the API container first;
    cloudflared starts once its health check on `/healthz` passes, and only then connects the tunnel. The ingest
    worker has no health check: it is healthy while its process runs, and its log (`/ecs/oryxa-fde-dev-ingest`)
    says `ingesting` once it has its database, its key and its queue. Its queue stays empty until step 12.
11. **SpiceDB schema.** Run `infra/scripts/run-task.sh spicedb-schema schema/fde.zed`. Until this
    runs, every permission check fails closed.
12. **Event subscribers for the workers.** The queues and the delivery role exist since step 4; what routes events into a
    queue is the bus's FIFO subscriber, which OpenTofu cannot make (How events reach the workers, below). Run
    `infra/scripts/create-subscriber.sh dev <account id> ap-south-1 context-ingestion` for the ingest worker, before the first
    upload you want searchable: a subscriber delivers events published after it exists.
13. **Cloudflare Workers.** Run the `deploy-workers` workflow on `main`. Then set the gateway's Worker secrets
    once, from `sandbox/gateway` (`npx wrangler secret put SERVICE_TOKEN`, and `DEV_SECRETS` per its
    README); until then the gateway refuses every call. Secrets survive later deploys.
14. **Smoke test.** The `oryxa-fde-api` service has one running task whose `api` container reports
    `HEALTHY` (`aws ecs describe-tasks`, `containers[].healthStatus`), `oryxa-fde-ingest` has one running task, the tunnel `oryxa-fde-dev-api`
    shows healthy in the Cloudflare dashboard, `https://app.<domain>` reaches the API through the
    binding, `admin.<domain>` asks for an Access login, and CloudTrail delivers to its bucket.
    Then run stage A of the scripted smoke test (next section), and stage B, document search, with
    `SMOKE_WORKERS=1` (it skips otherwise, because the script cannot tell a missing worker from a slow one):
    `SMOKE_WORKERS=1 infra/scripts/smoke-test.sh b`. If stage B times out, look in this order: the subscriber exists
    (`aws eventsv2 list-subscribers`), the queue receives (`aws sqs get-queue-attributes`), the worker logs, the
    dead-letter queue.

**The lifecycle worker, once a drafting model is chosen.** The founder's choice is recorded in ADR 0003 first
(Where prompts are processed). Then, in this order: (1) if the digest is wanted, verify the sender's address or domain in
SES in `aws_region` and request production access there (SES starts in a per-Region sandbox: it mails only verified
addresses, up to 200 a day); (2) set `update_model` (a `global.` profile) and, with it, `digest_from`, and apply: that creates the
worker's role, task definition and service, at one task when `start_services` is true; (3) run
`infra/scripts/create-subscriber.sh dev <account id> ap-south-1 lifecycle --replay`, which also delivers what the bus
kept of the earlier events (the handlers are idempotent). Create its subscriber only now: until the worker exists
nothing reads that queue, and a queue forgets a message after 4 days.

### How events reach the workers

```
API outbox relay -> bus oryxa-fde-dev (EventBridge v2)
  -> FIFO subscriber oryxa-fde-dev-<consumer>   (filter: the detail types its handlers take; script)
  -> queue oryxa-fde-dev-<consumer>.fifo        (+ -dlq.fifo after 5 receives; -undelivered if the bus cannot deliver)
  -> the worker's long poll (inbox.rs), one message at a time, signature verified before anything is read
```

| Worker | Consumer (queue) | Detail types |
| --- | --- | --- |
| `oryxa-fde-ingest` | `context-ingestion` | `fde.document.uploaded.v1` |
| `oryxa-fde-lifecycle` | `lifecycle` | `fde.access-request.status-changed.v1`, `fde.agent-run.finished.v1`, `fde.eval-run.finished.v1`, `fde.pull-request.merged.v1`, `fde.pull-request.opened.v1`, `fde.update.approved.v1` |

OpenTofu makes the queues (`modules/sqs_fifo`), the delivery role (`sqs:SendMessage` on the queues and their
`-undelivered` queues) and each worker's receive permission. It cannot make the subscriber: `hashicorp/aws` has no EventBridge v2
resource, which is also why the bus is made by script. `infra/scripts/create-subscriber.sh` makes it with `aws eventsv2
create-subscriber`, the way the platform consumer kit's `provision` does and with the same name, so either finds the other's:
FIFO, a filter on exactly the detail types above, the event's group and deduplication ids, 10 retries over a day, the
`-undelivered` queue for what still fails. Run on an existing subscriber, it refreshes the filter and nothing else.

Three things to know. A subscriber delivers only what is published after it exists, unless it is created with
`--replay`; an event published earlier is gone from the queue, though the bus keeps it for its retention (7 days). The
filter is a copy of what the handlers take, so `test-create-subscriber.sh` reads the code's detail types and fails
when a handler is added without its subscription. And a message a worker retries five times moves to the `-dlq.fifo`
queue, kept for 14 days and read by hand (`aws sqs receive-message`); `oryxa-fde-ops replay-dead-events` is the
API outbox's, not this one.

## Smoke test

`infra/scripts/smoke-test.sh` is one scripted pass against a deployed environment, so each stage of the first
deploy ends in a pass or a fail. It goes to the web app's public address the way a browser does and stops at the
first failure with a plain message and a non-zero exit. Needs `bash`, `curl` and `jq`.

```bash
export SMOKE_BASE_URL=https://app.<domain>               # exactly the web app's origin (the API's WEB_ORIGIN)
export SMOKE_SESSION_FILE=~/.oryxa-smoke-session         # the session cookie, see below
infra/scripts/smoke-test.sh a                            # stage A, the core (the default)
SMOKE_WORKERS=1 infra/scripts/smoke-test.sh b            # stage B, once the ingest worker runs and its subscriber exists (Apply order, steps 10 and 12)
SMOKE_AGENT_REPO=<owner>/<repo> infra/scripts/smoke-test.sh c   # stage C, once the agent routes are on
SMOKE_WORKERS=1 SMOKE_AGENT_REPO=<owner>/<repo> infra/scripts/smoke-test.sh all
```

Stages run in the order given. B and C need a company and a project, so run alone they make their own; run
together they share one. Every run first checks health and `/v1/me`.

| Stage | Checks, in order |
| --- | --- |
| **A, core** | `GET /api/healthz` (no session); `GET /v1/me` (the session is accepted; prints the organisation and role); create a company; create a project (starts in `discover`); add a task; the task is on `GET /v1/today`; the stage checklist reads (`discover`); a move to `scope` with items open and no reason is refused (`409 rejected_checklist_open`), then the same move with a reason succeeds and the checklist now reads `scope`; the task is removed and gone from Today |
| **B, workers** | Upload a small Markdown document with a one-off code word; poll until `status` is `ingested` with chunks (a `failed` status stops it, and so does `SMOKE_INGEST_TIMEOUT`, default 180 s); search for the code word and find that document's passage |
| **C, agent** | List the project's agent runs (a `404` means the agent routes are off); start a read-only run on the sample repository (`SMOKE_AGENT_BASE`, default `main`); poll until events arrive and the run is `finished` (`SMOKE_RUN_TIMEOUT`, default 900 s) with a `result` as its last event. A run that fails, or waits for an approval (the test never approves), stops it and is cancelled |

**Skips.** B skips unless `SMOKE_WORKERS=1` (the script cannot tell a missing worker from a slow one, so you
say it is deployed; then a document that never ingests is a failure). C skips without `SMOKE_AGENT_REPO`, and
when the agent routes answer a bare `404` (one with an error code fails). A skip prints `SKIP [stage] ...` and
exits 0 for that stage; the last line, `result: a=passed b=skipped ...`, tells passes and skips apart.

**The session.** The test signs in as the person who runs it, with the browser session cookie of a **test user in
a test organisation**: it creates a company in that organisation, and the user becomes its lead. Never use a
real customer's organisation or your own login.

1. In a private browser window, open `https://app.<domain>` and sign in as the test user. Do not sign out
   until the run is over (sign-out ends the WorkOS session, and with it the cookie the script uses).
2. In the browser's developer tools, Application (Chrome) or Storage (Firefox), Cookies, `https://app.<domain>`:
   copy the **Value** of `__Host-fde_session` (it is `HttpOnly`, so only the tools show it). Just the value.
3. Put it in a file only you can read, and paste it into that file in an editor, not on a command line:
   `install -m 600 /dev/null ~/.oryxa-smoke-session`. The script refuses a file that group or others can read.
   `SMOKE_SESSION` (the value in the environment) works too, for a secret manager; never an argument.
4. When the run is over, sign out in the private window, then delete the file. Signing out ends the WorkOS
   session, so every copy of the cookie stops working: the file, the clipboard, the browser's. Otherwise it stays
   usable for up to seven days. The handed-over cookie goes stale anyway once the API refreshes the session
   during a run: WorkOS refresh tokens are single use, so the API reseals the cookie, the run carries on with the
   new one in memory (the file is never written), and the browser's copy is spent. The script says so at the
   end. Take a fresh sign-in for each run.

The script puts the cookie in a private temporary file for curl, never in its command line (`ps` shows
arguments), and removes it on exit, on failure and on an interrupt (only `kill -9` leaves it, in a directory
only you can read under `$TMPDIR`). It turns tracing off, so `bash -x` cannot print it, ignores `~/.curlrc`, and
strips it from any error text. It prints identifiers and API error codes, never a header or a response body.

**What a write needs, as the browser sends it** (`fde-web/src/forward.ts`, `oryxa-fde-api/src/session.rs`):
`Cookie: __Host-fde_session=<value>`; `X-Oryxa-Request: 1`; and an `Origin` header equal to the web app's
origin on anything but a read. The Worker refuses a write whose `Origin` is not its own, and the API refuses one
whose `Origin` is not `WEB_ORIGIN` (`403 csrf`); that is why `SMOKE_BASE_URL` must be exactly that origin, with
`https` (plain `http` is accepted for `localhost` only). `/api/*` goes to the API with the `/api` prefix removed.

**What it makes, and what stays.** Everything is named `oryxa-smoke-<UTC time>-<random>`, with a summary saying
it is safe to ignore. It removes the task it adds, on success and on failure (and cancels a run it stops on).
The API has no delete for **companies, projects, documents or agent runs**, so each run leaves behind one company
and one project (stage `scope`), a document after B and a finished run after C. The script prints their ids at
the end. They sit in the test organisation; do not point the script at an organisation anyone works in.

`infra/scripts/test-smoke-test.sh` proves the script without a deployed environment: it starts
`infra/scripts/smoke-stub.py` (answers the routes the script calls with canned responses, on a random loopback
port, stopped afterwards) and runs every stage against it: full passes, failures in the middle (cleanup), an
interrupt, the skips, a session that rotates mid-run, and the session hand-over checks, including `bash -x` and
a verbose `~/.curlrc`. It needs `bash`, `curl`, `jq` and
`python3` only.

## Deploys

Two manual workflows, `workflow_dispatch` only, from `main` only, for `dev` only: every job that
deploys runs in the GitHub environment `dev`, and nothing else can use its credentials. Run them
from the Actions tab on `main`; on any other branch their jobs are skipped.

| Workflow | Does | Uses from `dev` |
| --- | --- | --- |
| `deploy-api` | Builds the backend binaries (`oryxa-fde-api`, `oryxa-fde-ops`, `oryxa-fde-ingest`, `oryxa-fde-lifecycle`) for `linux/arm64` into one image, pushes it to ECR, runs migrations as the one-off migrate task, rolls the API service onto it (the tunnel sidecar included in the new task; its image does not change). It does not roll the workers yet (The image) | `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN` |
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

**The image: one, with several entrypoints** (#130). The API, `oryxa-fde-ops` and the two queue workers ship in one image,
in the one ECR repository (still named `oryxa-fde-api`; renaming it would mean a new repository, its state and the deploy
role's grants for no gain). Each task definition picks its binary with `entryPoint` (the API is the default; the
migrate task already did this). Why one and not one per binary:

- **One version of the truth.** The API, the workers and the migrations share the store and events crates, and the schema
  and the event types change together. One commit builds one image, so the migrate task and every service run the same
  sha and cannot disagree. Four images could drift to four tags, and each drift is a failure that only shows at run time.
- **One build, one pipeline.** `cargo build` compiles the shared crates once for the four binaries (the release build is
  clean on a fresh runner every time, `docs/ci.md`), where four builds would compile them four times. One repository, one lifecycle
  policy, one image tag in SSM, one set of push permissions on the deploy role.
- **What it costs.** Each task carries binaries it never runs (a few tens of MB), and the workers carry the API's `busybox`.
  That is no new permission: the task role, its entrypoint and its security group decide what a task can do, and an image holds
  no credentials. If a worker ever needs a different base or its own release rhythm, it gets its own repository then.

Until #150 and the follow-up to this PR land, **`deploy-api` rolls only the API**. A worker takes the image tag in
`/oryxa-fde-dev/api-image-tag` when OpenTofu applies, which registers a new revision and replaces its task in place.
**Run `tofu apply` after every `deploy-api`**: until then the workers run the sha of the last apply, which can be older
than the API's. So a migration must keep working for the workers' image too (step 4), and an event may gain a field (the
decoders ignore unknown fields) but not lose or rename one under the same detail type, or the older worker cannot read it.

**deploy-api, step by step**
1. `build`, a release build, so never with shared caches (`docs/ci.md`): on a clean
   GitHub-hosted runner, with the toolchain `rust-toolchain.toml` pins, no sccache and a fresh
   `CARGO_HOME`, it cross-compiles the backend binaries for
   `aarch64-unknown-linux-gnu`; it builds all four binaries. It fails if any needs a newer glibc than the image's base (2.41).
2. `deploy`, hosted, in `dev`: reads `/oryxa-fde-dev/deploy` (names, subnets, the migrate task's
   security group; written by OpenTofu) and pushes the image tagged with the commit sha. Tags are
   immutable: a sha already in ECR is reused.
3. Registers new revisions of `oryxa-fde-dev-migrate` and `oryxa-fde-dev-api` that differ from the
   current ones only in the image, so env, secrets and roles stay as OpenTofu set them. The API task
   also holds the cloudflared sidecar (#145), so it swaps the image of the one container that runs
   the ECR repository's image and stops if that is not exactly one.
4. Runs the migrate task and stops on a non-zero exit, before the service changes. Migrations must
   therefore work with the image still running (add first, remove in a later deploy).
5. Updates the service, waits for it to settle (the new task's `api` container must pass its health
   check; "What the load balancer gave", below), and fails if the circuit breaker rolled it back.
6. Writes the sha to `/oryxa-fde-dev/api-image-tag`. OpenTofu reads that parameter on every plan,
   so a later apply keeps the deployed image instead of rolling it back. To roll back, revert the
   change on `main` and run `deploy-api` again.

**What the load balancer gave, and what replaced it** (#145). The ALB health-checked the API and
registered it only when healthy, drained connections on a rollout, and never took the old task out
before the new one answered. Without it:

| ALB did | Now |
| --- | --- |
| Polled `/healthz`; ECS replaced an unhealthy target | The `api` container has its own health check (`busybox wget` on `127.0.0.1:<api_port><api_health_check_path>`, every 10 s, 3 failures, 30 s start period). ECS replaces the task when it fails |
| Held the old task until the new target was healthy | The service keeps `deployment_minimum_healthy_percent = 100` and `maximum_percent = 200`: ECS starts the new task, counts it healthy once the `api` container's health check passes (cloudflared has none, so it does not count), then stops the old one. The deployment circuit breaker rolls back a task that never gets there. A rollout never runs fewer than one healthy task |
| Kept traffic off a target that was not ready | `cloudflared` has `dependsOn` the `api` container being `HEALTHY`, so the tunnel does not connect until the API answers |
| Drained connections for 30 s on deregistration | ECS stops a task's containers in reverse start order, so cloudflared gets SIGTERM first (per AWS's container dependency docs; the first deploy's logs confirm it). It stops taking new requests and lets those in flight finish for up to 30 s (`stopTimeout` 45 s), and only then does the API get SIGTERM |

**What happens to requests during a deploy, honestly.** For a moment two tasks hold two connectors of
one tunnel, and Cloudflare sends each request to either. A request in flight on the old connector
finishes if it takes under 30 s. Before, an API deploy never touched the tunnel (the ALB drained the old
API task); now every API deploy replaces a connector. ECS counts the new task healthy on the API's
check alone, so the old connector can start shutting down a few seconds before the new one has
registered with Cloudflare; a request in that gap, or one routed to the old connector as it begins
shutting down, fails with a 502. Nothing closes that window. A web Worker that retries an idempotent
request once covers it (that is the web stream's to add). **Every API deploy cuts every long-lived
connection through the API**: a WebSocket or streamed response ends when the old connector's 30 s drain
runs out, and the client has to reconnect. Today the API serves no stream (live agent output is a
Durable Object, `docs/plan.md`); anything that later streams through the API, live agent output
included, gets cut on each deploy and must resume on reconnect. The API has no graceful-shutdown handler of its own
(`axum::serve` without `with_graceful_shutdown`, `crates/oryxa-fde-api/src/main.rs:84`), so SIGTERM ends
it at once; adding one is the API stream's call. Migrations still run before the service changes.

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
3. Delete the bus: `aws eventsv2 delete-event-bus --region ap-south-1 --name oryxa-fde-dev`.

What stays behind:
- RDS keeps a final snapshot named `oryxa-fde-dev-final-<time the instance was created>`, so a
  second teardown never collides with the first. It is encrypted with the environment key, which
  is scheduled for deletion in 30 days: restore or copy it to another key before then, or it
  becomes unreadable.
- Secrets stay recoverable for 7 days. To rebuild within that window, restore them
  (`aws secretsmanager restore-secret`) and `tofu import` them, or the first apply fails on their names.

## Mumbai (ap-south-1)

The founder chose Mumbai for the first environment (#144). Read from AWS's own pages on 10 November 2026;
service and model availability changes, so `tofu plan` and the first apply are still the test. **In Mumbai**
means the service or model runs there. **Profile only** means the model has no in-Region endpoint in Mumbai and
is reached by naming a cross-Region inference profile, so Bedrock runs the request in another Region.

| What the code or infra uses | In Mumbai? | Source |
| --- | --- | --- |
| ECS Fargate, Linux | In Mumbai | [Fargate Regions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate-Regions.html) lists `ap-south-1` |
| Fargate on ARM64 | In Mumbai (no exception listed) | [ARM64 task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-arm64.html): the only Fargate exception is `use1-az3`; the [price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-south-1/index.json) has Fargate ARM vCPU and memory SKUs for Mumbai |
| RDS PostgreSQL 17 on `db.t4g.micro` | In Mumbai. The class and engine pairing is from the docs; Mumbai from AWS's T4g announcement and the price list | [DB engines per instance class](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Support.html) (`db.t4g.micro`: all PostgreSQL 17 versions); [T4g in 28 Regions incl. Mumbai, Aug 2023](https://aws.amazon.com/about-aws/whats-new/2023/08/amazon-rds-t4g-instances-6-regions/); [RDS price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-south-1/index.json) has `db.t4g.micro` PostgreSQL Single-AZ. AWS has no per-Region table for this pairing: `aws rds describe-orderable-db-instance-options --engine postgres --engine-version 17 --db-instance-class db.t4g.micro --region ap-south-1` is the check |
| pgvector on RDS PostgreSQL 17 | In the engine (0.8.x) | [Extension versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html); AWS lists extensions per engine version, not per Region |
| EventBridge v2 bus and `aws eventsv2` | In Mumbai | [Launch announcement, 24 Sep 2026](https://aws.amazon.com/about-aws/whats-new/2026/09/eventbridge-relaunches-custom-event-buses/): 14 Regions including Mumbai and Oregon; [API reference](https://docs.aws.amazon.com/eventbridgev2/latest/APIReference/Welcome.html); [price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSEvents/current/ap-south-1/index.json) has `EventsV2` SKUs for Mumbai |
| Bedrock embeddings, `amazon.titan-embed-text-v2:0` (`EMBEDDING_MODEL`) | **In Mumbai, in-Region** (not a profile; there is no geography or global profile for it) | [Titan Text Embeddings V2 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-titan-text-embeddings-v2.html): `ap-south-1` In-Region yes, Geo no, Global no |
| Claude Opus 5.5 (`anthropic.claude-opus-5-5`; the id the code's lifecycle note and tests name) | **Profile only**: `global.anthropic.claude-opus-5-5` | [Opus 5.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html): Mumbai In-Region no, Geo no, Global yes. The bare id works in `eu-west-2` only. There is no India or Asia Pacific-wide profile; the geography profiles are `us.`, `eu.`, `au.` and `jp.` |
| Claude Sonnet 5.5, Haiku 5.5, Fable 5.2 | **Profile only**, `global.` from Mumbai | [Sonnet 5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html), [Haiku 5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html), [Fable 5.2](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-fable-5-2.html): Mumbai In-Region no, Geo no, Global yes for each |
| Claude Opus 5 (the previous Opus) | **Profile only, but inside India**: `in.anthropic.claude-opus-5`, from Mumbai to Mumbai or Hyderabad | [Opus 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html): Geo India, source `ap-south-1`, destinations `ap-south-1`, `ap-south-2` |
| SES (the lifecycle digest; the code uses the SES v2 API) | In Mumbai | [SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html): `email.ap-south-1.amazonaws.com`. SES sandbox status is [per Region](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html): the digest needs production access in Mumbai and a verified `DIGEST_FROM` identity there |
| fck-nat AMI (`fck-nat-al2023-*-arm64-ebs`, owner `568608671756`) | In Mumbai | [fck-nat's published Region list](https://github.com/AndrewGuenther/fck-nat/blob/main/packer/fck-nat-public-all-regions.pkrvars.hcl) includes `ap-south-1` (last changed 31 May 2026); the owner id is in [its deploy guide](https://fck-nat.dev/stable/deploying/). The list says what the build publishes; `aws ec2 describe-images --owners 568608671756 --filters 'Name=name,Values=fck-nat-al2023-*-arm64-ebs' --region ap-south-1` is the check |
| `t4g.nano` (the NAT), KMS, Secrets Manager, Cloud Map, CloudTrail, ECR, S3, SQS FIFO | In Mumbai | each has Mumbai SKUs in AWS's price list for `ap-south-1` (the Monthly cost estimate below links them by name) |

Not offered in Mumbai: nothing the infra creates. Two things the code asks for are offered only through a
profile: the agent's Claude model and the weekly drafting model.

### Where prompts are processed

ADR 0003 keeps customer data **at rest** in AWS in one Region, and in dev that Region is Mumbai: the database,
the data bucket, the queues, the secrets and the logs. A Bedrock request is different. A prompt and its
answer pass through whatever Region serves the model:

- **Titan embeddings** (document text and search queries): processed in Mumbai.
- **A `global.` profile** (the only kind that reaches Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.2 from Mumbai):
  [global cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html)
  may process a request in any supported commercial AWS Region, and [AWS lists the destinations as all
  commercial Regions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html), which
  [can include Regions an account has not enabled](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html).
  The model cards do not list the current set for Opus 5.5; `aws bedrock get-inference-profile --region ap-south-1
  --inference-profile-identifier global.anthropic.claude-opus-5-5 --query 'models[].modelArn'` does. In plain
  terms: **with a `global.` profile, prompts and outputs leave India.** They
  [may be stored for abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
  in the Region that processes them, opt-in Regions included. For Fable 5.2, AWS's
  [abuse detection page](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html) says all traffic
  is retained for up to 30 days in that Region, and flagged traffic may be reviewed by people at AWS. CloudTrail
  records the Region in `additionalEventData.inferenceRegion` of each call, in Mumbai's trail.
- **A geography profile** keeps processing inside its geography: [AWS's page](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)
  says to check the destinations with `GetInferenceProfile` from the Region you call, not to trust the id's prefix.
  For Opus 5.5 the cards give: `eu.` from `eu-west-2` (London), to Frankfurt, Stockholm, Milan, Spain, Ireland,
  Paris and London; `au.` from Sydney or Melbourne, to those two; `jp.` from Tokyo or Osaka, to those two; `us.`
  from the US Regions. None of them can be called from Mumbai, so a geography profile means setting
  `agent_region` to a Region in that geography and calling Bedrock there, with the round trip that adds.
- **`in.anthropic.claude-opus-5`** is the one profile that keeps Opus-class inference inside India (Mumbai and
  Hyderabad), on the previous model.

Which of these to use is **the founder's decision, recorded in ADR 0003 before real customer data reaches any
model** (the agent or the weekly drafts). None is chosen yet. The options: a `global.` profile (cheapest, lowest
latency from Mumbai, prompts processed and possibly stored outside India), a geography profile called from
another Region (processed inside that geography, which is not India), or `in.` on Opus 5 (inside India, the
previous model). Until then P0 holds sample data only, as the Cloudflare sandboxes already do (ADR 0003's
amendment). This PR changes no model setting: `agent_model` stays null, and the example in
`terraform.tfvars.example` is commented out.

A role that calls a `global.` profile needs the three statements AWS documents
([IAM policy for global inference](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html)):
the profile in the calling Region, the foundation model in that Region only when called through the profile, and
the foundation model with `aws:RequestedRegion` set to `unspecified`. The lifecycle worker's role has exactly these three
for `update_model`, once one is set (#130). The API's role has none of it, because the agent's Bedrock calls are signed by
the gateway's outbound handler; the stream that adds that identity needs this too, and an SCP that denies Regions will
refuse the call.

## Monthly dev cost estimate

`ap-south-1` list prices, 730 hours a month, dev traffic, in US dollars. Prices were read on 10 November 2026
from AWS's public price lists (`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/ap-south-1/index.json`;
the Checked column names the offer and its publication date). Check against the AWS pricing calculator before apply.

| Item | Assumption | $/month | Checked |
| --- | --- | --- | --- |
| Fargate: oryxa-fde-api (with the cloudflared sidecar), SpiceDB | 2 tasks, each 0.25 vCPU + 0.5 GB ARM64, always on ($0.02383 per vCPU-hour, $0.00261 per GB-hour: $5.30 each) | 10.60 | AmazonECS, 19 Oct |
| Fargate: oryxa-fde-ingest | 0.5 vCPU + 2 GB ARM64, always on ($8.70 + $3.81) | 12.51 | AmazonECS, 19 Oct (the same prices) |
| Fargate: oryxa-fde-lifecycle | 0.25 vCPU + 0.5 GB, only once `update_model` is set ($5.30, as SpiceDB's) | 0 now; 5.30 then | AmazonECS, 19 Oct |
| RDS PostgreSQL | `db.t4g.micro` single-AZ ($0.021 an hour: $15.33), 20 GB gp3 ($0.131 a GB: $2.62), backups inside the free allowance | 18 | AmazonRDS, 29 Oct |
| NAT instance | fck-nat on `t4g.nano` ($0.0028 an hour: $2.04), its public IPv4 ($0.005 an hour: $3.65), 8 GB gp3 root volume ($0.0912 a GB: $0.73), and an assumed 10 GB or less a month out to the internet at $0.1093 a GB | 6.50 to 8 | AmazonEC2, 7 Nov; AmazonVPC, 5 Nov; AWSDataTransfer, 3 Nov; the root volume's size and the traffic are assumptions |
| Secrets Manager | 5 secrets + the RDS master secret at $0.40 (each switched-on feature adds 1 to 4) | 2.40 | AWSSecretsManager, 11 Sep |
| KMS | environment key + CloudTrail key at $1, requests at $0.03 per 10,000 (S3 Bucket Keys on) | 2 to 2.50 | awskms, 8 Nov |
| Cloud Map | private DNS namespace (a Route 53 zone, $0.50) + 1 instance ($0.10) | 0.60 | instance: AWSCloudMap, 6 Nov; the hosted zone's price is global and **was not rechecked** |
| CloudWatch Logs | 14-day retention, about 2 to 3 GB a month ingested at $0.67 a GB, storage $0.03 a GB-month | 1.50 to 2.50 | AmazonCloudWatch, 4 Nov; the volume is an assumption |
| CloudTrail | first trail's management events are free; data events on the data bucket at $0.10 per 100,000 | 0 to 0.50 | AWSCloudTrail, 2 Nov |
| S3 (data, trail logs), ECR (under 1 GB) | low volume, S3 $0.025 a GB-month, ECR $0.10 a GB-month | 0.50 to 1 | AmazonS3, 9 Nov; AmazonECR, 11 Sep |
| SQS, EventBridge v2 | two workers long-poll, 20 s each (about 130,000 receives a month each, under $0.15 together); low event volume. SQS FIFO $0.50 per million requests; EventBridge v2 is priced by data: $0.19 a GB in, $0.059 a GB out, $0.087 a GB-month retained | 0 to 1 | AWSQueueService, 11 Sep; AWSEvents, 8 Nov |
| S3 gateway endpoint, one-off tasks | free; one-off tasks bill seconds | 0 | not rechecked (free) |
| Cloudflare Workers Paid | needed for Sandboxes and Durable Objects anyway | 5 | not AWS; unchanged |
| Cloudflare Tunnel, Workers VPC, Access (under 50 users), DNS | free tiers; confirm Workers VPC pricing before apply | 0 | not AWS; unchanged |
| **Total** | excluding Bedrock tokens and sandbox container time, with the ingest worker and without the lifecycle worker (add $5.30 for it) | **about $60 to 65** | |

With `start_services = false` the tasks cost nothing, so the total is about $37 to 42. If the
account already has a CloudTrail trail, this trail's management events add about $2 to 5 (that rate was not
rechecked). Lines removed by #145: the internal ALB (17.50 to 19.50, `AWSELB`) and the cloudflared task
($5.30, now a container in the API's task that adds no Fargate line of its own), $22.80 to 24.80 in all, from
a total of about $70 to 77. The table for Oregon (us-west-2 list prices) had come to $70 to 78 at that point.

Bedrock tokens are not in the total. Mumbai list prices, from the Bedrock price lists
([foundation models](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/ap-south-1/index.json),
[Titan](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-south-1/index.json), 9 and 6 Nov), per million tokens
input and output: Titan Embeddings V2 $0.024 in; Opus 5.5 through the global profile $4 and $20; Opus 5 through
`in.` $5.50 and $27.50 (global $5 and $25); Sonnet 5.5 global $2 and $10; Haiku 5.5 global $0.10 and $0.50;
Fable 5.2 global $8 and $40. The Mumbai list prices Opus 5.5 only for global use.

Compared with the platform's $38 to 50, the difference is an always-on API on Fargate plus an RDS
instance instead of Lambda and scale-to-zero Aurora (ADR 0003 picks Fargate because agent runs and live
streams outlast Lambda). Cuts that are left, each with a cost:

- Fargate Spot for the two tasks, if ARM64 Spot is offered in the region: saves up to about $7 (the
  earlier estimate's roughly 70% discount, applied to $10.60; Spot prices are not in the price list, and AWS's
  Fargate capacity-provider page names no Region limit, so Mumbai was **not rechecked**), but tasks can be
  interrupted, and an interrupted API task takes its tunnel connector with it.
- Stop the RDS instance while unused (at most 7 days at a time): up to $15.33, prorated.

## Verify before apply

These could not be checked without an account. Each one is flagged at the place it is used.

- **EventBridge v2.** There is no OpenTofu resource, so the bus is created by script. The publish
  action `events:PutEvents` on the v2 bus ARN is inferred from the SDK's signing name, as in the
  platform. The CLI field names in `create-event-bus.sh` match `aws-sdk-eventbridgev2` 1.2.0.
- **Workers VPC reaching the loopback.** `cloudflare_connectivity_directory_service` (provider 5.27) is
  set to `ipv4 = "127.0.0.1"` on `http_port = api_port`, reached through the tunnel (`network.tunnel_id`):
  the connector's own loopback, which is the API's, because the sidecar shares its task's network. Whether
  Workers VPC accepts a loopback address is **not confirmed**; the apply of the VPC service answers it. If it
  refuses, try `hostname = "localhost"` with `resolver_network = { tunnel_id = ... }` (a three-line change in
  `modules/cloudflare`). If neither is accepted, the fallback is a separate cloudflared service reaching the
  API through Cloud Map (the other option in #145). Then confirm the service shows healthy and that fde-web's
  binding reaches `/healthz`.
- **Health check and start order.** The API container's health check runs `/usr/local/bin/busybox wget`
  (the image has no shell); `docker run` of that wget against a local server gave exit 0 for 200 and 1 for
  404 and a refused connection. Confirm in the first run that the `api` container reaches `HEALTHY` and that
  cloudflared waits for it (`describe-tasks`). The shutdown order (cloudflared first) is from AWS's
  `dependsOn` docs ("for container shutdown it is reversed"); the first deploy's CloudWatch streams
  (`api/` and `cloudflared/` in `/ecs/oryxa-fde-dev-api`) show whether the tunnel drained first.
- **fck-nat AMI owner** `568608671756` is the one fck-nat's deploy guide gives. That the AMI exists in
  Mumbai is the project's published Region list; run the `describe-images` check in Mumbai (ap-south-1) first.
- **zed task.** `authzed/zed:v1.14.0-debug` (busybox shell, ARM64 confirmed on ghcr.io) reads the
  key from `ZED_TOKEN` through zed's `ZED_` env flag binding. If zed reports no token, that binding
  did not apply.
- **Docker Hub pulls** (SpiceDB, cloudflared, zed) are anonymous and rate-limited per NAT IP. An ECR
  pull-through cache fixes it if it bites. SpiceDB and zed are pinned by tag; cloudflared by digest (it
  holds the API's role).
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
- **Event subscribers by CLI.** `create-subscriber.sh` is the platform kit's `provision` re-expressed as
  `aws eventsv2 create-subscriber`. Its arguments pass the CLI's own client-side validation (checked offline against AWS CLI
  2.37.12 for both a new and a replayed subscriber, and for `update-subscriber`), and its logic is tested against a fake `aws`,
  but no call has reached a real bus: the first run answers whether the account accepts the delivery role, the
  `{% $events.SystemMetadata... %}` group and deduplication expressions, and `--replay`'s `HORIZON`. Then upload a
  document and watch the message arrive (`aws sqs get-queue-attributes`).
- **SES, per Region.** The lifecycle worker mails the digest with SES v2 from `digest_from`. A new SES account in a Region
  is in the sandbox: it sends only to verified addresses and domains, 200 messages a day. Production access is requested
  per Region (here Mumbai) and granted by AWS, so the digest to real sponsors waits on it; until then SES refuses a
  message to an unverified address, and the worker logs `digest mail not sent` with SES's error code and tries that mail
  again on later hourly checks, a bounded number of times (`digest.rs`). The sender must be a verified identity in `aws_region`
  too, and the role's `ses:SendEmail` names that identity (the address, or its domain): confirm which kind was verified.
- **The global inference profile's policy.** The lifecycle role has AWS's three statements for a `global.` profile, as
  AWS's page gives them (read 10 November 2026). Nothing has called Bedrock with them: check the profile's destination
  Regions (`aws bedrock get-inference-profile`), and confirm the first draft works. An SCP that denies Regions will
  refuse the call (the third statement's Region is `unspecified`).
- **Worker sizing.** The ingest worker's 0.5 vCPU and 2 GiB are an estimate from the code (the extraction child may take
  1 GiB of address space, plus the document and the process). If a large PDF ends a task with exit code 137, raise `ingest_memory`.
- **Bedrock.** The API's and the ingest worker's roles may `bedrock:InvokeModel` on `foundation-model/amazon.titan-embed-text-v2:0` in
  `aws_region`. AWS lists the model as in-Region in Mumbai (Mumbai (ap-south-1)); confirm it works for the account
  (model access) before the first upload. The Claude models need an inference profile there, and the profile
  chosen decides where prompts are processed (Where prompts are processed).
- **RDS in Mumbai.** AWS has no per-Region table for PostgreSQL 17 on `db.t4g.micro`; the
  `describe-orderable-db-instance-options` command in Mumbai (ap-south-1) answers it before the first apply.
- **`WORKOS_ISSUER`.** The code's default is `https://api.workos.com/`, pinned against the token's `iss`
  (`oryxa-authn/src/workos_jwt.rs:57`). If the WorkOS environment uses a custom auth domain, the issuer is
  that domain: set `workos_issuer`, or every sign-in is refused.
- **Gateway and realtime URLs** are known only after `deploy-workers`, so agent routes are switched on by a
  second apply (`sandbox_gateway_url`, `agent_model`), after the gateway's `SERVICE_TOKEN` and
  `api/sandbox-gateway-token` hold the same value.

## Known limits (dev only)

- `ponytail:` one NAT instance, single-AZ RDS and one SpiceDB task, with no failover.
- `ponytail:` plaintext hops inside the VPC, limited by security groups: the API to SpiceDB (gRPC).
  The tunnel to the API is loopback inside one task. SpiceDB reaches RDS with `sslmode=require`, which
  does not verify the CA. Prod adds TLS on each hop and the RDS CA bundle.
- Tasks may reach any host on 443 through the NAT. The application's outbound allowlist
  (CLAUDE.md) is the control; a network firewall is a prod decision.
- **No per-company KMS keys in P0** (ADR 0003, amendment of 4 November). The bucket encrypts with
  the environment key, and the API's role is limited to company documents and canvas snapshots. A provisioning step
  adds a key per company before the first real customer data (P1).
- `ponytail:` the API and the tunnel connector share one 0.25 vCPU / 512 MiB task (`api_cpu`, `api_memory`).
  cloudflared is small, but a busy tunnel and a busy API compete; raise the task, not one container.
- `ponytail:` no health check on cloudflared itself: a connector that is running but not connected is not
  replaced (the standalone service had none either). A crashed one stops the task, and ECS replaces it.
- A rollout can fail a request in the seconds the old connector shuts down before the new one registers, and
  cuts every stream or WebSocket through the API (Deploys, "What the load balancer gave").
- `ponytail:` cloudflared shares the API task's role and security group. It makes no AWS call, but a
  compromised connector gets the API's credentials (S3 company prefixes, Bedrock, `rds-db:connect` as the
  API, its Secrets Manager reads), where the separate service had a role with no permissions. Its image is
  pinned by digest for that reason. Dev holds sample data only (ADR 0003). Prod runs the connector as its
  own service with an empty role, reaching the API through an internal load balancer (`modules/internal_alb`)
  or Cloud Map, with an ingress rule from the connector's group only.
- `ponytail:` the API image carries a static `busybox` so the container health check has a command to run.
  It gives code running in the container a shell and network tools it did not have (no new permission:
  nonroot, read-only root). Replace it with a health-check subcommand in `oryxa-fde-ops` (API stream) and drop
  the busybox stage.
- `ponytail:` a queue worker has no health endpoint, so ECS judges it by its process: an essential container whose exit
  replaces the task. A worker that is alive but stuck is not detected (the queue's heartbeat and 15 minute ceiling bound one
  stuck message, not a stuck loop). Add a liveness signal with the graceful-shutdown work (#150) if it ever happens.
- `ponytail:` workers stop with SIGTERM and Fargate's longest wait (`stopTimeout` 120 s), and a deploy replaces the task
  in place, so processing pauses for the swap (the queue holds the events) and two consumers never overlap. Neither worker
  has a graceful shutdown yet (#150): SIGTERM ends it at once, and the message it held returns after its visibility timeout
  (120 s), which the handlers allow. The 120 s only matters once #150 lands.
- `ponytail:` until the follow-up to #130, `deploy-api` does not roll the workers: an `apply` does, with the sha it last
  recorded. The deploy role cannot touch a worker's service or roles.
- `ponytail:` the workers' tasks carry the API's `busybox` and the API's binary (one image). They have no credentials of
  the API's: each task role is its own.
- ECR lives in the dev stack until a second environment needs it.

## Contracts with other streams

- **API (`crates/oryxa-fde-api`)** gets the env names its code reads, listed with file and line in
  The API environment contract above; `tests/plan.tftest.hcl` reads that table.
  - **The database: IAM authentication** (lead decision on #37), no stored passwords. Infra gives the
    service and the migrate task `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER` (`oryxa_fde_api` and
    `oryxa_fde_migrator`), and each task role may `rds-db:connect` as its own login only. The API
    and `oryxa-fde-ops` sign in with IAM tokens when those four are set (`store/src/iam.rs`); local
    and test runs keep `DATABASE_URL` (and `MIGRATION_DATABASE_URL`). So do the workers and the MCP
    server since #143, each as a login of its own (Database logins).
  - **Workers (#130).** The ingest and lifecycle workers are the images' other two entrypoints; each variable they read is in
    its table above, read from the binary. They need graceful shutdown on SIGTERM (#150) to use their 120 s stop
    timeout; until then they stop at once and rely on redelivery.
  - **Migrations run as a one-off task, never at startup** (#32, #39). The migrate task runs
    `oryxa-fde-ops migrate` from the API's image (`/usr/local/bin/oryxa-fde-ops`, beside
    `/usr/local/bin/oryxa-fde-api`), connected as `oryxa_fde_migrator`, and exits 0 when done. The
    service connects as `oryxa_fde_api`, a member of `oryxa_fde_runtime` only, so every query runs
    inside a transaction that took `oryxa_fde_app`, `oryxa_fde_relay` or `oryxa_fde_grants`. The
    bootstrap creates those roles and `oryxa_fde_runtime`, so no login needs CREATEROLE, and the
    migrator holds the first three with admin option for migrations 0001 and 0003.
  - It serves `GET /healthz` without auth (it does; the container health check and the deploy rely on
    it), listens where `LISTEN_ADDR` says (`127.0.0.1:<api_port>` in dev; the tunnel sidecar is its only
    client), keeps files under
    `<tenant>/<company>/` (`oryxa-fde-context/src/blob.rs`), and writes nothing to its root filesystem, which is
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
tofu -chdir=infra/envs/dev test      # mock providers: no credentials, no cloud calls; checks the API and worker tasks against the contract tables
shellcheck infra/scripts/*.sh
bash infra/scripts/test-smoke-test.sh # the smoke test against a local stub; no environment needed
bash infra/scripts/test-create-subscriber.sh # the subscriber script against a fake aws, and its filters against the code
actionlint                            # the deploy workflows
```

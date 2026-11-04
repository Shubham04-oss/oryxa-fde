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
| `envs/dev` | The composition, variables, outputs, lock file and `tests/plan.tftest.hcl` |
| `scripts/create-event-bus.sh` | Creates the EventBridge v2 bus `oryxa-fde-<env>` in a named region (no OpenTofu resource yet) |
| `scripts/run-task.sh` | One-off tasks in the private subnets: bootstrap SQL, the store's migrations, SpiceDB migrate, SpiceDB schema write |
| `sql/01-bootstrap.sql` | pgvector, the IAM logins `oryxa_fde_migrator`, `oryxa_fde_api` and `spicedb`, the roles the API's transactions take, the `spicedb` database, and a check that the API cannot act as the owner |

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
| `api_image_tag` | required | Git sha of the `oryxa-fde-api` image in ECR (tags are immutable); the API service and the migrate task run it |
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
| `shared/spicedb-preshared-key` | `SPICEDB_PRESHARED_KEY` (API), `SPICEDB_GRPC_PRESHARED_KEY` (SpiceDB), `ZED_TOKEN` (zed task) | oryxa-fde-api, SpiceDB, the zed task |
| `cloudflared/tunnel-token` | `TUNNEL_TOKEN` | cloudflared |
| RDS master (created by RDS) | `PGUSER`, `PGPASSWORD` | the db-admin task only |

No service has a database password: the API, the migrate task and SpiceDB connect with IAM
database auth, as `oryxa_fde_api`, `oryxa_fde_migrator` and `spicedb`, and each task role may
`rds-db:connect` as its own user only.

## Database logins

| Login | Used by | May |
| --- | --- | --- |
| `oryxa_fde_migrator` | the one-off migrate task (`oryxa-fde-api migrate`) | own and change the FDE tables; nothing else connects as it |
| `oryxa_fde_api` | the API service | `SET LOCAL ROLE` to `oryxa_fde_app` or `oryxa_fde_relay` per transaction, inheriting neither; owns nothing, creates nothing |
| `spicedb` | SpiceDB | its own `spicedb` database only |
| RDS master | the db-admin task | the bootstrap SQL |

The API can never become the table owner: its login is not a member of the migrator (or the
master), and its task role cannot connect as the migrator (`tests/plan.tftest.hcl` pins both IAM
sides). The bootstrap ends with a check that fails if the API login could act as an owner. A query
the API runs outside a scoped transaction is refused, because it inherits no table rights.

## Apply order

The owner needs an admin AWS login for the dev account, OpenTofu 1.11 or newer (CI uses 1.12.6),
AWS CLI 2.37.3 or newer (for `aws eventsv2`), `jq`, Docker with buildx for ARM64 images, and
`CLOUDFLARE_API_TOKEN` scoped to the account and zone with these permissions, all Edit: Cloudflare
Tunnel, Access: Apps and Policies, Workers VPC (Connectivity Directory), and Zone DNS.

1. **State.** Create a versioned, encrypted, private S3 bucket by hand, then run
   `tofu -chdir=infra/envs/dev init -backend-config="bucket=<state bucket>" -backend-config="region=us-west-2"`.
2. **Bus.** Run `infra/scripts/create-event-bus.sh dev <account id> us-west-2`, with the region you
   set as `aws_region`. It refuses any other account and prints the ARN for `event_bus_arn`.
3. **First apply, nothing running.** Fill `terraform.tfvars` with `start_services = false` and any
   `api_image_tag`, then run `tofu -chdir=infra/envs/dev plan -out dev.tfplan` and
   `tofu -chdir=infra/envs/dev apply dev.tfplan`. This creates the network, keys, the database (about
   10 minutes), the empty secrets, ECR, the ALB, the cluster with every service at 0 tasks, queues,
   CloudTrail, and on Cloudflare the DNS records, the tunnel, the VPC service and Access.
4. **Database bootstrap.** Run `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql`. It creates
   pgvector, the IAM logins, the API's transaction roles and the `spicedb` database, and is safe to
   re-run. It stops with an error if the API login could act as the table owner.
5. **Secret values**, by hand from files you delete afterwards, never typed on a command line:
   `aws secretsmanager put-secret-value --secret-id oryxa-fde-dev/<name> --secret-string file://<file>`
   for each name in `tofu output secrets`. The SpiceDB key is random (`openssl rand -base64 32`), the
   WorkOS key comes from the WorkOS dashboard, and the event signing key is an Ed25519 PEM
   (`openssl genpkey -algorithm ed25519`). Copy the tunnel token from the Cloudflare dashboard
   (Zero Trust, Networks, Tunnels, `oryxa-fde-dev-api`; output `tunnel_id`).
6. **SpiceDB datastore.** Run `infra/scripts/run-task.sh spicedb-migrate` (`datastore migrate head`,
   IAM auth).
7. **API image.** Build `oryxa-fde-api` for `linux/arm64`, push it to
   `$(tofu output -raw ecr_repository_url):<git sha>`, set `api_image_tag` to that sha, then plan and
   apply (services still at 0) so the migrate task runs that image.
8. **Migrations.** Run `infra/scripts/run-task.sh migrate`. The store's migrations run as
   `oryxa_fde_migrator` and the task exits; re-run it for every image that adds a migration, before
   the service runs that image.
9. **Start.** Set `start_services = true`, then plan and apply. SpiceDB, cloudflared and the API
   each start one task. The API registers with the ALB once `/healthz` answers 200.
10. **SpiceDB schema.** Run `infra/scripts/run-task.sh spicedb-schema schema/fde.zed`. Until this
    runs, every permission check fails closed.
11. **fde-web.** Bind the API in fde-web's wrangler config as
    `vpc_services: [{ binding: "API", service_id: <tofu output api_vpc_service_id> }]`, route
    `app.<domain>/*` as a zone route (OpenTofu owns that DNS record), then `wrangler deploy`.
12. **Smoke test.** The ALB target is healthy, `https://app.<domain>` reaches the API through the
    binding, `admin.<domain>` asks for an Access login, and CloudTrail delivers to its bucket.

When a consumer lands (wave 2), create its FIFO subscriber into `oryxa-fde-dev-<consumer>.fifo`,
with the `-undelivered` queue as its on-failure target and `tofu output eventbus_delivery_role_arn`
as its role (`aws eventsv2 create-subscriber`, or the platform kit's `provision` with env
`fde-dev`). Grant its service `ReceiveMessage` on that queue only; nothing reads the queues yet.

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
| Secrets Manager | 4 secrets + the RDS master secret at $0.40 | 2 |
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

## Known limits (dev only)

- `ponytail:` one NAT instance, single-AZ RDS and one SpiceDB task, with no failover.
- `ponytail:` plaintext hops inside the VPC, limited by security groups: cloudflared to the ALB to
  the API (HTTP), and the API to SpiceDB (gRPC). SpiceDB reaches RDS with `sslmode=require`, which
  does not verify the CA. Prod adds TLS on each hop and the RDS CA bundle.
- Tasks may reach any host on 443 through the NAT. The application's outbound allowlist
  (CLAUDE.md) is the control; a network firewall is a prod decision.
- **Per-company KMS keys** (ADR 0003) are not created here. The bucket encrypts with the
  environment key, and the API's role is limited to `tenants/*/companies/*`. The proposed decision,
  for the lead to record in ADR 0003, is on #34: keep the environment key while P0 holds sample data
  only, and add a key per company, made by a provisioning step, before real customer data arrives.
- ECR lives in the dev stack until a second environment needs it.

## Contracts with other streams

- **API (`crates/oryxa-fde-api`)** gets the env names its `main.rs` reads: `LISTEN_ADDR`,
  `SPICEDB_ENDPOINT`, `SPICEDB_PRESHARED_KEY`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
  `EVENT_SIGNING_KID`, `EVENT_SIGNING_KEY` and `EVENT_BUS_ARN`, plus `AWS_REGION`, `ORYXA_ENV`,
  `DATA_BUCKET` and `WEB_ORIGIN`. `tests/plan.tftest.hcl` pins the list.
  - **Open: the database.** The API reads one `DATABASE_URL`. Issue #7 asks for IAM database auth,
    whose password is a 15-minute token, so infra provides `DB_HOST`, `DB_PORT`, `DB_NAME` and
    `DB_USER` instead, and the API's role may connect only as `oryxa_fde_api`. Until the API builds
    its connection from those with a token (as the platform's services do), it cannot start here.
    The alternative, a password login with `DATABASE_URL` in Secrets Manager, needs no API change
    but brings back a database password. The lead decides.
  - **Migrations run as a one-off task, never at startup** (#32). The migrate task runs the API image
    with the argument `migrate`: `oryxa-fde-api migrate` connects as `DB_USER` (`oryxa_fde_migrator`)
    from `DB_HOST`, `DB_PORT`, `DB_NAME` and `AWS_REGION`, runs the store's migrations and exits 0.
    The service connects as `oryxa_fde_api`, which owns nothing and inherits no table rights, so
    every query must run inside a transaction that took `oryxa_fde_app` or `oryxa_fde_relay`. The
    bootstrap creates those two roles, so neither login needs CREATEROLE, and the migrator holds
    them with admin option, so migration 0001's re-grant to itself still works.
  - It serves `GET /healthz` without auth (it does), keeps files under
    `tenants/<tenant>/companies/<company>/`, and ships a `linux/arm64` image that writes nothing to
    its root filesystem, which is read-only.
- **Web (`fde-web/`)** uses the `vpc_services` binding (output `api_vpc_service_id`) and a zone route
  on `app.<domain>`, not a custom domain.
- **Agent (`sandbox/`)** has nothing here yet. Its gateway's hostname and an AWS identity for the
  outbound handler's Bedrock calls are follow-ups when that stream needs them.

## Checks

```bash
tofu fmt -check -recursive infra
tofu -chdir=infra/envs/dev init -backend=false
tofu -chdir=infra/envs/dev validate
tofu -chdir=infra/envs/dev test      # mock providers: no credentials, no cloud calls
shellcheck infra/scripts/*.sh
```

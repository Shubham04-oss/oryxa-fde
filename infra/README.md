# infra: the dev environment in OpenTofu

AWS and Cloudflare for `oryxa-fde`, following ADR 0003. **Nothing here has been applied.** Only
the owner applies, from their own machine, in the order below. CI runs `fmt`, `validate` and a
plan on mock providers with no credentials.

Patterns come from the platform's `infra/modules` and `docs/deploy.md` (oryxa-platform `2b064a3`).
The S3, SQS FIFO and EventBridge modules and the VPC are adapted from there, and each file says so.

## What it builds

```
Browser -> Cloudflare (DNS, Access on <admin_hostname>) -> fde-web Worker (<web_hostname>)
  -> vpc_services binding (Workers VPC) -> Cloudflare Tunnel
  -> one Fargate task in a private subnet: cloudflared (sidecar) -> 127.0.0.1:8080 -> oryxa-fde-api
       -> RDS PostgreSQL 17 + pgvector    (IAM database auth, TLS, private)
       -> SpiceDB on Fargate              (spicedb.oryxa-fde-dev.internal:50051, Cloud Map, private)
       -> S3 data bucket                  (KMS, <tenant>/<company>/ prefix per company, one KMS key per company: Company keys)
       -> EventBridge v2 bus oryxa-fde-dev -> per-consumer SQS FIFO + DLQ + undelivered queue
Two more Fargate tasks, queue workers with no inbound network at all (they read SQS and call out):
  oryxa-fde-ingest    <- context-ingestion queue; S3 (read), Bedrock embeddings; RDS as oryxa_fde_ingest
  oryxa-fde-lifecycle <- lifecycle queue; Bedrock (drafts), SES (digest), Slack tokens (read); RDS as
                         oryxa_fde_lifecycle. Not deployed until a drafting model is chosen (update_model).
And, only with enable_mcp (off by default), the MCP server for an FDE's own agent, with a tunnel of its own:
  Agent -> <mcp_hostname> (Cloudflare's edge) -> its own tunnel -> one Fargate task: cloudflared (sidecar) -> 127.0.0.1:8081
  -> oryxa-fde-mcp (RDS as oryxa_fde_mcp, SpiceDB, Bedrock to embed a query); no S3, no listener, no inbound network
Everything outbound (AWS APIs, image pulls, WorkOS, the tunnels) leaves through one fck-nat instance.
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
| `modules/s3` | Private bucket: KMS, versioned, public access blocked, TLS only; `force_destroy` for teardown only; takes extra policy statements (the company key rules) |
| `modules/company_keys` | The parts of per-company KMS keys that are the same for every company (Company keys): the provisioning and offboarding roles, the policy every key gets, the bucket's write rules. It creates no key |
| `modules/sqs_fifo` | FIFO queue, FIFO DLQ, optional undelivered queue (names and attributes match the platform's consumer kit) |
| `modules/eventbridge` | Delivery role for bus subscribers and the publish policy (the bus itself is created by script) |
| `modules/cloudtrail` | Multi-region trail with its own bucket and key, log file validation, data events on the data bucket |
| `modules/cloudflare` | DNS for the web and admin host names (named by variables, not derived), the tunnel, the Workers VPC service to the API on the loopback of the tunnel's connector, Access on the admin host; with `enable_mcp`, the MCP server's own tunnel, its ingress rule and its proxied record for the MCP host name |
| `envs/dev` | The composition, variables, outputs, lock file and `tests/plan.tftest.hcl` (with `tests/contract`, which reads the environment contract tables below, one per binary, and `tests/code`, which reads the API's health-check and shutdown constants and the Dockerfile); `deploy.tf` holds the GitHub deploy role and the deploy parameters |
| `docker/oryxa-fde-api.Dockerfile` | The backend image, one for every task: the prebuilt ARM64 `oryxa-fde-api`, `oryxa-fde-ops`, `oryxa-fde-ingest`, `oryxa-fde-lifecycle` and `oryxa-fde-mcp` on distroless Debian 13, nonroot, with no shell and no other program (Deploys, The image) |
| `scripts/create-event-bus.sh` | Creates the EventBridge v2 bus `oryxa-fde-<env>` in a named region (no OpenTofu resource yet) |
| `scripts/create-subscriber.sh` | Creates (or refreshes the filter of) a worker's EventBridge v2 FIFO subscriber into its queue; `test-create-subscriber.sh` tests it against a fake `aws` and checks each filter against the events the worker's code handles |
| `scripts/company-key.sh` | Creates, checks, syncs and offboards one company's KMS key; `scripts/test-company-key.sh` tests it against a fake `aws` (`scripts/test-company-key-fake-aws.py`) |
| `scripts/run-task.sh` | One-off tasks in the private subnets: bootstrap SQL, the store's migrations, SpiceDB migrate, SpiceDB schema write |
| `sql/01-bootstrap.sql` | pgvector, the IAM logins `oryxa_fde_migrator`, `oryxa_fde_api`, `oryxa_fde_ingest`, `oryxa_fde_lifecycle`, `oryxa_fde_mcp` and `spicedb`, the NOLOGIN roles they reach, the `spicedb` database, and a check that nothing the API or a worker reaches has owner powers |
| `sql/02-api-owns-nothing.sql` | Once, only on a database the first bootstrap let `oryxa_fde_api` own: hands its objects to the migrator and drops its old grants |

Names: the ECS services are `oryxa-fde-api`, `oryxa-fde-ingest`, `oryxa-fde-lifecycle` and `oryxa-fde-mcp`, and the one
ECR repository, which holds the backend image all of them run, is `oryxa-fde-api`. Everything
else is `oryxa-fde-<env>-…`: the cluster `oryxa-fde-dev`, SpiceDB `oryxa-fde-dev-spicedb`, the
one-off tasks `oryxa-fde-dev-migrate`, `-db-admin` and `-zed`, the bus `oryxa-fde-dev`, the
queues `oryxa-fde-dev-<consumer>.fifo`, `-dlq.fifo` and `-undelivered`, and a worker's (or the MCP server's) task definition,
roles and log group (`/ecs/oryxa-fde-dev-ingest`, `-lifecycle`, `-mcp`).

## Variables

Set in `envs/dev/terraform.tfvars` (gitignored; start from `terraform.tfvars.example`). None of
them is a secret. The Cloudflare API token comes from `CLOUDFLARE_API_TOKEN` in the environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `env` | `dev` | Environment name in every resource name (`oryxa-fde-<env>`); 2 to 10 lowercase letters or digits |
| `aws_account_id` | required | The only account the AWS provider will touch (`allowed_account_ids`) |
| `aws_region` | `ap-south-1` | Mumbai, chosen by the founder to see real latency from the team and first customers (#144). Everything in AWS runs and rests here; what Mumbai does and does not offer is in Mumbai (ap-south-1) below |
| `cloudflare_account_id` | required | Account for the tunnel, the Workers VPC service and Access |
| `cloudflare_zone_id` | required | The Cloudflare zone's id |
| `cloudflare_zone_name` | required | That zone's own name (`example.com` in the examples; this README never names a real zone). It is not a host name: it is what the three host names below are checked against |
| `web_hostname` | required | The web app's full host name (fde-web). **The API's `WEB_ORIGIN` is `https://<web_hostname>`, exactly**, because the session cookie and the CSRF check depend on it; the `WEB_HOSTNAME` GitHub variable (Deploys) and the smoke test's `SMOKE_BASE_URL` are the same name. Validated: a lowercase host name that is the zone itself or **exactly one label under it** (Cloudflare's Universal SSL certificate covers the zone and one level of subdomain only, so `app.fde-dev.<zone>` would have no certificate). For dev, for example `fde-dev.<zone>` |
| `admin_hostname` | required | The admin tools' full host name, behind Cloudflare Access (a proxied `AAAA` placeholder record for a Worker route, and the Access application). Same rules, and not the web app's. For dev, for example `fde-dev-admin.<zone>` |
| `mcp_hostname` | `null` | The MCP server's full host name (its tunnel's one public name, its ingress rule and `MCP_ALLOWED_HOSTS`). **Required with `enable_mcp`**, ignored without it. Same rules, and neither of the other two. For dev, for example `fde-dev-mcp.<zone>` |
| `admin_emails` | required | Who may open `admin_hostname` through Cloudflare Access |
| `workos_client_id` | required | WorkOS client id (public); the API key is a secret |
| `event_bus_arn` | required | Printed by `scripts/create-event-bus.sh`; must be the `oryxa-fde-<env>` v2 bus in `aws_account_id` and `aws_region` (plan fails otherwise) |
| `event_signing_kid` | `k1` | Key id of the API's event signing key (`EVENT_SIGNING_KID`); change it when the key rotates |
| `event_public_key` | required | The public half of that key as a PEM (`-----BEGIN PUBLIC KEY-----`): `EVENT_PUBLIC_KEY` on both workers, which verify every event with it. Not a secret. Make the pair before the first apply (Apply order, step 4); rotate it with `event_signing_kid` |
| `data_bucket_name` | required | Globally unique name for the customer data bucket |
| `cloudtrail_bucket_name` | required | Globally unique name for the CloudTrail log bucket |
| `company_key_operator_arns` | required | IAM users or roles of the account that may assume the company-key provisioning and offboarding roles (Company keys); at least one. To start, the founder's admin role only; no MFA condition for now |
| `company_key_reader_role_arns` | `[]` | Roles other than the ingest worker's that only read company files. Not the MCP server: none of its tools reads a file, so its role has no S3 or KMS permission and is not a reader (oryxa-fde-mcp). The ingest worker's task role is always a reader, added by `envs/dev`, and listing it here is refused. Each reader is named in every company key's policy, so adding one means `company-key.sh sync` per company with a key |
| `company_key_rotation` | `false` | Yearly automatic rotation of each company key. Off for now (Company keys, Cost): each rotation adds a billed key version, for little gain on S3 object data. Switch it on per environment; `provision` then switches it on for each key it checks |
| `require_company_keys` | `false` | `false`: a company file written without naming a key lands under the environment key (sample data only). `true`: S3 refuses any write that does not name a company key, and the API's role loses `kms:GenerateDataKey` on the environment key. The API has named company keys on write since #176 and both it and the ingest worker carry `COMPANY_KEY_ALIAS_ARN_PREFIX` (#183). Set it before the first real customer data, once the checks in Company keys, Before `require_company_keys` is switched on, pass |
| `api_image_tag` | required | Seeds `/oryxa-fde-<env>/api-image-tag` on the first apply (any value while nothing runs); after that `deploy-api` owns the tag (Deploys) |
| `github_repository` | `Shubham04-oss/oryxa-fde` | The repository whose `environment: <env>` jobs may assume the deploy role |
| `github_oidc_subject_prefix` | `null` | The OIDC `sub` prefix the deploy role trusts, before `:environment:<env>`. Null is `repo:<github_repository>`. With GitHub's immutable subject on (this repository has it), set it to the `sub_claim_prefix` that `gh api repos/<owner>/<name>/actions/oidc/customization/sub` prints, `repo:<owner>@<owner id>/<name>@<repo id>` (Apply order, step 4). Validated: that shape or `repo:<owner>/<name>`, naming `github_repository`, no wildcard |
| `github_oidc_provider_arn` | `null` | The account's GitHub OIDC provider, if it already has one; null creates it |
| `start_services` | `false` | `false`: every service (SpiceDB, the API task, the workers) runs 0 tasks. Set `true` once the image and every secret value exist |
| `consumers` | `["lifecycle", "context-ingestion"]` | Event consumers; each gets a FIFO queue, a DLQ and an undelivered queue. Must include those two: the workers read them |
| `api_port` | `8080` | Port `oryxa-fde-api` listens on, on the task's loopback (`LISTEN_ADDR` is `127.0.0.1:<port>`); the health check and the Workers VPC service use it |
| `api_shutdown_grace_seconds` | `20` | Seconds the API drains after SIGTERM: `SHUTDOWN_GRACE_SECONDS` on the API, and the `api` container's `stopTimeout` is this plus 10. A whole number from 1 to 65: the API starts with up to 119, but the stop sequence (cloudflared's 45 s, then the API's grace plus 10) must fit 120 s (Deploys, How a task stops) |
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
| `workos_issuer` | `null` | `WORKOS_ISSUER` on the API and the MCP server, which pin every token's `iss` to it. Needed only with a custom auth domain in WorkOS: set it to that domain, or every sign-in is refused. Null: the code derives WorkOS's own issuer from the client id, `https://api.workos.com/user_management/<client id>`, which is what a WorkOS environment without a custom auth domain issues; setting it to that value is harmless. Validated: https, an optional path of letters, digits, `_`, `-` and `.`, no query, fragment, userinfo or wildcard (Verify before apply) |
| `ingest_cpu`, `ingest_memory` | `512`, `2048` | The ingest worker's task. It holds each document in memory and extracts its text in a child limited to 1 GiB of address space (`child.rs`), so memory is the figure to watch |
| `lifecycle_cpu`, `lifecycle_memory` | `256`, `512` | The lifecycle worker's task |
| `enable_mcp` | `false` | Deploy the MCP server for FDE agents: its task (the server and its own cloudflared), role and service, the `cloudflared/mcp-tunnel-token` secret, and on Cloudflare its tunnel, ingress rule and the proxied record for `mcp_hostname` (which it requires). **Off, because how an FDE's agent signs in is not decided** (What is missing before an agent can sign in): on, the name answers on the internet and refuses every request without a valid WorkOS token. Off, nothing of it exists, although the binary is in the image |
| `mcp_cpu`, `mcp_memory` | `256`, `512` | The MCP server's task, shared by the server and its connector |
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

### Host names

The three host names are inputs, not derived from one base name. The zone is the founder's real one and also holds the
production names (the zone itself, `app.`, `admin.`, `mcp.`), and Cloudflare's Universal SSL certificate covers the zone
and one level of subdomain only, so dev needs single-level names of its own, chosen explicitly. There is no default
for any of them, so nobody takes the production names by accident, and `terraform.tfvars.example` shows dev's with the
placeholder zone `example.com` (no real zone or host name belongs in this repository):

| Variable | Dev example | Where it goes |
| --- | --- | --- |
| `web_hostname` | `fde-dev.example.com` | the proxied `AAAA` placeholder record for fde-web's route; the API's `WEB_ORIGIN` (`https://fde-dev.example.com`) and the lifecycle worker's, with the digest; output `web_hostname`, which is the `WEB_HOSTNAME` GitHub variable (the route `<WEB_HOSTNAME>/*` that `deploy-workers` adds); the smoke test's `SMOKE_BASE_URL`; the WorkOS redirect URI `https://<web_hostname>/auth/callback` |
| `admin_hostname` | `fde-dev-admin.example.com` | its proxied `AAAA` placeholder record; the Cloudflare Access application's domain; output `admin_hostname` |
| `mcp_hostname` | `fde-dev-mcp.example.com` | only with `enable_mcp`: its proxied CNAME to the MCP tunnel, the tunnel's one ingress rule, `MCP_ALLOWED_HOSTS` on the MCP server; output `mcp_hostname` |

`plan` refuses a name that is not lowercase, is neither the zone nor exactly one label under it (with the reason), is
the same as another of the three, or (`mcp_hostname`) is missing while `enable_mcp` is on. The web name must be exactly
the web app's origin: the API compares the browser's `Origin` with `WEB_ORIGIN` (`403 csrf`) and the session cookie is
`__Host-` bound to the host, so a different name in either place signs nobody in. The GitHub environment variable
`WEB_HOSTNAME` is `tofu output -raw web_hostname`, never typed by hand, so it cannot differ from `web_hostname`.

## Secrets

Secrets Manager holds one secret per value. OpenTofu creates each secret empty, encrypted with
the environment key, and grants read access by exact ARN to the tasks that use it. The owner
sets the values by hand, so no value passes through OpenTofu config, plan or state. ECS injects
them as env vars when a task starts, and a task cannot start until its secrets have values.

| Secret (`oryxa-fde-dev/…`) | Env name | Read by |
| --- | --- | --- |
| `api/workos-api-key` | `WORKOS_API_KEY` | oryxa-fde-api, and oryxa-fde-mcp with `enable_mcp` (its binary builds a WorkOS client with it) |
| `api/event-signing-key` | `EVENT_SIGNING_KEY` | oryxa-fde-api (outbox relay) |
| `api/session-password` | `SESSION_PASSWORD` | oryxa-fde-api (seals the session cookie) |
| `api/sandbox-gateway-token` | `SANDBOX_GATEWAY_TOKEN` | oryxa-fde-api, only with `sandbox_gateway_url` |
| `api/realtime-token` | `REALTIME_TOKEN` | oryxa-fde-api, only with `realtime_url` |
| `api/github-app-private-key`, `api/github-client-secret`, `api/github-webhook-secret` | `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` | oryxa-fde-api, only with `github_app` |
| `api/slack-client-secret`, `api/slack-signing-secret` | `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | oryxa-fde-api, only with `slack_client_id` |
| `api/install-state-key` | `INSTALL_STATE_KEY` | oryxa-fde-api, with `github_app` or `slack_client_id` |
| `shared/spicedb-preshared-key` | `SPICEDB_PRESHARED_KEY` (API, MCP), `SPICEDB_GRPC_PRESHARED_KEY` (SpiceDB), `ZED_TOKEN` (zed task) | oryxa-fde-api, oryxa-fde-mcp with `enable_mcp`, SpiceDB, the zed task |
| `cloudflared/tunnel-token` | `TUNNEL_TOKEN` | the cloudflared sidecar of the API task only (ECS injects secrets per container: the API container does not see it, and cloudflared sees none of the API's) |
| `cloudflared/mcp-tunnel-token` | `TUNNEL_TOKEN` | the cloudflared sidecar of the MCP task only, and only with `enable_mcp`: its tunnel is not the API's, so the two tokens differ |
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
database auth, as `oryxa_fde_api`, `oryxa_fde_ingest`, `oryxa_fde_lifecycle`, `oryxa_fde_mcp`, `oryxa_fde_migrator` and
`spicedb`, and each task role may `rds-db:connect` as its own user only (no worker connects as the API).

## Database logins

| Login | Used by | May |
| --- | --- | --- |
| `oryxa_fde_migrator` | the one-off migrate task (`oryxa-fde-ops migrate`) | own and change the FDE tables; grant `oryxa_fde_app`, `oryxa_fde_relay` and `oryxa_fde_grants` onward (admin option), no CREATEROLE; nothing else connects as it |
| `oryxa_fde_api` | the API service | member of `oryxa_fde_runtime` only: `SET LOCAL ROLE` to `oryxa_fde_app`, `oryxa_fde_relay` or `oryxa_fde_grants` per transaction, inheriting none; `connect` and `usage` only; owns nothing, creates nothing |
| `oryxa_fde_ingest` | the ingest worker | member of `oryxa_fde_app` only, not inherited: `SET LOCAL ROLE` per transaction; `connect` and `usage` only; owns nothing |
| `oryxa_fde_lifecycle` | the lifecycle worker | member of `oryxa_fde_app` and `oryxa_fde_grants` (its cross-tenant scan, `store/src/engine.rs:443`), neither inherited; otherwise as the ingest login |
| `oryxa_fde_mcp` | the MCP server (only with `enable_mcp`) | member of `oryxa_fde_app` only, as the ingest login. That role can write, so the server is read-only by its code, not by its login (How the MCP server is reached, item 8) |
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

Read from the code, not from memory (each `Read at` is `file:line` in `crates/`; every table was checked against
`main` at `8f16f6a`; the `oryxa-fde-mcp` table and every `COMPANY_KEY_ALIAS_ARN_PREFIX` row again at `514d528`), and compared with what `envs/dev` sets. `tests/plan.tftest.hcl`
reads the tables of `oryxa-fde-api`, `oryxa-fde-ingest`, `oryxa-fde-lifecycle` and `oryxa-fde-mcp`: every `always` variable of the
binary must be on its task definition, every variable the task definition sets must be in the table, and a secret
must be injected from Secrets Manager, never set as plain config. Add or change a variable in the code, and the table and `envs/dev` change in the same PR.
The line numbers are not tested: when a PR moves code a table points at, it refreshes them. Three things are also read from
the source as text (`tests/code`): the shape `COMPANY_KEY_ALIAS_ARN_PREFIX` must have, built from the literals of `CompanyKeyPrefix::parse` in `context/src/keys.rs` and checked against the value on the API's and the ingest worker's tasks, with its Region equal to theirs; the `healthcheck` row of the `oryxa-fde-ops` table must give the command the API
container's health check runs, and the `SHUTDOWN_GRACE_SECONDS` row's default and range must be the code's (`health.rs`,
`shutdown.rs`), with the grace on the task inside that range and the stop timeouts derived from it. This couples the infra tests to
the Rust source on purpose: a Rust PR that renames or reshapes those constants (or the Dockerfile's `COPY`) fails
`tofu test` until the infra side, this README and `tests/code` are updated with it.

Columns. **Needed**: `always`; a feature the variable belongs to (`agent`, `realtime`, `github`,
`slack`; for the lifecycle worker `digest`, `slack`: needed when that feature is on, and the first row of each is its switch); `optional` (the code has
a default); `local only` (tests and laptops). **Kind**: `config` (plain, visible in the task definition),
`secret` (a value; ECS injects it from Secrets Manager), `reference` (a Secrets Manager name or KMS key
ARN, not a value). Every task also gets its AWS identity from the task role: the SDK reads
`AWS_REGION` and the container credentials ECS provides (`aws_config::load_from_env`). The API's
task is two containers (the API and cloudflared), so the table below describes the `api` container
only; the sidecar has one variable, `TUNNEL_TOKEN`. The MCP server's task is built the same way (its table describes the `mcp`
container). A worker task is one container.

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
| `AWS_REGION` | always | config | none | `iam.rs:133`, `oryxa-fde-context/src/lib.rs:112`, `oryxa-events/src/lib.rs:210` | `aws_region` |
| `SPICEDB_ENDPOINT` | always | config | none | `oryxa-fde-api/src/main.rs:52` | Cloud Map name |
| `SPICEDB_PRESHARED_KEY` | always | secret | none | `main.rs:53` | `shared/spicedb-preshared-key` |
| `WORKOS_API_KEY` | always | secret | none | `main.rs:57` | `api/workos-api-key` |
| `WORKOS_CLIENT_ID` | always | config | none | `main.rs:58` | `workos_client_id` |
| `WEB_ORIGIN` | always | config | none | `main.rs:71`, `main.rs:89` | `https://<web_hostname>`: the web app's origin exactly |
| `SESSION_PASSWORD` | always | secret | none | `main.rs:72` | `api/session-password` |
| `EVENT_SIGNING_KID` | always | config | none | `main.rs:79` | `event_signing_kid` |
| `EVENT_SIGNING_KEY` | always | secret | none | `main.rs:79` | `api/event-signing-key` |
| `EVENT_BUS_ARN` | always | config | none | `main.rs:80` | `event_bus_arn` |
| `DOCUMENTS_BUCKET` | always | config | none | `oryxa-fde-context/src/lib.rs:113` | the data bucket |
| `LISTEN_ADDR` | optional | config | `0.0.0.0:8080` | `health.rs:28` (the API calls it at `main.rs:93`; `oryxa-fde-ops healthcheck` reads it too) | `127.0.0.1:<api_port>`: the tunnel sidecar is the only client, and the health check calls it |
| `SHUTDOWN_GRACE_SECONDS` | optional | config | `20`; 1 to 119, anything else stops startup | `shutdown.rs:30` (named at `:17`, used at `main.rs:49`) | `api_shutdown_grace_seconds` (20): the `api` container's `stopTimeout` is this plus 10 |
| `EMBEDDING_PROVIDER` | optional | config | `bedrock` (`fake` for tests) | `context/src/lib.rs:114` | `bedrock` |
| `EMBEDDING_MODEL` | optional | config | `amazon.titan-embed-text-v2:0` (`embed.rs:12`) | `context/src/lib.rs:118` | `embedding_model` |
| `EMBEDDING_REPLACES` | optional | config | none | `context/src/lib.rs:123` | not set |
| `COMPANY_KEY_ALIAS_ARN_PREFIX` | optional | config | none: no company key named, every file under the environment key | `context/src/lib.rs:130` (name: `context/src/keys.rs:18`, parsed at `keys.rs:40`, Region compared at `keys.rs:93`) | output `company_key_alias_arn_prefix`, always (Company keys): `arn:<partition>:kms:<region>:<account>:alias/oryxa-fde-<env>/companies/`. A malformed prefix, or one in another Region than `AWS_REGION`, stops startup; `tests/code` reads the parser from the source and checks the value on the task against it |
| `WORKOS_ISSUER` | optional | config | `https://api.workos.com/user_management/<WORKOS_CLIENT_ID>` (`session.rs:496`; blank counts as unset) | `main.rs:57` | `workos_issuer`; not set when null. Needed only with a custom auth domain in WorkOS: that domain |
| `SESSION_PASSWORD_PREVIOUS` | optional | secret | none | `main.rs:75` | not set; add a secret when rotating |
| `RUST_LOG` | optional | config | `info` | `main.rs:44` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:307` | never set |
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
| `kms:Decrypt`, `kms:GenerateDataKey` on the environment key, only through S3 | the bucket's default encryption; files written before a company has a key | granted; `GenerateDataKey` removed with `require_company_keys` |
| `kms:Decrypt`, `kms:GenerateDataKey` on each company's key | named in the **key's** policy, not in this role's IAM policy (Company keys): only through S3, only under that company's prefix | granted by the key policy |
| `kms:DescribeKey` on each company's key | "has this company a key?": `DescribeKey` on the company's alias (`context/src/keys.rs:178`, `describe`). KMS authorises it against the key, so for a company that has a key it is the **key's** policy that allows it (`ServingRolesCheckTheKeyExists`, the API's role only), with no IAM grant on any key | granted by the key policy |
| `kms:DescribeKey` on `alias/oryxa-fde-<env>/companies/*` | the same call for a company that has no key. An alias ARN in an IAM `Resource` names the alias and never a key, so this reaches no key at all; AWS's permissions reference lists only "KMS key" as `DescribeKey`'s resource, so by the documentation it grants nothing and is kept as harmless (Company keys, How the API's key check is authorised) | granted (`LookUpCompanyKeyAliases`) |
| `bedrock:InvokeModel` on `foundation-model/<embedding_model>` in `aws_region` | embeddings (`context/src/embed.rs:95`) | granted |
| `secretsmanager:CreateSecret`, `TagResource`, `PutSecretValue`, `GetSecretValue`, `DeleteSecret` on `oryxa-fde/<env>/slack/*`, and `kms:Decrypt`, `kms:GenerateDataKey` only through Secrets Manager | Slack bot tokens (`integrations/src/secrets.rs:87`, `:99`, `:117`, `:134`) | only with `slack_client_id` |
| Bedrock for `AGENT_MODEL`, `EVAL_JUDGE_MODEL` | not the API: the judge is a `curl` run inside the sandbox (`agent/src/evals.rs:243`), signed by the gateway's outbound handler | not granted; the gateway's AWS identity is the agent stream's follow-up |

### `oryxa-fde-ops`

Entrypoint `/usr/local/bin/oryxa-fde-ops` in the API image.

| Subcommand | Variables (Read at) | In dev |
| --- | --- | --- |
| `migrate` | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` as `oryxa_fde_migrator`, and `AWS_REGION` (`store/src/lib.rs:266`, `iam.rs:82`); `MIGRATION_DATABASE_URL` for local runs only (`lib.rs:273`) | the `oryxa-fde-dev-migrate` task sets all five; its role may connect as the migrator only |
| `replay-dead-events [tenant]` | `DB_*` as `oryxa_fde_api`, and `AWS_REGION` (`store/src/lib.rs:299`, `ops.rs:33`) | not deployed: no task definition. A one-off task, so it keeps the API's login |
| `healthcheck` | `LISTEN_ADDR` only (`health.rs:28`, default `0.0.0.0:8080`), no secret, no AWS call, no database. One GET to `/healthz` (`health.rs:8`) over loopback (an address that is neither loopback nor unspecified fails), 2 s timeout (`health.rs:12`), exit 0 only on a 200 (`ops.rs:38`) | the `api` container's health check: `/usr/local/bin/oryxa-fde-ops healthcheck`, run every 10 s with ECS's timeout at 5 s, 3 misses to replace the task, 30 s start period |

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
| `AWS_REGION` | always | config | none | `iam.rs:133`, `oryxa-fde-context/src/lib.rs:112` | `aws_region` |
| `DOCUMENTS_BUCKET` | always | config | none | `context/src/lib.rs:113` | the data bucket |
| `EVENT_SIGNING_KID` | always | config | none | `context/src/bin/ingest.rs:47` | `event_signing_kid` |
| `EVENT_PUBLIC_KEY` | always | config | none (PEM) | `ingest.rs:49` | `event_public_key`: the public half of the API's signing key, so plain config |
| `INGEST_QUEUE_URL` | always | config | none | `ingest.rs:51` | the `context-ingestion` queue's url |
| `EMBEDDING_PROVIDER` | optional | config | `bedrock` (`fake` for tests) | `context/src/lib.rs:114` | `bedrock` |
| `EMBEDDING_MODEL` | optional | config | `amazon.titan-embed-text-v2:0` | `context/src/lib.rs:118` | `embedding_model` |
| `EMBEDDING_REPLACES` | optional | config | none | `context/src/lib.rs:123` | not set |
| `COMPANY_KEY_ALIAS_ARN_PREFIX` | optional | config | none | `context/src/lib.rs:130` | output `company_key_alias_arn_prefix`, the API's value: the worker only reads, and S3 knows each object's key, so it never names a key or asks KMS (`has_key` has no caller in the worker); it builds the same context as the API, which parses and checks the value at start, so the two tasks carry one value |
| `RUST_LOG` | optional | config | `info` | `ingest.rs:41` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:307` | never set |

What the ingest role may do, from what the code calls. It calls AWS only (S3, SQS, Bedrock):

| Permission | Why (`Read at`) | In dev |
| --- | --- | --- |
| `rds-db:connect` as `oryxa_fde_ingest` | the store (`iam.rs`) | granted |
| `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on the `context-ingestion` queue | long poll, delete when handled, extend the message's visibility while a handler runs (`oryxa-fde-events/src/inbox.rs:96`, `:159`, `:173`); never the dead-letter queue (SQS moves messages there) and never a send | granted |
| `s3:GetObject` on `*/*/documents/*` | the document at `<tenant>/<company>/documents/<id>` (`context/src/blob.rs:31`, `:81`; `context/src/ingest.rs:60`). The worker builds the same blob store as the API but only calls `get`: no put, no canvas, no list, no delete | granted |
| `kms:Decrypt` only through S3 | reading an object the bucket encrypted; no `GenerateDataKey`, since it never writes, and no `DescribeKey`: nothing in the worker asks whether a company has a key, so neither its IAM policy nor the keys' policies grant it (`tests/plan.tftest.hcl` pins both) | granted on the environment key. A company's key (Company keys) lets it decrypt under that company's prefix, through S3 only: its task role is a reader in every company key's policy (`envs/dev` adds it to `company_key_reader_role_arns` itself, #171). A key made before that role was added needs `company-key.sh sync` for its company once, after the apply that added it |
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
| `AWS_REGION` | always | config | none | `iam.rs:133`, `oryxa-fde-lifecycle/src/bin/lifecycle.rs:57` | `aws_region`; the Bedrock client is built from this alone, so the profile must be one this Region can call |
| `EVENT_SIGNING_KID` | always | config | none | `lifecycle.rs:53` | `event_signing_kid` |
| `EVENT_PUBLIC_KEY` | always | config | none (PEM) | `lifecycle.rs:55` | `event_public_key` |
| `UPDATE_MODEL` | always | config | none | `lifecycle.rs:58` | `update_model`: a `global.` profile (Where prompts are processed) |
| `LIFECYCLE_QUEUE_URL` | always | config | none | `lifecycle.rs:110` | the `lifecycle` queue's url |
| `DIGEST_FROM` | digest | config | none: no digest | `lifecycle.rs:60` | `digest_from` |
| `WEB_ORIGIN` | digest | config | none; required with `DIGEST_FROM` | `lifecycle.rs:63` | `https://<web_hostname>` |
| `SLACK_SECRET_PREFIX` | slack | reference | none: no update posted to Slack | `lifecycle.rs:96` | `oryxa-fde/<env>/slack/`, set with `slack_client_id` |
| `RUST_LOG` | optional | config | `info` | `lifecycle.rs:48` | not set |
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

### `oryxa-fde-mcp`

The MCP server for an FDE's own coding agent, entrypoint `/usr/local/bin/oryxa-fde-mcp` (the same image as the API),
container `mcp` of the `oryxa-fde-dev-mcp` task, service `oryxa-fde-mcp`. **Deployed only while `enable_mcp` is true** (off
by default: What is missing before an agent can sign in). It serves four read-only tools over one project (search, scope,
decisions, tasks) on the streamable HTTP transport at `/mcp` (`oryxa-fde-mcp/src/lib.rs`), and checks every request's
WorkOS bearer token as the API does (`Principal::from_bearer`). A variable that is missing, or not valid, stops startup.

| Variable | Needed | Kind | Default | Read at | Infra |
| --- | --- | --- | --- | --- | --- |
| `DB_HOST` | always | config | none | `oryxa-fde-store/src/iam.rs:82` (`Store::from_env`, `oryxa-fde-mcp/src/bin/mcp.rs:28`) | RDS address |
| `DB_PORT` | always | config | none | `iam.rs:82` | RDS port |
| `DB_NAME` | always | config | none | `iam.rs:82` | `oryxa_fde` |
| `DB_USER` | always | config | none | `iam.rs:82` | `oryxa_fde_mcp`, its own login |
| `AWS_REGION` | always | config | none | `iam.rs:133`, `oryxa-fde-context/src/lib.rs:112` | `aws_region` |
| `SPICEDB_ENDPOINT` | always | config | none | `mcp.rs:30` | Cloud Map name |
| `SPICEDB_PRESHARED_KEY` | always | secret | none | `mcp.rs:31` | `shared/spicedb-preshared-key`, the API's |
| `WORKOS_API_KEY` | always | secret | none | `mcp.rs:35` | `api/workos-api-key`, the API's |
| `WORKOS_CLIENT_ID` | always | config | none | `mcp.rs:36` | `workos_client_id` |
| `MCP_ALLOWED_HOSTS` | always | config | none; comma-separated `Host` values, none means the server accepts none that is not loopback | `mcp.rs:41` | `mcp_hostname` only |
| `DOCUMENTS_BUCKET` | always | config | none | `context/src/lib.rs:113` (`Context::from_env`, `mcp.rs:40`) | the data bucket: the binary needs the name to start, and no tool reads a file |
| `LISTEN_ADDR` | optional | config | `0.0.0.0:8081` | `mcp.rs:47` | `127.0.0.1:8081`: the tunnel sidecar is the only client |
| `EMBEDDING_PROVIDER` | optional | config | `bedrock` (`fake` for tests) | `context/src/lib.rs:114` | `bedrock` |
| `EMBEDDING_MODEL` | optional | config | `amazon.titan-embed-text-v2:0` | `context/src/lib.rs:118` | `embedding_model` |
| `EMBEDDING_REPLACES` | optional | config | none | `context/src/lib.rs:123` | not set |
| `COMPANY_KEY_ALIAS_ARN_PREFIX` | optional | config | none | `context/src/lib.rs:130` | not set: no tool reads or writes a file, and the role has no KMS permission. The binary builds the same context as the API, so it would parse a value if given one, but it never names a key or asks KMS |
| `WORKOS_ISSUER` | optional | config | `https://api.workos.com/user_management/<WORKOS_CLIENT_ID>` (`session.rs:496`; blank counts as unset) | `mcp.rs:35` | `workos_issuer`; not set when null. Needed only with a custom auth domain in WorkOS: that domain |
| `RUST_LOG` | optional | config | `info` | `mcp.rs:26` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:307` | never set |

What the MCP role may do, from what the code calls (AWS: Bedrock; SpiceDB over gRPC; WorkOS's key set over HTTPS through the NAT):

| Permission | Why (`Read at`) | In dev |
| --- | --- | --- |
| `rds-db:connect` as `oryxa_fde_mcp` | the store (`iam.rs`) | granted with the server |
| `bedrock:InvokeModel` on `foundation-model/<embedding_model>` in `aws_region` | `search_context` embeds the query (`context/src/search.rs:141`, `embed.rs:95`) | granted with the server |
| S3 and KMS | **none**: the README used to list the API's S3 read and a place among the company keys' readers for this server, and the code does not need them. A tool's answer is built from rows (`oryxa-fde-api/src/reads.rs`, `context/src/search.rs`: `search_project` reads chunks and embeddings from the database); the only blob reads are the API's download and canvas routes and the ingest worker (`context/src/blob.rs` callers: `documents.rs:184`, `canvas.rs:136` and `:233`, `ingest.rs:61`). `Context::from_env` builds an S3 client and needs the bucket's name, and never calls it | not granted. A tool that reads a file's bytes later needs `s3:GetObject` on `*/*/documents/*`, `kms:Decrypt` through S3, and a place in `company_key_reader_role_arns` with a `company-key.sh sync` per company, in the same change |
| Secrets Manager, SQS, SES, other models | none: nothing in the binary calls them (ECS reads the task's two secrets with the execution role) | not granted |

The task's security group admits nothing and its egress is HTTPS (through the NAT: WorkOS, AWS), the database, SpiceDB's port and the
tunnel's port. SpiceDB, the database and the NAT list its group as a client (`tests/plan.tftest.hcl` pins each).

### Not deployed

`oryxa-fde-ops replay-dead-events` is a one-off task nobody has needed to define. It reaches the database as the API does
(`Store::from_env`, `store/src/lib.rs:299`): IAM tokens when `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER` are all set (they win over
`DATABASE_URL`), else `DATABASE_URL` for local runs only; a half-set `DB_*` or a missing token stops startup. It also needs
`AWS_REGION` and `RUST_LOG`, and `rds-db:connect` as `oryxa_fde_api`.

### How the MCP server is reached

The server is for an FDE's own agent (ADR 0006: it stays read-only; `docs/direction.md`), which is **not a Cloudflare Worker**. That
decides the question: a Workers VPC service is reachable only from a Worker bound to it in this account, so an agent on a laptop or
in an FDE's own tooling cannot use one. Two options were compared (the first is the one this README used to propose):

| | Cloud Map plus a second Workers VPC service on the API's tunnel | A tunnel of its own, run as a sidecar in the MCP task (chosen) |
| --- | --- | --- |
| What it builds | A Cloud Map service and its instance, a security group rule from the API task to port 8081 and a second VPC service on the API's tunnel (`resolver_network`), **and then a Worker** that the agent calls and that proxies to the binding, with its route, its secrets and its deploy | One tunnel, its ingress rule and one proxied DNS record in Cloudflare, one secret for its token, and the sidecar in a task that already needs a task and a role of its own |
| Moving parts in AWS | Cloud Map instance, an ingress rule on the MCP task and an egress rule on the API's (the API's connector would reach into another service) | The same sidecar pattern as the API's (egress to the tunnel's port, the pinned image); nothing registered, no rule that admits traffic |
| Who an agent reaches | The gateway Worker's public name, which is then the thing to harden and to sign in to | `<mcp_hostname>` at Cloudflare's edge, the same server |
| Coupling | The MCP server is reachable only while the API task's connector runs, and the API's connector can reach the MCP server | None: each task has its own connector, and a deploy of one does not cut the other |
| Open question | Whether Workers VPC accepts a hostname resolved through the tunnel (the same as the API's loopback, Verify before apply) | None new: a tunnel's public hostname with an ingress rule is Cloudflare's long-standing feature, and the sidecar is the API's pattern |

**What is built:** a tunnel `oryxa-fde-dev-mcp` (remotely managed, token-run; the token is copied into
`cloudflared/mcp-tunnel-token` by hand, so it never passes through OpenTofu), one ingress rule, `<mcp_hostname>` to
`http://127.0.0.1:8081`, with `http_status:404` for any other name, and one proxied CNAME `<mcp_hostname>` to `<tunnel id>.cfargotunnel.com`.
The server listens on `127.0.0.1:8081` and its `MCP_ALLOWED_HOSTS` is `mcp_hostname` alone, so a request for another name (a rebinding
attack, the API's name) is refused by the server even if it got that far. Private here means: **no listener, load balancer, public
IP or inbound rule in AWS; reachable only through Cloudflare**, which terminates TLS. It does not mean unreachable from the internet
at Cloudflare's edge: the name resolves for anyone, and every request without a valid WorkOS access token (verified against WorkOS's
key set, the issuer pinned, as the API does) is refused by the server with `401` before MCP sees it. Cloudflare Access is not in
front of it (item 6 below).

**What is missing before an FDE's own agent can sign in.** Today the server accepts one thing: `Authorization: Bearer <a WorkOS
access token>` that the API would accept (a short-lived JWT: `oryxa-fde-api/src/auth.rs`). Nothing issues one to an agent. The
list, none of it built here (each is the API stream's or the lead's):
1. **OAuth for MCP** (the API stream). MCP clients sign in with the OAuth flow the MCP specification defines: a protected-resource
   metadata document (RFC 9728, at `/.well-known/oauth-protected-resource`) that names an authorization server, how a client registers
   with it, and a `WWW-Authenticate` challenge that points at the metadata on a `401`. The server serves none of it, so a stock MCP
   client cannot start, and whether WorkOS can be that authorization server for an agent is for the API stream to confirm. Until
   then a person can paste a token by hand, and it expires in minutes.
2. **The audience.** The server checks signature, issuer and expiry, and takes the tenant and user from the token (`from_bearer`);
   whether a token minted for another application of the same WorkOS client would be accepted needs a decision with the sign-in work
   (the resource indicator in OAuth for MCP is where it belongs).
3. **A health route.** The binary serves `/mcp` only, so `oryxa-fde-ops healthcheck` (which calls `/healthz`) cannot check it: the
   connector starts with the process, not when the server answers, and ECS replaces the task only when the process exits. A `/healthz`
   outside the token check (and a `healthcheck` on the MCP port) lets the task wait for it, as the API's does.
4. **A graceful shutdown**, as the API has: the server dies on SIGTERM with requests in flight (cloudflared drains first, so only a request
   already inside the server is cut).
5. **WorkOS's API key.** The binary builds a WorkOS client with the API's key but, as far as its code shows, only verifies tokens. A
   code change to not need the key would let the task drop that secret.
6. **Hostname and Access** (the lead). Which name: `mcp_hostname` is chosen explicitly per environment, one label under the zone like the other two, so it has the same certificate coverage (a name such as `fde-dev-mcp.<zone>` for dev). Whether to put Cloudflare Access in front: it would need a service-token
   or an identity policy that an MCP client can satisfy next to the WorkOS bearer token, which the sign-in design decides.
7. **Whether to switch it on at all** before 1, 2 and 8 are done. With it off nothing exists.
8. **Read-only by its login, not only by its code** (the API stream, then infra). ADR 0006 says the server stays read-only, and its tools
   only read, but `oryxa_fde_mcp` takes `oryxa_fde_app` per transaction (the store's `SET LOCAL ROLE`), which may insert, update and
   delete, and the SpiceDB pre-shared key it shares with the API may write relationships. A process taken over through the internet-facing
   name could therefore write customer rows and grants. Wanted before it is switched on: a select-only transaction role the store takes for
   this login, granted in `sql/01-bootstrap.sql` in place of `oryxa_fde_app`; SpiceDB stays shared until it has per-client keys.

**Turning it on** (only after the lead decides 6 and 7): (1) the image must already hold `oryxa-fde-mcp`: every `deploy-api` run from
the change that added it does, so run one first if none has; (2) set `enable_mcp = true`, plan and apply: this creates the tunnel, its ingress
rule, the DNS record, the secret `cloudflared/mcp-tunnel-token` and the task with its service (at 0 tasks until `start_services`, and one
task after: a task cannot start until its secrets have values, so ECS retries until the next step); (3) copy the new tunnel's token (output
`mcp_tunnel_id`: Zero Trust, Networks, Tunnels, `oryxa-fde-dev-mcp`) into that secret, as in Apply order step 6; if the service gave up
meanwhile, run `deploy-api`, which rolls the MCP service with the rest; (4) check that the task runs, that the tunnel shows healthy in the
Cloudflare dashboard and that `curl -i -X POST https://<mcp_hostname>/mcp` answers `401` (no token). There is no other path to the task: there
is no listener in AWS.

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
   file for step 6. Set `cloudflare_zone_name`, `web_hostname` and `admin_hostname` (and `mcp_hostname` before `enable_mcp`) as in Host names, and check the records first (Verify before apply: the names must be free in the zone). Leave `update_model` and `digest_from` unset (Not deployed: the lifecycle worker waits for a model).
   Read the repository's OIDC subject setting: `gh api repos/<owner>/<name>/actions/oidc/customization/sub`. If it
   answers `use_immutable_subject: true`, set `github_oidc_subject_prefix` to its `sub_claim_prefix`
   (`repo:<owner>@<owner id>/<name>@<repo id>`); otherwise leave it unset (Deploys: the deploy role's trust).
   Then run `tofu -chdir=infra/envs/dev plan -out dev.tfplan` and
   `tofu -chdir=infra/envs/dev apply dev.tfplan`. This creates the network, keys, the database (about
   10 minutes), the empty secrets, ECR, the cluster with every service at 0 tasks (SpiceDB, the API and the
   ingest worker), the queues, the event bus's delivery role, CloudTrail, the GitHub deploy role and its two SSM parameters (and the account's GitHub OIDC
   provider unless `github_oidc_provider_arn` is set), and on Cloudflare the DNS records, the
   tunnel, the VPC service and Access.
5. **Database bootstrap.** Run `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql`. It creates
   pgvector, the IAM logins (the API's, the workers' and SpiceDB's), their roles and the `spicedb` database, and is safe to
   re-run: **run it again after #130 on a database it already set up**, for the worker logins. It stops with an error if
   anything the API or a worker can reach has owner powers (Database logins). The script sends a SQL file without its
   comment-only and blank lines, which keeps it under the task override's limit; `tofu test` checks that every file in
   `infra/sql/` fits, measured that way.
6. **Secret values**, by hand from files you delete afterwards, never typed on a command line:
   `aws secretsmanager put-secret-value --secret-id oryxa-fde-dev/<name> --secret-string file://<file>`
   for each name in `tofu output secrets`. The SpiceDB key is random (`openssl rand -base64 32`), the
   WorkOS key comes from the WorkOS dashboard, and the event signing key is the private PEM of the pair
   made in step 4 (its public half is `event_public_key`, which the workers verify events with). In the WorkOS dashboard, register `https://<web_hostname>/auth/callback` as a redirect URI (the API sends the browser back to `<WEB_ORIGIN>/auth/callback`, `session.rs:362`); a mismatch fails the first sign-in. Copy the tunnel token from the Cloudflare dashboard
   (Zero Trust, Networks, Tunnels, `oryxa-fde-dev-api`; output `tunnel_id`). With a custom auth domain in WorkOS,
   `workos_issuer` must be that domain in `terraform.tfvars` before step 10's apply, or every sign-in is refused
   (Verify before apply: `WORKOS_ISSUER`); without one, leave it null. A person can sign in only as
   an active member of a WorkOS organisation with the role `admin` or `member`: add them there first.
7. **SpiceDB datastore.** Run `infra/scripts/run-task.sh spicedb-migrate` (`datastore migrate head`,
   IAM auth).
8. **`dev` variables.** Add the six variables to the `dev` environment (Deploys, below).
9. **Backend image and migrations.** Run the `deploy-api` workflow on `main`. It pushes the one backend image
   (the API, the ingest and lifecycle workers and the migrations' binary), runs the store's migrations as
   `oryxa_fde_migrator` in the migrate task, points the API service and the ingest worker's (both still at 0 tasks) at the
   image, and records the sha for OpenTofu. The same workflow rolls the workers on every later deploy (Deploys).
10. **Start.** Set `start_services = true`, then plan and apply. SpiceDB, the API and the ingest worker each start one
    task, on the sha `deploy-api` recorded (an apply after a complete deploy keeps it: Deploys, drift). The API task starts the API container first;
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
    shows healthy in the Cloudflare dashboard, `https://<web_hostname>` reaches the API through the
    binding, `<admin_hostname>` asks for an Access login, and CloudTrail delivers to its bucket.
    Then run stage A of the scripted smoke test (next section), and stage B, document search, with
    `SMOKE_WORKERS=1` (it skips otherwise, because the script cannot tell a missing worker from a slow one):
    `SMOKE_WORKERS=1 infra/scripts/smoke-test.sh b`. If stage B times out, look in this order: the subscriber exists
    (`aws eventsv2 list-subscribers`), the queue receives (`aws sqs get-queue-attributes`), the worker logs, the
    dead-letter queue.
15. **Company keys, before the first real customer data.** Set `company_key_operator_arns`, apply, and follow
    Company keys: provision each company's key, then (once the API names it on every write) set
    `require_company_keys = true`. The roles exist after step 4; no key does until you make one.

**The lifecycle worker, once a drafting model is chosen.** The founder's choice is recorded in ADR 0003 first
(Where prompts are processed). Then, in this order: (1) if the digest is wanted, verify the sender's address or domain in
SES in `aws_region` and request production access there (SES starts in a per-Region sandbox: it mails only verified
addresses, up to 200 a day); (2) set `update_model` (a `global.` profile) and, with it, `digest_from`, and apply: that creates the
worker's role, task definition and service, at one task when `start_services` is true; (3) run
`infra/scripts/create-subscriber.sh dev <account id> ap-south-1 lifecycle --replay`, which also delivers what the bus
kept of the earlier events (the handlers are idempotent). Create its subscriber only now: until the worker exists
nothing reads that queue, and a queue forgets a message after 4 days.

**The MCP server, once the lead has decided to expose it** (How the MCP server is reached lists the decisions): `enable_mcp = true`,
apply, put the new tunnel's token in `cloudflared/mcp-tunnel-token`, run `deploy-api`, and check as that section says. Until then nothing of it exists.

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
export SMOKE_BASE_URL=https://<web_hostname>             # exactly the web app's origin (the API's WEB_ORIGIN), for dev e.g. https://fde-dev.<zone>
export SMOKE_SESSION_FILE=~/.oryxa-smoke-session         # the session cookie, see below
infra/scripts/smoke-test.sh a                            # stage A, the core (the default)
SMOKE_WORKERS=1 infra/scripts/smoke-test.sh b            # stage B, once the ingest worker runs and its subscriber exists (Apply order, steps 10 and 12)
SMOKE_AGENT_REPO=<owner>/<repo> infra/scripts/smoke-test.sh c   # stage C, once the agent routes are on
SMOKE_COMPANY_KEYS=1 SMOKE_WORKERS=1 infra/scripts/smoke-test.sh k   # stage K, company keys: waits for an operator (Company keys)
SMOKE_WORKERS=1 SMOKE_AGENT_REPO=<owner>/<repo> infra/scripts/smoke-test.sh all
```

Stages run in the order given. B, C and K need a company (C a project too), so run alone they make their own; run
together they share one. `all` is A, B and C: K waits for a person, so it is named. Every run first checks health and `/v1/me`.

| Stage | Checks, in order |
| --- | --- |
| **A, core** | `GET /api/healthz` (no session); `GET /v1/me` (the session is accepted; prints the organisation and role); create a company; create a project (starts in `discover`); add a task; the task is on `GET /v1/today`; the stage checklist reads (`discover`); a move to `scope` with items open and no reason is refused (`409 rejected_checklist_open`), then the same move with a reason succeeds and the checklist now reads `scope`; the task is removed and gone from Today |
| **B, workers** | Upload a small Markdown document with a one-off code word; poll until `status` is `ingested` with chunks (a `failed` status stops it, and so does `SMOKE_INGEST_TIMEOUT`, default 180 s); search for the code word and find that document's passage |
| **K, company keys** | Needs `SMOKE_COMPANY_KEYS=1` (the API has `COMPANY_KEY_ALIAS_ARN_PREFIX`) and `SMOKE_WORKERS=1`. `GET /v1/companies/{c}/key` for the new company reads `false`; with `SMOKE_KEYS_REQUIRED=1` (`require_company_keys` is on) an upload is refused with `409 company_key_missing`; it prints the `company-key.sh provision` command for the tenant and company and polls the check until it reads `true` (`SMOKE_KEY_TIMEOUT`, default 300 s: you run `provision` meanwhile); then it runs B's upload, ingestion and search under the key |
| **C, agent** | List the project's agent runs (a `404` means the agent routes are off); start a read-only run on the sample repository (`SMOKE_AGENT_BASE`, default `main`); poll until events arrive and the run is `finished` (`SMOKE_RUN_TIMEOUT`, default 900 s) with a `result` as its last event. A run that fails, or waits for an approval (the test never approves), stops it and is cancelled |

**Skips.** B skips unless `SMOKE_WORKERS=1` (the script cannot tell a missing worker from a slow one, so you
say it is deployed; then a document that never ingests is a failure). K skips unless both `SMOKE_COMPANY_KEYS=1` and `SMOKE_WORKERS=1` are set. C skips without `SMOKE_AGENT_REPO`, and
when the agent routes answer a bare `404` (one with an error code fails). A skip prints `SKIP [stage] ...` and
exits 0 for that stage; the last line, `result: a=passed b=skipped ...`, tells passes and skips apart.

**The session.** The test signs in as the person who runs it, with the browser session cookie of a **test user in
a test organisation**: it creates a company in that organisation, and the user becomes its lead. Never use a
real customer's organisation or your own login.

1. In a private browser window, open `https://<web_hostname>` and sign in as the test user. Do not sign out
   until the run is over (sign-out ends the WorkOS session, and with it the cookie the script uses).
2. In the browser's developer tools, Application (Chrome) or Storage (Firefox), Cookies, `https://<web_hostname>`:
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
and one project (stage `scope`), a document after B or K (and, after K, the company's KMS key: retire it with `company-key.sh offboard`) and a finished run after C. The script prints their ids at
the end. They sit in the test organisation; do not point the script at an organisation anyone works in.

`infra/scripts/test-smoke-test.sh` proves the script without a deployed environment: it starts
`infra/scripts/smoke-stub.py` (answers the routes the script calls with canned responses, on a random loopback
port, stopped afterwards) and runs every stage against it (K included: a key that appears while it waits, one that never does, a company that already has one,
and an upload refused for want of a key): full passes, failures in the middle (cleanup), an
interrupt, the skips, a session that rotates mid-run, and the session hand-over checks, including `bash -x` and
a verbose `~/.curlrc`. It needs `bash`, `curl`, `jq` and
`python3` only.

## Company keys

ADR 0003's amendment, issue #109, and the gate in ADR 0006: **no real customer data enters the product until
the company it belongs to has its own KMS key.** Nothing here is applied. The API names a company key on every write
(#166, #176) and the deployed tasks are wired for it (#183); `require_company_keys` stays `false` until the checks in
Before `require_company_keys` is switched on pass, so dev keeps working on sample data.

### What the code does today

Read from `crates/` at `5ce29b1`; the last bullet again at `514d528`, after the API named company keys (#176):

- **Object keys.** `<tenant>/<company>/documents/<id>` and `<tenant>/<company>/canvas/<id>`
  (`oryxa-fde-context/src/blob.rs:25`, `:30`, `:36`). Both ids are validated types: `[A-Za-z0-9_-]`, a tenant up to 64,
  a company up to 128, so neither can hold `/`, `*` or `?`. The code never lists or deletes.
- **Who writes and reads.** The API's task role writes and reads (`blob.rs:65`, `:81`: `put_object`, `get_object`; a
  document is one `PutObject`, 20 MiB at most, `lib.rs:26`; there is no multipart upload). The ingest worker will read
  (`oryxa-fde-context/src/ingest.rs:60`, `blobs.get`). The MCP server does not: none of its tools reads a file (oryxa-fde-mcp).
- **How it names a key.** *(Changed by #176; the text at `5ce29b1` was "it does not".)* With
  `COMPANY_KEY_ALIAS_ARN_PREFIX` set, `put` first asks whether the company has a key (`context/src/keys.rs`, `has_key`); if so it sends
  `aws:kms`, the company's alias ARN (`<prefix><company>`, a validated `CompanyId`) and `bucket_key_enabled(false)`
  (`blob.rs:131`); if not it sends no encryption header (SSE-KMS without a key id would mean the account's `aws/s3` key), so the
  bucket's default applies, the environment key with an S3 Bucket Key, until `require_company_keys`, when S3 refuses that write and
  the API answers `409 company_key_missing`. With the variable unset, as before #183, no key is ever named.

### How provisioning runs, and why

**An operator runs `infra/scripts/company-key.sh`** (`provision`, `status`, `sync`, `offboard`), the way they run
`create-event-bus.sh` and `run-task.sh`. The standing parts (the two roles that may run it, the policy every key
gets, the bucket's write rules) are OpenTofu in `modules/company_keys`, and the script reads them from
`tofu output -json company_keys`, so the policy is written once and `tofu test` pins it.

Why not the other two ways:

- **One OpenTofu resource per company** means an apply per customer, a customer list in tfvars, and an offboarding
  that is a deleted line in a diff. A company is created by a user at run time; the infra state should not
  follow it.
- **A one-off ECS task** needs an image with the AWS CLI, a task definition and a task role that can create keys,
  for the same operator-run step, and adds nothing the script lacks. When creating companies is frequent, the way to automate this is a worker (not the API) that holds the provisioning role and acts on
  the company-created event: the provisioning identity below is made for that, and its trust list already takes a task
  role.

What the script guarantees, and `test-company-key.sh` proves against a fake `aws`:

- Ids are checked against `[A-Za-z0-9_-]{1,128}` before anything else, so there is no AWS call for a bad one.
  The script takes no raw string from a request; the tenant and company come from the operator's command line, and
  reach the policy, the alias and the tags only after that check.
- It refuses any account but the one in the config (`account_id`, from `data.aws_caller_identity`), and
  refuses to run as the wrong role: `provision` as the provisioning role, `offboard` as the offboarding role.
- **Idempotent.** An existing alias is checked, never changed: the key must be a single-Region symmetric
  customer managed key, tagged for this environment, this tenant and this company (an alias that points at another
  company's key is refused), enabled, with the current policy. With `company_key_rotation` on, rotation switched off
  is switched back on; with it off (the default), rotation is left as it is.
  A changed policy is reported, and `sync` (an administrator, not the provisioner) puts it.
- `--dry-run` makes the reads and prints what it would write. It writes nothing.
- A key created and not yet named (the alias call failed) is reported with the command that finishes the job.
  A re-run would make a second key.

```bash
# once per apply, then per company:
tofu -chdir=infra/envs/dev output -json company_keys > "$XDG_RUNTIME_DIR/company-keys.json"   # ARNs and a policy, no secret
# assume the provisioning role (tofu output company_keys: provisioner_role), then:
infra/scripts/company-key.sh provision "$XDG_RUNTIME_DIR/company-keys.json" <tenant id> <company id> [--dry-run]
infra/scripts/company-key.sh status    "$XDG_RUNTIME_DIR/company-keys.json" <tenant id> <company id>   # 0 enabled, 3 none, 4 other
# assume the offboarding role, then:
infra/scripts/company-key.sh offboard  "$XDG_RUNTIME_DIR/company-keys.json" <tenant id> <company id> --confirm <tenant>/<company>
```

### The key policy, in words

Every company key gets this policy, with the tenant and company filled in (`modules/company_keys`, `key_policy`):

- **Use only through S3, by the serving roles.** The API's task role (and each reader role added later) may
  `kms:Decrypt` (the API also `kms:GenerateDataKey`) only with `kms:ViaService` = `s3.<region>.amazonaws.com`, from this
  account, and only with the encryption context `aws:s3:arn` matching `arn:aws:s3:::<bucket>/<tenant>/<company>/*`.
  S3 sends the object's ARN as the context when no Bucket Key is used, so **this company's key cannot encrypt or
  decrypt another company's object**, even for a role that may read both.
- **The account administers the key and cannot use it.** The account root may describe, read, tag, name, rotate and
  `PutKeyPolicy`, and nothing else, so no IAM policy can grant use. An explicit Deny closes use outside S3 and every
  grant for everyone, the root included.
- **Deletion belongs to the offboarding role.** Only it may schedule deletion, cancel it or disable the key (an
  explicit Deny for everyone else), and a wait under 30 days, the longest KMS allows, is denied for all.
- Tags: `project=oryxa-fde`, `env`, `purpose=company-data`, `tenant`, `company`. Alias:
  `alias/oryxa-fde-<env>/companies/<company>`. Rotation off unless `company_key_rotation` is on. Waiting period 30 days.

The serving roles are named in each key's policy when the key is made, so a role has to exist first, and a role
that is replaced (a new role with the same name has a new id) or added needs `company-key.sh sync`
for each company that has a key. **Run `sync` once per existing company after a reader role is added** (the ingest
worker's, which `envs/dev` adds to `company_key_reader_role_arns` itself, is the only one today: the MCP server reads no
file): a key made before the apply keeps its old policy until then, and its documents stay unreadable to that role. Keys made
after the apply already name it, and before the first key exists there is nothing to sync.

**The two identities**, both assumed by the operators in `company_key_operator_arns`, for an hour. That list is
the founder's admin role only, to start (the lead's decision, 10 November 2026; no MFA condition for now): whoever
is in it can make and retire company keys, so add a person only as you would give them account administration.

| Role | May | May not |
| --- | --- | --- |
| `oryxa-fde-<env>-company-key-provisioner` | `kms:CreateKey` and `kms:TagResource` with exactly the five tags and `tenant` and `company` present, symmetric and single-Region only; `kms:CreateAlias` on `alias/oryxa-fde-<env>/companies/*` and only for a key tagged as this environment's company key; reads of those keys, and `kms:EnableKeyRotation` only when `company_key_rotation` is on | use a key, `PutKeyPolicy`, update or delete an alias, disable, schedule deletion, create a grant, `kms:*` |
| `oryxa-fde-<env>-company-key-offboarder` | `kms:ScheduleKeyDeletion` (30 days or more) and `kms:CancelKeyDeletion` on company keys of this environment; reads | create, tag, use |

The provisioner can fill the company alias namespace with company keys and nothing else, which is what lets the
bucket policy trust that namespace. Two limits on that: `CreateKey` takes its key policy from the caller and KMS has
no condition key on a policy's content, so the provisioner chooses the policy a new key starts with (`provision`
puts the one from the config and checks it, and `provision` and `sync` refuse or replace any other); and an account
administrator can also create aliases there. The namespace is as trustworthy as the operators and the
administrators.

### The bucket policy, in words, and what it cannot do

A bucket policy is one static document. It cannot take the company out of the object key and compare it with
the key a write names, and one statement per company would pass S3's 20 KB policy limit at about 50 companies.
So the rules are split:

- **The bucket policy** (`modules/company_keys`, `bucket_policy_statements`, added to `modules/s3`) refuses a
  `PutObject` that names a key outside `arn:aws:kms:<region>:<account>:alias/oryxa-fde-<env>/companies/*`: the
  environment key (by ARN, id or alias), another account's key and `aws/s3` are all refused when named, because the only
  string that passes is an alias in the namespace the provisioner fills. (While `require_company_keys` is false, a
  write that sends `aws:kms` with no key id gets `aws/s3` from S3: sample data only, and refused once keys are required.) It also refuses SSE-S3. With
  `require_company_keys = true` it refuses a write that names no key at all, which means the environment key by
  default, and any value but `aws:kms`.
- **The key's own policy** is what ties a company's key to its prefix (above): a write under company B's prefix
  that names company A's alias passes the bucket policy and is refused by KMS, because A's key allows only A's
  prefix. This is why the API must write company objects **without an S3 Bucket Key** (`bucket_key_enabled(false)`):
  with one S3 sends the bucket's ARN as the context, and the key policy refuses it (an object would have no per-prefix
  binding). The cost is below.
- **It cannot lock the environment out.** The rules deny `s3:PutObject` only: nothing is denied on reads, so every
  object written under the environment key stays readable, by the API role that keeps `kms:Decrypt` on it.
  The bucket default stays the environment key with a Bucket Key. Changing the policy needs no object write, so
  turning `require_company_keys` back to `false` and applying always repairs a mistake. The statements apply to
  every object in the bucket, not only the company shape, so a stray write elsewhere is refused too.
- **Objects written before a company has a key stay under the environment key**, and offboarding cannot make
  them unreadable. That is why `require_company_keys` must be on before real data: with it on, no such object
  can be written.

### A company without a key

| | `require_company_keys = false` (dev today) | `true` (before the first real engagement) |
| --- | --- | --- |
| Write that names no key | lands under the environment key: sample data only | refused by S3 (`AccessDenied`) |
| Write naming a company alias | allowed if the alias exists and the key policy allows it | same |
| Write naming anything else | refused | refused |
| Read of an older object | works | works |
| API role on the environment key | `Decrypt`, `GenerateDataKey` | `Decrypt` only |

The API must not rely on S3 to find out: it checks first (next section). ADR 0006's generic routes (webhook bodies,
results uploads, forwarded email, pasted notes) and every route that stores customer content in S3 are switched on
for a company only when that check passes.

### For the API stream (and the ingest worker)

Done in #166 (PR #176); the text below is what was asked, kept as the contract the code is read against. Infra's half is #183: the
prefix on the API's and the ingest worker's tasks, and the lookup grant (How the API's key check is authorised).
`require_company_keys` is switched on by the lead only after the deployed checks below pass.

1. **Name the company's key on write** (`oryxa-fde-context/src/blob.rs`, `S3Blobs::put`):
   `put_object().server_side_encryption(ServerSideEncryption::AwsKms).ssekms_key_id(<alias ARN>).bucket_key_enabled(false)`,
   where the alias ARN is `<prefix><company>` and the company is the `CompanyScope`'s validated `CompanyId`, never a
   raw string. The prefix is new API config, `COMPANY_KEY_ALIAS_ARN_PREFIX`, equal to the output
   `company_key_alias_arn_prefix`
   (`arn:aws:kms:<region>:<account>:alias/oryxa-fde-<env>/companies/`). Infra adds the variable to the API's task and to the
   contract table in the same PR that makes the code read it. `put` needs the scope, so `BlobStore::put` takes it
   (or a resolved key reference). The API reads with `get_object` as now: S3 knows the object's key.
2. **How a company is marked as having a key: the alias.** `kms:DescribeKey` on `<prefix><company>` (the key's policy
   lets the API's role do it): the company has a key when the call succeeds, `KeyMetadata.KeyState` is `Enabled`, and
   `KeyUsage` is `ENCRYPT_DECRYPT`. **Every other outcome means no key** (not found, access denied, throttled, a key
   pending deletion or disabled): fail closed. Cache a yes for about a minute and a no for a few seconds. A key that
   is scheduled for deletion cannot be used from that moment, so a cached yes can only cost one failed write.
   Put it in `oryxa-fde-context` beside `BlobStore` (a `CompanyKeys` trait with an S3/KMS implementation and a
   fake), and call it before any route stores customer content in S3 or switches a generic inbound route on (ADR 0006).
   `company-key.sh status` is the same check for an operator.
3. **When it is missing:** refuse the request with a stable error (a 409 `company_key_missing`), store nothing, and do
   not retry. Sample data may still use the environment key while `require_company_keys` is `false`, if the company is
   marked as sample data only.
4. **Map the S3 and KMS failures.** `AccessDenied` on `put` under `require_company_keys` and a KMS
   `DisabledException` or `KMSInvalidStateException` on a read mean the company has no key, or has been offboarded: a
   permanent error, not a retry.
5. **The ingest worker** reads only: no change to `BlobStore::get`. Its task role is already in every key's reader list
   (#171), so only `sync` for each company with an older key is left. The worker treats the
   errors in 4 as permanent for that event (quarantine it, like any event it can never process). It never writes S3.
6. **Offboarding**: the operator runs `offboard`; the API's check in 2 turns the company off within the cache time.
   Deleting the company's rows and permissions is the API's, as ever.

### How the API's key check is authorised

The check is `kms:DescribeKey` with the company's alias ARN as the key id (`context/src/keys.rs`, `describe`). What IAM and KMS
do with that, from the AWS KMS developer guide (read 10 November 2026: "Use aliases to control access to KMS keys", "KMS key access
and permissions", the permissions reference, and the `DescribeKey` reference, "Required permissions: kms:DescribeKey (key policy)"):

- **The permission is evaluated against the key the alias points to**, by the key's policy, not against the alias. An alias ARN
  as an IAM `Resource` "applies to the alias resource, not to any KMS key that might be associated with it": no IAM statement can
  say "the key behind this alias". The ways to scope an IAM grant by alias are the condition keys `kms:RequestAlias` (the alias
  named in the request, as a name pattern, never an ARN) and `kms:ResourceAliases` (the aliases the key has), on a
  `key/*` resource; the tag form is `aws:ResourceTag/purpose` and `/env` on `key/*`, as the provisioner's policy uses.
- **So for a company that has a key, nothing in the API role's IAM policy is needed or granted.** Every company key's policy
  already allows the API's role `kms:DescribeKey` (`ServingRolesCheckTheKeyExists`, #164; `tests/company_keys.tftest.hcl` pins the
  statement), and a same-account principal named in a key policy needs no IAM grant. **The key policy is unchanged by #183**, so there is
  no `company-key.sh sync` to run for this change. (`sync` is still needed after a serving or reading role is added or replaced, as
  above: the ingest worker's role, #171, for any key made before it.) What this reaches: the API's role can describe every company key
  of the environment, by alias or key ARN: key state, spec, dates, no policy, no tags and no use. It cannot describe any other key in the
  account, because no IAM statement of its role grants `DescribeKey` on a key and no other key's policy names it (the account root's
  `kms:Describe*` on a company key lets IAM grant, and the API's role has no such grant).
- **For a company that has no key** the alias does not exist and KMS has no key to authorise against. #183 adds
  `kms:DescribeKey` on `arn:aws:kms:<region>:<account>:alias/oryxa-fde-<env>/companies/*` (statement `LookUpCompanyKeyAliases`) for that
  case, the same form as the provisioner's `LookUpTheCompanyAliases`. **By AWS's documentation it grants nothing:** the KMS developer
  guide's permissions reference lists `DescribeKey` with the resource "KMS key" only, and the alias resource only for `CreateAlias`,
  `DeleteAlias` and `UpdateAlias`. It is kept because it is harmless (an alias resource, one action, this environment's company aliases
  only: it reaches no key and allows no other call) and because what KMS answers for an absent alias is not documented either way. If KMS
  answers `NotFoundException`, the check reads "no key" quietly; if `AccessDenied`, it also reads "no key", with a warning in the API's
  log on every check (the cache keeps a no for 5 seconds). Step 3 of Before `require_company_keys` is switched on shows which; neither is
  unsafe, and an `AccessDenied` there is not fixed by any IAM grant (see Verify before apply).
- **Why not `key/*` with a tag condition for the API**, the narrowest IAM form that reaches keys: it would repeat what the key
  policy grants, and add a second place where the list of describable keys lives. It is also not narrower than the key policy's
  statement, which names the API's role on keys this script made and on nothing else. **A tighter form exists and is not used:** a
  `kms:RequestAlias` condition on the key policy statement would limit a describe to the key's own alias name. Whether a request that names
  the alias by ARN satisfies an exact alias name there is not documented (AWS's example matches a pattern), and a wrong guess makes every
  check answer no, so the key policy stays as reviewed in #164.

The ingest worker gets none of this: its IAM policy has `kms:Decrypt` on the environment key through S3 only, and each key's policy
gives it `kms:Decrypt` through S3 under any company's prefix and no other action (`ReadingRolesDecryptThroughS3`; `tests/plan.tftest.hcl` pins
its action list). No describe, no `GenerateDataKey`, no write. The MCP server has no KMS permission at all.

### Before `require_company_keys` is switched on

Run these in order, in a deployed environment, with **sample data only**: a test organisation and a company made by the smoke test
(Smoke test; `T` is its organisation's id, which `/v1/me` returns and stage K prints, and `C` the company). Each step says what a
pass looks like; stop at the first that does not pass and read its "if not". `<cfg>` is the file from
`tofu -chdir=infra/envs/dev output -json company_keys` (How provisioning runs, and why). The first six change nothing that stops dev working; step 7 is
the switch itself.

The order differs from the issue's list in one place: provisioning comes first, because the S3 and KMS checks need a company key to write under.

1. **The wiring is on the tasks and the API started.** After the apply and once the services run the new task definition revisions (the
   apply, or the next `deploy-api`, Deploys):
   ```bash
   for f in api:oryxa-fde-dev-api ingest:oryxa-fde-dev-ingest; do
     aws ecs describe-task-definition --region <region> --task-definition "${f#*:}" |
       jq -r --arg c "${f%%:*}" '.taskDefinition.containerDefinitions[] | select(.name == $c) | .environment[] | select(.name == "COMPANY_KEY_ALIAS_ARN_PREFIX") | .value'
   done
   tofu -chdir=infra/envs/dev output -raw company_key_alias_arn_prefix
   aws ecs describe-services --region <region> --cluster "$(tofu -chdir=infra/envs/dev output -raw cluster)" --services oryxa-fde-api oryxa-fde-ingest \
     --query 'services[].[serviceName, length(deployments), deployments[0].status, deployments[0].rolloutState, deployments[0].taskDefinition, runningCount]'
   ```
   Pass: three identical lines ending `:alias/oryxa-fde-dev/companies/`; each service has one deployment, `PRIMARY` and `COMPLETED`, on the
   latest revision of `oryxa-fde-dev-api` or `oryxa-fde-dev-ingest` (the one the first command read), with tasks running; and `infra/scripts/smoke-test.sh a` passes. The deployment check matters: a
   malformed prefix, or one in another Region than `AWS_REGION`, stops the new tasks at start while the old ones keep serving, so the smoke test alone
   would pass. If not: the log group `/ecs/oryxa-fde-dev-api` (or `-ingest`) names `COMPANY_KEY_ALIAS_ARN_PREFIX`.
2. **Keys that already exist have the current policy.** For every company that already has a key, as an administrator:
   `infra/scripts/company-key.sh sync <cfg> <tenant> <company>`. Pass: `... already has the current policy`. (None in dev until step 4. #183 changes no key
   policy, so this is only for a key made before the ingest worker's role was added, #171.)
3. **A company with no key reads as no key, quietly.** Pick a company that has none (the smoke test's, `C`):
   `GET /api/v1/companies/C/key` through the app. Pass: `{"has_key":false}`, and none of
   `aws logs filter-log-events --region <region> --log-group-name /ecs/oryxa-fde-dev-api --filter-pattern '"company key check failed"' --start-time $(( ($(date +%s) - 600) * 1000 ))`
   names `C`. If not: the log line's `code` is `AccessDenied`: KMS answers a lookup of an absent alias with a denial, which no IAM grant changes (AWS
   documents no alias resource for `DescribeKey`). The API still reads it as no key, so nothing is unsafe, only noisy; but expect `provision` in step 4 to
   stop at its lookup for the same reason, and apply the fallback in Verify before apply (The API's key check) first.
4. **Provision a key for the sample company, and the API sees it.** As the provisioning role: `infra/scripts/company-key.sh provision <cfg> T C`;
   then `GET /api/v1/companies/C/key` within about ten seconds. Pass: `provision` ends `... is provisioned`, `status` exits 0, and the check answers `{"has_key":true}`.
   If not and it stays false: the log line's `code` says why (`AccessDenied` on a key that exists means the key's policy does not
   name the API's role: `sync`; `KMSInvalidStateException` or disabled: the key is not enabled).
5. **An upload and its ingestion succeed under that key** (this is also where S3 is shown to accept the alias ARN in the bucket policy's
   key condition, to let a request turn the Bucket Key off, and to hand KMS the object's ARN as the encryption context). Upload a small sample
   document to `C` through the app, or let the smoke test's stage K do steps 3 to 5 in one run: it makes a company, checks it has no key, prints the `provision`
   command of step 4 and waits for it while you run it, then uploads and waits for ingestion: `SMOKE_COMPANY_KEYS=1 SMOKE_WORKERS=1 infra/scripts/smoke-test.sh k`.
   Then, as an administrator:
   ```bash
   aws s3api head-object --region <region> --bucket <data bucket> --key T/C/documents/<document id>
   aws cloudtrail lookup-events --region <region> --lookup-attributes AttributeKey=EventName,AttributeValue=GenerateDataKey --max-results 10   # events lag by up to 15 minutes
   ```
   Pass: the upload answers `201`, the document reaches `ingested` and a search finds it (the ingest worker decrypted it through its reader entry);
   `head-object` shows `ServerSideEncryption` `aws:kms`, `SSEKMSKeyId` the company key's ARN (not the environment key's), and no `BucketKeyEnabled`
   (or `false`); the CloudTrail `GenerateDataKey` by the API's role has `requestParameters.encryptionContext["aws:s3:arn"]` equal to
   `arn:aws:s3:::<data bucket>/T/C/documents/<document id>` (the object, not the bucket). If not: an upload that is `AccessDenied` from S3 means S3
   compares the resolved key ARN rather than the alias in the bucket policy; an `AccessDenied` that names `kms:GenerateDataKey` means the key policy's
   context condition did not match (a Bucket Key was in play): the two fallbacks are in Verify before apply, and neither is applied before the checks are understood.
6. **A write naming company A's alias under company B's prefix is refused by KMS.** This cannot be driven through the API: it builds the alias and the
   object key from one `CompanyScope`, so they always name the same company, and the only other client is a deliberately broken one. An operator cannot make the
   write directly either: only ECS tasks may assume the API's role (its trust says so, and the image has no shell or AWS CLI), and widening that
   trust for a test is a change for the lead, not for this step. What stands in for it: the key policy's context condition
   (`kms:EncryptionContext:aws:s3:arn` on `<bucket>/<tenant>/<company>/*`, with `kms:ViaService`) is pinned by `tests/company_keys.tftest.hcl` for every key; step 4 checks that a real key
   has the current policy (`provision` compares it); and step 5 shows the precondition the condition relies on, that S3 sends the object's ARN as the context.
   Together they say a write under B naming A's key is refused whenever S3 behaves as documented. **It is not exercised end to end, and only a real
   refusal would show it**: the first time an API build writes under the wrong alias, or a test role added to one key's policy by an administrator for the purpose.
   Follow-up, not a gate for step 7: an operator can run the negative test without widening any trust, as a one-off task in the private subnets with
   an image that has the AWS CLI (pinned by digest) and `taskRoleArn` overridden to the API's task role (ECS may assume it; the operator needs `iam:PassRole`
   on it). Its one call, a sample `put-object` to `T/B/documents/...` naming A's alias with `--bucket-key-enabled false`, must fail with `AccessDenied`
   from KMS; if it succeeds it writes one sample object and shows the hole. That is a new `run-task.sh` command and task definition, an infra issue.
7. **Switch on, then check the refusals** (still sample data). Set `require_company_keys = true`, plan (the bucket policy gains `DenyWriteWithoutCompanyKey` and
   `DenyWriteNotUsingKms`; the API role loses `kms:GenerateDataKey` on the environment key), apply. Then:
   - a company with no key is refused by the API: `SMOKE_KEYS_REQUIRED=1 SMOKE_COMPANY_KEYS=1 SMOKE_WORKERS=1 infra/scripts/smoke-test.sh k` passes
     its first half (`an upload without a key is refused (company_key_missing)`) and, once the operator step is done, its second;
   - the bucket policy refuses a write that names no key or the environment key, for any caller. As an administrator, once with no encryption option and once with
     `--server-side-encryption aws:kms --ssekms-key-id <the environment key's ARN>`: `aws s3api put-object --region <region> --bucket <data bucket> --key T/C/documents/refused-sample --body /dev/null [options]`.
     Pass: `AccessDenied`, and for these two the message says "explicit deny in a resource-based policy" (the bucket policy, not a lack of rights), and
     `head-object` on that key is `404`. Before the switch the first one succeeds and writes a (sample) object, which is the difference this step shows;
     a delete marker removes it from view and leaves the version.
   If not: set `require_company_keys` back to `false` and apply: it repairs a mistake, since nothing is denied on reads.

After step 7 passes, `require_company_keys` stays `true` and real customer data may follow, ADR 0006's generic routes included, one company at a time as each gets its key.

### Cost

Mumbai list prices, read on 10 November 2026 from the public price list (AWSKMS offer, published 8 November,
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/awskms/current/ap-south-1/index.json`):
**$1 per customer managed KMS key version a month** (prorated by the hour), requests **$0.03 per 10,000**, and 20,000
requests a month free for the account. Automatic rotation adds a key version a year, and AWS charges the first and
second rotation of a key, then no more ("Key rotation and pricing", the KMS developer guide, read the same day).

| Companies with a key | Keys a month, rotation off (the default) | With rotation on: after the first rotation | With rotation on: from the second rotation | Requests at 5,000 a company a month |
| --- | --- | --- | --- | --- |
| 10 | $10 | $20 | $30 | $0.09 |
| 100 | $100 | $200 | $300 | $1.44 |
| 1,000 | $1,000 | $2,000 | $3,000 | $15 |

The request volume is an assumption, one KMS call per object write or read, because company objects use no S3 Bucket
Key (so the key policy can bind a key to its prefix); at 100,000 requests a company a month, 1,000 companies would be
$300. KMS requests also show up in CloudTrail's management events, one per object access, naming the company's key and
the object: the per-company audit trail the keys are for. Rotation is off (`company_key_rotation`, the lead's decision,
10 November 2026), which keeps $1 a key a month: rotating triples key cost at scale for little gain on S3 object data.
It can be switched on per environment later. A key
pending deletion is not documented as free in the price list, so **assume it is billed until it is deleted**
(not rechecked). KMS allows 100,000 keys a Region by default (adjustable). Nothing is billed until the first key
exists.

### Limits

- `ponytail:` provisioning is one operator command per company; automate it with a worker that holds the
  provisioning role once companies are created often. Until then a company created in the app has no key, and the API
  stops it from taking real data.
- `ponytail:` a company is identified by its id alone in the alias (ADR 0003). The API generates company ids at
  random, so two tenants do not collide; if one ever did, the second `provision` refuses (the tags name the other
  tenant) instead of sharing a key.
- An account administrator can still rewrite a company key's policy (`PutKeyPolicy`) or the bucket policy: the
  controls stop the roles in this design, not an administrator. CloudTrail records it.
- After `ScheduleKeyDeletion` KMS refuses every use, but S3 "might not immediately" stop serving a data key it
  has cached (the KMS developer guide says so for data keys). With no Bucket Key the exposure is short; the check
  after the first real offboarding is a read that must fail.
- Objects written before a company's key exists stay under the environment key (above).
- The bucket policy cannot see the object key's company segment. A write under B naming A's alias is refused by KMS,
  not by the bucket policy; if the key policy's encryption-context condition ever stopped working, the bucket policy alone
  would not stop it.

## Deploys

Two manual workflows, `workflow_dispatch` only, from `main` only, for `dev` only: every job that
deploys runs in the GitHub environment `dev`, and nothing else can use its credentials. Run them
from the Actions tab on `main`; on any other branch their jobs are skipped.

| Workflow | Does | Uses from `dev` |
| --- | --- | --- |
| `deploy-api` | Builds the backend binaries (`oryxa-fde-api`, `oryxa-fde-ops`, `oryxa-fde-ingest`, `oryxa-fde-lifecycle`, `oryxa-fde-mcp`) for `linux/arm64` into one image, pushes it to ECR, runs migrations as the one-off migrate task, then rolls the API service and then each deployed worker onto it (the tunnel sidecar included in the API's new task; its image does not change) | `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN` |
| `deploy-workers` | `wrangler deploy` for `sandbox/gateway` and `realtime/` (skipped until it exists), then `fde-web` with dev's route and API binding | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `WEB_HOSTNAME`, `API_VPC_SERVICE_ID`; optional `WEB_OWN_SIGN_IN` |

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
  | `WEB_OWN_SIGN_IN` | Optional. `1` builds fde-web with `VITE_FDE_OWN_SIGN_IN=1` (our own sign-in screens, ADR 0007); unset or any other value leaves them off |
- **Environment secret** `CLOUDFLARE_API_TOKEN`, on `dev` only, never a repository secret: a token
  for this account and zone only, with Account: Workers Scripts Edit and Containers Edit (the
  gateway's sandbox image), and Zone: Workers Routes Edit. Not the OpenTofu token. Only the
  `wrangler deploy` steps see it; installs (`npm ci --ignore-scripts`) and builds run without it.

There is no AWS key anywhere. The `deploy` job of `deploy-api` gets a one-hour session for
`oryxa-fde-dev-github-deploy` through GitHub OIDC. Its trust needs both claims to match exactly:
`sub` is `<github_oidc_subject_prefix>:environment:dev` (the prefix is `repo:<github_repository>` unless the variable
is set; with GitHub's immutable subject on, `repo:<owner>@<owner id>/<name>@<repo id>`), and `job_workflow_ref` is
`<github_repository>/.github/workflows/deploy-api.yml@refs/heads/main`. So no other workflow, branch
or environment gets in, even before the environment's branch rule exists. `deploy-workers` needs no
AWS access and cannot assume it. The role may push to the `oryxa-fde-api` repository, register task
definitions that run as the task and execution roles of the API, the migrate task and each deployed worker only
(`iam:PassRole` names exactly those, to ECS tasks only; registering takes no resource, so that is the limit), run the
migrate task, update and describe the services of the API and of each deployed worker (the lifecycle worker's once it
exists), and read its deploy parameters (`tests/plan.tftest.hcl` pins all of it). It cannot touch SpiceDB, the one-off
db-admin and zed tasks, or any role outside that list. (The MCP server's service and roles join the list only with `enable_mcp`.)

**The image: one, with several entrypoints** (#130). The API, `oryxa-fde-ops`, the two queue workers and the MCP server ship in one image,
in the one ECR repository (still named `oryxa-fde-api`; renaming it would mean a new repository, its state and the deploy
role's grants for no gain). Each task definition picks its binary with `entryPoint` (the API is the default; the
migrate task already did this). Why one and not one per binary:

- **One version of the truth.** The API, the workers and the migrations share the store and events crates, and the schema
  and the event types change together. One commit builds one image, so the migrate task and every service run the same
  sha and cannot disagree. Five images could drift to five tags, and each drift is a failure that only shows at run time.
- **One build, one pipeline.** `cargo build` compiles the shared crates once for the five binaries (the release build is
  clean on a fresh runner every time, `docs/ci.md`), where five builds would compile them five times. One repository, one lifecycle
  policy, one image tag in SSM, one set of push permissions on the deploy role.
- **What it costs.** Each task carries binaries it never runs (a few tens of MB).
  That is no new permission: the task role, its entrypoint and its security group decide what a task can do, and an image holds
  no credentials. If a worker ever needs a different base or its own release rhythm, it gets its own repository then.

**One deploy brings the API and the workers to one image** (#165). `deploy-api` registers a new revision of the API's, the
migrate task's and each worker's task definition, runs the migrations, and rolls the API and then each worker onto the
sha it built, so they never run different versions for longer than the deploy takes. Order: migrations, the API, then the
workers (ingest, then the lifecycle worker and the MCP server when they exist). The migrations come first because they run before any
service changes and must work for the image still running (add first, remove in a later deploy). The API comes before
the workers because the API writes the events and the workers read them: an event may gain a field (the decoders ignore
unknown fields) but not lose or rename one under the same detail type, so a worker still on the old image reads what
the new API writes. The other order, a new worker reading what the old API writes, is no safer: it has to read the events
already queued from before the deploy either way. A migration must keep working for the workers' old image too, which is
running while the API rolls.

**deploy-api, step by step**
1. `build`, a release build, so never with shared caches (`docs/ci.md`): on a clean
   GitHub-hosted runner, with the toolchain `rust-toolchain.toml` pins, no sccache and a fresh
   `CARGO_HOME`, it cross-compiles the backend binaries for
   `aarch64-unknown-linux-gnu`; it builds all five binaries. It fails if any needs a newer glibc than the image's base (2.41).
2. `deploy`, hosted, in `dev`: reads `/oryxa-fde-dev/deploy` (names, subnets, the migrate task's
   security group; written by OpenTofu) and pushes the image tagged with the commit sha. Tags are
   immutable: a sha already in ECR is reused.
3. Registers new revisions of `oryxa-fde-dev-migrate`, `oryxa-fde-dev-api` and of each worker in the deploy
   parameter's `workers` list (`oryxa-fde-dev-ingest`, then `-lifecycle` only while `update_model` is set, then `-mcp` only while
   `enable_mcp` is) that differ
   from the current ones only in the image, so env, secrets and roles stay as OpenTofu set them. The API task
   also holds the cloudflared sidecar (#145), so for each family it swaps the image of the one container that runs
   the ECR repository's image and stops if that is not exactly one (zero or several: nothing is guessed). All of them are
   registered before anything changes, so a family that fails the rule stops the deploy before the migrations run.
   A worker that is not deployed is not in the list, so it is skipped by configuration, and no error is swallowed.
4. Runs the migrate task and stops on a non-zero exit, before any service changes. Migrations must
   therefore work with the image still running (add first, remove in a later deploy).
5. Updates the API service and waits for it to settle (the new task's `api` container must pass its health
   check; "What the load balancer gave", below), then does the same for each worker in turn, one at a time. Each wait is
   bounded: the AWS CLI's waiter polls every 15 s and gives up after 40 tries, 10 minutes, and a service that does not
   settle on its new revision (the circuit breaker rolled it back, which also reads as stable, so the workflow checks the
   primary deployment) fails the deploy. A service at 0 tasks (`start_services = false`) reads as stable at once while its
   rollout is still `IN_PROGRESS`, so that check polls every 5 s for up to 2 minutes until the primary deployment is
   `COMPLETED` on the new revision, and stops at once if it is on another revision or `FAILED`. A worker has no health check, so it settles when its replacement task runs; a worker
   that starts and crashes is replaced until the breaker gives up. Services already rolled stay on the new image, and the
   failure (an annotation and the run's summary) names which services are on the new image, which were not rolled, and the
   one it stopped at.
6. Only when the API and every worker settled, writes the sha to `/oryxa-fde-dev/api-image-tag`. OpenTofu reads that
   parameter on every plan, so a later apply keeps the deployed image instead of rolling anything back. To roll back, revert the
   change on `main` and run `deploy-api` again.

**After a deploy, and `tofu apply` (drift).** An apply is needed only when the infrastructure's configuration changes, not
after a deploy. The workflow and OpenTofu both register task definitions in the same families: the workflow copies the latest
revision and changes the image, OpenTofu builds one from the configuration with the image tag in
`/oryxa-fde-dev/api-image-tag`. Since the workflow records the tag only once everything has settled on it, an apply after a
complete deploy builds the same image the services run, so it never rolls the API or a worker back to an older one (what
it does do: it registers a fresh revision of each family that carries the same image and rolls each service onto it once,
so a plain apply after a deploy replaces each task once more with no change in what runs). After a deploy that stopped
partway (the API or a worker did not settle, so no tag was recorded) an apply returns the API and the workers together to the
last complete deploy's sha, which is consistent but not what the failed deploy meant: fix the cause and run `deploy-api`
again instead. A configuration change applied after a deploy is carried by the next one too, because the workflow copies the
latest revision, which is OpenTofu's. Do not run an apply while `deploy-api` runs (the workflow's concurrency group stops
two deploys, not a deploy and an apply). The first apply after this change must come before the first run of the new
workflow: it grants the deploy role the worker services and roles, and writes the `workers` list into the deploy
parameter, and the workflow refuses a parameter without it.

**What the load balancer gave, and what replaced it** (#145). The ALB health-checked the API and
registered it only when healthy, drained connections on a rollout, and never took the old task out
before the new one answered. Without it:

| ALB did | Now |
| --- | --- |
| Polled `/healthz`; ECS replaced an unhealthy target | The `api` container has its own health check, `oryxa-fde-ops healthcheck`: one GET to `/healthz` on `LISTEN_ADDR` over loopback that exits 0 only on a 200 and gives up after 2 s. ECS runs it every 10 s with a 5 s timeout, replaces the task after 3 misses, and ignores misses for the first 30 s. The path and address are fixed by the code, not set here |
| Held the old task until the new target was healthy | The service keeps `deployment_minimum_healthy_percent = 100` and `maximum_percent = 200`: ECS starts the new task, counts it healthy once the `api` container's health check passes (cloudflared has none, so it does not count), then stops the old one. The deployment circuit breaker rolls back a task that never gets there. A rollout never runs fewer than one healthy task |
| Kept traffic off a target that was not ready | `cloudflared` has `dependsOn` the `api` container being `HEALTHY`, so the tunnel does not connect until the API answers |
| Drained connections for 30 s on deregistration | ECS stops a task's containers in reverse start order, so cloudflared gets SIGTERM first (per AWS's container dependency docs; the first deploy's logs confirm it). It stops taking new requests and lets those in flight finish for up to 30 s (`stopTimeout` 45 s), and only then does the API get SIGTERM and drain in turn (How a task stops, below) |

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
included, gets cut on each deploy and must resume on reconnect. The API drains for itself once cloudflared has exited:
on SIGTERM it closes its listener, gives requests in flight and its two background loops (the outbox relay and the
grant reconciler) `SHUTDOWN_GRACE_SECONDS` to finish, and exits 0 (`crates/oryxa-fde-api/src/shutdown.rs`); what is
still running at the bound is dropped, which the outbox and the pending-grant rows make safe. Migrations still run before
the service changes.

**How a task stops, and for how long.** Times are measured from the moment ECS stops the task, with the defaults
(`api_shutdown_grace_seconds` 20, cloudflared's `stopTimeout` 45 s). Each container waits up to its own `stopTimeout`
after SIGTERM, and ECS stops a container only after the ones that depend on it have exited.

| After the stop | What happens | Bound |
| --- | --- | --- |
| 0 s | ECS sends SIGTERM to `cloudflared` | |
| 0 to 30 s | cloudflared takes no new request and lets those in flight finish (its own 30 s grace); it exits when they are done | ECS kills it at 45 s |
| `t` (under 30 s, at most 45 s) | cloudflared has exited. ECS sends SIGTERM to `api`: the listener closes, requests in flight and the two loops drain, the process exits 0 | the grace, 20 s (`SHUTDOWN_GRACE_SECONDS`) |
| `t` + 20 s at most | The API has exited and the task stops | ECS kills it at `t` + 30 s: `stopTimeout` is the grace plus 10 s |

A normal stop ends within about 50 s and the worst case, a cloudflared that has to be killed and an API that runs out
its stop timeout, at 45 + 30 = 75 s. Fargate allows no `stopTimeout` over 120 s and documents no longer total, so the
budget is 120 s for the sequence: the `fargate_service` module refuses a task whose longest sidecar stop timeout plus its
main container's is over it. With cloudflared at 45 s that makes 65 s the largest grace the task accepts, although the
API itself starts with up to 119, so `api_shutdown_grace_seconds` refuses anything over 65 (the module's check stays as a
second guard). The
grace and the container's stop timeout both come from `api_shutdown_grace_seconds`, so they cannot drift apart, and
`tests/plan.tftest.hcl` pins the relation and the range against `shutdown.rs`.

The workers have no sidecar and no grace of their own: `stopTimeout` is 120 s, Fargate's longest, which is also the
budget. On SIGTERM each stops receiving and finishes the message in hand (#150). The lifecycle worker's hourly drafts
and digest round is stopped only between rounds, so it covers a round of up to 120 s; a round that runs longer is
killed, and a kill in the middle of the digest can mail a sponsor twice (`digest.rs`). A longer budget does not exist on
Fargate, so bounding a round (checking the stop signal between projects, #169's follow-up) is the code's to do.

Without the workflow, the same steps by hand: push an image, put its sha in
`/oryxa-fde-dev/api-image-tag`, apply, and run `infra/scripts/run-task.sh migrate`.

**deploy-workers.** Each Worker deploys with the `wrangler` its own lockfile pins. `fde-web`'s
`wrangler.jsonc` stays local-only: after `pnpm build`, the workflow adds dev's settings to the built
config: the zone route `<WEB_HOSTNAME>/*` (OpenTofu owns that DNS record), the `API` binding to the
Workers VPC service, and `workers_dev` and preview URLs off, so `<web_hostname>` is its only address.
The web build's flags come from an explicit list of `dev` variables, one per flag: today only
`WEB_OWN_SIGN_IN` to `VITE_FDE_OWN_SIGN_IN`, on only when the variable is exactly `1`. Nothing else is
passed through, because every `VITE_` value is baked into the public bundle and must never be a secret. The
job summary lists each flag and whether it is on. The mock-only `VITE_FDE_WORKSPACE` is not passed.
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
| Fargate: oryxa-fde-mcp (with its cloudflared sidecar) | only with `enable_mcp`: 0.25 vCPU + 0.5 GB ARM64 ($5.30, as the API's task) and one more tunnel (free) | 0 now; 5.30 then | AmazonECS, 19 Oct (the same prices) |
| RDS PostgreSQL | `db.t4g.micro` single-AZ ($0.021 an hour: $15.33), 20 GB gp3 ($0.131 a GB: $2.62), backups inside the free allowance | 18 | AmazonRDS, 29 Oct |
| NAT instance | fck-nat on `t4g.nano` ($0.0028 an hour: $2.04), its public IPv4 ($0.005 an hour: $3.65), 8 GB gp3 root volume ($0.0912 a GB: $0.73), and an assumed 10 GB or less a month out to the internet at $0.1093 a GB | 6.50 to 8 | AmazonEC2, 7 Nov; AmazonVPC, 5 Nov; AWSDataTransfer, 3 Nov; the root volume's size and the traffic are assumptions |
| Secrets Manager | 5 secrets + the RDS master secret at $0.40 (each switched-on feature adds 1 to 4) | 2.40 | AWSSecretsManager, 11 Sep |
| KMS | environment key + CloudTrail key at $1, requests at $0.03 per 10,000 (S3 Bucket Keys on). Company keys are $1 each from the day each is made (Company keys, Cost) and none exists yet | 2 to 2.50 | awskms, 8 Nov |
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

- **The host names are free in the zone.** The zone already serves production, and apply must not touch it. `tofu apply`
  does not overwrite a record. Cloudflare documents ("Records with the same name", "Round-robin DNS", "Proxy status")
  that an `A`/`AAAA` record may sit beside other `A`/`AAAA` records at the same name, so the new `AAAA` is **added beside
  an existing address record**, the name answers with both, and if any of them is proxied all are treated as proxied;
  it refuses an `A`/`AAAA` at a name that has a CNAME, and a CNAME (the MCP record) at a name that has an `A`, `AAAA`
  or CNAME. So,
  before the first apply, for each of `web_hostname`, `admin_hostname` and (before `enable_mcp`) `mcp_hostname`, check that
  the zone has **no record of any type** at that exact name, and that the Zero Trust dashboard has no Access application and no
  Worker route or custom domain on it. With `CLOUDFLARE_API_TOKEN` in the environment and the zone's id (the token is passed
  as a header file, not an argument, so `ps` never shows it):
  `curl -s -H @<(printf 'Authorization: Bearer %s' "$CLOUDFLARE_API_TOKEN") "https://api.cloudflare.com/client/v4/zones/<cloudflare_zone_id>/dns_records?name=<host name>" | jq '.result | length'`
  must print `0` for each name. The check is by exact name: records at other names, the production ones included, are not
  affected, and a web name equal to the zone itself would sit on the apex, where records usually exist.

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
- **The MCP server's tunnel (#165), with `enable_mcp`.** `cloudflare_zero_trust_tunnel_cloudflared_config` (provider 5.27) puts the
  ingress rule on the remotely managed tunnel, and the connector run with only `TUNNEL_TOKEN` takes it from Cloudflare: the first apply and
  the dashboard show it (the tunnel healthy, the rule `<mcp_hostname>` to `http://127.0.0.1:8081`). Cloudflare forwards the request's own `Host`
  (`<mcp_hostname>`) to the origin by default, which is what `MCP_ALLOWED_HOSTS` is compared with: if the first request is refused with a
  host error, that is the place to look. Two connectors of this tunnel run during a deploy (as the API's do). The `mcp_hostname` record is
  proxied (an orange-cloud CNAME to `<tunnel id>.cfargotunnel.com`), and the certificate for it is the zone's Universal SSL one, which is why the name is the zone or one label under it, as the web app's.
- **Health check and start order.** The API container's health check runs `/usr/local/bin/oryxa-fde-ops healthcheck`
  (the image has no shell). The binary's own test (`crates/oryxa-fde-api/tests/shutdown.rs`) shows exit 0 on a 200 and 1 on
  anything else, but it has not run as an ECS health check: confirm in the first run that the `api` container reaches
  `HEALTHY` and that cloudflared waits for it (`describe-tasks`), and that the check's `LISTEN_ADDR` is the container's (it is
  an `environment` entry, which ECS passes to the check). The shutdown order (cloudflared first) is from AWS's
  `dependsOn` docs ("for container shutdown it is reversed"); the first deploy's CloudWatch streams
  (`api/` and `cloudflared/` in `/ecs/oryxa-fde-dev-api`) show whether the tunnel drained first and how long each took,
  and whether the API logged its drain before it exited (How a task stops).
- **fck-nat AMI owner** `568608671756` is the one fck-nat's deploy guide gives. That the AMI exists in
  Mumbai is the project's published Region list; run the `describe-images` check in Mumbai (ap-south-1) first.
- **zed task.** `authzed/zed:v1.14.0-debug` (busybox shell, ARM64 confirmed on ghcr.io) reads the
  key from `ZED_TOKEN` through zed's `ZED_` env flag binding. If zed reports no token, that binding
  did not apply.
- **Docker Hub pulls** (SpiceDB, cloudflared, zed) are anonymous and rate-limited per NAT IP. An ECR
  pull-through cache fixes it if it bites. SpiceDB and zed are pinned by tag; cloudflared by digest (it
  holds the API's role).
- **Deploy role.** `ecs:RegisterTaskDefinition` and `ecs:DescribeTaskDefinition` take `*` (not
  scoped to a family); `iam:PassRole` on the roles of the API, the migrate task and each worker (six roles, two more for each of the lifecycle worker and the MCP server) is what limits a new revision. If the account
  already has a GitHub OIDC provider, set `github_oidc_provider_arn` or the first apply fails on it.
  The trust's `job_workflow_ref` condition relies on STS validating that GitHub claim (supported for
  GitHub since 2025). If a `deploy-api` run is refused at `AssumeRoleWithWebIdentity`, compare the trust with the
  token's claims; the failure is closed, never open. Found on the first dev deploy (#196): this repository has
  GitHub's immutable subject on, so the token's `sub` is `repo:<owner>@<owner id>/<name>@<repo id>:environment:dev`
  and the name-only `sub` the role then trusted refused it. `github_oidc_subject_prefix` now carries that prefix
  (Apply order, step 4). The immutable setting changes `sub` only: with the trust's `sub` set to the immutable form by
  hand and `job_workflow_ref` left as `<github_repository>/.github/workflows/deploy-api.yml@refs/heads/main`, the
  rerun signed in, so `job_workflow_ref` still names the owner and repository, not their ids.
- **Cloudflare token for deploys.** The permission names (Containers Edit for the sandbox image, and
  whether binding a Workers VPC service needs a Connectivity Directory permission too) are from the
  docs; the first `deploy-workers` run confirms them.

- **Company keys (#109).** Each of these fails closed (a refused write, never an open one), and the first real
  check is a test with sample data before `require_company_keys` is turned on:
  - **S3 compares the key header as written.** The bucket policy lets a write name only `.../alias/oryxa-fde-<env>/companies/*`,
    which works only if S3 evaluates `s3:x-amz-server-side-encryption-aws-kms-key-id` against the string in the request
    and accepts an alias ARN in that header. AWS documents only the key ARN form for this condition: the SSE-KMS guide
    ("Requiring server-side encryption", read 10 November 2026) says "To specify the KMS key, you must use a key Amazon
    Resource Name (ARN) that is in the `arn:aws:kms:region:acct-id:key/key-id` format" and "AWS Identity and Access
    Management does not validate if the string ... exists", which reads as a string comparison, but also "the AWS KMS
    key ID that Amazon S3 uses for object encryption must match the AWS KMS key ID in the policy", which could mean the
    resolved key. The PutObject reference lists "Key ID, Key ARN, or Key Alias" for the header. If S3 compares the
    resolved key ARN, every company write is refused (closed, and the bucket half needs the fallback below before
    `require_company_keys`). First, right after the first apply with this policy: an upload through the API with no key
    header (today's code) still succeeds; if it is `AccessDenied`, S3 fills the condition key from the bucket default,
    and `extra_policy_statements` comes out until the design is changed. Then: a `PutObject` naming a company
    alias ARN succeeds under a company prefix; one naming the environment key's ARN, its id or `alias/oryxa-fde-<env>` is
    `AccessDenied`. If the alias is refused, the API names the key ARN (it resolves it with `DescribeKey`) and
    the bucket policy keeps only its negative rules (refuse the environment key's ARN, no key header, other
    encryption): weaker, because a spelling it does not list passes, but the company key policy still binds each key
    to its own prefix.
  - **A request-level `x-amz-server-side-encryption-bucket-key-enabled: false` gives the object's ARN as the
    encryption context** (the S3 Bucket Key guide: the header overrides the bucket's setting; the SSE-KMS guide: the
    context is the object ARN without a Bucket Key). Test: the write above, then a `GetObject` by the API role,
    both succeed; a write under company B's prefix naming company A's alias is `AccessDenied` from KMS.
    If a Bucket Key cannot be turned off per request, the key policy's context pattern must also allow the bucket's
    ARN (`arn:aws:s3:::<bucket>`), which gives up the per-prefix binding.
  - **A caller cannot choose `aws:s3:arn`.** S3 "appends the default encryption context of `aws:s3:arn`" to any
    context the caller sends in `x-amz-server-side-encryption-context` (the SSE-KMS guide, Encryption context); what
    it does when the caller's own context names `aws:s3:arn` is not documented. This one would fail open, not
    closed, and only a serving role (which may already use every company's key) could try it. Test: a write under
    company B's prefix naming company A's alias, with that header set to `{"aws:s3:arn": "<an object ARN under A>"}`,
    must be refused.
  - **`DescribeKey` on an alias that does not exist** answers `NotFoundException` for the provisioning role, which
    the script reads as "no key". Its policy grants `DescribeKey` on the alias ARNs for this; if the first run
    answers `AccessDenied` instead, the script stops and says so rather than creating a key.
  - **`GetKeyPolicy` returns the policy in a form the script compares after normalising** (one-element lists
    unwrapped, lists unordered). If the first re-run of `provision` reports a policy difference with nothing changed,
    the comparison needs another rule.
  - **Condition keys** used for the first time here (`kms:ScheduleKeyDeletionPendingWindowInDays`, `kms:KeySpec`,
    `kms:MultiRegion`, `kms:BypassPolicyLockoutSafetyCheck`, `kms:EncryptionContext:aws:s3:arn`, `kms:ViaService`) are
    in the KMS developer guide's condition key list (read 10 November). The first `provision` shows whether `CreateKey`
    with its tags and `TagResource` pass the provisioner's conditions (AWS needs `kms:TagResource` as well as
    `kms:CreateKey` when tags go on at creation).
  - **The API's key check (#183).** Documented (KMS developer guide, read 10 November 2026): `DescribeKey` is authorised against the key an
    alias points to, by the key policy ("Required permissions: kms:DescribeKey (key policy)"); "You can use the key policy alone to control
    access if the key and the IAM principal are in the same AWS account" ("KMS key access and permissions"), and `ServingRolesCheckTheKeyExists`
    names the API's role directly, not through the account root; an alias ARN as an IAM `Resource` "applies to the alias resource, not to any
    KMS key that might be associated with it" ("Use aliases to control access to KMS keys"); and the permissions reference lists only "KMS key"
    as `DescribeKey`'s resource (the alias resource is for `CreateAlias`, `DeleteAlias`, `UpdateAlias`), so `LookUpCompanyKeyAliases`, like the
    provisioner's `LookUpTheCompanyAliases`, is documented to grant nothing. Not documented, so confirmed only on the account: (1) what a lookup
    of an alias that does not exist answers, `NotFoundException` or `AccessDenied` (step 3 of Before `require_company_keys` is switched on shows
    it: a `company key check failed` warning with `AccessDenied` for a company with no key). If `AccessDenied`: the API still answers "no key",
    only noisily, and no IAM grant changes it, so accept the warning (do not quieten `AccessDenied` in the code, which is also how a key whose
    policy misses the API's role shows); but `company-key.sh`'s `lookup` stops on anything but `NotFoundException`, so `provision` would stop
    for every new company at step 4, and the provisioner then needs `kms:ListAliases` (resource `*`) and the script a `list-aliases` check
    for the alias before it describes, in an infra PR. (2) A lookup of an alias that exists, by alias ARN with no IAM grant on any key, succeeds
    (documented as above; step 4 shows it). If it fails, the API role needs an IAM `DescribeKey` on `key/*` with `aws:ResourceTag/purpose`
    `company-data` and `aws:ResourceTag/env`: the form the provisioner uses (the account root's `kms:Describe*` in each key policy lets IAM grant
    it). (3) `DescribeKey` is evaluated as the eventually consistent API AWS says it is, so a key provisioned seconds ago may read as absent for a
    moment (the cache keeps a no for 5 s).
  - **A multipart upload** names its key only in `CreateMultipartUpload`, so a `UploadPart` would meet
    `DenyWriteWithoutCompanyKey`. The API uses single `PutObject` calls; test `UploadPart` before anything else uploads in parts.
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
- **`WORKOS_ISSUER`.** The token's `iss` is pinned exactly (`oryxa-authn/src/workos_jwt.rs:57`). Unset, the API and
  the MCP server derive it from the client id (`session.rs:496`): `https://api.workos.com/user_management/<client id>`,
  which a standard WorkOS environment (no custom auth domain) issues, as
  `https://api.workos.com/user_management/<client id>/.well-known/openid-configuration` shows. Leave `workos_issuer`
  null there; setting it to that value is harmless. If the WorkOS environment uses a custom auth domain, the issuer is
  that domain: set `workos_issuer` to it. Either way, a wrong issuer refuses every sign-in with `401 unauthorized` at
  `/auth/callback`.
- **Who can sign in.** A person can sign in only as an active member of a WorkOS organisation with the role `admin`
  or `member`. Add each person to the organisation in the WorkOS dashboard, with one of those roles, before their
  first sign-in.
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
- **Per-company KMS keys are built but off** (ADR 0003, amendment of 4 November; Company keys). Until the API names a
  company's key on write and `require_company_keys` is `true`, new files land under the environment key, which is for
  sample data only. The API's role is limited to company documents and canvas snapshots.
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
- `ponytail:` a queue worker has no health endpoint, so ECS judges it by its process: an essential container whose exit
  replaces the task. A worker that is alive but stuck is not detected (the queue's heartbeat and 15 minute ceiling bound one
  stuck message, not a stuck loop). Add a liveness signal if it ever happens.
- `ponytail:` workers stop with SIGTERM and Fargate's longest wait (`stopTimeout` 120 s), and a deploy replaces the task
  in place, so processing pauses for the swap (the queue holds the events) and two consumers never overlap. On SIGTERM a
  worker stops receiving and finishes the message in hand (#150); one still running at 120 s is killed, and its message
  returns after its visibility timeout, which the handlers allow.
- `ponytail:` a deploy rolls the API and the workers one after the other, so for a few minutes the API can be on the new
  image while a worker is still on the old (and, after a failed deploy, until the next one). A migration must work for the
  old image, and an event may gain a field but never lose one. Nothing orders a worker's start against the API's beyond that.
- `ponytail:` the workers' tasks carry the API's binary (one image). They have no credentials of
  the API's: each task role is its own.
- `ponytail:` the MCP server's cloudflared shares the MCP task's role and security group, as the API's does (the role holds only
  `rds-db:connect` as its own login and one Bedrock model, so a compromised connector gets less than the API's does). The MCP task has no
  health check (the binary has no health route), so the connector starts with the process, not when the server answers, and a server that is
  alive but stuck is not replaced. The server has no graceful shutdown. Both are on the API stream's list (How the MCP server is reached).
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
    its table above, read from the binary. On SIGTERM they finish the message in hand (#150) within their 120 s stop
    timeout; past it they are killed and rely on redelivery.
  - **Migrations run as a one-off task, never at startup** (#32, #39). The migrate task runs
    `oryxa-fde-ops migrate` from the API's image (`/usr/local/bin/oryxa-fde-ops`, beside
    `/usr/local/bin/oryxa-fde-api`), connected as `oryxa_fde_migrator`, and exits 0 when done. The
    service connects as `oryxa_fde_api`, a member of `oryxa_fde_runtime` only, so every query runs
    inside a transaction that took `oryxa_fde_app`, `oryxa_fde_relay` or `oryxa_fde_grants`. The
    bootstrap creates those roles and `oryxa_fde_runtime`, so no login needs CREATEROLE, and the
    migrator holds the first three with admin option for migrations 0001 and 0003.
  - **Company keys** (#109): write each company's files under its own key, and check that the company has one before
    storing customer content (ADR 0006). Done in #176; the API and the ingest worker carry `COMPANY_KEY_ALIAS_ARN_PREFIX` (#183), and what the
    API's role may call is in Company keys, How the API's key check is authorised. A change to `keys.rs`'s parser or variable name fails
    `tofu test` until `envs/dev` follows (`tests/code`).
  - It serves `GET /healthz` without auth (it does; the container health check and the deploy rely on
    it), listens where `LISTEN_ADDR` says (`127.0.0.1:<api_port>` in dev; the tunnel sidecar is its only
    client), keeps files under
    `<tenant>/<company>/` (`oryxa-fde-context/src/blob.rs`), and writes nothing to its root filesystem, which is
    read-only. Infra builds the image (`deploy-api`) from the five binaries:
    `oryxa-fde-api` is the entrypoint, the migrate task runs `/usr/local/bin/oryxa-fde-ops migrate` and the API's container
    health check `/usr/local/bin/oryxa-fde-ops healthcheck`.
- **MCP server (API stream, #165).** The binary has what the infra gives it (the contract table of `oryxa-fde-mcp`). What the API stream still
  owes before an FDE's agent can use it, none of it built here: OAuth for MCP (the protected-resource metadata, the `WWW-Authenticate`
  challenge and an authorization server an MCP client can register with), a decision on the token's audience, a `/healthz` outside the token
  check with a matching `healthcheck`, a graceful shutdown, and no need for WorkOS's API key (How the MCP server is reached). When a tool
  needs a file's bytes, it adds its S3 and KMS permission with its company-key reader entry in the same change, and tells infra first.
- **Web (`fde-web/`, `realtime/`).** `deploy-workers` adds the `API` binding (`env.API`, the Workers
  VPC service) and the zone route on `<web_hostname>` to the built config at deploy time, so
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
bash infra/scripts/test-company-key.sh # company-key.sh against a fake aws; no account needed
actionlint                            # the deploy workflows
```

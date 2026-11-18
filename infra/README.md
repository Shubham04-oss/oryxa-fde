# infra: the dev environment in OpenTofu

AWS and Cloudflare for `oryxa-fde`, following ADR 0003. Only the owner applies, from their own machine, in
the order below. CI runs `fmt`, `validate` and a plan on mock providers with no credentials.

Since #298 the environment holds what sign-in needs and nothing else, as the code has since #296: the API,
SpiceDB, the database, the one-off migrate, schema and database admin tasks, the secrets sign-in reads,
CloudTrail, the Cloudflare side of `fde-web` and the deploy roles. The queue workers, the MCP server, the event
bus and its queues, the customer data bucket and the per-company keys are gone, with their scripts and tests.

Patterns come from the platform's `infra/modules` and `docs/deploy.md` (oryxa-platform `2b064a3`). The VPC is
adapted from there, and its file says so.

## What it builds

```
Browser -> Cloudflare (DNS, Access on <admin_hostname>) -> fde-web Worker (<web_hostname>)
  -> vpc_services binding (Workers VPC) -> Cloudflare Tunnel
  -> one Fargate task in a private subnet: cloudflared (sidecar) -> 127.0.0.1:8080 -> oryxa-fde-api
       -> RDS PostgreSQL 17                (IAM database auth, TLS, private)
       -> SpiceDB on Fargate              (spicedb.oryxa-fde-dev.internal:50051, Cloud Map, private)
Everything outbound (AWS APIs, image pulls, WorkOS, the tunnel) leaves through one fck-nat instance.
CloudTrail logs management events in every Region.
```

Nothing in AWS accepts traffic from the internet. No security group has a CIDR ingress rule wider
than the VPC, and the API has no public hostname. Only Workers in this Cloudflare account that
are bound to the VPC service reach it, through the tunnel. The tunnel's connector is a second
container in the API's task, so it reaches the API on the task's loopback: the API listens on
`127.0.0.1` only, and no security group admits anything to it (#145; the path used to go through
a separate cloudflared service and an internal ALB, and "What the load balancer gave" in Deploys
says what replaced it).

| Path | What |
| --- | --- |
| `modules/vpc` | VPC `10.50.0.0/16`, public and private subnets in two AZs, fck-nat instance, S3 gateway endpoint (ECR's image layers), optional interface endpoints |
| `modules/postgres` | RDS for PostgreSQL 17, encrypted, IAM auth, `rds.force_ssl`, master password managed by RDS in Secrets Manager |
| `modules/fargate_service` | One ARM64 main container, with optional health check, stop timeout and sidecars: task definition, log group, execution and task roles, security group, optional ECS service. The API, SpiceDB and the one-off tasks are all this module |
| `modules/internal_alb` | Internal ALB, target group (`ip`), HTTP listener reachable from named security groups only. **Not used by `envs/dev` since #145**; kept, with its test, for a production environment that fronts a service with a load balancer (pair it with `fargate_service`'s `load_balancer`) |
| `modules/cloudtrail` | Multi-region trail with its own bucket and key, log file validation; data events on any data bucket it is given (dev gives none) |
| `modules/cloudflare` | DNS for the web and admin host names (named by variables, not derived), the tunnel, the Workers VPC service to the API on the loopback of the tunnel's connector, Access on the admin host |
| `envs/dev` | The composition, variables, outputs, lock file and `tests/plan.tftest.hcl` (with `tests/contract`, which reads the API's environment contract table below, and `tests/code`, which reads the API's health-check and shutdown constants, the Dockerfile and `run-task.sh`); `deploy.tf` holds the GitHub deploy role and the deploy parameters |
| `docker/oryxa-fde-api.Dockerfile` | The backend image: the prebuilt ARM64 `oryxa-fde-api` and `oryxa-fde-ops` on distroless Debian 13, nonroot, with no shell and no other program (Deploys, The image) |
| `scripts/run-task.sh` | One-off tasks in the private subnets: bootstrap SQL, the store's migrations, SpiceDB migrate, SpiceDB schema write |
| `scripts/smoke-test.sh` | A scripted check of a deployed environment through the web app's address (Smoke test); `test-smoke-test.sh` runs it against `smoke-stub.py` |
| `sql/01-bootstrap.sql` | The IAM logins `oryxa_fde_migrator`, `oryxa_fde_api` and `spicedb`, the NOLOGIN roles they reach, the `spicedb` database, and a check that nothing the API reaches has owner powers |

Names: the ECS service is `oryxa-fde-api`, and so is the one ECR repository, which holds the backend image. Everything
else is `oryxa-fde-<env>-…`: the cluster `oryxa-fde-dev`, SpiceDB `oryxa-fde-dev-spicedb`, the
one-off tasks `oryxa-fde-dev-migrate`, `-db-admin` and `-zed`.

## Variables

Set in `envs/dev/terraform.tfvars` (gitignored; start from `terraform.tfvars.example`). None of
them is a secret. The Cloudflare API token comes from `CLOUDFLARE_API_TOKEN` in the environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `env` | `dev` | Environment name in every resource name (`oryxa-fde-<env>`); 2 to 10 lowercase letters or digits |
| `aws_account_id` | required | The only account the AWS provider will touch (`allowed_account_ids`) |
| `aws_region` | `ap-south-1` | Mumbai, chosen by the founder to see real latency from the team and first customers (#144). Everything in AWS runs and rests here; what Mumbai offers is in Mumbai (ap-south-1) below |
| `cloudflare_account_id` | required | Account for the tunnel, the Workers VPC service and Access |
| `cloudflare_zone_id` | required | The Cloudflare zone's id |
| `cloudflare_zone_name` | required | That zone's own name (`example.com` in the examples; this README never names a real zone). It is not a host name: it is what the two host names below are checked against |
| `web_hostname` | required | The web app's full host name (fde-web). **The API's `WEB_ORIGIN` is `https://<web_hostname>`, exactly**, because the session cookie and the CSRF check depend on it; the `WEB_HOSTNAME` GitHub variable (Deploys) and the smoke test's `SMOKE_BASE_URL` are the same name. Validated: a lowercase host name that is the zone itself or **exactly one label under it** (Cloudflare's Universal SSL certificate covers the zone and one level of subdomain only, so `app.fde-dev.<zone>` would have no certificate). For dev, for example `fde-dev.<zone>` |
| `admin_hostname` | required | The admin tools' full host name, behind Cloudflare Access (a proxied `AAAA` placeholder record for a Worker route, and the Access application). Same rules, and not the web app's. For dev, for example `fde-dev-admin.<zone>` |
| `admin_emails` | required | Who may open `admin_hostname` through Cloudflare Access |
| `workos_client_id` | required | WorkOS client id (public); the API key is a secret |
| `workos_issuer` | `null` | `WORKOS_ISSUER` on the API, which pins every token's `iss` to it. Needed only with a custom auth domain in WorkOS: set it to that domain, or every sign-in is refused. Null: the code derives WorkOS's own issuer from the client id, `https://api.workos.com/user_management/<client id>`, which is what a WorkOS environment without a custom auth domain issues; setting it to that value is harmless. Validated: https, an optional path of letters, digits, `_`, `-` and `.`, no query, fragment, userinfo or wildcard (Verify before apply) |
| `cloudtrail_bucket_name` | required | Globally unique name for the CloudTrail log bucket |
| `api_image_tag` | required | Seeds `/oryxa-fde-<env>/api-image-tag` on the first apply (any value while nothing runs); after that `deploy-api` owns the tag (Deploys) |
| `github_repository` | `Shubham04-oss/oryxa-fde` | The repository whose `environment: <env>` jobs may assume the deploy role |
| `github_oidc_subject_prefix` | `null` | The OIDC `sub` prefix the deploy role trusts, before `:environment:<env>`. Null is `repo:<github_repository>`. With GitHub's immutable subject on (this repository has it), set it to the `sub_claim_prefix` that `gh api repos/<owner>/<name>/actions/oidc/customization/sub` prints, `repo:<owner>@<owner id>/<name>@<repo id>` (Apply order, step 3). Validated: that shape or `repo:<owner>/<name>`, naming `github_repository`, no wildcard |
| `github_oidc_provider_arn` | `null` | The account's GitHub OIDC provider, if it already has one; null creates it |
| `start_services` | `false` | `false`: every service (SpiceDB and the API task) runs 0 tasks. Set `true` once the image and every secret value exist |
| `api_port` | `8080` | Port `oryxa-fde-api` listens on, on the task's loopback (`LISTEN_ADDR` is `127.0.0.1:<port>`); the health check and the Workers VPC service use it |
| `api_shutdown_grace_seconds` | `20` | Seconds the API drains after SIGTERM: `SHUTDOWN_GRACE_SECONDS` on the API, and the `api` container's `stopTimeout` is this plus 10. A whole number from 1 to 65: the API starts with up to 119, but the stop sequence (cloudflared's 45 s, then the API's grace plus 10) must fit 120 s (Deploys, How a task stops) |
| `api_cpu` | `256` | CPU units of the API task, shared by the API and the cloudflared sidecar (0.25 vCPU) |
| `api_memory` | `512` | Memory of the API task in MiB, shared by both containers |
| `spicedb_image` | `authzed/spicedb:v1.56.2` | Same version as CI |
| `cloudflared_image` | `cloudflare/cloudflared@sha256:4955524aeaa3...` (2026.10.7) | Tunnel connector, the sidecar of the API task. Pinned by digest because it runs with the API task's role |
| `db_instance_class` | `db.t4g.micro` | RDS instance class |
| `allow_destroy` | `false` | Set `true` only to tear the environment down: lifts RDS deletion protection and lets `destroy` empty the CloudTrail bucket and the ECR repository |
| `vpc_cidr` | `10.50.0.0/16` | Distinct from the platform's `10.40.0.0/16`, so the two can be peered later |
| `interface_endpoints` | `[]` | PrivateLink endpoints for AWS APIs (about $7.30/month each); empty means the NAT carries that traffic |
| `log_retention_days` | `14` | CloudWatch retention for every task's logs |

The state backend takes `bucket` and `region` at `tofu init` (step 1); the state key is
`oryxa-fde/dev/terraform.tfstate`.

### Host names

The two host names are inputs, not derived from one base name. The zone is the founder's real one and also holds the
production names (the zone itself, `app.`, `admin.`), and Cloudflare's Universal SSL certificate covers the zone
and one level of subdomain only, so dev needs single-level names of its own, chosen explicitly. There is no default
for either, so nobody takes the production names by accident, and `terraform.tfvars.example` shows dev's with the
placeholder zone `example.com` (no real zone or host name belongs in this repository):

| Variable | Dev example | Where it goes |
| --- | --- | --- |
| `web_hostname` | `fde-dev.example.com` | the proxied `AAAA` placeholder record for fde-web's route; the API's `WEB_ORIGIN` (`https://fde-dev.example.com`); output `web_hostname`, which is the `WEB_HOSTNAME` GitHub variable (the route `<WEB_HOSTNAME>/*` that `deploy-workers` adds); the smoke test's `SMOKE_BASE_URL`; the WorkOS redirect URI `https://<web_hostname>/auth/callback` |
| `admin_hostname` | `fde-dev-admin.example.com` | its proxied `AAAA` placeholder record; the Cloudflare Access application's domain; output `admin_hostname` |

`plan` refuses a name that is not lowercase, is neither the zone nor exactly one label under it (with the reason), or is
the same as the other. The web name must be exactly the web app's origin: the API compares the browser's `Origin` with
`WEB_ORIGIN` (`403 csrf`) and the session cookie is `__Host-` bound to the host, so a different name in either place signs
nobody in. The GitHub environment variable `WEB_HOSTNAME` is `tofu output -raw web_hostname`, never typed by hand, so it
cannot differ from `web_hostname`.

## Secrets

Secrets Manager holds one secret per value. OpenTofu creates each secret empty, encrypted with
the environment key, and grants read access by exact ARN to the tasks that use it. The owner
sets the values by hand, so no value passes through OpenTofu config, plan or state. ECS injects
them as env vars when a task starts, and a task cannot start until its secrets have values.

| Secret (`oryxa-fde-dev/…`) | Env name | Read by |
| --- | --- | --- |
| `api/workos-api-key` | `WORKOS_API_KEY` | oryxa-fde-api |
| `api/session-password` | `SESSION_PASSWORD` | oryxa-fde-api (seals the session cookie) |
| `shared/spicedb-preshared-key` | `SPICEDB_PRESHARED_KEY` (API), `SPICEDB_GRPC_PRESHARED_KEY` (SpiceDB), `ZED_TOKEN` (zed task) | oryxa-fde-api, SpiceDB, the zed task |
| `cloudflared/tunnel-token` | `TUNNEL_TOKEN` | the cloudflared sidecar of the API task only (ECS injects secrets per container: the API container does not see it, and cloudflared sees none of the API's) |
| RDS master (created by RDS) | `PGUSER`, `PGPASSWORD` | the db-admin task only |

`tofu output secrets` lists the names. How to fill them: `api/session-password` is 64 hex characters
(`openssl rand -hex 32`); the SpiceDB key is random (`openssl rand -base64 32`); the WorkOS key comes from the
WorkOS dashboard; the tunnel token from the Cloudflare dashboard (Apply order, step 5).

No service has a database password: the API, the migrate task and SpiceDB connect with IAM database auth, as
`oryxa_fde_api`, `oryxa_fde_migrator` and `spicedb`, and each task role may `rds-db:connect` as its own user only.

## Database logins

| Login | Used by | May |
| --- | --- | --- |
| `oryxa_fde_migrator` | the one-off migrate task (`oryxa-fde-ops migrate`) | own and change the FDE tables; grant `oryxa_fde_app`, `oryxa_fde_relay` and `oryxa_fde_grants` onward (admin option), no CREATEROLE; nothing else connects as it |
| `oryxa_fde_api` | the API service | member of `oryxa_fde_runtime` only: `SET LOCAL ROLE` to a transaction role per transaction, inheriting none; `connect` and `usage` only; owns nothing, creates nothing |
| `spicedb` | SpiceDB | its own `spicedb` database only |
| RDS master | the db-admin task | the bootstrap SQL |

The NOLOGIN roles come from the bootstrap, so no login needs CREATEROLE: `oryxa_fde_app` and
`oryxa_fde_relay` (each transaction's role; `sign_in_limits` is reached as `oryxa_fde_relay`), `oryxa_fde_grants`
(kept for the baseline migration) and `oryxa_fde_runtime`, which migration 0001 makes a member of the other three
without inheritance.

Every login is `login nosuperuser nocreaterole nocreatedb nobypassrls`, granted `rds_iam`; the migrator and the API get
`connect` on `oryxa_fde` and `usage` on `public`.

The API can never reach table ownership, CREATEROLE or BYPASSRLS: its login is not a member of the migrator or the
master, and no task role can connect as the migrator or as another service's login (`tests/plan.tftest.hcl` pins both
IAM sides). The bootstrap ends with a check over the API login and every role it can reach by `SET ROLE` or
inheritance, and stops if any of them is a superuser, may create roles or databases, bypasses row-level security, is
the migrator, the master or a predefined role, owns a relation, a schema or the database, may create in `public`, or
holds an admin option. A query the API runs outside a scoped transaction is refused, because it inherits no table
rights.

## The environment contract

Read from the code, not from memory (each `Read at` is `file:line` in `crates/`, checked against `main` at
`2b8cdcb`), and compared with what `envs/dev` sets. `tests/plan.tftest.hcl` reads the `oryxa-fde-api` table: every
`always` variable must be on the task definition, every variable the task definition sets must be in the table, and a
secret must be injected from Secrets Manager, never set as plain config. Add or change a variable in the code, and the
table and `envs/dev` change in the same PR. The line numbers are not tested: when a PR moves code a table points at, it
refreshes them. Two things are also read from the source as text (`tests/code`): the `healthcheck` row of the
`oryxa-fde-ops` table must give the command the API container's health check runs, and the `SHUTDOWN_GRACE_SECONDS`
row's default and range must be the code's (`health.rs`, `shutdown.rs`), with the grace on the task inside that range
and the stop timeouts derived from it. This couples the infra tests to the Rust source on purpose: a Rust PR that
renames or reshapes those constants (or the Dockerfile's `COPY`) fails `tofu test` until the infra side, this README
and `tests/code` are updated with it.

Columns. **Needed**: `always`; `optional` (the code has a default); `local only` (tests and laptops). **Kind**:
`config` (plain, visible in the task definition), `secret` (a value; ECS injects it from Secrets Manager),
`reference` (a Secrets Manager name or KMS key ARN, not a value). The task also gets its AWS identity from the task
role: the SDK reads `AWS_REGION` and the container credentials ECS provides (`aws_config::load_from_env`). The API's
task is two containers (the API and cloudflared), so the table below describes the `api` container only; the sidecar
has one variable, `TUNNEL_TOKEN`.

### `oryxa-fde-api`

The service, entrypoint `/usr/local/bin/oryxa-fde-api` (deployed), container `api` of the `oryxa-fde-api` task. A
variable that is missing, or not valid, stops startup.

| Variable | Needed | Kind | Default | Read at | Infra |
| --- | --- | --- | --- | --- | --- |
| `DB_HOST` | always | config | none | `oryxa-fde-store/src/iam.rs:82` | RDS address |
| `DB_PORT` | always | config | none | `iam.rs:82` | RDS port |
| `DB_NAME` | always | config | none | `iam.rs:82` | `oryxa_fde` |
| `DB_USER` | always | config | none | `iam.rs:82` | `oryxa_fde_api` |
| `AWS_REGION` | always | config | none | `iam.rs:133` | `aws_region` |
| `SPICEDB_ENDPOINT` | always | config | none | `oryxa-fde-api/src/main.rs:45` | Cloud Map name |
| `SPICEDB_PRESHARED_KEY` | always | secret | none | `main.rs:46` | `shared/spicedb-preshared-key` |
| `WORKOS_CLIENT_ID` | always | config | none | `main.rs:49` | `workos_client_id` |
| `WORKOS_API_KEY` | always | secret | none | `main.rs:52` | `api/workos-api-key` |
| `WEB_ORIGIN` | always | config | none | `main.rs:59` | `https://<web_hostname>`: the web app's origin exactly |
| `SESSION_PASSWORD` | always | secret | none | `main.rs:60` | `api/session-password` |
| `LISTEN_ADDR` | optional | config | `0.0.0.0:8080` | `health.rs:28` (the API calls it at `main.rs:67`; `oryxa-fde-ops healthcheck` reads it too) | `127.0.0.1:<api_port>`: the tunnel sidecar is the only client, and the health check calls it |
| `SHUTDOWN_GRACE_SECONDS` | optional | config | `20`; 1 to 119, anything else stops startup | `shutdown.rs:50` (named at `:37`, used at `main.rs:42`) | `api_shutdown_grace_seconds` (20): the `api` container's `stopTimeout` is this plus 10 |
| `WORKOS_ISSUER` | optional | config | `https://api.workos.com/user_management/<WORKOS_CLIENT_ID>` (`session.rs:914`; blank counts as unset) | `main.rs:50` | `workos_issuer`; not set when null. Needed only with a custom auth domain in WorkOS: that domain |
| `SESSION_PASSWORD_PREVIOUS` | optional | secret | none | `main.rs:63` | not set; add a secret when rotating |
| `RUST_LOG` | optional | config | `info` | `main.rs:37` | not set |
| `DATABASE_URL` | local only | secret | none | `store/src/lib.rs:134` | never set |

What the API's task role may do, from what the code calls:

| Permission | Why (`Read at`) | In dev |
| --- | --- | --- |
| `rds-db:connect` as `oryxa_fde_api` | the store's IAM sign-in (`iam.rs`) | granted; the role's only statement |

### `oryxa-fde-ops`

Entrypoint `/usr/local/bin/oryxa-fde-ops` in the API image.

| Subcommand | Variables (Read at) | In dev |
| --- | --- | --- |
| `migrate` | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` as `oryxa_fde_migrator`, and `AWS_REGION` (`store/src/lib.rs:93`, `iam.rs:82`); `MIGRATION_DATABASE_URL` for local runs only (`lib.rs:100`) | the `oryxa-fde-dev-migrate` task sets all five; its role may connect as the migrator only |
| `healthcheck` | `LISTEN_ADDR` only (`health.rs:28`, default `0.0.0.0:8080`), no secret, no AWS call, no database. One GET to `/healthz` (`health.rs:8`) over loopback (an address that is neither loopback nor unspecified fails), 2 s timeout (`health.rs:12`), exit 0 only on a 200 (`ops.rs:30`) | the `api` container's health check: `/usr/local/bin/oryxa-fde-ops healthcheck`, run every 10 s with ECS's timeout at 5 s, 3 misses to replace the task, 30 s start period |

## Apply order

The owner needs an admin AWS login for the dev account, OpenTofu 1.11 or newer (CI uses 1.12.6), the AWS CLI, `jq`,
and `CLOUDFLARE_API_TOKEN` scoped to the account and zone with these permissions, all Edit: Cloudflare Tunnel, Access:
Apps and Policies, Workers VPC (Connectivity Directory), and Zone DNS. The image and the web Worker are built and
deployed by the two deploy workflows (Deploys, below), not from the owner's machine.

1. **State.** Create a versioned, encrypted, private S3 bucket by hand, then run
   `tofu -chdir=infra/envs/dev init -backend-config="bucket=<state bucket>" -backend-config="region=ap-south-1"` (the state bucket is in `aws_region`).
2. **The protected `dev` environment, before the deploy role exists.** In GitHub, Settings,
   Environments, New environment `dev`: deployment branches, selected branches, `main` only. Add the
   `CLOUDFLARE_API_TOKEN` environment secret now or before step 11 (Deploys, below).
3. **First apply, nothing running.** Fill `terraform.tfvars` with `start_services = false` and any
   `api_image_tag`. Set `cloudflare_zone_name`, `web_hostname` and `admin_hostname` as in Host names, and check the
   records first (Verify before apply: the names must be free in the zone).
   Read the repository's OIDC subject setting: `gh api repos/<owner>/<name>/actions/oidc/customization/sub`. If it
   answers `use_immutable_subject: true`, set `github_oidc_subject_prefix` to its `sub_claim_prefix`
   (`repo:<owner>@<owner id>/<name>@<repo id>`); otherwise leave it unset (Deploys: the deploy role's trust).
   Then run `tofu -chdir=infra/envs/dev plan -out dev.tfplan` and
   `tofu -chdir=infra/envs/dev apply dev.tfplan`. This creates the network, the environment key, the database (about
   10 minutes), the empty secrets, ECR, the cluster with every service at 0 tasks (SpiceDB and the API), CloudTrail,
   the GitHub deploy role and its two SSM parameters (and the account's GitHub OIDC provider unless
   `github_oidc_provider_arn` is set), and on Cloudflare the DNS records, the tunnel, the VPC service and Access.
4. **Database bootstrap.** Run `infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql`. It creates
   the IAM logins (the migrator's, the API's and SpiceDB's), their roles and the `spicedb` database, and is safe to
   re-run. It stops with an error if anything the API can reach has owner powers (Database logins). The script sends a
   SQL file without its comment-only and blank lines, which keeps it under the task override's limit; `tofu test`
   checks that every file in `infra/sql/` fits, measured that way.
5. **Secret values**, by hand from files you delete afterwards, never typed on a command line:
   `aws secretsmanager put-secret-value --secret-id oryxa-fde-dev/<name> --secret-string file://<file>`
   for each name in `tofu output secrets` (Secrets). In the WorkOS dashboard, register
   `https://<web_hostname>/auth/callback` as a redirect URI (the API sends the browser back to
   `<WEB_ORIGIN>/auth/callback`, `session.rs:984`); a mismatch fails the first sign-in. Copy the tunnel token from the
   Cloudflare dashboard (Zero Trust, Networks, Tunnels, `oryxa-fde-dev-api`; output `tunnel_id`). With a custom auth
   domain in WorkOS, `workos_issuer` must be that domain in `terraform.tfvars` before step 9's apply, or every sign-in
   is refused (Verify before apply: `WORKOS_ISSUER`); without one, leave it null. A person can sign in only as an
   active member of a WorkOS organisation with the role `admin` or `member`: add them there first.
6. **SpiceDB datastore.** Run `infra/scripts/run-task.sh spicedb-migrate` (`datastore migrate head`,
   IAM auth).
7. **`dev` variables.** Add the variables to the `dev` environment (Deploys, below).
8. **Backend image and migrations.** Run the `deploy-api` workflow on `main`. It pushes the backend image (the API
   and the migrations' binary), runs the store's migrations as `oryxa_fde_migrator` in the migrate task, points the
   API service (still at 0 tasks) at the image, and records the sha for OpenTofu.
9. **Start.** Set `start_services = true`, then plan and apply. SpiceDB and the API each start one task, on the sha
   `deploy-api` recorded (an apply after a complete deploy keeps it: Deploys, drift). The API task starts the API
   container first; cloudflared starts once its health check on `/healthz` passes, and only then connects the tunnel.
10. **SpiceDB schema.** Run `infra/scripts/run-task.sh spicedb-schema schema/fde.zed`. Until this
    runs, every permission check fails closed, and so does the role mirror every signed-in request writes.
11. **The web Worker.** Run the `deploy-workers` workflow on `main` (Deploys).
12. **Smoke test.** The `oryxa-fde-api` service has one running task whose `api` container reports
    `HEALTHY` (`aws ecs describe-tasks`, `containers[].healthStatus`), the tunnel `oryxa-fde-dev-api`
    shows healthy in the Cloudflare dashboard, `https://<web_hostname>` reaches the API through the
    binding, `<admin_hostname>` asks for an Access login, and CloudTrail delivers to its bucket.
    Then run the scripted smoke test (next section).

## Smoke test

`infra/scripts/smoke-test.sh` is one scripted pass against a deployed environment. It goes to the web app's public
address the way a browser does and stops at the first failure with a plain message and a non-zero exit. Needs `bash`,
`curl` and `jq`.

```bash
export SMOKE_BASE_URL=https://<web_hostname>             # exactly the web app's origin (the API's WEB_ORIGIN), for dev e.g. https://fde-dev.<zone>
export SMOKE_SESSION_FILE=~/.oryxa-smoke-session         # the session cookie, see below
infra/scripts/smoke-test.sh
```

It checks, in order: `GET /api/healthz` (no session), then `GET /api/v1/me` (the session is accepted; it prints the
organisation and role). It reads only: it creates nothing and leaves nothing behind.

**The session.** The test signs in as the person who runs it, with the browser session cookie of a **test user in
a test organisation**. Never use a real customer's organisation.

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
strips it from any error text. It prints identifiers and API error codes, never a header or a response body. It sends
`X-Oryxa-Request: 1` on every request, as the web client does (`fde-web/src/forward.ts`); `/api/*` goes to the API with
the `/api` prefix removed. `SMOKE_BASE_URL` must be `https` (plain `http` is accepted for `localhost` only).

`infra/scripts/test-smoke-test.sh` proves the script without a deployed environment: it starts
`infra/scripts/smoke-stub.py` (answers the two routes with canned responses, on a random loopback port, stopped
afterwards) and runs the script against it: a pass, a refused session, an API that does not answer, a session that
rotates mid-run, and the session hand-over checks, including `bash -x` and a verbose `~/.curlrc`. It needs `bash`,
`curl`, `jq` and `python3` only.

## Deploys

Two manual workflows, `workflow_dispatch` only, from `main` only, for `dev` only: every job that
deploys runs in the GitHub environment `dev`, and nothing else can use its credentials. Run them
from the Actions tab on `main`; on any other branch their jobs are skipped.

| Workflow | Does | Uses from `dev` |
| --- | --- | --- |
| `deploy-api` | Builds `oryxa-fde-api` and `oryxa-fde-ops` for `linux/arm64` into one image, pushes it to ECR, runs migrations as the one-off migrate task, then rolls the API service onto it (the tunnel sidecar included in the API's new task; its image does not change) | `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN` |
| `deploy-workers` | `wrangler deploy` for `fde-web`, with dev's route and API binding | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `WEB_HOSTNAME`, `API_VPC_SERVICE_ID`; optional `WEB_OWN_SIGN_IN` |

**What the lead adds once**, in Settings, Environments, New environment `dev`, before the first
apply (Apply order, step 2):
- **Deployment branches:** selected branches, `main`. Required reviewers are optional.
- **Variables** (none is a secret; none goes in the repository):

  | Variable | Value |
  | --- | --- |
  | `AWS_REGION` | `aws_region` from tfvars |
  | `AWS_DEPLOY_ROLE_ARN` | `tofu output -raw github_deploy_role_arn` |
  | `CLOUDFLARE_ACCOUNT_ID` | `cloudflare_account_id` from tfvars |
  | `CLOUDFLARE_ZONE_ID` | `cloudflare_zone_id` from tfvars |
  | `WEB_HOSTNAME` | `tofu output -raw web_hostname`: fde-web's route |
  | `API_VPC_SERVICE_ID` | `tofu output -raw api_vpc_service_id` |
  | `WEB_OWN_SIGN_IN` | Optional. `1` builds fde-web with `VITE_FDE_OWN_SIGN_IN=1` (our own sign-in screens, ADR 0007); unset or any other value leaves them off |
- **Environment secret** `CLOUDFLARE_API_TOKEN`, on `dev` only, never a repository secret: a token
  for this account and zone only, with Account: Workers Scripts Edit and Zone: Workers Routes Edit. Not the
  OpenTofu token. Only the `wrangler deploy` step sees it; installs and builds run without it.

There is no AWS key anywhere. The `deploy` job of `deploy-api` gets a one-hour session for
`oryxa-fde-dev-github-deploy` through GitHub OIDC. Its trust needs both claims to match exactly:
`sub` is `<github_oidc_subject_prefix>:environment:dev` (the prefix is `repo:<github_repository>` unless the variable
is set; with GitHub's immutable subject on, `repo:<owner>@<owner id>/<name>@<repo id>`), and `job_workflow_ref` is
`<github_repository>/.github/workflows/deploy-api.yml@refs/heads/main`. So no other workflow, branch
or environment gets in, even before the environment's branch rule exists. `deploy-workers` needs no
AWS access and cannot assume it. The role may push to the `oryxa-fde-api` repository, register task
definitions that run as the task and execution roles of the API and the migrate task only (`iam:PassRole` names
exactly those four, to ECS tasks only; registering takes no resource, so that is the limit), run the migrate task,
update and describe the API service, and read its deploy parameters (`tests/plan.tftest.hcl` pins all of it). It
cannot touch SpiceDB, the one-off db-admin and zed tasks, or any role outside that list.

**The image** holds the API and `oryxa-fde-ops`, in the one ECR repository `oryxa-fde-api`. The migrate task picks
`oryxa-fde-ops` with `entryPoint`; the API is the image's default. One commit builds one image, so the migrations and
the service run the same sha and cannot disagree about the schema.

**deploy-api, step by step**
1. `build`, a release build, so never with shared caches (`docs/ci.md`): on a clean
   GitHub-hosted runner, with the toolchain `rust-toolchain.toml` pins, no sccache and a fresh
   `CARGO_HOME`, it cross-compiles `oryxa-fde-api` and `oryxa-fde-ops` for `aarch64-unknown-linux-gnu`. It fails if
   either needs a newer glibc than the image's base (2.41).
2. `deploy`, hosted, in `dev`: reads `/oryxa-fde-dev/deploy` (names, subnets, the migrate task's
   security group; written by OpenTofu) and pushes the image tagged with the commit sha. Tags are
   immutable: a sha already in ECR is reused.
3. Registers new revisions of `oryxa-fde-dev-migrate` and `oryxa-fde-dev-api` that differ from the current ones only
   in the image, so env, secrets and roles stay as OpenTofu set them. The API task also holds the cloudflared sidecar
   (#145), so for each family it swaps the image of the one container that runs the ECR repository's image and stops
   if that is not exactly one (zero or several: nothing is guessed). Both are registered before anything changes.
4. Runs the migrate task and stops on a non-zero exit, before the service changes. Migrations must
   therefore work with the image still running (add first, remove in a later deploy).
5. Updates the API service and waits for it to settle (the new task's `api` container must pass its health
   check; "What the load balancer gave", below). The wait is bounded: the AWS CLI's waiter polls every 15 s and gives
   up after 40 tries, 10 minutes, and a service that does not settle on its new revision (the circuit breaker rolled
   it back, which also reads as stable, so the workflow checks the primary deployment) fails the deploy. A service at
   0 tasks (`start_services = false`) reads as stable at once while its rollout is still `IN_PROGRESS`, so that check
   polls every 5 s for up to 2 minutes until the primary deployment is `COMPLETED` on the new revision, and stops at
   once if it is on another revision or `FAILED`.
6. Only when the API settled, writes the sha to `/oryxa-fde-dev/api-image-tag`. OpenTofu reads that
   parameter on every plan, so a later apply keeps the deployed image instead of rolling anything back. To roll back,
   revert the change on `main` and run `deploy-api` again.

**After a deploy, and `tofu apply` (drift).** An apply is needed only when the infrastructure's configuration changes, not
after a deploy. The workflow and OpenTofu both register task definitions in the same families: the workflow copies the
latest revision and changes the image, OpenTofu builds one from the configuration with the image tag in
`/oryxa-fde-dev/api-image-tag`. Since the workflow records the tag only once the API has settled on it, an apply after a
complete deploy builds the same image the service runs, so it never rolls the API back to an older one (what it does
do: it registers a fresh revision that carries the same image and rolls the service onto it once). After a deploy that
stopped partway (no tag was recorded) an apply returns the API to the last complete deploy's sha: fix the cause and run
`deploy-api` again instead. A configuration change applied after a deploy is carried by the next one too, because the
workflow copies the latest revision, which is OpenTofu's. Do not run an apply while `deploy-api` runs (the workflow's
concurrency group stops two deploys, not a deploy and an apply).

**What the load balancer gave, and what replaced it** (#145). The ALB health-checked the API and
registered it only when healthy, drained connections on a rollout, and never took the old task out
before the new one answered. Without it:

| ALB did | Now |
| --- | --- |
| Polled `/healthz`; ECS replaced an unhealthy target | The `api` container has its own health check, `oryxa-fde-ops healthcheck`: one GET to `/healthz` on `LISTEN_ADDR` over loopback that exits 0 only on a 200 and gives up after 2 s. ECS runs it every 10 s with a 5 s timeout, replaces the task after 3 misses, and ignores misses for the first 30 s. The path and address are fixed by the code, not set here |
| Held the old task until the new target was healthy | The service keeps `deployment_minimum_healthy_percent = 100` and `maximum_percent = 200`: ECS starts the new task, counts it healthy once the `api` container's health check passes (cloudflared has none, so it does not count), then stops the old one. The deployment circuit breaker rolls back a task that never gets there. A rollout never runs fewer than one healthy task |
| Kept traffic off a target that was not ready | `cloudflared` has `dependsOn` the `api` container being `HEALTHY`, so the tunnel does not connect until the API answers |
| Drained connections for 30 s on deregistration | ECS stops a task's containers in reverse start order, so cloudflared gets SIGTERM first (per AWS's container dependency docs). It stops taking new requests and lets those in flight finish for up to 30 s (`stopTimeout` 45 s), and only then does the API get SIGTERM and drain in turn (How a task stops, below) |

**What happens to requests during a deploy, honestly.** For a moment two tasks hold two connectors of
one tunnel, and Cloudflare sends each request to either. A request in flight on the old connector
finishes if it takes under 30 s. ECS counts the new task healthy on the API's check alone, so the old connector can
start shutting down a few seconds before the new one has registered with Cloudflare; a request in that gap, or one
routed to the old connector as it begins shutting down, fails with a 502. Nothing closes that window; the web client
retries a read once when the API is mid-deploy (#294). **Every API deploy cuts every long-lived connection through
the API**: a WebSocket or streamed response ends when the old connector's 30 s drain runs out. The API serves no
stream today. The API drains for itself once cloudflared has exited: on SIGTERM it closes its listener, gives requests
in flight `SHUTDOWN_GRACE_SECONDS` to finish, and exits 0 (`crates/oryxa-fde-api/src/shutdown.rs`). Migrations still
run before the service changes.

**How a task stops, and for how long.** Times are measured from the moment ECS stops the task, with the defaults
(`api_shutdown_grace_seconds` 20, cloudflared's `stopTimeout` 45 s). Each container waits up to its own `stopTimeout`
after SIGTERM, and ECS stops a container only after the ones that depend on it have exited.

| After the stop | What happens | Bound |
| --- | --- | --- |
| 0 s | ECS sends SIGTERM to `cloudflared` | |
| 0 to 30 s | cloudflared takes no new request and lets those in flight finish (its own 30 s grace); it exits when they are done | ECS kills it at 45 s |
| `t` (under 30 s, at most 45 s) | cloudflared has exited. ECS sends SIGTERM to `api`: the listener closes, requests in flight drain, the process exits 0 | the grace, 20 s (`SHUTDOWN_GRACE_SECONDS`) |
| `t` + 20 s at most | The API has exited and the task stops | ECS kills it at `t` + 30 s: `stopTimeout` is the grace plus 10 s |

A normal stop ends within about 50 s and the worst case, a cloudflared that has to be killed and an API that runs out
its stop timeout, at 45 + 30 = 75 s. Fargate allows no `stopTimeout` over 120 s and documents no longer total, so the
budget is 120 s for the sequence: the `fargate_service` module refuses a task whose longest sidecar stop timeout plus its
main container's is over it. With cloudflared at 45 s that makes 65 s the largest grace the task accepts, although the
API itself starts with up to 119, so `api_shutdown_grace_seconds` refuses anything over 65 (the module's check stays as a
second guard). The grace and the container's stop timeout both come from `api_shutdown_grace_seconds`, so they cannot
drift apart, and `tests/plan.tftest.hcl` pins the relation and the range against `shutdown.rs`.

Without the workflow, the same steps by hand: push an image, put its sha in
`/oryxa-fde-dev/api-image-tag`, apply, and run `infra/scripts/run-task.sh migrate`.

**deploy-workers.** fde-web deploys with the `wrangler` its lockfile pins. Its `wrangler.jsonc` stays local-only: after
`pnpm build`, the workflow adds dev's settings to the built config: the zone route `<WEB_HOSTNAME>/*` (OpenTofu owns
that DNS record), the `API` binding to the Workers VPC service, and `workers_dev` and preview URLs off, so
`<web_hostname>` is its only address. The web build's one flag comes from a named `dev` variable: `WEB_OWN_SIGN_IN` to
`VITE_FDE_OWN_SIGN_IN`, on only when the variable is exactly `1`. Nothing else is passed through, because every `VITE_`
value is baked into the public bundle and must never be a secret. The job summary lists the flag and whether it is on.
fde-web reads no Worker secret.

**Teardown.**

1. Set `allow_destroy = true`, then plan and apply. This only lifts RDS deletion protection and marks
   the CloudTrail bucket and the ECR repository for emptying on destroy; nothing is deleted yet.
2. Run `tofu -chdir=infra/envs/dev destroy`. It deletes every object version in the CloudTrail bucket and every
   image in ECR.

What stays behind:
- RDS keeps a final snapshot named `oryxa-fde-dev-final-<time the instance was created>`, so a
  second teardown never collides with the first. It is encrypted with the environment key, which
  is scheduled for deletion in 30 days: restore or copy it to another key before then, or it
  becomes unreadable.
- Secrets stay recoverable for 7 days. To rebuild within that window, restore them
  (`aws secretsmanager restore-secret`) and `tofu import` them, or the first apply fails on their names.
- The fde-web Worker: delete it with `wrangler delete` if the environment is gone for good.

## Mumbai (ap-south-1)

The founder chose Mumbai for the first environment (#144). Read from AWS's own pages on 10 November 2026; service
availability changes, so `tofu plan` and an apply are still the test.

| What the infra uses | In Mumbai? | Source |
| --- | --- | --- |
| ECS Fargate, Linux | In Mumbai | [Fargate Regions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate-Regions.html) lists `ap-south-1` |
| Fargate on ARM64 | In Mumbai (no exception listed) | [ARM64 task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-arm64.html): the only Fargate exception is `use1-az3`; the [price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-south-1/index.json) has Fargate ARM vCPU and memory SKUs for Mumbai |
| RDS PostgreSQL 17 on `db.t4g.micro` | In Mumbai. The class and engine pairing is from the docs; Mumbai from AWS's T4g announcement and the price list | [DB engines per instance class](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Support.html) (`db.t4g.micro`: all PostgreSQL 17 versions); [T4g in 28 Regions incl. Mumbai, Aug 2023](https://aws.amazon.com/about-aws/whats-new/2023/08/amazon-rds-t4g-instances-6-regions/); [RDS price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-south-1/index.json) has `db.t4g.micro` PostgreSQL Single-AZ. AWS has no per-Region table for this pairing: `aws rds describe-orderable-db-instance-options --engine postgres --engine-version 17 --db-instance-class db.t4g.micro --region ap-south-1` is the check |
| fck-nat AMI (`fck-nat-al2023-*-arm64-ebs`, owner `568608671756`) | In Mumbai | [fck-nat's published Region list](https://github.com/AndrewGuenther/fck-nat/blob/main/packer/fck-nat-public-all-regions.pkrvars.hcl) includes `ap-south-1` (last changed 31 May 2026); the owner id is in [its deploy guide](https://fck-nat.dev/stable/deploying/). The list says what the build publishes; `aws ec2 describe-images --owners 568608671756 --filters 'Name=name,Values=fck-nat-al2023-*-arm64-ebs' --region ap-south-1` is the check |
| `t4g.nano` (the NAT), KMS, Secrets Manager, Cloud Map, CloudTrail, ECR, S3 | In Mumbai | each has Mumbai SKUs in AWS's price list for `ap-south-1` (the Monthly cost estimate below links them by name) |

Not offered in Mumbai: nothing the infra creates.

## Monthly dev cost estimate

`ap-south-1` list prices, 730 hours a month, dev traffic, in US dollars. Prices were read on 10 November 2026
from AWS's public price lists (`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/ap-south-1/index.json`;
the Checked column names the offer and its publication date). Check against the AWS pricing calculator before apply.

| Item | Assumption | $/month | Checked |
| --- | --- | --- | --- |
| Fargate: oryxa-fde-api (with the cloudflared sidecar), SpiceDB | 2 tasks, each 0.25 vCPU + 0.5 GB ARM64, always on ($0.02383 per vCPU-hour, $0.00261 per GB-hour: $5.30 each) | 10.60 | AmazonECS, 19 Oct |
| RDS PostgreSQL | `db.t4g.micro` single-AZ ($0.021 an hour: $15.33), 20 GB gp3 ($0.131 a GB: $2.62), backups inside the free allowance | 18 | AmazonRDS, 29 Oct |
| NAT instance | fck-nat on `t4g.nano` ($0.0028 an hour: $2.04), its public IPv4 ($0.005 an hour: $3.65), 8 GB gp3 root volume ($0.0912 a GB: $0.73), and an assumed 10 GB or less a month out to the internet at $0.1093 a GB | 6.50 to 8 | AmazonEC2, 7 Nov; AmazonVPC, 5 Nov; AWSDataTransfer, 3 Nov; the root volume's size and the traffic are assumptions |
| Secrets Manager | 4 secrets + the RDS master secret at $0.40 | 2 | AWSSecretsManager, 11 Sep |
| KMS | environment key + CloudTrail key at $1, requests at $0.03 per 10,000 | 2 to 2.50 | awskms, 8 Nov |
| Cloud Map | private DNS namespace (a Route 53 zone, $0.50) + 1 instance ($0.10) | 0.60 | instance: AWSCloudMap, 6 Nov; the hosted zone's price is global and **was not rechecked** |
| CloudWatch Logs | 14-day retention, about 1 to 3 GB a month ingested at $0.67 a GB, storage $0.03 a GB-month | 1 to 2 | AmazonCloudWatch, 4 Nov; the volume is an assumption |
| CloudTrail | first trail's management events are free; no data events | 0 | AWSCloudTrail, 2 Nov |
| S3 (trail logs), ECR (under 1 GB) | low volume, S3 $0.025 a GB-month, ECR $0.10 a GB-month | 0.50 to 1 | AmazonS3, 9 Nov; AmazonECR, 11 Sep |
| S3 gateway endpoint, one-off tasks | free; one-off tasks bill seconds | 0 | not rechecked (free) |
| Cloudflare Workers Paid | the account's plan; whether fde-web alone still needs it (Workers VPC may) was **not rechecked** | 5 | not AWS |
| Cloudflare Tunnel, Workers VPC, Access (under 50 users), DNS | free tiers; confirm Workers VPC pricing | 0 | not AWS; unchanged |
| **Total** | | **about $46 to 50** | |

With `start_services = false` the tasks cost nothing, so the total is about $36 to 39. If the
account already has a CloudTrail trail, this trail's management events add about $2 to 5 (that rate was not
rechecked). Removed by #298: the ingest worker ($12.51), the data bucket's share of S3 and CloudTrail data events,
the queues and the bus, and the event signing secret; with them the total was about $60 to 65.

Compared with the platform's $38 to 50, the difference is an always-on API on Fargate plus an RDS
instance instead of Lambda and scale-to-zero Aurora (ADR 0003). Cuts that are left, each with a cost:

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
  it refuses an `A`/`AAAA` at a name that has a CNAME. So, before the first apply, for each of `web_hostname` and
  `admin_hostname`, check that the zone has **no record of any type** at that exact name, and that the Zero Trust
  dashboard has no Access application and no Worker route or custom domain on it. With `CLOUDFLARE_API_TOKEN` in the
  environment and the zone's id (the token is passed as a header file, not an argument, so `ps` never shows it):
  `curl -s -H @<(printf 'Authorization: Bearer %s' "$CLOUDFLARE_API_TOKEN") "https://api.cloudflare.com/client/v4/zones/<cloudflare_zone_id>/dns_records?name=<host name>" | jq '.result | length'`
  must print `0` for each name. The check is by exact name: records at other names, the production ones included, are not
  affected, and a web name equal to the zone itself would sit on the apex, where records usually exist.
- **Workers VPC reaching the loopback.** `cloudflare_connectivity_directory_service` (provider 5.27) is
  set to `ipv4 = "127.0.0.1"` on `http_port = api_port`, reached through the tunnel (`network.tunnel_id`):
  the connector's own loopback, which is the API's, because the sidecar shares its task's network. If Workers VPC ever
  refuses a loopback address, try `hostname = "localhost"` with `resolver_network = { tunnel_id = ... }` (a three-line
  change in `modules/cloudflare`); if neither is accepted, the fallback is a separate cloudflared service reaching the
  API through Cloud Map (the other option in #145).
- **Health check and start order.** The API container's health check runs `/usr/local/bin/oryxa-fde-ops healthcheck`
  (the image has no shell). The binary's own test (`crates/oryxa-fde-api/tests/shutdown.rs`) shows exit 0 on a 200 and 1
  on anything else. After a deploy, confirm that the `api` container reaches `HEALTHY` and that cloudflared waits for it
  (`describe-tasks`). The shutdown order (cloudflared first) is from AWS's `dependsOn` docs ("for container shutdown it
  is reversed"); the CloudWatch streams (`api/` and `cloudflared/` in `/ecs/oryxa-fde-dev-api`) show whether the tunnel
  drained first and how long each took, and whether the API logged its drain before it exited (How a task stops).
- **fck-nat AMI owner** `568608671756` is the one fck-nat's deploy guide gives. That the AMI exists in
  Mumbai is the project's published Region list; run the `describe-images` check in Mumbai (ap-south-1) first.
- **zed task.** `authzed/zed:v1.14.0-debug` (busybox shell, ARM64 confirmed on ghcr.io) reads the
  key from `ZED_TOKEN` through zed's `ZED_` env flag binding. If zed reports no token, that binding
  did not apply.
- **Docker Hub pulls** (SpiceDB, cloudflared, zed) are anonymous and rate-limited per NAT IP. An ECR
  pull-through cache fixes it if it bites. SpiceDB and zed are pinned by tag; cloudflared by digest (it
  holds the API's role).
- **Deploy role.** `ecs:RegisterTaskDefinition` and `ecs:DescribeTaskDefinition` take `*` (not
  scoped to a family); `iam:PassRole` on the roles of the API and the migrate task (four roles) is what limits a new
  revision. If the account already has a GitHub OIDC provider, set `github_oidc_provider_arn` or the first apply fails
  on it. The trust's `job_workflow_ref` condition relies on STS validating that GitHub claim (supported for
  GitHub since 2025). If a `deploy-api` run is refused at `AssumeRoleWithWebIdentity`, compare the trust with the
  token's claims; the failure is closed, never open. Found on the first dev deploy (#196): this repository has
  GitHub's immutable subject on, so the token's `sub` is `repo:<owner>@<owner id>/<name>@<repo id>:environment:dev`
  and the name-only `sub` the role then trusted refused it. `github_oidc_subject_prefix` now carries that prefix
  (Apply order, step 3). The immutable setting changes `sub` only: `job_workflow_ref` still names the owner and
  repository, not their ids.
- **Cloudflare token for deploys.** The permission names (and whether binding a Workers VPC service needs a
  Connectivity Directory permission too) are from the docs; a `deploy-workers` run confirms them.
- **RDS in Mumbai.** AWS has no per-Region table for PostgreSQL 17 on `db.t4g.micro`; the
  `describe-orderable-db-instance-options` command in Mumbai (ap-south-1) answers it before the first apply.
- **`WORKOS_ISSUER`.** The token's `iss` is pinned exactly (`oryxa-authn/src/workos_jwt.rs:82`). Unset, the API
  derives it from the client id (`session.rs:914`): `https://api.workos.com/user_management/<client id>`,
  which a standard WorkOS environment (no custom auth domain) issues, as
  `https://api.workos.com/user_management/<client id>/.well-known/openid-configuration` shows. Leave `workos_issuer`
  null there; setting it to that value is harmless. If the WorkOS environment uses a custom auth domain, the issuer is
  that domain: set `workos_issuer` to it. Either way, a wrong issuer refuses every sign-in with `401 unauthorized` at
  `/auth/callback`.
- **Who can sign in.** A person can sign in only as an active member of a WorkOS organisation with the role `admin`
  or `member`. Add each person to the organisation in the WorkOS dashboard, with one of those roles, before their
  first sign-in.

## Known limits (dev only)

- `ponytail:` one NAT instance, single-AZ RDS and one SpiceDB task, with no failover.
- `ponytail:` plaintext hops inside the VPC, limited by security groups: the API to SpiceDB (gRPC).
  The tunnel to the API is loopback inside one task. SpiceDB reaches RDS with `sslmode=require`, which
  does not verify the CA. Prod adds TLS on each hop and the RDS CA bundle.
- Tasks may reach any host on 443 through the NAT. The application's outbound allowlist
  (CLAUDE.md) is the control; a network firewall is a prod decision.
- No customer data store exists: no data bucket and no per-company keys since #298. Whatever brings customer data
  back brings per-company keys with it first (ADR 0003).
- `ponytail:` the API and the tunnel connector share one 0.25 vCPU / 512 MiB task (`api_cpu`, `api_memory`).
  cloudflared is small, but a busy tunnel and a busy API compete; raise the task, not one container.
- `ponytail:` no health check on cloudflared itself: a connector that is running but not connected is not
  replaced (the standalone service had none either). A crashed one stops the task, and ECS replaces it.
- A rollout can fail a request in the seconds the old connector shuts down before the new one registers, and
  cuts every stream or WebSocket through the API (Deploys, "What the load balancer gave").
- `ponytail:` cloudflared shares the API task's role and security group. It makes no AWS call, but a
  compromised connector gets the API's credentials (`rds-db:connect` as the API and its Secrets Manager reads), where
  the separate service had a role with no permissions. Its image is pinned by digest for that reason. Prod runs the
  connector as its own service with an empty role, reaching the API through an internal load balancer
  (`modules/internal_alb`) or Cloud Map, with an ingress rule from the connector's group only.
- ECR lives in the dev stack until a second environment needs it.

## Contracts with other streams

- **API (`crates/oryxa-fde-api`)** gets the env names its code reads, listed with file and line in
  The environment contract above; `tests/plan.tftest.hcl` reads that table.
  - **The database: IAM authentication** (lead decision on #37), no stored passwords. Infra gives the
    service and the migrate task `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER` (`oryxa_fde_api` and
    `oryxa_fde_migrator`), and each task role may `rds-db:connect` as its own login only. The API
    and `oryxa-fde-ops` sign in with IAM tokens when those four are set (`store/src/iam.rs`); local
    and test runs keep `DATABASE_URL` (and `MIGRATION_DATABASE_URL`).
  - **Migrations run as a one-off task, never at startup** (#32, #39). The migrate task runs
    `oryxa-fde-ops migrate` from the API's image (`/usr/local/bin/oryxa-fde-ops`, beside
    `/usr/local/bin/oryxa-fde-api`), connected as `oryxa_fde_migrator`, and exits 0 when done. The
    service connects as `oryxa_fde_api`, a member of `oryxa_fde_runtime` only, so every query runs
    inside a transaction that took a transaction role. The bootstrap creates those roles and `oryxa_fde_runtime`,
    so no login needs CREATEROLE, and the migrator holds the transaction roles with admin option for migration 0001.
  - It serves `GET /healthz` without auth (the container health check and the deploy rely on it), listens where
    `LISTEN_ADDR` says (`127.0.0.1:<api_port>` in dev; the tunnel sidecar is its only client), and writes nothing to
    its root filesystem, which is read-only. Infra builds the image (`deploy-api`) from the two binaries:
    `oryxa-fde-api` is the entrypoint, the migrate task runs `/usr/local/bin/oryxa-fde-ops migrate` and the API's
    container health check `/usr/local/bin/oryxa-fde-ops healthcheck`. A new binary in the image is an infra change
    first (the Dockerfile, `deploy-api` and `tests/code` together).
- **Web (`fde-web/`).** `deploy-workers` adds the `API` binding (`env.API`, the Workers VPC service) and the zone route
  on `<web_hostname>` to the built config at deploy time, so `wrangler.jsonc` keeps no dev values.

## Checks

```bash
tofu fmt -check -recursive infra
tofu -chdir=infra/envs/dev init -backend=false
tofu -chdir=infra/envs/dev validate
tofu -chdir=infra/envs/dev test      # mock providers: no credentials, no cloud calls; checks the API task against the contract table
shellcheck infra/scripts/*.sh
bash infra/scripts/test-smoke-test.sh # the smoke test against a local stub; no environment needed
actionlint                            # the workflows
```

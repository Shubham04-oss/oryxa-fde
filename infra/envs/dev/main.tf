# Dev composition (ADR 0003). Variables, apply order and costs: infra/README.md.
# Secrets live in Secrets Manager and are put there by hand; this config creates the empty secrets
# and grants each task read access to exactly the ones it uses, so no secret enters config or state.
# Since #298 it holds what sign-in needs and nothing else (#296 stripped the code to sign-in).

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  prefix  = "oryxa-fde-${var.env}"
  account = data.aws_caller_identity.current.account_id
  region  = data.aws_region.current.region
  subnets = module.network.private_subnet_ids
  desired = var.start_services ? 1 : 0

  # IAM database auth: each task connects as its own Postgres user (infra/sql/01-bootstrap.sql),
  # and its task role may connect as that user only. No database password exists for services.
  # The migrator owns the tables; only the one-off migrate task may connect as it, never the API.
  db_name = "oryxa_fde"
  db_user = {
    api     = "oryxa_fde_api"
    migrate = "oryxa_fde_migrator"
    spicedb = "spicedb"
  }
  db_user_arn = {
    for k, u in local.db_user : k => "arn:aws:rds-db:${local.region}:${local.account}:dbuser:${module.db.resource_id}/${u}"
  }

  # SpiceDB is reached inside the VPC only, by private DNS (Cloud Map).
  namespace        = "${local.prefix}.internal"
  spicedb_endpoint = "http://spicedb.${local.namespace}:50051"

  # Tasks reach AWS APIs, image registries and WorkOS over HTTPS through the NAT instance.
  https_out = { https = { port = 443, cidr = "0.0.0.0/0" } }
  # The tunnel connector dials out to Cloudflare on 7844 through the NAT; nothing dials in.
  tunnel_out = {
    tunnel-tcp = { port = 7844, protocol = "tcp", cidr = "0.0.0.0/0" }
    tunnel-udp = { port = 7844, protocol = "udp", cidr = "0.0.0.0/0" }
  }
  db_out = { postgres = { port = 5432, security_group_id = module.db.security_group_id } }

  # Secrets Manager, one secret per value, created empty; the owner sets values by hand. Only what sign-in reads.
  secrets = {
    "api/workos-api-key"           = "WorkOS API key: oryxa-fde-api sign-in"
    "api/session-password"         = "64 hex characters that seal the session cookie: oryxa-fde-api"
    "shared/spicedb-preshared-key" = "SpiceDB preshared key: SpiceDB and oryxa-fde-api"
    "cloudflared/tunnel-token"     = "Cloudflare Tunnel token: the cloudflared sidecar of the oryxa-fde-api task"
  }
  secret_arn = { for k, s in aws_secretsmanager_secret.this : k => s.arn }

  # Env name => secret the API task gets it from (the API contract, infra/README.md).
  api_secrets = {
    WORKOS_API_KEY        = "api/workos-api-key"
    SESSION_PASSWORD      = "api/session-password"
    SPICEDB_PRESHARED_KEY = "shared/spicedb-preshared-key"
  }

  # Plain configuration the API reads (the contract). WORKOS_ISSUER only when one is set.
  api_environment = merge(
    {
      AWS_REGION  = local.region
      LISTEN_ADDR = "127.0.0.1:${var.api_port}" # the tunnel sidecar is the only client, and the health check calls it
      # How long the API drains after SIGTERM (shutdown.rs); its container's stop timeout is derived from it.
      SHUTDOWN_GRACE_SECONDS = tostring(var.api_shutdown_grace_seconds)
      DB_HOST                = module.db.address
      DB_PORT                = tostring(module.db.port)
      DB_NAME                = local.db_name
      DB_USER                = local.db_user["api"]
      SPICEDB_ENDPOINT       = local.spicedb_endpoint
      WORKOS_CLIENT_ID       = var.workos_client_id
      WEB_ORIGIN             = "https://${module.cloudflare.web_hostname}"
    },
    var.workos_issuer != null ? { WORKOS_ISSUER = var.workos_issuer } : {},
  )

  # Who the NAT instance carries for: HTTPS out for every task, and the tunnel's port for the API task's connector.
  nat_https_clients = {
    api      = module.api.security_group_id
    spicedb  = module.spicedb.security_group_id
    db_admin = module.db_admin.security_group_id
    migrate  = module.migrate.security_group_id
    zed      = module.zed.security_group_id
  }
  nat_tunnel_clients = { api = module.api.security_group_id }
  # Who reaches the database on 5432, and SpiceDB on 50051.
  db_clients = {
    api      = module.api.security_group_id
    spicedb  = module.spicedb.security_group_id
    db_admin = module.db_admin.security_group_id
    migrate  = module.migrate.security_group_id
  }
  spicedb_clients = { api = module.api.security_group_id, zed = module.zed.security_group_id }

  # The API service and the one-off migrate task run one image, at the sha last deployed (deploy.tf).
  api_image = "${aws_ecr_repository.api.repository_url}:${data.aws_ssm_parameter.api_image_tag.insecure_value}"
}

# ---------------------------------------------------------------- keys and secrets

# General key: RDS storage, the RDS master secret and Secrets Manager. Every grant to it is limited by
# kms:ViaService.
resource "aws_kms_key" "this" {
  description             = "${local.prefix} key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_secretsmanager_secret" "this" {
  for_each                = local.secrets
  name                    = "${local.prefix}/${each.key}"
  description             = each.value
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = 7
}

# ---------------------------------------------------------------- network

module "network" {
  source              = "../../modules/vpc"
  name                = local.prefix
  cidr                = var.vpc_cidr
  interface_endpoints = var.interface_endpoints
  nat_https_clients   = local.nat_https_clients
  # The tunnel connector is the API task's sidecar, so the API's group is the one that dials out.
  nat_tunnel_clients = local.nat_tunnel_clients
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = local.namespace
  vpc  = module.network.vpc_id
}

resource "aws_service_discovery_service" "spicedb" {
  name = "spicedb"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# ---------------------------------------------------------------- database

# Private subnets. 5432 only from the API, SpiceDB and the one-off db-admin and migrate tasks.
module "db" {
  source                  = "../../modules/postgres"
  name                    = local.prefix
  database_name           = local.db_name
  instance_class          = var.db_instance_class
  kms_key_arn             = aws_kms_key.this.arn
  vpc_id                  = module.network.vpc_id
  subnet_ids              = local.subnets
  deletion_protection     = !var.allow_destroy
  allowed_security_groups = local.db_clients
}

# ---------------------------------------------------------------- compute

resource "aws_ecs_cluster" "this" {
  name = local.prefix

  setting {
    name  = "containerInsights"
    value = "disabled" # cost; task logs still go to CloudWatch
  }
}

# One repository for the API image. ponytail: lives in the dev stack until a second environment
# needs it; then it moves to a shared stack and dev imports it.
resource "aws_ecr_repository" "api" {
  name                 = "oryxa-fde-api"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.allow_destroy

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

# The API reaches AWS for one thing: an IAM token to sign in to the database as its own login.
data "aws_iam_policy_document" "api" {
  statement {
    sid       = "ConnectAsOwnUser"
    actions   = ["rds-db:connect"]
    resources = [local.db_user_arn["api"]]
  }
}

# One task, two containers: the API, and cloudflared, the Workers VPC tunnel's connector. They share a
# network namespace, so the tunnel reaches the API on 127.0.0.1 and the API listens nowhere else: no
# security group admits anything to this task, and there is no load balancer. cloudflared starts only
# once the API's own health check passes, stops before it, and a task that fails either is replaced.
# The environment is the API contract in infra/README.md (read from the code; tests/plan.tftest.hcl
# checks this task against that table), except the database: IAM database auth (lead decision on #37),
# so DB_* replace the DATABASE_URL that local and test runs use.
module "api" {
  source              = "../../modules/fargate_service"
  name                = "${local.prefix}-api"
  service_name        = "oryxa-fde-api"
  cluster_arn         = aws_ecs_cluster.this.arn
  container_name      = "api"
  image               = local.api_image
  ecr_repository_arns = [aws_ecr_repository.api.arn]
  cpu                 = var.api_cpu
  memory              = var.api_memory
  kms_key_arn         = aws_kms_key.this.arn
  vpc_id              = module.network.vpc_id
  subnet_ids          = local.subnets
  egress = merge(local.https_out, local.db_out, local.tunnel_out, {
    spicedb = { port = 50051, security_group_id = module.spicedb.security_group_id }
  })
  environment   = local.api_environment
  secrets       = { for env, k in local.api_secrets : env => { arn = local.secret_arn[k] } }
  task_policies = { api = data.aws_iam_policy_document.api.json }
  # The API's own check (`oryxa-fde-ops healthcheck`, health.rs): one GET to /healthz on LISTEN_ADDR over loopback,
  # exit 0 only on a 200, gives up after 2 s. The path and address are fixed by the code, so nothing here names them.
  # ECS's timeout is longer than the 2 s so the check's own exit code arrives first; 3 misses at 10 s apart replace the task.
  health_check = {
    command      = ["/usr/local/bin/oryxa-fde-ops", "healthcheck"]
    interval     = 10
    timeout      = 5
    retries      = 3
    start_period = 30
  }
  # ECS stops cloudflared first (it drains for up to 30 s, killed at 45 s), then sends the API SIGTERM; the API
  # drains for the grace and ECS kills it 10 s after that. The module checks the two add up to 120 s or less.
  stop_timeout = var.api_shutdown_grace_seconds + 10
  sidecars = {
    cloudflared = {
      image   = var.cloudflared_image
      command = ["tunnel", "--no-autoupdate", "run"]
      secrets = { TUNNEL_TOKEN = { arn = local.secret_arn["cloudflared/tunnel-token"] } }
      # cloudflared drains requests in flight for 30 s after SIGTERM; ECS kills it at stop_timeout.
      stop_timeout = 45
    }
  }
  desired_count      = local.desired
  log_retention_days = var.log_retention_days
}

data "aws_iam_policy_document" "spicedb" {
  statement {
    sid       = "ConnectAsOwnUser"
    actions   = ["rds-db:connect"]
    resources = [local.db_user_arn["spicedb"]]
  }
}

# Postgres datastore in its own database, IAM auth like the services. Reached by the API and the one-off zed task only.
# ponytail: plaintext gRPC inside the VPC (security groups admit only the API and zed) and
# sslmode=require without CA verification to RDS; prod adds SpiceDB TLS and the RDS CA bundle.
module "spicedb" {
  source         = "../../modules/fargate_service"
  name           = "${local.prefix}-spicedb"
  cluster_arn    = aws_ecs_cluster.this.arn
  container_name = "spicedb"
  image          = var.spicedb_image
  port           = 50051
  command = [
    "serve",
    "--grpc-addr", ":50051",
    "--http-enabled=false",
    "--datastore-engine", "postgres",
    "--datastore-credentials-provider-name", "aws-iam",
    # db.t4g.micro allows about 80 connections; the defaults would hold 30 idle.
    "--datastore-conn-pool-read-max-open", "8",
    "--datastore-conn-pool-read-min-open", "1",
    "--datastore-conn-pool-write-max-open", "4",
    "--datastore-conn-pool-write-min-open", "1",
  ]
  environment = {
    AWS_REGION = local.region
    SPICEDB_DATASTORE_CONN_URI = format(
      "postgres://%s@%s:%s/spicedb?sslmode=require", local.db_user["spicedb"], module.db.address, module.db.port,
    )
  }
  secrets            = { SPICEDB_GRPC_PRESHARED_KEY = { arn = local.secret_arn["shared/spicedb-preshared-key"] } }
  kms_key_arn        = aws_kms_key.this.arn
  vpc_id             = module.network.vpc_id
  subnet_ids         = local.subnets
  ingress            = local.spicedb_clients
  egress             = merge(local.https_out, local.db_out)
  task_policies      = { spicedb = data.aws_iam_policy_document.spicedb.json }
  service_registry   = { arn = aws_service_discovery_service.spicedb.arn }
  desired_count      = local.desired
  single_task        = true # one task: never two against the same datastore during a deploy
  log_retention_days = var.log_retention_days
}

# One-off tasks the owner starts with infra/scripts/run-task.sh: the database and SpiceDB have no
# public endpoint and there is no bastion. db-admin and zed read their input from a base64 env override.

# psql for the bootstrap SQL. The only thing that reads the RDS master secret.
module "db_admin" {
  source         = "../../modules/fargate_service"
  name           = "${local.prefix}-db-admin"
  run_as_service = false
  cluster_arn    = aws_ecs_cluster.this.arn
  container_name = "psql"
  image          = "public.ecr.aws/docker/library/postgres:17-alpine"
  entry_point    = ["sh", "-c"]
  command        = ["printf '%s' \"$SQL_B64\" | base64 -d | psql -v ON_ERROR_STOP=1"]
  environment = {
    PGHOST     = module.db.address
    PGPORT     = tostring(module.db.port)
    PGDATABASE = local.db_name
    PGSSLMODE  = "require"
  }
  secrets = {
    PGUSER     = { arn = module.db.master_secret_arn, key = "username" }
    PGPASSWORD = { arn = module.db.master_secret_arn, key = "password" }
  }
  kms_key_arn        = aws_kms_key.this.arn
  vpc_id             = module.network.vpc_id
  subnet_ids         = local.subnets
  egress             = merge(local.https_out, local.db_out)
  log_retention_days = var.log_retention_days
}

data "aws_iam_policy_document" "migrate" {
  statement {
    sid       = "ConnectAsOwnUser"
    actions   = ["rds-db:connect"]
    resources = [local.db_user_arn["migrate"]]
  }
}

# The store's migrations: `oryxa-fde-ops migrate` from the API's image, connected as the migrator,
# which owns the tables. Only this task's role may connect as the migrator, so the running API can
# never take the owner's place and turn row-level security off.
module "migrate" {
  source              = "../../modules/fargate_service"
  name                = "${local.prefix}-migrate"
  run_as_service      = false
  cluster_arn         = aws_ecs_cluster.this.arn
  container_name      = "migrate"
  image               = local.api_image
  ecr_repository_arns = [aws_ecr_repository.api.arn]
  entry_point         = ["/usr/local/bin/oryxa-fde-ops"]
  command             = ["migrate"]
  environment = {
    AWS_REGION = local.region
    DB_HOST    = module.db.address
    DB_PORT    = tostring(module.db.port)
    DB_NAME    = local.db_name
    DB_USER    = local.db_user["migrate"]
  }
  kms_key_arn        = aws_kms_key.this.arn
  vpc_id             = module.network.vpc_id
  subnet_ids         = local.subnets
  egress             = merge(local.https_out, local.db_out)
  task_policies      = { migrate = data.aws_iam_policy_document.migrate.json }
  log_retention_days = var.log_retention_days
}

# zed for `zed schema write schema/fde.zed`. The -debug image adds the shell; zed reads the schema
# from stdin and the preshared key from ZED_TOKEN, so the key never appears in a command line.
module "zed" {
  source         = "../../modules/fargate_service"
  name           = "${local.prefix}-zed"
  run_as_service = false
  cluster_arn    = aws_ecs_cluster.this.arn
  container_name = "zed"
  image          = "authzed/zed:v1.14.0-debug"
  entry_point    = ["sh", "-c"]
  command        = ["printf '%s' \"$SCHEMA_B64\" | base64 -d | zed schema write --endpoint \"$SPICEDB_ADDR\" --insecure"]
  read_only_root = false # zed may write its config directory
  environment    = { SPICEDB_ADDR = "spicedb.${local.namespace}:50051" }
  secrets        = { ZED_TOKEN = { arn = local.secret_arn["shared/spicedb-preshared-key"] } }
  kms_key_arn    = aws_kms_key.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = local.subnets
  egress = merge(local.https_out, {
    spicedb = { port = 50051, security_group_id = module.spicedb.security_group_id }
  })
  log_retention_days = var.log_retention_days
}

# ---------------------------------------------------------------- audit

module "cloudtrail" {
  source        = "../../modules/cloudtrail"
  name          = local.prefix
  bucket_name   = var.cloudtrail_bucket_name
  force_destroy = var.allow_destroy
}

# ---------------------------------------------------------------- cloudflare

module "cloudflare" {
  source         = "../../modules/cloudflare"
  account_id     = var.cloudflare_account_id
  zone_id        = var.cloudflare_zone_id
  name           = local.prefix
  web_hostname   = var.web_hostname
  admin_hostname = var.admin_hostname
  api_port       = var.api_port
  admin_emails   = var.admin_emails
}

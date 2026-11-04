# Dev composition (ADR 0003). Variables, apply order and costs: infra/README.md.
# Secrets live in Secrets Manager and are put there by hand; this config creates the empty secrets
# and grants each task read access to exactly the ones it uses, so no secret enters config or state.

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  prefix  = "oryxa-fde-${var.env}"
  account = data.aws_caller_identity.current.account_id
  region  = data.aws_region.current.region
  subnets = module.network.private_subnet_ids
  desired = var.start_services ? 1 : 0

  # IAM database auth: each service connects as its own Postgres user (infra/sql/01-bootstrap.sql),
  # and its task role may connect as that user only. No database password exists for services.
  db_name = "oryxa_fde"
  db_user = { api = "oryxa_fde_api", spicedb = "spicedb" }
  db_user_arn = {
    for k, u in local.db_user : k => "arn:aws:rds-db:${local.region}:${local.account}:dbuser:${module.db.resource_id}/${u}"
  }

  # SpiceDB is reached inside the VPC only, by private DNS (Cloud Map).
  namespace        = "${local.prefix}.internal"
  spicedb_endpoint = "http://spicedb.${local.namespace}:50051"

  # Tasks reach AWS APIs, image registries and WorkOS over HTTPS through the NAT instance.
  https_out = { https = { port = 443, cidr = "0.0.0.0/0" } }
  db_out    = { postgres = { port = 5432, security_group_id = module.db.security_group_id } }

  # Secrets Manager, one secret per value, created empty; the owner sets values by hand.
  secrets = {
    "api/workos-api-key"           = "WorkOS API key: oryxa-fde-api sign-in"
    "api/event-signing-key"        = "Event signing private key (PEM): oryxa-fde-api outbox relay"
    "shared/spicedb-preshared-key" = "SpiceDB preshared key: SpiceDB and oryxa-fde-api"
    "cloudflared/tunnel-token"     = "Cloudflare Tunnel token: cloudflared"
  }
  secret_arn = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

# ---------------------------------------------------------------- keys and secrets

# General key: RDS storage, the RDS master secret, Secrets Manager and the data bucket. Every grant
# to it is limited by kms:ViaService.
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
  nat_https_clients = {
    api         = module.api.security_group_id
    spicedb     = module.spicedb.security_group_id
    cloudflared = module.cloudflared.security_group_id
    db_admin    = module.db_admin.security_group_id
    zed         = module.zed.security_group_id
  }
  nat_tunnel_clients = { cloudflared = module.cloudflared.security_group_id }
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

# ---------------------------------------------------------------- data

# One prefix per company: tenants/<tenant id>/companies/<company id>/. The API's role can touch
# objects under that shape only; which company a request may reach is the API's CompanyScope check.
module "data_bucket" {
  source      = "../../modules/s3"
  name        = var.data_bucket_name
  kms_key_arn = aws_kms_key.this.arn
}

# Private subnets. 5432 only from the API, SpiceDB and the one-off db-admin task.
module "db" {
  source              = "../../modules/postgres"
  name                = local.prefix
  database_name       = local.db_name
  instance_class      = var.db_instance_class
  kms_key_arn         = aws_kms_key.this.arn
  vpc_id              = module.network.vpc_id
  subnet_ids          = local.subnets
  deletion_protection = var.db_deletion_protection
  allowed_security_groups = {
    api      = module.api.security_group_id
    spicedb  = module.spicedb.security_group_id
    db_admin = module.db_admin.security_group_id
  }
}

# ---------------------------------------------------------------- events

# One FIFO queue, DLQ and undelivered queue per consumer. Each consumer's bus subscriber and its
# receive permission arrive with the consumer (wave 2); nothing reads these queues yet.
module "queue" {
  source            = "../../modules/sqs_fifo"
  for_each          = var.consumers
  name              = "${local.prefix}-${each.key}"
  undelivered_queue = true
}

module "eventbridge" {
  source              = "../../modules/eventbridge"
  name                = local.prefix
  bus_arn             = var.event_bus_arn
  consumer_queue_arns = flatten([for q in module.queue : [q.arn, q.undelivered_arn]])
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

module "alb" {
  source                   = "../../modules/internal_alb"
  name                     = "${local.prefix}-api"
  vpc_id                   = module.network.vpc_id
  subnet_ids               = local.subnets
  clients                  = { cloudflared = module.cloudflared.security_group_id }
  target_security_group_id = module.api.security_group_id
  target_port              = var.api_port
  health_check_path        = var.api_health_check_path
}

data "aws_iam_policy_document" "api" {
  source_policy_documents = [module.eventbridge.publish_policy_json]

  statement {
    sid       = "ConnectAsOwnUser"
    actions   = ["rds-db:connect"]
    resources = [local.db_user_arn["api"]]
  }

  statement {
    sid       = "CompanyFiles"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${module.data_bucket.arn}/tenants/*/companies/*"]
  }

  statement {
    sid       = "ListCompanyFiles"
    actions   = ["s3:ListBucket"]
    resources = [module.data_bucket.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["tenants/*/companies/*"]
    }
  }

  statement {
    sid       = "FileKeyViaS3"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }
}

# Reached only through the internal ALB. Env names match crates/oryxa-fde-api/src/main.rs, except
# the database: DB_* are the inputs for IAM auth, where the API reads DATABASE_URL (README).
module "api" {
  source              = "../../modules/fargate_service"
  name                = "${local.prefix}-api"
  service_name        = "oryxa-fde-api"
  cluster_arn         = aws_ecs_cluster.this.arn
  container_name      = "api"
  image               = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
  ecr_repository_arns = [aws_ecr_repository.api.arn]
  cpu                 = var.api_cpu
  memory              = var.api_memory
  port                = var.api_port
  kms_key_arn         = aws_kms_key.this.arn
  vpc_id              = module.network.vpc_id
  subnet_ids          = local.subnets
  ingress             = { alb = module.alb.security_group_id }
  egress = merge(local.https_out, local.db_out, {
    spicedb = { port = 50051, security_group_id = module.spicedb.security_group_id }
  })
  environment = {
    ORYXA_ENV         = var.env
    AWS_REGION        = local.region
    LISTEN_ADDR       = "0.0.0.0:${var.api_port}"
    DB_HOST           = module.db.address
    DB_PORT           = tostring(module.db.port)
    DB_NAME           = local.db_name
    DB_USER           = local.db_user["api"]
    SPICEDB_ENDPOINT  = local.spicedb_endpoint
    EVENT_BUS_ARN     = var.event_bus_arn
    EVENT_SIGNING_KID = var.event_signing_kid
    DATA_BUCKET       = module.data_bucket.name
    WORKOS_CLIENT_ID  = var.workos_client_id
    WEB_ORIGIN        = "https://${module.cloudflare.web_hostname}"
  }
  secrets = {
    WORKOS_API_KEY        = { arn = local.secret_arn["api/workos-api-key"] }
    EVENT_SIGNING_KEY     = { arn = local.secret_arn["api/event-signing-key"] }
    SPICEDB_PRESHARED_KEY = { arn = local.secret_arn["shared/spicedb-preshared-key"] }
  }
  task_policies      = { api = data.aws_iam_policy_document.api.json }
  load_balancer      = { target_group_arn = module.alb.target_group_arn }
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

# Postgres datastore in its own database, IAM auth like the services. Reached by the API (and the
# one-off zed task) only.
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
  ingress            = { api = module.api.security_group_id, zed = module.zed.security_group_id }
  egress             = merge(local.https_out, local.db_out)
  task_policies      = { spicedb = data.aws_iam_policy_document.spicedb.json }
  service_registry   = { arn = aws_service_discovery_service.spicedb.arn }
  desired_count      = local.desired
  single_task        = true # one task: never two against the same datastore during a deploy
  log_retention_days = var.log_retention_days
}

# The Workers VPC tunnel's connector. Outbound only: HTTPS and the tunnel port through the NAT, and
# HTTP to the internal ALB. It has no task role permissions.
module "cloudflared" {
  source         = "../../modules/fargate_service"
  name           = "${local.prefix}-cloudflared"
  cluster_arn    = aws_ecs_cluster.this.arn
  container_name = "cloudflared"
  image          = var.cloudflared_image
  command        = ["tunnel", "--no-autoupdate", "run"]
  secrets        = { TUNNEL_TOKEN = { arn = local.secret_arn["cloudflared/tunnel-token"] } }
  kms_key_arn    = aws_kms_key.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = local.subnets
  egress = merge(local.https_out, {
    tunnel-tcp = { port = 7844, protocol = "tcp", cidr = "0.0.0.0/0" }
    tunnel-udp = { port = 7844, protocol = "udp", cidr = "0.0.0.0/0" }
    alb        = { port = 80, security_group_id = module.alb.security_group_id }
  })
  desired_count      = local.desired
  log_retention_days = var.log_retention_days
}

# One-off tasks the owner starts with infra/scripts/run-task.sh: the database and SpiceDB have no
# public endpoint and there is no bastion. Each reads its input from a base64 env override.

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
  source           = "../../modules/cloudtrail"
  name             = local.prefix
  bucket_name      = var.cloudtrail_bucket_name
  data_bucket_arns = [module.data_bucket.arn]
}

# ---------------------------------------------------------------- cloudflare

module "cloudflare" {
  source              = "../../modules/cloudflare"
  account_id          = var.cloudflare_account_id
  zone_id             = var.cloudflare_zone_id
  name                = local.prefix
  domain              = var.domain
  api_origin_hostname = module.alb.dns_name
  admin_emails        = var.admin_emails
}

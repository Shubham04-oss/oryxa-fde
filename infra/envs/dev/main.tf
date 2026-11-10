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

  # IAM database auth: each task connects as its own Postgres user (infra/sql/01-bootstrap.sql),
  # and its task role may connect as that user only. No database password exists for services.
  # The migrator owns the tables; only the one-off migrate task may connect as it, never the API.
  db_name = "oryxa_fde"
  # The workers each have a login of their own (lead decision on #130: none connects as oryxa_fde_api).
  # mcp's is created by the bootstrap now; its service comes later.
  db_user = {
    api       = "oryxa_fde_api"
    migrate   = "oryxa_fde_migrator"
    spicedb   = "spicedb"
    ingest    = "oryxa_fde_ingest"
    lifecycle = "oryxa_fde_lifecycle"
    mcp       = "oryxa_fde_mcp"
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

  # Optional API features, on while their variable is set (variables.tf). Off, the API starts without
  # them and no secret or permission for them exists.
  agent_on = var.sandbox_gateway_url != null
  # Where the agent's Bedrock calls start from; may differ from region (variables.tf, agent_region).
  agent_region = coalesce(var.agent_region, local.region)
  realtime_on  = local.agent_on && var.realtime_url != null
  github_on    = var.github_app != null
  slack_on     = var.slack_client_id != null

  # The lifecycle worker exists only once a drafting model is chosen (variables.tf, update_model); the digest
  # is on within it while digest_from is set. Ingest has no such switch: document search needs no model of ours.
  lifecycle_on = var.update_model != null
  digest_on    = local.lifecycle_on && var.digest_from != null

  # Slack bot tokens are created by the API at run time, one secret per workspace, under this prefix
  # (SLACK_SECRET_PREFIX, which the code wants as oryxa-fde/<env>/slack/). Not OpenTofu's, so teardown leaves them.
  slack_prefix = "oryxa-fde/${var.env}/slack/"

  # Secrets Manager, one secret per value, created empty; the owner sets values by hand. The catalog
  # holds every secret there can be; `secrets` is the ones a switched-on feature uses.
  secret_catalog = {
    "api/workos-api-key"           = "WorkOS API key: oryxa-fde-api sign-in"
    "api/event-signing-key"        = "Event signing private key (PEM): oryxa-fde-api outbox relay"
    "api/session-password"         = "64 hex characters that seal the session cookie: oryxa-fde-api"
    "api/install-state-key"        = "32+ random bytes that sign GitHub and Slack install states: oryxa-fde-api"
    "api/sandbox-gateway-token"    = "Bearer token the sandbox gateway Worker expects (its SERVICE_TOKEN): oryxa-fde-api agent runs"
    "api/realtime-token"           = "Bearer token the realtime Worker expects: oryxa-fde-api live agent output"
    "api/github-app-private-key"   = "GitHub App private key (PEM): oryxa-fde-api"
    "api/github-client-secret"     = "GitHub App OAuth client secret: oryxa-fde-api"
    "api/github-webhook-secret"    = "GitHub App webhook secret (32+ bytes): oryxa-fde-api"
    "api/slack-client-secret"      = "Slack app client secret: oryxa-fde-api"
    "api/slack-signing-secret"     = "Slack app signing secret (16+ bytes): oryxa-fde-api"
    "shared/spicedb-preshared-key" = "SpiceDB preshared key: SpiceDB and oryxa-fde-api"
    "cloudflared/tunnel-token"     = "Cloudflare Tunnel token: the cloudflared sidecar of the oryxa-fde-api task"
  }

  # Env name => secret the API task gets it from (the API contract, infra/README.md).
  api_secrets = merge(
    {
      WORKOS_API_KEY        = "api/workos-api-key"
      EVENT_SIGNING_KEY     = "api/event-signing-key"
      SESSION_PASSWORD      = "api/session-password"
      SPICEDB_PRESHARED_KEY = "shared/spicedb-preshared-key"
    },
    local.agent_on ? { SANDBOX_GATEWAY_TOKEN = "api/sandbox-gateway-token" } : {},
    local.realtime_on ? { REALTIME_TOKEN = "api/realtime-token" } : {},
    local.github_on ? {
      GITHUB_APP_PRIVATE_KEY = "api/github-app-private-key"
      GITHUB_CLIENT_SECRET   = "api/github-client-secret"
      GITHUB_WEBHOOK_SECRET  = "api/github-webhook-secret"
    } : {},
    local.slack_on ? {
      SLACK_CLIENT_SECRET  = "api/slack-client-secret"
      SLACK_SIGNING_SECRET = "api/slack-signing-secret"
    } : {},
    local.github_on || local.slack_on ? { INSTALL_STATE_KEY = "api/install-state-key" } : {},
  )
  secrets    = { for k, d in local.secret_catalog : k => d if contains(concat(values(local.api_secrets), ["cloudflared/tunnel-token"]), k) }
  secret_arn = { for k, s in aws_secretsmanager_secret.this : k => s.arn }

  # Plain configuration the API reads (the contract). Anything optional is set only when its feature is on.
  api_environment = merge(
    {
      AWS_REGION         = local.region
      LISTEN_ADDR        = "127.0.0.1:${var.api_port}" # the tunnel sidecar is the only client
      DB_HOST            = module.db.address
      DB_PORT            = tostring(module.db.port)
      DB_NAME            = local.db_name
      DB_USER            = local.db_user["api"]
      SPICEDB_ENDPOINT   = local.spicedb_endpoint
      EVENT_BUS_ARN      = var.event_bus_arn
      EVENT_SIGNING_KID  = var.event_signing_kid
      DOCUMENTS_BUCKET   = module.data_bucket.name
      EMBEDDING_PROVIDER = "bedrock"
      EMBEDDING_MODEL    = var.embedding_model
      WORKOS_CLIENT_ID   = var.workos_client_id
      WEB_ORIGIN         = "https://${module.cloudflare.web_hostname}"
    },
    local.agent_on ? {
      SANDBOX_GATEWAY_URL = var.sandbox_gateway_url
      AGENT_MODEL         = var.agent_model
      AGENT_REGION        = local.agent_region
    } : {},
    local.realtime_on ? { REALTIME_URL = var.realtime_url } : {},
    var.workos_issuer != null ? { WORKOS_ISSUER = var.workos_issuer } : {},
    local.github_on ? {
      GITHUB_APP_ID    = var.github_app.app_id
      GITHUB_APP_SLUG  = var.github_app.slug
      GITHUB_CLIENT_ID = var.github_app.client_id
    } : {},
    local.slack_on ? {
      SLACK_CLIENT_ID     = var.slack_client_id
      SLACK_SECRET_PREFIX = local.slack_prefix
      SLACK_KMS_KEY_ID    = aws_kms_key.this.arn
    } : {},
  )

  # The workers verify every event with the API's public signing key and read their own queue (infra/README.md,
  # the contracts of oryxa-fde-ingest and oryxa-fde-lifecycle, read from their binaries). Each connects as its own
  # database login. No secret: the public key is not one, and the queue url is a name.
  worker_environment = {
    AWS_REGION        = local.region
    DB_HOST           = module.db.address
    DB_PORT           = tostring(module.db.port)
    DB_NAME           = local.db_name
    EVENT_SIGNING_KID = var.event_signing_kid
    EVENT_PUBLIC_KEY  = var.event_public_key
  }
  ingest_environment = merge(local.worker_environment, {
    DB_USER            = local.db_user["ingest"]
    DOCUMENTS_BUCKET   = module.data_bucket.name
    EMBEDDING_PROVIDER = "bedrock"
    EMBEDDING_MODEL    = var.embedding_model
    INGEST_QUEUE_URL   = module.queue["context-ingestion"].url
  })
  lifecycle_environment = merge(
    local.worker_environment,
    {
      DB_USER             = local.db_user["lifecycle"]
      UPDATE_MODEL        = var.update_model
      LIFECYCLE_QUEUE_URL = module.queue["lifecycle"].url
    },
    local.digest_on ? { DIGEST_FROM = var.digest_from, WEB_ORIGIN = "https://${module.cloudflare.web_hostname}" } : {},
    local.slack_on ? { SLACK_SECRET_PREFIX = local.slack_prefix } : {},
  )

  # The API service, the workers and the one-off migrate task run one image, at the sha last deployed (deploy.tf).
  api_image = "${aws_ecr_repository.api.repository_url}:${data.aws_ssm_parameter.api_image_tag.insecure_value}"
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
  nat_https_clients = merge({
    api      = module.api.security_group_id
    spicedb  = module.spicedb.security_group_id
    db_admin = module.db_admin.security_group_id
    migrate  = module.migrate.security_group_id
    zed      = module.zed.security_group_id
    ingest   = module.ingest.security_group_id
    },
    local.lifecycle_on ? { lifecycle = module.lifecycle[0].security_group_id } : {},
  )
  # The tunnel connector is the API task's sidecar, so the API's group is the one that dials out.
  nat_tunnel_clients = { api = module.api.security_group_id }
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

# One prefix per company: <tenant id>/<company id>/ (oryxa-fde-context blob.rs). The API's role can touch
# objects under that shape only; which company a request may reach is the API's CompanyScope check.
module "data_bucket" {
  source        = "../../modules/s3"
  name          = var.data_bucket_name
  kms_key_arn   = aws_kms_key.this.arn
  force_destroy = var.allow_destroy
}

# Private subnets. 5432 only from the API, SpiceDB and the one-off db-admin and migrate tasks.
module "db" {
  source              = "../../modules/postgres"
  name                = local.prefix
  database_name       = local.db_name
  instance_class      = var.db_instance_class
  kms_key_arn         = aws_kms_key.this.arn
  vpc_id              = module.network.vpc_id
  subnet_ids          = local.subnets
  deletion_protection = !var.allow_destroy
  allowed_security_groups = merge({
    api      = module.api.security_group_id
    spicedb  = module.spicedb.security_group_id
    db_admin = module.db_admin.security_group_id
    migrate  = module.migrate.security_group_id
    ingest   = module.ingest.security_group_id
    },
    local.lifecycle_on ? { lifecycle = module.lifecycle[0].security_group_id } : {},
  )
}

# ---------------------------------------------------------------- events

# One FIFO queue, DLQ and undelivered queue per consumer. The context-ingestion and lifecycle workers read
# theirs (below). A consumer's bus subscriber is not OpenTofu's (no resource for it): infra/scripts/create-subscriber.sh
# makes it once the queue exists (infra/README.md, Apply order).
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

data "aws_iam_policy_document" "api" {
  source_policy_documents = [module.eventbridge.publish_policy_json]

  statement {
    sid       = "ConnectAsOwnUser"
    actions   = ["rds-db:connect"]
    resources = [local.db_user_arn["api"]]
  }

  # The code puts and gets documents and canvas snapshots at the keys blob.rs builds: no delete, no listing.
  statement {
    sid       = "CompanyFiles"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${module.data_bucket.arn}/*/*/documents/*", "${module.data_bucket.arn}/*/*/canvas/*"]
  }

  # Document search embeds its query, and ingestion its text, on this one model.
  statement {
    sid       = "EmbedOnTheConfiguredModel"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${local.region}::foundation-model/${var.embedding_model}"]
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

  # Slack bot tokens: the API stores, reads and deletes one secret per workspace under the prefix, and
  # no other secret (integrations secrets.rs). The secrets use the environment key.
  dynamic "statement" {
    for_each = local.slack_on ? [1] : []
    content {
      sid = "SlackTokenSecrets"
      actions = [
        "secretsmanager:CreateSecret", "secretsmanager:TagResource", "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue", "secretsmanager:DeleteSecret",
      ]
      resources = ["arn:aws:secretsmanager:${local.region}:${local.account}:secret:${local.slack_prefix}*"]
    }
  }

  dynamic "statement" {
    for_each = local.slack_on ? [1] : []
    content {
      sid       = "SlackTokenKeyViaSecretsManager"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [aws_kms_key.this.arn]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${local.region}.amazonaws.com"]
      }
    }
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
  # busybox is in the image for this alone (infra/docker/oryxa-fde-api.Dockerfile); the image has no shell.
  health_check = {
    command = ["/usr/local/bin/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:${var.api_port}${var.api_health_check_path}"]
  }
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

# ---------------------------------------------------------------- the queue workers

# Both read one SQS FIFO queue with no inbound network at all, reach AWS and Slack through the NAT, and run the API's
# image under their own entrypoint. ECS has no health endpoint to ask: a worker's process is its health, so it is
# an essential container and ECS replaces the task when it exits (a worker that is alive but stuck is not detected;
# the queue's heartbeat and 15 minute ceiling in oryxa-fde-events inbox.rs bound a stuck message, not a stuck loop).
# A deploy replaces a task in place (single_task): the queue holds events meanwhile, and two consumers never
# overlap. stop_timeout 120 is Fargate's longest wait after SIGTERM, for a handler to finish and delete its message;
# the workers have no graceful shutdown yet (#150), so until it lands SIGTERM ends them at once, and the message
# comes back after its visibility timeout, which the handlers allow (idempotent).

# oryxa-fde-ingest: `fde.document.uploaded.v1` in, text, chunks and embeddings in the database out. Reads the
# document from S3 under <tenant>/<company>/documents/<id> (oryxa-fde-context blob.rs `document_key`), never writes
# S3, and embeds with the one model in the region. It runs its own binary as a child to extract text (rlimits, no
# environment), by its own path, so the root filesystem stays read-only and nothing is written.
data "aws_iam_policy_document" "ingest" {
  statement {
    sid       = "ConnectAsOwnUser"
    actions   = ["rds-db:connect"]
    resources = [local.db_user_arn["ingest"]]
  }

  # oryxa-fde-events inbox.rs: receive (long poll), delete when handled, extend visibility while a handler runs.
  # Not the dead-letter queue: SQS moves messages there, the worker never touches it.
  statement {
    sid       = "ReadItsQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"]
    resources = [module.queue["context-ingestion"].arn]
  }

  statement {
    sid       = "ReadCompanyDocuments"
    actions   = ["s3:GetObject"]
    resources = ["${module.data_bucket.arn}/*/*/documents/*"]
  }

  # Reading an object under the bucket's KMS encryption needs Decrypt only, and only through S3.
  statement {
    sid       = "DocumentKeyViaS3"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "EmbedOnTheConfiguredModel"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${local.region}::foundation-model/${var.embedding_model}"]
  }
}

module "ingest" {
  source              = "../../modules/fargate_service"
  name                = "${local.prefix}-ingest"
  service_name        = "oryxa-fde-ingest"
  cluster_arn         = aws_ecs_cluster.this.arn
  container_name      = "ingest"
  image               = local.api_image
  ecr_repository_arns = [aws_ecr_repository.api.arn]
  entry_point         = ["/usr/local/bin/oryxa-fde-ingest"]
  cpu                 = var.ingest_cpu
  memory              = var.ingest_memory
  environment         = local.ingest_environment
  kms_key_arn         = aws_kms_key.this.arn
  vpc_id              = module.network.vpc_id
  subnet_ids          = local.subnets
  egress              = merge(local.https_out, local.db_out)
  task_policies       = { ingest = data.aws_iam_policy_document.ingest.json }
  desired_count       = local.desired
  single_task         = true
  stop_timeout        = 120
  log_retention_days  = var.log_retention_days
}

# oryxa-fde-lifecycle: lifecycle events in, rules applied in the database; every hour it drafts last week's update
# for each active project that has none, and mails each newly approved update to the customer's sponsors. Calls
# Bedrock (the drafting model), SES (the digest) and, for approved updates, Slack with a bot token it reads from
# Secrets Manager. Exists only with update_model.
data "aws_iam_policy_document" "lifecycle" {
  count = local.lifecycle_on ? 1 : 0

  statement {
    sid       = "ConnectAsOwnUser"
    actions   = ["rds-db:connect"]
    resources = [local.db_user_arn["lifecycle"]]
  }

  statement {
    sid       = "ReadItsQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"]
    resources = [module.queue["lifecycle"].arn]
  }

  # The three statements AWS documents for a global inference profile (docs.aws.amazon.com/bedrock, "Global
  # cross-Region inference", IAM policy requirements), for this one profile and the model behind it. An SCP that
  # denies Regions refuses the unspecified-Region statement's call.
  statement {
    sid       = "DraftThroughTheProfile"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${local.region}:${local.account}:inference-profile/${var.update_model}"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  statement {
    sid       = "DraftOnTheModelInRegion"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${local.region}::foundation-model/${trimprefix(var.update_model, "global.")}"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
    condition {
      test     = "StringEquals"
      variable = "bedrock:InferenceProfileArn"
      values   = ["arn:aws:bedrock:${local.region}:${local.account}:inference-profile/${var.update_model}"]
    }
  }

  statement {
    sid       = "DraftOnTheGlobalModel"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:::foundation-model/${trimprefix(var.update_model, "global.")}"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = ["unspecified"]
    }
    condition {
      test     = "StringEquals"
      variable = "bedrock:InferenceProfileArn"
      values   = ["arn:aws:bedrock:${local.region}:${local.account}:inference-profile/${var.update_model}"]
    }
  }

  # digest.rs sends with SES v2 SendEmail from one address; the identity is that address or its domain.
  dynamic "statement" {
    for_each = local.digest_on ? [1] : []
    content {
      sid     = "SendTheDigest"
      actions = ["ses:SendEmail"]
      resources = [
        "arn:aws:ses:${local.region}:${local.account}:identity/${var.digest_from}",
        "arn:aws:ses:${local.region}:${local.account}:identity/${split("@", var.digest_from)[1]}",
      ]
      condition {
        test     = "StringEquals"
        variable = "ses:FromAddress"
        values   = [var.digest_from]
      }
    }
  }

  # Read only (integrations secrets.rs `reader`): the API makes the tokens, this worker posts with them.
  dynamic "statement" {
    for_each = local.slack_on ? [1] : []
    content {
      sid       = "ReadSlackTokens"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = ["arn:aws:secretsmanager:${local.region}:${local.account}:secret:${local.slack_prefix}*"]
    }
  }

  dynamic "statement" {
    for_each = local.slack_on ? [1] : []
    content {
      sid       = "SlackTokenKeyViaSecretsManager"
      actions   = ["kms:Decrypt"]
      resources = [aws_kms_key.this.arn]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${local.region}.amazonaws.com"]
      }
    }
  }
}

module "lifecycle" {
  count               = local.lifecycle_on ? 1 : 0
  source              = "../../modules/fargate_service"
  name                = "${local.prefix}-lifecycle"
  service_name        = "oryxa-fde-lifecycle"
  cluster_arn         = aws_ecs_cluster.this.arn
  container_name      = "lifecycle"
  image               = local.api_image
  ecr_repository_arns = [aws_ecr_repository.api.arn]
  entry_point         = ["/usr/local/bin/oryxa-fde-lifecycle"]
  cpu                 = var.lifecycle_cpu
  memory              = var.lifecycle_memory
  environment         = local.lifecycle_environment
  kms_key_arn         = aws_kms_key.this.arn
  vpc_id              = module.network.vpc_id
  subnet_ids          = local.subnets
  egress              = merge(local.https_out, local.db_out)
  task_policies       = { lifecycle = data.aws_iam_policy_document.lifecycle[0].json }
  desired_count       = local.desired
  single_task         = true
  stop_timeout        = 120
  log_retention_days  = var.log_retention_days
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
  source           = "../../modules/cloudtrail"
  name             = local.prefix
  bucket_name      = var.cloudtrail_bucket_name
  data_bucket_arns = [module.data_bucket.arn]
  force_destroy    = var.allow_destroy
}

# ---------------------------------------------------------------- cloudflare

module "cloudflare" {
  source       = "../../modules/cloudflare"
  account_id   = var.cloudflare_account_id
  zone_id      = var.cloudflare_zone_id
  name         = local.prefix
  domain       = var.domain
  api_port     = var.api_port
  admin_emails = var.admin_emails
}

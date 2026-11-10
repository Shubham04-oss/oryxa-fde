# Plans the dev environment and its modules on mock providers: no credentials, no AWS or
# Cloudflare calls (CI's infra job). Catches plan-time errors `tofu validate` cannot (for_each over
# unknown values) and pins the security rules: nothing public, IAM database auth, secrets by
# reference only, every service stopped until start_services.

mock_provider "aws" {
  # Mocks return random strings; these resources validate ARNs and lists at plan time.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  # The account and region the provider would report; the bus precondition compares against them.
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }
  mock_data "aws_region" {
    defaults = { region = "ap-south-1" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-south-1a", "ap-south-1b"] }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      master_user_secret = [{
        kms_key_id    = "mock"
        secret_arn    = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:mock"
        secret_status = "active"
      }]
    }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:ap-south-1:000000000000:key/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/mock" }
  }
  # Only the internal_alb module test below uses these (dev has no load balancer since #145).
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:000000000000:loadbalancer/app/mock/0" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:000000000000:targetgroup/mock/0" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:ap-south-1:000000000000:cluster/mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ap-south-1:000000000000:task-definition/mock:1" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:mock" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:ap-south-1:000000000000:service/srv-mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:ap-south-1:000000000000:mock" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:ap-south-1:000000000000:repository/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-south-1:000000000000:log-group:mock" }
  }
}

mock_provider "cloudflare" {}

variables {
  aws_account_id         = "000000000000"
  cloudflare_account_id  = "mock"
  cloudflare_zone_id     = "mock"
  domain                 = "fde-dev.example.com"
  admin_emails           = ["owner@example.com"]
  workos_client_id       = "client_mock"
  event_bus_arn          = "arn:aws:events:ap-south-1:000000000000:event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde"
  data_bucket_name       = "oryxa-fde-dev-data-mock"
  cloudtrail_bucket_name = "oryxa-fde-dev-trail-mock"
  api_image_tag          = "mock"
}

# ---------------------------------------------------------------- the environment

run "dev_plans_without_credentials" {
  command = plan

  assert {
    condition     = toset(keys(output.queue_urls)) == toset(["lifecycle", "context-ingestion"])
    error_message = "one queue set per default consumer"
  }

  assert {
    condition = (
      output.web_hostname == "app.fde-dev.example.com" && output.admin_hostname == "admin.fde-dev.example.com"
    )
    error_message = "hostnames hang off var.domain"
  }

  assert {
    condition     = aws_ecr_repository.api.force_delete == false
    error_message = "destroy may empty nothing until allow_destroy is set"
  }

  # The founder chose Mumbai for dev (#144). Everything regional follows var.aws_region; nothing hard-codes it.
  assert {
    condition     = var.aws_region == "ap-south-1" && output.region == "ap-south-1"
    error_message = "dev defaults to ap-south-1 (Mumbai)"
  }
  assert {
    condition     = output.agent_model_target == null
    error_message = "the agent model target exists only while the agent routes are on"
  }
}

# The API's environment contract (#108): infra/README.md's table, read from the code, is what the API
# task definition must match. A variable the code needs and the task lacks (the API would not start),
# one the task sets that the table does not know (a rename the code never saw, like DATA_BUCKET for
# DOCUMENTS_BUCKET), a feature's variable with the feature off, or a secret value set as plain config,
# fails here. Each scenario applies the environment to the mock providers (a plan run exposes no outputs to
# later runs), then ./tests/contract compares the names.
run "api_task_with_every_feature_off" {
  command = apply

  # Least privilege: what the code calls, on what it uses, never a bare wildcard.
  assert {
    condition = toset(flatten([
      for s in data.aws_iam_policy_document.api.statement : s.actions if contains(["CompanyFiles", "EmbedOnTheConfiguredModel"], s.sid)
    ])) == toset(["bedrock:InvokeModel", "s3:GetObject", "s3:PutObject"])
    error_message = "files are got and put, embeddings invoked: nothing else (the code never deletes or lists)"
  }
  assert {
    condition = toset(flatten([
      for s in data.aws_iam_policy_document.api.statement : s.resources if s.sid == "CompanyFiles"
    ])) == toset(["${module.data_bucket.arn}/*/*/documents/*", "${module.data_bucket.arn}/*/*/canvas/*"])
    error_message = "the API's files are at the keys oryxa-fde-context blob.rs builds: <tenant>/<company>/documents and canvas"
  }
  assert {
    condition = flatten([
      for s in data.aws_iam_policy_document.api.statement : s.resources if s.sid == "EmbedOnTheConfiguredModel"
    ]) == ["arn:aws:bedrock:ap-south-1::foundation-model/amazon.titan-embed-text-v2:0"]
    error_message = "the API may invoke the embedding model only, in its region"
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.api.statement : !contains(s.resources, "*")])
    error_message = "no statement of the API's role takes a bare wildcard resource"
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.api.statement : s if startswith(s.sid, "Slack")]) == 0
    error_message = "Slack permissions exist only with slack_client_id"
  }
  assert {
    condition     = contains(keys(output.secrets), "api/session-password") && !contains(keys(output.secrets), "api/slack-client-secret") && !contains(keys(output.secrets), "api/install-state-key")
    error_message = "a secret exists only while its feature is on"
  }
  assert {
    condition     = !contains(module.migrate.env_names, "DATABASE_URL") && length(setsubtract(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "AWS_REGION"], module.migrate.env_names)) == 0
    error_message = "oryxa-fde-ops migrate takes DB_* and AWS_REGION"
  }
}

# The shorter path (#145): web Worker, Workers VPC service, tunnel, API. The tunnel's connector is a
# sidecar in the API task, so there is no load balancer and nothing is admitted to the API.
run "the_api_task_carries_its_own_tunnel_and_admits_nothing" {
  command = plan

  assert {
    condition     = length(module.api.ingress_sources) == 0
    error_message = "no security group admits anything to the API task: the tunnel reaches it on the task's loopback"
  }
  assert {
    condition     = local.api_environment.LISTEN_ADDR == "127.0.0.1:8080" && alltrue([for c in module.api.containers : length(try(c.portMappings, [])) == 0])
    error_message = "the API listens on the task's loopback and publishes no port"
  }
  assert {
    condition     = [for c in module.api.containers : c.name] == ["api", "cloudflared"]
    error_message = "the API task is the API and the cloudflared sidecar, in that order (the deploy workflow swaps the image by prefix, not by position)"
  }
  assert {
    condition = (
      module.api.containers[0].healthCheck.command[0] == "CMD"
      && endswith(join(" ", module.api.containers[0].healthCheck.command), "http://127.0.0.1:8080/healthz")
      && module.api.containers[0].healthCheck.retries >= 2
    )
    error_message = "the API container has its own health check on /healthz, on the loopback"
  }
  assert {
    condition = (
      module.api.containers[1].dependsOn == [{ containerName = "api", condition = "HEALTHY" }]
      && module.api.containers[1].essential && module.api.containers[0].essential
    )
    error_message = "the tunnel starts only once the API is healthy, and a task that loses either container is replaced"
  }
  assert {
    condition     = module.api.containers[1].stopTimeout > 30
    error_message = "cloudflared's 30 second drain must finish before ECS kills it"
  }
  assert {
    condition = (
      module.api.containers[1].secrets == [{ name = "TUNNEL_TOKEN", valueFrom = local.secret_arn["cloudflared/tunnel-token"] }]
      && length(module.api.containers[1].environment) == 0
      && contains(module.api.secret_arns, local.secret_arn["cloudflared/tunnel-token"])
    )
    error_message = "the tunnel token is a Secrets Manager reference, injected into the sidecar only, and the execution role may read it"
  }
  assert {
    condition     = module.api.deployment.minimum_healthy_percent == 100 && module.api.deployment.maximum_percent == 200
    error_message = "a rollout starts the new task and waits for it to be healthy before it stops the old one: never zero healthy tasks"
  }
  assert {
    condition     = contains(module.api.egress_names, "tunnel-tcp") && contains(module.api.egress_names, "tunnel-udp") && !contains(module.api.egress_names, "alb")
    error_message = "the API task dials the tunnel out and talks to no load balancer"
  }
  assert {
    condition     = module.spicedb.ingress_sources == toset(["api", "zed"])
    error_message = "SpiceDB is its own service: the API and the zed task call it, it calls nothing back"
  }
  assert {
    condition     = module.api.deployment.minimum_healthy_percent == 100 && module.spicedb.deployment.minimum_healthy_percent == 0
    error_message = "only SpiceDB replaces its single task in place"
  }
}

run "contract_with_every_feature_off" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    plain_env_names  = run.api_task_with_every_feature_off.api_env_names.plain
    secret_env_names = run.api_task_with_every_feature_off.api_env_names.secret
    features         = []
  }

  assert {
    condition     = output.table_read
    error_message = "the table in infra/README.md was not read (its heading or row format changed?)"
  }
  assert {
    condition     = length(output.missing) == 0
    error_message = "the API task definition lacks what the API requires at start: ${join(", ", output.missing)}"
  }
  assert {
    condition     = length(output.unexpected) == 0
    error_message = "the API task definition sets what the contract table does not allow: ${join(", ", output.unexpected)}"
  }
  assert {
    condition     = length(output.secrets_as_plain) == 0
    error_message = "secret values set as plain config: ${join(", ", output.secrets_as_plain)}"
  }
  assert {
    condition     = length(output.injected_non_secrets) == 0
    error_message = "injected from Secrets Manager but not a secret in the table: ${join(", ", output.injected_non_secrets)}"
  }
}

run "api_task_with_agent_github_and_slack_on" {
  command = apply
  variables {
    sandbox_gateway_url = "https://gateway.example.com"
    agent_model         = "eu.anthropic.claude-opus-5-5"
    agent_region        = "eu-west-1"
    realtime_url        = "https://realtime.example.com"
    github_app          = { app_id = "12345", slug = "oryxa-fde-dev", client_id = "Iv1.mock" }
    slack_client_id     = "1234.5678"
  }

  assert {
    condition = toset([
      for s in data.aws_iam_policy_document.api.statement : s.sid if startswith(s.sid, "Slack")
    ]) == toset(["SlackTokenSecrets", "SlackTokenKeyViaSecretsManager"])
    error_message = "Slack's permissions are two statements"
  }
  assert {
    condition = flatten([
      for s in data.aws_iam_policy_document.api.statement : s.resources if s.sid == "SlackTokenSecrets"
    ]) == ["arn:aws:secretsmanager:ap-south-1:000000000000:secret:oryxa-fde/dev/slack/*"]
    error_message = "the API may touch Slack token secrets under its own prefix only"
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.api.statement : !contains(s.resources, "*")])
    error_message = "no statement of the API's role takes a bare wildcard resource"
  }
}

run "contract_with_agent_github_and_slack_on" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    plain_env_names  = run.api_task_with_agent_github_and_slack_on.api_env_names.plain
    secret_env_names = run.api_task_with_agent_github_and_slack_on.api_env_names.secret
    features         = ["agent", "realtime", "github", "slack"]
  }

  assert {
    condition     = length(output.missing) == 0
    error_message = "the API task definition lacks what the API requires at start: ${join(", ", output.missing)}"
  }
  assert {
    condition     = length(output.unexpected) == 0
    error_message = "the API task definition sets what the contract table does not allow: ${join(", ", output.unexpected)}"
  }
  assert {
    condition     = length(output.secrets_as_plain) == 0 && length(output.injected_non_secrets) == 0
    error_message = "secrets are injected from Secrets Manager, never plain config: ${join(", ", concat(output.secrets_as_plain, output.injected_non_secrets))}"
  }
}

run "api_task_with_slack_only" {
  command = apply
  variables {
    slack_client_id = "1234.5678"
  }
}

run "contract_with_slack_only" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    plain_env_names  = run.api_task_with_slack_only.api_env_names.plain
    secret_env_names = run.api_task_with_slack_only.api_env_names.secret
    features         = ["slack"]
  }

  assert {
    condition     = length(output.missing) == 0 && length(output.unexpected) == 0
    error_message = "slack alone sets Slack's variables and the install state key, no GitHub or agent one: missing ${join(", ", output.missing)}; unexpected ${join(", ", output.unexpected)}"
  }
}

# In Mumbai the Claude models are reached only through cross-Region inference profiles, so the agent's Region
# is an explicit variable (infra/README.md, Where prompts are processed). Unset, it is the main Region;
# set, the contract's AGENT_REGION is that Region and nothing else.
run "agent_region_defaults_to_the_main_region" {
  command = plan
  variables {
    sandbox_gateway_url = "https://gateway.example.com"
    agent_model         = "global.anthropic.claude-opus-5-5"
  }

  assert {
    condition = (
      output.agent_model_target.model == "global.anthropic.claude-opus-5-5" && output.agent_model_target.region == "ap-south-1"
    )
    error_message = "AGENT_REGION is aws_region when agent_region is null"
  }
}

run "agent_region_is_the_one_asked_for" {
  command = plan
  variables {
    sandbox_gateway_url = "https://gateway.example.com"
    agent_model         = "eu.anthropic.claude-opus-5-5"
    agent_region        = "eu-west-2"
  }

  assert {
    condition     = output.agent_model_target.region == "eu-west-2" && var.aws_region == "ap-south-1" && local.api_environment.AGENT_REGION == "eu-west-2"
    error_message = "a geography profile is called from its own Region; the main Region does not move"
  }
}

run "an_agent_needs_its_model" {
  command = plan
  variables {
    sandbox_gateway_url = "https://gateway.example.com"
  }
  expect_failures = [var.agent_model]
}

run "realtime_needs_the_gateway" {
  command = plan
  variables {
    realtime_url = "https://realtime.example.com"
  }
  expect_failures = [var.realtime_url]
}

run "allow_destroy_lets_teardown_empty_what_holds_data" {
  command = plan
  variables {
    allow_destroy = true
  }

  assert {
    condition     = aws_ecr_repository.api.force_delete
    error_message = "teardown deletes the images with the repository"
  }
}

# The API must never become the table owner (#34): only the one-off migrate task's role may connect
# as oryxa_fde_migrator, and the API's role may connect as oryxa_fde_api alone.
run "only_the_migrate_task_connects_as_the_table_owner" {
  command = plan

  assert {
    condition = [
      for r in flatten([for s in data.aws_iam_policy_document.api.statement : s.resources if contains(s.actions, "rds-db:connect")]) :
      regex("[^/]+$", r)
    ] == ["oryxa_fde_api"]
    error_message = "the API's role may connect as oryxa_fde_api only"
  }
  assert {
    condition = [
      for r in flatten([for s in data.aws_iam_policy_document.migrate.statement : s.resources if contains(s.actions, "rds-db:connect")]) :
      regex("[^/]+$", r)
    ] == ["oryxa_fde_migrator"]
    error_message = "the migrate task's role may connect as oryxa_fde_migrator only"
  }
  assert {
    condition = [
      for r in flatten([for s in data.aws_iam_policy_document.spicedb.statement : s.resources if contains(s.actions, "rds-db:connect")]) :
      regex("[^/]+$", r)
    ] == ["spicedb"]
    error_message = "SpiceDB's role may connect as spicedb only"
  }
  assert {
    condition     = module.migrate.service_name == null && contains(module.migrate.env_names, "DB_USER")
    error_message = "migrations run as a one-off task, never as a service"
  }
}

# GitHub deploys (#31): only deploy-api.yml on main, in this repository's dev environment, may assume
# the deploy role, and it may only push the API image, run the migrate task and update the API service.
run "only_dev_environment_jobs_of_this_repo_assume_the_deploy_role" {
  command = plan

  assert {
    condition = {
      for c in one(data.aws_iam_policy_document.github_deploy_assume.statement).condition :
      c.variable => "${c.test} ${join(" ", c.values)}"
      } == {
      "token.actions.githubusercontent.com:aud"              = "StringEquals sts.amazonaws.com"
      "token.actions.githubusercontent.com:sub"              = "StringEquals repo:Shubham04-oss/oryxa-fde:environment:dev"
      "token.actions.githubusercontent.com:job_workflow_ref" = "StringEquals Shubham04-oss/oryxa-fde/.github/workflows/deploy-api.yml@refs/heads/main"
    }
    error_message = "the deploy role trusts exactly deploy-api.yml on main in this repository's dev environment, with no wildcard"
  }
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 1
    error_message = "the GitHub OIDC provider is created when none is passed in"
  }
}

run "deploy_role_reaches_only_the_api_image_migrate_task_and_api_service" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : [for a in s.actions : !strcontains(a, "*")]
    ]))
    error_message = "no wildcard actions"
  }
  assert {
    condition = toset([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.sid if contains(tolist(s.resources), "*")
    ]) == toset(["EcrLogin", "TaskDefinitions"])
    error_message = "only actions with no resource-level scoping take *"
  }
  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.github_deploy.statement :
      length(s.condition) == 1 && one(s.condition).variable == "iam:PassedToService" if contains(s.actions, "iam:PassRole")
    ])
    error_message = "roles may be passed to ECS tasks only"
  }
  assert {
    condition = flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:RunTask")
    ]) == ["arn:aws:ecs:ap-south-1:000000000000:task-definition/oryxa-fde-dev-migrate:*"]
    error_message = "the only task the deploy role may run is the migrate task"
  }
  assert {
    condition = flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:UpdateService")
    ]) == ["arn:aws:ecs:ap-south-1:000000000000:service/oryxa-fde-dev/oryxa-fde-api"]
    error_message = "the only service the deploy role may update is the API"
  }
}

run "an_existing_github_oidc_provider_is_reused" {
  command = plan
  variables {
    github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  }

  assert {
    condition = (
      length(aws_iam_openid_connect_provider.github) == 0
      && one(one(data.aws_iam_policy_document.github_deploy_assume.statement).principals).identifiers == toset([var.github_oidc_provider_arn])
    )
    error_message = "the deploy role trusts the provider passed in, and none is created"
  }
}

run "rejects_a_wildcard_repository" {
  command = plan
  variables {
    github_repository = "Shubham04-oss/*"
  }
  expect_failures = [var.github_repository]
}

run "rejects_a_bus_that_is_not_oryxa_fde" {
  command = plan
  variables {
    event_bus_arn = "arn:aws:events:ap-south-1:000000000000:event-busv2/oryxa-dev/abcdefghij0123456789abcde"
  }
  expect_failures = [var.event_bus_arn]
}

run "rejects_a_consumer_name_the_kit_cannot_use" {
  command = plan
  variables {
    consumers = ["Lifecycle"]
  }
  expect_failures = [var.consumers]
}

run "rejects_an_account_id_that_is_not_12_digits" {
  command = plan
  variables {
    aws_account_id = "1234"
  }
  expect_failures = [var.aws_account_id]
}

# ---------------------------------------------------------------- modules

run "postgres_is_private_encrypted_and_iam_only" {
  command = plan
  module {
    source = "../../modules/postgres"
  }
  providers = {
    aws = aws
  }
  variables {
    name                    = "oryxa-fde-test"
    database_name           = "oryxa_fde"
    kms_key_arn             = "arn:aws:kms:ap-south-1:000000000000:key/mock"
    vpc_id                  = "vpc-mock"
    subnet_ids              = ["subnet-a", "subnet-b"]
    allowed_security_groups = { api = "sg-api" }
  }

  assert {
    condition     = aws_db_instance.this.publicly_accessible == false
    error_message = "Postgres must not be publicly accessible"
  }
  assert {
    condition = (
      aws_db_instance.this.iam_database_authentication_enabled && aws_db_instance.this.manage_master_user_password
    )
    error_message = "IAM database auth on, master password managed by RDS (never in state)"
  }
  assert {
    condition = (
      aws_db_instance.this.storage_encrypted
      && aws_db_instance.this.kms_key_id == "arn:aws:kms:ap-south-1:000000000000:key/mock"
    )
    error_message = "storage encrypted with the environment key"
  }
  assert {
    condition     = one([for p in aws_db_parameter_group.this.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "TLS is required"
  }
  assert {
    condition     = aws_db_parameter_group.this.family == "postgres17" && aws_db_instance.this.engine_version == "17"
    error_message = "PostgreSQL 17 (ADR 0003)"
  }
  assert {
    condition = (
      aws_db_instance.this.deletion_protection && !aws_db_instance.this.skip_final_snapshot
      && can(regex("^oryxa-fde-test-final-[0-9]{14}$", aws_db_instance.this.final_snapshot_identifier))
    )
    error_message = "deletion protection on by default, and each teardown keeps a final snapshot under its own name"
  }
  assert {
    condition = alltrue([
      for r in aws_vpc_security_group_ingress_rule.pg : r.cidr_ipv4 == null && r.referenced_security_group_id != null
    ])
    error_message = "5432 only from named security groups, never a CIDR"
  }
}

# The bus comes from a script, so its ARN must name this env's bus in this account and region.
run "bus_must_be_this_envs_in_this_account_and_region" {
  command = plan
  module {
    source = "../../modules/eventbridge"
  }
  providers = {
    aws = aws
  }
  variables {
    name                = "oryxa-fde-dev"
    bus_arn             = "arn:aws:events:ap-south-1:000000000000:event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde"
    consumer_queue_arns = ["arn:aws:sqs:ap-south-1:000000000000:mock"]
  }
}

run "rejects_a_bus_in_another_region" {
  command = plan
  module {
    source = "../../modules/eventbridge"
  }
  providers = {
    aws = aws
  }
  variables {
    name                = "oryxa-fde-dev"
    bus_arn             = "arn:aws:events:us-east-1:000000000000:event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde"
    consumer_queue_arns = []
  }
  expect_failures = [data.aws_iam_policy_document.publish]
}

run "rejects_a_bus_in_another_account" {
  command = plan
  module {
    source = "../../modules/eventbridge"
  }
  providers = {
    aws = aws
  }
  variables {
    name                = "oryxa-fde-dev"
    bus_arn             = "arn:aws:events:ap-south-1:111111111111:event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde"
    consumer_queue_arns = []
  }
  expect_failures = [data.aws_iam_policy_document.publish]
}

run "rejects_another_envs_bus" {
  command = plan
  module {
    source = "../../modules/eventbridge"
  }
  providers = {
    aws = aws
  }
  variables {
    name                = "oryxa-fde-dev"
    bus_arn             = "arn:aws:events:ap-south-1:000000000000:event-busv2/oryxa-fde-prod/abcdefghij0123456789abcde"
    consumer_queue_arns = []
  }
  expect_failures = [data.aws_iam_policy_document.publish]
}

# Not used by dev since #145; kept for an environment that wants a load balancer in front of a service.
run "alb_is_internal_and_reached_only_by_named_groups" {
  command = plan
  module {
    source = "../../modules/internal_alb"
  }
  providers = {
    aws = aws
  }
  variables {
    name                     = "oryxa-fde-test-api"
    vpc_id                   = "vpc-mock"
    subnet_ids               = ["subnet-a", "subnet-b"]
    clients                  = { cloudflared = "sg-cloudflared" }
    target_security_group_id = "sg-api"
    target_port              = 8080
    health_check_path        = "/healthz"
  }

  assert {
    condition     = aws_lb.this.internal
    error_message = "the API's load balancer must be internal"
  }
  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.clients : r.cidr_ipv4 == null])
    error_message = "listener reachable from named security groups only"
  }
}

run "nat_admits_named_groups_and_the_tunnel_port_only_where_asked" {
  command = plan
  module {
    source = "../../modules/vpc"
  }
  providers = {
    aws = aws
  }
  variables {
    name               = "oryxa-fde-test"
    nat_https_clients  = { api = "sg-api", cloudflared = "sg-cf" }
    nat_tunnel_clients = { cloudflared = "sg-cf" }
  }

  assert {
    condition = toset(keys(aws_vpc_security_group_ingress_rule.nat)) == toset([
      "api-https", "cloudflared-https", "cloudflared-tunnel-tcp", "cloudflared-tunnel-udp",
    ])
    error_message = "HTTPS for every client, 7844 only for tunnel clients"
  }
  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.nat : r.cidr_ipv4 == null])
    error_message = "the NAT admits security groups, never a CIDR"
  }
  assert {
    condition     = length([for s in aws_subnet.this : s if s.map_public_ip_on_launch == true]) == 0
    error_message = "no subnet hands out public IPs"
  }
}

run "fargate_task_takes_secrets_by_reference_and_no_public_ip" {
  command = plan
  module {
    source = "../../modules/fargate_service"
  }
  providers = {
    aws = aws
  }
  variables {
    name           = "oryxa-fde-test-api"
    cluster_arn    = "arn:aws:ecs:ap-south-1:000000000000:cluster/mock"
    container_name = "api"
    image          = "example/api:1"
    port           = 8080
    kms_key_arn    = "arn:aws:kms:ap-south-1:000000000000:key/mock"
    vpc_id         = "vpc-mock"
    subnet_ids     = ["subnet-a"]
    environment    = { B = "2", A = "1" }
    secrets = {
      KEY      = { arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:key" }
      PASSWORD = { arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:master", key = "password" }
    }
    egress        = { https = { port = 443, cidr = "0.0.0.0/0" } }
    desired_count = 0
  }

  assert {
    condition = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].secrets == [
      { name = "KEY", valueFrom = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:key" },
      { name = "PASSWORD", valueFrom = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:master:password::" },
    ]
    error_message = "secrets are injected by ARN (and JSON key), never as values"
  }
  assert {
    condition = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment == [
      { name = "A", value = "1" }, { name = "B", value = "2" },
    ]
    error_message = "plain env is sorted so the task definition does not churn"
  }
  assert {
    condition     = one(aws_ecs_service.this[0].network_configuration).assign_public_ip == false
    error_message = "tasks never get a public IP"
  }
  assert {
    condition     = aws_ecs_service.this[0].desired_count == 0
    error_message = "desired_count passes through (start_services = false runs nothing)"
  }
  assert {
    condition     = one(aws_ecs_task_definition.this.runtime_platform).cpu_architecture == "ARM64"
    error_message = "ARM64 Fargate"
  }
}

run "one_off_task_has_no_service" {
  command = plan
  module {
    source = "../../modules/fargate_service"
  }
  providers = {
    aws = aws
  }
  variables {
    name           = "oryxa-fde-test-db-admin"
    run_as_service = false
    cluster_arn    = "arn:aws:ecs:ap-south-1:000000000000:cluster/mock"
    container_name = "psql"
    image          = "example/psql:1"
    kms_key_arn    = "arn:aws:kms:ap-south-1:000000000000:key/mock"
    vpc_id         = "vpc-mock"
    subnet_ids     = ["subnet-a"]
    egress         = {}
  }

  assert {
    condition     = length(aws_ecs_service.this) == 0
    error_message = "db-admin runs only when started by hand"
  }
}

run "a_sidecar_waits_for_a_healthy_main_container_and_shares_its_log_group" {
  command = plan
  module {
    source = "../../modules/fargate_service"
  }
  providers = {
    aws = aws
  }
  variables {
    name           = "oryxa-fde-test-api"
    cluster_arn    = "arn:aws:ecs:ap-south-1:000000000000:cluster/mock"
    container_name = "api"
    image          = "example/api:1"
    kms_key_arn    = "arn:aws:kms:ap-south-1:000000000000:key/mock"
    vpc_id         = "vpc-mock"
    subnet_ids     = ["subnet-a"]
    egress         = {}
    health_check   = { command = ["/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"] }
    sidecars = {
      tunnel = { image = "example/tunnel:1", secrets = { TOKEN = { arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:tunnel" } } }
    }
    desired_count = 0
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[1].dependsOn == [{ containerName = "api", condition = "HEALTHY" }]
    error_message = "a sidecar starts after the main container passes its health check"
  }
  assert {
    condition = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].healthCheck == {
      command  = ["CMD", "/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
      interval = 10, timeout = 5, retries = 3, startPeriod = 30
    }
    error_message = "the health check runs as CMD (no shell in the image) with the defaults"
  }
  assert {
    condition     = contains(local.all_secrets[*].arn, "arn:aws:secretsmanager:ap-south-1:000000000000:secret:tunnel")
    error_message = "the execution role may read the sidecar's secret"
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.this) == 0
    error_message = "a sidecar needs no ingress rule: it shares the main container's network"
  }
}

run "the_api_is_reached_through_the_tunnel_not_a_public_hostname" {
  command = plan
  module {
    source = "../../modules/cloudflare"
  }
  providers = {
    cloudflare = cloudflare
  }
  variables {
    account_id   = "mock"
    zone_id      = "mock"
    name         = "oryxa-fde-test"
    domain       = "fde-dev.example.com"
    api_port     = 8080
    admin_emails = ["owner@example.com"]
  }

  assert {
    condition = (
      cloudflare_connectivity_directory_service.api.host.ipv4 == "127.0.0.1"
      && cloudflare_connectivity_directory_service.api.http_port == var.api_port
      && cloudflare_connectivity_directory_service.api.host.network.tunnel_id == cloudflare_zero_trust_tunnel_cloudflared.api.id
    )
    error_message = "the Workers VPC service targets the API on the loopback of the tunnel's connector (the sidecar in the API task)"
  }
  assert {
    condition = toset(keys(cloudflare_dns_record.worker)) == toset([
      "app.fde-dev.example.com", "admin.fde-dev.example.com",
    ])
    error_message = "DNS only for Worker hostnames; the API has none"
  }
  assert {
    condition     = cloudflare_zero_trust_access_application.admin.domain == "admin.fde-dev.example.com"
    error_message = "Access sits in front of the admin hostname"
  }
}

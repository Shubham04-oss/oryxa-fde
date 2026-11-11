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
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
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
  cloudflare_zone_name   = "example.com"
  web_hostname           = "fde-dev.example.com"
  admin_hostname         = "fde-dev-admin.example.com"
  mcp_hostname           = "fde-dev-mcp.example.com" # used only with enable_mcp
  admin_emails           = ["owner@example.com"]
  workos_client_id       = "client_mock"
  event_bus_arn          = "arn:aws:events:ap-south-1:000000000000:event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde"
  data_bucket_name       = "oryxa-fde-dev-data-mock"
  cloudtrail_bucket_name = "oryxa-fde-dev-trail-mock"
  api_image_tag          = "mock"
  event_public_key       = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAeD7ALX9Ai3wKqTW5j3PPVxO+N1jj78yHWjpmf7FnHOQ=\n-----END PUBLIC KEY-----\n"

  company_key_operator_arns = ["arn:aws:iam::000000000000:user/operator"]
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
      output.web_hostname == "fde-dev.example.com" && output.admin_hostname == "fde-dev-admin.example.com"
    )
    error_message = "the host names are the ones the variables name, not derived from a base name"
  }

  assert {
    condition = (
      local.api_environment.WEB_ORIGIN == "https://${var.web_hostname}" && local.api_environment.WEB_ORIGIN == "https://fde-dev.example.com"
      && module.cloudflare.web_hostname == var.web_hostname && module.cloudflare.admin_hostname == var.admin_hostname
    )
    error_message = "the API's WEB_ORIGIN is https:// plus the web host name exactly: the session cookie and the CSRF check compare it with the browser's Origin"
  }

  assert {
    condition     = output.web_hostname != output.admin_hostname
    error_message = "the web and admin names are distinct"
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
      module.api.containers[0].healthCheck.command == ["CMD", "/usr/local/bin/oryxa-fde-ops", "healthcheck"]
      && module.api.containers[0].healthCheck.retries >= 2
    )
    error_message = "the API container's health check is the API's own `oryxa-fde-ops healthcheck` (no shell in the image), run as CMD; it tolerates a miss"
  }
  assert {
    condition = (
      module.api.containers[1].dependsOn == [{ containerName = "api", condition = "HEALTHY" }]
      && module.api.containers[1].essential && module.api.containers[0].essential
    )
    error_message = "the tunnel starts only once the API is healthy, and a task that loses either container is replaced"
  }
  assert {
    condition     = strcontains(module.api.containers[1].image, "@sha256:")
    error_message = "cloudflared runs with the API task's role, so its image is pinned by digest, not a tag"
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

# The container health check and the shutdown grace against the API's source, the Dockerfile and infra/README.md
# (./tests/code reads them as text). Wrong here means: the check runs something the image does not have or the code
# does not dispatch, ECS would kill the check before it gives up, the grace is a value the API refuses to start with,
# or the container is killed before the grace is over.
# The value on each task against crates/oryxa-fde-context/src/keys.rs, read as text: `CompanyKeyPrefix::parse` and
# `prefix_from` stop the process on a value of another shape or in another Region than AWS_REGION. The shape is built
# from the parser's own literals, so a change to the parser fails here until the module's output follows it.
run "the_company_key_prefix_on_each_task_is_what_the_code_parses" {
  command = plan
  module {
    source = "./tests/code"
  }
  providers = {
    aws = aws
  }
  variables {
    task                 = run.api_task_with_every_feature_off.api_task_timing
    company_key_prefixes = run.api_task_with_every_feature_off.company_key_prefix_by_task
  }

  assert {
    condition     = output.company_key_prefix_var == "COMPANY_KEY_ALIAS_ARN_PREFIX" && contains(keys(var.task.environment), output.company_key_prefix_var)
    error_message = "keys.rs reads another variable than the one the API task sets (PREFIX_VAR)"
  }
  assert {
    condition     = output.company_key_prefix_accepted == { api = true, ingest = true }
    error_message = "a task's company key prefix is not what CompanyKeyPrefix::parse accepts, or not in the task's AWS_REGION: the process would stop at start (${jsonencode(output.company_key_prefix_accepted)})"
  }
  assert {
    condition     = !anytrue(output.company_key_prefix_rejects_the_wrong_shapes)
    error_message = "the shape built from keys.rs accepts a value the parser refuses"
  }
}

# Apply order step 5 as written (#195): every file in infra/sql fits run-task.sh's task override once the script drops
# its comment-only and blank lines. The limit and the dropped lines are read from the script itself.
run "every_sql_file_fits_the_task_override" {
  command = plan
  module {
    source = "./tests/code"
  }
  providers = {
    aws = aws
  }
  variables {
    task = run.api_task_with_every_feature_off.api_task_timing
  }

  assert {
    condition     = contains(keys(output.task_override_lengths), "infra/sql/01-bootstrap.sql") && output.task_override_limit == 7000
    error_message = "the check reads the SQL files and run-task.sh's limit"
  }
  assert {
    condition     = alltrue([for f, n in output.task_override_lengths : n < output.task_override_limit])
    error_message = "a file in infra/sql is too large for run-task.sh's override even without comments; split it: ${jsonencode(output.task_override_lengths)}"
  }
}

run "the_api_health_check_and_the_stop_sequence_match_the_code" {
  command = plan
  module {
    source = "./tests/code"
  }
  providers = {
    aws = aws
  }
  variables {
    task = run.api_task_with_every_feature_off.api_task_timing
  }

  assert {
    condition     = output.healthcheck_subcommand_exists && output.health_path == "/healthz"
    error_message = "oryxa-fde-ops no longer dispatches `healthcheck`, or its path is not /healthz: re-read crates/oryxa-fde-api/src/health.rs and bin/ops.rs"
  }
  assert {
    condition     = var.task.health_check.command == concat(["CMD"], split(" ", output.readme_healthcheck_command))
    error_message = "the API container's health check differs from the command infra/README.md's oryxa-fde-ops table gives (`healthcheck` row): change both together"
  }
  assert {
    condition = (
      split(" ", output.readme_healthcheck_command)[1] == "healthcheck"
      && dirname(split(" ", output.readme_healthcheck_command)[0]) == "/usr/local/bin"
      && anytrue([
        for i in output.image : startswith(i, "COPY ") && endswith(i, " /usr/local/bin/") && contains(split(" ", i), basename(split(" ", output.readme_healthcheck_command)[0]))
      ])
    )
    error_message = "the health check names a binary or subcommand the image does not carry in /usr/local/bin"
  }
  assert {
    condition = (
      var.task.health_check.timeout > output.health_timeout_seconds
      && var.task.health_check.interval >= var.task.health_check.timeout
    )
    error_message = "ECS's health check timeout must outlast the check's own timeout (health.rs TIMEOUT), so its exit code arrives first, and the interval must not be shorter than that timeout"
  }
  assert {
    condition     = contains(keys(var.task.environment), output.grace_var)
    error_message = "the API task does not set ${output.grace_var}, the variable shutdown.rs reads (renamed in the code, or dropped here)"
  }
  assert {
    condition = (
      tonumber(var.task.environment[output.grace_var]) >= 1
      && tonumber(var.task.environment[output.grace_var]) <= output.grace_max_seconds
    )
    error_message = "the grace is outside the range the API starts with (shutdown.rs MAX_GRACE_SECS)"
  }
  assert {
    condition     = var.task.stop_timeouts["api"] == tonumber(var.task.environment[output.grace_var]) + 10
    error_message = "the api container's stop timeout must be the grace plus 10 s, so ECS cannot kill it before the drain is over"
  }
  assert {
    condition     = var.task.stop_timeouts["cloudflared"] + var.task.stop_timeouts["api"] <= 120
    error_message = "cloudflared's stop timeout plus the API's is over Fargate's 120 s"
  }
  assert {
    condition     = output.grace_max_seconds == 119
    error_message = "the code's grace range changed: update api_shutdown_grace_seconds' validation (variables.tf), the README row and this test together"
  }
  assert {
    condition     = output.readme_grace_default_seconds == output.grace_default_seconds && output.readme_grace_max_seconds == output.grace_max_seconds
    error_message = "the README's row for the grace variable gives a default or range that is not the code's"
  }
  # The image: distroless, nonroot, the four binaries, and nothing else (no busybox for the old check).
  assert {
    condition = (
      length([for i in output.image : i if startswith(i, "FROM ")]) == 1
      && anytrue([for i in output.image : startswith(i, "FROM gcr.io/distroless/cc-debian13:nonroot@sha256:")])
      && contains(output.image, "USER nonroot")
      && contains(output.image, "COPY --chmod=0555 oryxa-fde-api oryxa-fde-ops oryxa-fde-ingest oryxa-fde-lifecycle oryxa-fde-mcp /usr/local/bin/")
      && length([for i in output.image : i if startswith(i, "COPY ") || startswith(i, "ADD ") || startswith(i, "RUN ")]) == 1
    )
    error_message = "the image is one distroless nonroot stage that adds the four binaries and nothing else"
  }
  assert {
    condition     = !anytrue([for i in output.image : strcontains(lower(i), "busybox")])
    error_message = "busybox is back in the image"
  }
}

# 65 is the largest grace whose stop sequence fits 120 s (45 + 65 + 10); one more is refused at the variable.
run "accepts_the_largest_shutdown_grace_the_stop_budget_allows" {
  command = plan
  variables {
    api_shutdown_grace_seconds = 65
  }
  assert {
    condition     = module.api.containers[0].stopTimeout == 75
    error_message = "a grace of 65 gives the api container a 75 s stop timeout"
  }
}

run "rejects_a_shutdown_grace_over_the_stop_budget" {
  command = plan
  variables {
    api_shutdown_grace_seconds = 66
  }
  expect_failures = [var.api_shutdown_grace_seconds]
}

run "rejects_a_shutdown_grace_of_zero_or_a_fraction" {
  command = plan
  variables {
    api_shutdown_grace_seconds = 0.5
  }
  expect_failures = [var.api_shutdown_grace_seconds]
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

# One KMS key per company (#109; the rules themselves are pinned in tests/company_keys.tftest.hcl). The
# bucket's policy carries the write rules, the API's role holds no IAM grant on any company key (each key's
# own policy names it), and the environment key stays readable for what was written under it.
run "company_keys_reach_the_bucket_policy_and_name_the_api_role" {
  command = plan

  assert {
    condition = [for s in jsondecode(module.data_bucket.policy).Statement : s.Sid] == [
      "DenyInsecureTransport", "DenyWriteNamingAnotherKey", "DenyWriteWithAnotherEncryption",
    ]
    error_message = "until company keys are required, a write may name no key (the bucket default) or a company alias"
  }
  assert {
    condition     = jsonencode([for s in output.company_keys.key_policy.Statement : s.Principal.AWS if s.Sid == "ServingRolesUseTheKeyThroughS3"][0]) == jsonencode([module.api.task_role_arn])
    error_message = "the API's task role is the role that uses company keys"
  }
  assert {
    condition = length([
      for s in data.aws_iam_policy_document.api.statement : s
      if anytrue([for a in s.actions : startswith(a, "kms:")]) && !contains(s.resources, aws_kms_key.this.arn)
      && s.sid != "LookUpCompanyKeyAliases"
    ]) == 0
    error_message = "the API's IAM policy names the environment key only, besides the alias lookup (tested below); company keys name the API in their own policies"
  }
  assert {
    condition = toset([
      for s in data.aws_iam_policy_document.api.statement : s.actions if s.sid == "FileKeyViaS3"
    ][0]) == toset(["kms:Decrypt", "kms:GenerateDataKey"])
    error_message = "while company keys are optional the environment key still encrypts new files"
  }
  assert {
    condition     = output.company_key_alias_arn_prefix == "arn:aws:kms:ap-south-1:000000000000:alias/oryxa-fde-dev/companies/"
    error_message = "the alias prefix the API stream names on write"
  }
  assert {
    condition     = output.company_keys.rotation == false
    error_message = "company keys do not rotate unless company_key_rotation is set (the lead's decision on cost)"
  }
}

# Wiring the company keys into the deployed tasks (#183). The API names a company's key on every write and asks KMS
# whether a company has one; both parse COMPANY_KEY_ALIAS_ARN_PREFIX at start. The value is the module's output, and
# tests/code checks it against the parser's shape, read from the Rust source.
run "the_api_and_the_ingest_worker_carry_the_company_key_alias_prefix" {
  command = plan

  assert {
    condition = (
      local.api_environment.COMPANY_KEY_ALIAS_ARN_PREFIX == output.company_key_alias_arn_prefix
      && local.ingest_environment.COMPANY_KEY_ALIAS_ARN_PREFIX == output.company_key_alias_arn_prefix
    )
    error_message = "the API and the ingest worker are set from the company_key_alias_arn_prefix output"
  }
  assert {
    condition = (
      !contains(keys(local.mcp_environment), "COMPANY_KEY_ALIAS_ARN_PREFIX")
      && !contains(keys(local.lifecycle_environment), "COMPANY_KEY_ALIAS_ARN_PREFIX")
      && !contains(keys(local.worker_environment), "COMPANY_KEY_ALIAS_ARN_PREFIX")
    )
    error_message = "the MCP server (no file reads) and the lifecycle worker (no context) do not take the prefix"
  }
  # The lookup: DescribeKey on aliases under the prefix, nothing else, and no key ARN (an IAM Resource that is a
  # key ARN would let the role describe keys outside the company namespace).
  assert {
    condition = (
      length([for s in data.aws_iam_policy_document.api.statement : s if s.sid == "LookUpCompanyKeyAliases"]) == 1
      && [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "LookUpCompanyKeyAliases"][0].actions == toset(["kms:DescribeKey"])
      && [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "LookUpCompanyKeyAliases"][0].resources == toset(["arn:aws:kms:ap-south-1:000000000000:alias/oryxa-fde-dev/companies/*"])
      && length([for s in data.aws_iam_policy_document.api.statement : s if s.sid == "LookUpCompanyKeyAliases"][0].condition) == 0
      && coalesce([for s in data.aws_iam_policy_document.api.statement : s if s.sid == "LookUpCompanyKeyAliases"][0].effect, "Allow") == "Allow"
    )
    error_message = "the API may DescribeKey on alias/oryxa-fde-<env>/companies/* only"
  }
  assert {
    condition = length([
      for s in data.aws_iam_policy_document.api.statement : s
      if contains(s.actions, "kms:DescribeKey") || contains(s.actions, "kms:*") || contains(s.actions, "kms:Describe*")
    ]) == 1
    error_message = "DescribeKey is granted in one statement of the API's policy and nowhere else"
  }
  # What the ingest worker may do with KMS: decrypt through S3, nothing that describes, writes or names an alias.
  assert {
    condition = (
      flatten([for s in data.aws_iam_policy_document.ingest.statement : s.actions if anytrue([for a in s.actions : startswith(a, "kms:")])]) == ["kms:Decrypt"]
      && flatten([for s in data.aws_iam_policy_document.ingest.statement : s.resources if contains(s.actions, "kms:Decrypt")]) == [aws_kms_key.this.arn]
    )
    error_message = "the ingest worker holds kms:Decrypt on the environment key through S3 (company keys name it in their own policies) and no other KMS action"
  }
}

# Every company's key policy names the ingest worker's task role as a reader (Decrypt through S3), and nobody else's
# unless it is listed: the roles get distinct ARNs here, since the mock gives every role the same one.
run "the_ingest_worker_reads_every_company_key_and_nothing_else_does" {
  command = apply
  override_resource {
    target = module.api.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/oryxa-fde-dev-api-task" }
  }
  override_resource {
    target = module.ingest.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/oryxa-fde-dev-ingest-task" }
  }
  override_resource {
    target = module.lifecycle.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/oryxa-fde-dev-lifecycle-task" }
  }
  variables {
    update_model                 = "global.anthropic.claude-sonnet-5-5"
    company_key_reader_role_arns = ["arn:aws:iam::000000000000:role/oryxa-fde-dev-mcp-task"]
  }

  assert {
    condition = jsonencode([
      for s in module.company_keys.config.key_policy.Statement : s.Principal.AWS if s.Sid == "ReadingRolesDecryptThroughS3"
    ][0]) == jsonencode(["arn:aws:iam::000000000000:role/oryxa-fde-dev-ingest-task", "arn:aws:iam::000000000000:role/oryxa-fde-dev-mcp-task"])
    error_message = "the readers of a company key are the ingest worker's task role, then the roles listed in company_key_reader_role_arns, and not the API's or the lifecycle worker's"
  }
  assert {
    condition = jsonencode([
      for s in module.company_keys.config.key_policy.Statement : s.Principal.AWS if s.Sid == "ServingRolesUseTheKeyThroughS3"
    ][0]) == jsonencode(["arn:aws:iam::000000000000:role/oryxa-fde-dev-api-task"])
    error_message = "only the API's role writes: the ingest worker never gets GenerateDataKey"
  }
  assert {
    condition = jsonencode([
      for s in module.company_keys.config.key_policy.Statement : s.Action if s.Sid == "ReadingRolesDecryptThroughS3"
    ][0]) == jsonencode(["kms:Decrypt"])
    error_message = "a reader may only decrypt"
  }
}

run "the_ingest_worker_is_a_reader_with_no_extra_readers_listed" {
  command = apply
  override_resource {
    target = module.ingest.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/oryxa-fde-dev-ingest-task" }
  }

  assert {
    condition = jsonencode([
      for s in module.company_keys.config.key_policy.Statement : s.Principal.AWS if s.Sid == "ReadingRolesDecryptThroughS3"
    ][0]) == jsonencode(["arn:aws:iam::000000000000:role/oryxa-fde-dev-ingest-task"])
    error_message = "with company_key_reader_role_arns empty, the ingest worker is still a reader"
  }
}

run "rejects_listing_the_ingest_role_as_an_extra_reader" {
  command = plan
  variables {
    company_key_reader_role_arns = ["arn:aws:iam::000000000000:role/oryxa-fde-dev-ingest-task"]
  }
  expect_failures = [var.company_key_reader_role_arns]
}

run "required_company_keys_refuse_writes_that_name_no_company_key_and_stop_environment_key_writes" {
  command = plan
  variables {
    require_company_keys = true
  }

  assert {
    condition = [for s in jsondecode(module.data_bucket.policy).Statement : s.Sid] == [
      "DenyInsecureTransport", "DenyWriteNamingAnotherKey", "DenyWriteWithAnotherEncryption",
      "DenyWriteWithoutCompanyKey", "DenyWriteNotUsingKms",
    ]
    error_message = "every write must name a company key"
  }
  assert {
    condition = toset([
      for s in data.aws_iam_policy_document.api.statement : s.actions if s.sid == "FileKeyViaS3"
    ][0]) == toset(["kms:Decrypt"])
    error_message = "the environment key keeps Decrypt for old files and loses GenerateDataKey"
  }
}

run "rejects_no_company_key_operators" {
  command = plan
  variables {
    company_key_operator_arns = []
  }
  expect_failures = [var.company_key_operator_arns]
}

# GitHub deploys (#31, #165): only deploy-api.yml on main, in this repository's dev environment, may assume
# the deploy role, and it may only push the API image, run the migrate task and update the API and the worker services.
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

# With GitHub's immutable subject on (#196), the token's sub names the owner and repository by id too. The prefix
# variable carries it; the condition stays an exact match and job_workflow_ref keeps the names. Placeholder ids.
run "the_deploy_role_trusts_the_immutable_subject_when_given" {
  command = plan
  variables {
    github_oidc_subject_prefix = "repo:Shubham04-oss@1111111/oryxa-fde@2222222"
  }

  assert {
    condition = {
      for c in one(data.aws_iam_policy_document.github_deploy_assume.statement).condition :
      c.variable => "${c.test} ${join(" ", c.values)}"
      } == {
      "token.actions.githubusercontent.com:aud"              = "StringEquals sts.amazonaws.com"
      "token.actions.githubusercontent.com:sub"              = "StringEquals repo:Shubham04-oss@1111111/oryxa-fde@2222222:environment:dev"
      "token.actions.githubusercontent.com:job_workflow_ref" = "StringEquals Shubham04-oss/oryxa-fde/.github/workflows/deploy-api.yml@refs/heads/main"
    }
    error_message = "with the immutable prefix, sub is exactly <prefix>:environment:dev and job_workflow_ref is unchanged"
  }
}

run "the_name_only_prefix_given_explicitly_is_the_default" {
  command = plan
  variables {
    github_oidc_subject_prefix = "repo:Shubham04-oss/oryxa-fde"
  }

  assert {
    condition = jsonencode(flatten([
      for c in one(data.aws_iam_policy_document.github_deploy_assume.statement).condition :
      c.values if c.variable == "token.actions.githubusercontent.com:sub"
    ])) == jsonencode(["repo:Shubham04-oss/oryxa-fde:environment:dev"])
    error_message = "the name-only prefix builds the same sub as leaving the variable unset"
  }
}

run "rejects_a_wildcard_subject_prefix" {
  command = plan
  variables {
    github_oidc_subject_prefix = "repo:Shubham04-oss@*/oryxa-fde@*"
  }
  expect_failures = [var.github_oidc_subject_prefix]
}

run "rejects_a_subject_prefix_with_the_environment" {
  command = plan
  variables {
    github_oidc_subject_prefix = "repo:Shubham04-oss@1111111/oryxa-fde@2222222:environment:dev"
  }
  expect_failures = [var.github_oidc_subject_prefix]
}

run "rejects_a_subject_prefix_with_only_one_id" {
  command = plan
  variables {
    github_oidc_subject_prefix = "repo:Shubham04-oss@1111111/oryxa-fde"
  }
  expect_failures = [var.github_oidc_subject_prefix]
}

run "rejects_a_subject_prefix_naming_another_repository" {
  command = plan
  variables {
    github_oidc_subject_prefix = "repo:someone-else@1111111/oryxa-fde@2222222"
  }
  expect_failures = [var.github_oidc_subject_prefix]
}

run "deploy_role_reaches_only_the_api_image_migrate_task_and_the_deployed_services" {
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
    ]) == ["arn:aws:ecs:ap-south-1:000000000000:service/oryxa-fde-dev/oryxa-fde-api", "arn:aws:ecs:ap-south-1:000000000000:service/oryxa-fde-dev/oryxa-fde-ingest"]
    error_message = "the services the deploy role may update are the API and the ingest worker: not SpiceDB, and no lifecycle worker while none is deployed"
  }
  assert {
    condition = flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:DescribeServices")
    ]) == flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:UpdateService")])
    error_message = "the deploy waits on exactly the services it updates"
  }
  assert {
    condition     = local.deploy_workers == [{ name = "ingest", service = "oryxa-fde-ingest", task_definition = "oryxa-fde-dev-ingest" }]
    error_message = "one deploy rolls the ingest worker after the API; the lifecycle worker is not deployed without a model, so it is not listed"
  }
}

# What the deploy role may hand a task definition revision to run as (iam:PassRole is the only limit on a family:
# registering takes no resource). The mock gives every role one ARN, so each role below gets its own: a role the deploy
# must not pass (SpiceDB, db-admin, zed) keeps the mock's, which none of the lists may hold.
run "the_deploy_role_passes_only_the_roles_of_the_api_the_migrate_task_and_the_workers" {
  command = apply
  override_resource {
    target = module.api.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/dev-api-task" }
  }
  override_resource {
    target = module.api.aws_iam_role.execution
    values = { arn = "arn:aws:iam::000000000000:role/dev-api-exec" }
  }
  override_resource {
    target = module.migrate.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/dev-migrate-task" }
  }
  override_resource {
    target = module.migrate.aws_iam_role.execution
    values = { arn = "arn:aws:iam::000000000000:role/dev-migrate-exec" }
  }
  override_resource {
    target = module.ingest.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/dev-ingest-task" }
  }
  override_resource {
    target = module.ingest.aws_iam_role.execution
    values = { arn = "arn:aws:iam::000000000000:role/dev-ingest-exec" }
  }

  assert {
    condition = toset(flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")
    ])) == toset([for r in ["api-task", "api-exec", "migrate-task", "migrate-exec", "ingest-task", "ingest-exec"] : "arn:aws:iam::000000000000:role/dev-${r}"])
    error_message = "the deploy role passes the API's, the migrate task's and the ingest worker's task and execution roles, and no other"
  }
  assert {
    condition = (
      [for s in data.aws_iam_policy_document.github_deploy.statement : s.sid if contains(s.actions, "iam:PassRole")] == ["PassOnlyDeployedServiceRoles"]
      && !contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), module.spicedb.task_role_arn)
      && !contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), module.db_admin.task_role_arn)
    )
    error_message = "one PassRole statement, and never SpiceDB's, db-admin's or zed's roles (the mock's shared ARN)"
  }
  # The deploy parameter is what the workflow reads: the API's family, then the workers in rolling order.
  assert {
    condition = (
      jsondecode(aws_ssm_parameter.deploy.insecure_value).workers == [{ name = "ingest", service = "oryxa-fde-ingest", task_definition = "oryxa-fde-dev-ingest" }]
      && jsondecode(aws_ssm_parameter.deploy.insecure_value).api_task_definition == "oryxa-fde-dev-api"
    )
    error_message = "the deploy parameter names the ingest worker's service and task family, after the API"
  }
}

# Drift: an apply after a deploy must build every service from the sha the workflow recorded, never from api_image_tag
# (which only seeds the parameter), or it would roll a worker back to an older image than the API's.
run "every_service_runs_the_recorded_image_tag" {
  command = plan
  variables {
    update_model = "global.anthropic.claude-sonnet-5-5"
    enable_mcp   = true
  }
  override_data {
    target = data.aws_ssm_parameter.api_image_tag
    values = { insecure_value = "deployed-sha" }
  }

  assert {
    condition = alltrue([
      for c in [module.api.containers[0], module.migrate.containers[0], module.ingest.containers[0], module.lifecycle[0].containers[0], module.mcp[0].containers[0]] :
      c.image == "${aws_ecr_repository.api.repository_url}:deployed-sha"
    ])
    error_message = "the API, the migrate task, both workers and the MCP server take the tag deploy-api recorded, not api_image_tag"
  }
}

# The lifecycle worker joins the deploy with its model, and only then: its service, its roles and its place in the
# parameter appear together, after the ingest worker.
run "the_lifecycle_worker_joins_the_deploy_with_its_model" {
  command = apply
  variables {
    update_model = "global.anthropic.claude-sonnet-5-5"
  }
  override_resource {
    target = module.lifecycle.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/dev-lifecycle-task" }
  }
  override_resource {
    target = module.lifecycle.aws_iam_role.execution
    values = { arn = "arn:aws:iam::000000000000:role/dev-lifecycle-exec" }
  }

  assert {
    condition = (
      [for w in jsondecode(aws_ssm_parameter.deploy.insecure_value).workers : w.name] == ["ingest", "lifecycle"]
      && jsondecode(aws_ssm_parameter.deploy.insecure_value).workers[1].service == "oryxa-fde-lifecycle"
      && jsondecode(aws_ssm_parameter.deploy.insecure_value).workers[1].task_definition == "oryxa-fde-dev-lifecycle"
    )
    error_message = "with a model the lifecycle worker is rolled last"
  }
  assert {
    condition = flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:UpdateService")
    ]) == [for s in ["oryxa-fde-api", "oryxa-fde-ingest", "oryxa-fde-lifecycle"] : "arn:aws:ecs:ap-south-1:000000000000:service/oryxa-fde-dev/${s}"]
    error_message = "the deploy role may update the lifecycle worker's service once it exists"
  }
  assert {
    condition = (
      contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), "arn:aws:iam::000000000000:role/dev-lifecycle-task")
      && contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), "arn:aws:iam::000000000000:role/dev-lifecycle-exec")
    )
    error_message = "and may pass the lifecycle worker's task and execution roles to ECS"
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
    health_check   = { command = ["/usr/local/bin/oryxa-fde-ops", "healthcheck"] }
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
      command  = ["CMD", "/usr/local/bin/oryxa-fde-ops", "healthcheck"]
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

# A task stops its sidecars first and then its main container, each for up to its stop timeout: the longest sidecar
# plus the main container must fit Fargate's 120 s. 75 + 45 is the most the API task can ask (a grace of 65).
run "a_stop_sequence_of_120_seconds_is_accepted_and_one_second_more_is_refused" {
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
    stop_timeout   = 75
    sidecars       = { tunnel = { image = "example/tunnel:1", stop_timeout = 45 } }
    desired_count  = 0
  }

  assert {
    condition     = [for c in jsondecode(aws_ecs_task_definition.this.container_definitions) : c.stopTimeout] == [75, 45]
    error_message = "the main container and the sidecar keep the stop timeouts they were given"
  }
}

run "a_stop_sequence_over_120_seconds_is_refused" {
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
    stop_timeout   = 76
    sidecars       = { tunnel = { image = "example/tunnel:1", stop_timeout = 45 } }
    desired_count  = 0
  }
  expect_failures = [aws_ecs_task_definition.this]
}

run "a_sidecar_with_no_stop_timeout_counts_as_ecs_default_30_seconds" {
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
    stop_timeout   = 91
    sidecars       = { tunnel = { image = "example/tunnel:1" } }
    desired_count  = 0
  }
  expect_failures = [aws_ecs_task_definition.this]
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
    account_id     = "mock"
    zone_id        = "mock"
    name           = "oryxa-fde-test"
    web_hostname   = "fde-dev.example.com"
    admin_hostname = "fde-dev-admin.example.com"
    mcp_hostname   = "fde-dev-mcp.example.com"
    api_port       = 8080
    admin_emails   = ["owner@example.com"]
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
      "fde-dev.example.com", "fde-dev-admin.example.com",
    ])
    error_message = "DNS only for Worker hostnames; the API has none"
  }
  assert {
    condition = (
      cloudflare_dns_record.worker["fde-dev.example.com"].name == var.web_hostname
      && cloudflare_dns_record.worker["fde-dev-admin.example.com"].name == var.admin_hostname
      && alltrue([for r in values(cloudflare_dns_record.worker) : r.type == "AAAA" && r.proxied == true && r.zone_id == var.zone_id])
      && output.web_hostname == var.web_hostname && output.admin_hostname == var.admin_hostname
    )
    error_message = "each Worker record is named exactly by its variable (no app. or admin. is added), proxied, in the zone"
  }
  assert {
    condition     = cloudflare_zero_trust_access_application.admin.domain == "fde-dev-admin.example.com"
    error_message = "Access sits in front of the admin hostname"
  }
}

# ---------------------------------------------------------------- the queue workers (#130)

# oryxa-fde-ingest and oryxa-fde-lifecycle: each its own database login, its own queue, only the calls its binary
# makes (read from the code, infra/README.md), no inbound network. The ingest worker has no model of ours to wait
# for, so it exists by default; the lifecycle worker waits for update_model.
run "workers_with_the_defaults" {
  command = apply

  # Every login the workers use is made by the bootstrap and listed with its use in the README.
  assert {
    condition = alltrue([
      for u in values(local.db_user) :
      strcontains(file("${path.module}/../../sql/01-bootstrap.sql"), u) && strcontains(file("${path.module}/../../README.md"), "| `${u}` |")
    ])
    error_message = "every database login in local.db_user is created by infra/sql/01-bootstrap.sql and in the README's Database logins table"
  }

  # ---- ingest: who it signs in as, what it reads, what it may call
  assert {
    condition = [
      for r in flatten([for s in data.aws_iam_policy_document.ingest.statement : s.resources if contains(s.actions, "rds-db:connect")]) :
      regex("[^/]+$", r)
    ] == ["oryxa_fde_ingest"] && local.ingest_environment.DB_USER == "oryxa_fde_ingest"
    error_message = "the ingest worker connects as oryxa_fde_ingest only: no worker takes the API's login"
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.ingest.statement : s.actions])) == toset([
      "rds-db:connect", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
      "s3:GetObject", "kms:Decrypt", "bedrock:InvokeModel",
    ])
    error_message = "ingest: receive, delete and extend messages of its queue, read documents, decrypt through S3, embed: nothing else (no S3 write, no SQS send, no generate-data-key)"
  }
  assert {
    condition = (
      flatten([for s in data.aws_iam_policy_document.ingest.statement : s.resources if s.sid == "ReadItsQueue"]) == [module.queue["context-ingestion"].arn]
      && flatten([for s in data.aws_iam_policy_document.ingest.statement : s.resources if s.sid == "ReadCompanyDocuments"]) == ["${module.data_bucket.arn}/*/*/documents/*"]
      && flatten([for s in data.aws_iam_policy_document.ingest.statement : s.resources if s.sid == "EmbedOnTheConfiguredModel"]) == ["arn:aws:bedrock:ap-south-1::foundation-model/amazon.titan-embed-text-v2:0"]
    )
    error_message = "ingest reads its own queue, <tenant>/<company>/documents/ keys (blob.rs) and the one embedding model in the region"
  }
  assert {
    condition = (
      jsonencode([for s in data.aws_iam_policy_document.ingest.statement : [for c in s.condition : c.values] if s.sid == "DocumentKeyViaS3"]) == jsonencode([[["s3.ap-south-1.amazonaws.com"]]])
      && alltrue([for s in data.aws_iam_policy_document.ingest.statement : !contains(s.resources, "*")])
    )
    error_message = "the document key is usable only through S3, and no statement takes a bare wildcard resource"
  }

  # ---- ingest: network, container and rollout
  assert {
    condition = (
      length(module.ingest.ingress_sources) == 0
      && module.ingest.egress_names == toset(["https", "postgres"])
      && alltrue([for c in module.ingest.containers : length(try(c.portMappings, [])) == 0])
    )
    error_message = "no security group admits anything to a worker, it publishes no port, and it dials out only to HTTPS (through the NAT) and the database"
  }
  assert {
    condition = (
      [for c in module.ingest.containers : c.name] == ["ingest"]
      && module.ingest.containers[0].entryPoint == ["/usr/local/bin/oryxa-fde-ingest"]
      && startswith(module.ingest.containers[0].image, "${aws_ecr_repository.api.repository_url}:")
      && module.ingest.containers[0].essential && module.ingest.containers[0].readonlyRootFilesystem
    )
    error_message = "one essential container, from the backend image under its own entrypoint, with a read-only root"
  }
  assert {
    condition = (
      try(module.ingest.containers[0].healthCheck, null) == null
      && module.ingest.containers[0].stopTimeout == 120
      && module.ingest.containers[0].logConfiguration.options["awslogs-group"] == "/ecs/oryxa-fde-dev-ingest"
    )
    error_message = "a worker's health is its process (no health endpoint), it gets Fargate's longest stop timeout, and it logs to its own group"
  }
  assert {
    condition     = module.ingest.deployment.minimum_healthy_percent == 0 && module.ingest.deployment.maximum_percent == 100 && local.desired == 0
    error_message = "a deploy replaces the worker in place (two consumers never overlap), and it runs 0 tasks until start_services"
  }
  assert {
    condition = (
      !contains(module.ingest.env_names, "DATABASE_URL") && length(module.ingest.secret_env_names) == 0
      && local.ingest_environment.INGEST_QUEUE_URL == module.queue["context-ingestion"].url
      && local.ingest_environment.EVENT_SIGNING_KID == "k1"
      && startswith(local.ingest_environment.EVENT_PUBLIC_KEY, "-----BEGIN PUBLIC KEY-----")
    )
    error_message = "IAM database auth (never DATABASE_URL), no secret, its own queue, and the public half of the signing key (public, so plain config)"
  }

  # ---- no model chosen: no lifecycle worker, and nothing that could call Bedrock for it
  assert {
    condition = (
      length(module.lifecycle) == 0 && length(data.aws_iam_policy_document.lifecycle) == 0
      && output.lifecycle_env_names == null
    )
    error_message = "without update_model the lifecycle worker, its role and its Bedrock permission do not exist"
  }
  assert {
    condition     = output.event_subscribers.consumers == { context-ingestion = module.queue["context-ingestion"].url, lifecycle = module.queue["lifecycle"].url }
    error_message = "create-subscriber.sh's two consumers have their queues"
  }
}

run "contract_ingest" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    binary           = "oryxa-fde-ingest"
    min_rows         = 10
    plain_env_names  = run.workers_with_the_defaults.ingest_env_names.plain
    secret_env_names = run.workers_with_the_defaults.ingest_env_names.secret
    features         = []
  }

  assert {
    condition     = output.table_read
    error_message = "the ingest table in infra/README.md was not read (its heading or row format changed?)"
  }
  assert {
    condition     = length(output.missing) == 0 && length(output.unexpected) == 0
    error_message = "the ingest task definition and its README table disagree: missing ${join(", ", output.missing)}; unexpected ${join(", ", output.unexpected)}"
  }
  assert {
    condition     = length(output.secrets_as_plain) == 0 && length(output.injected_non_secrets) == 0
    error_message = "no secret reaches the ingest worker; the public key is plain config"
  }
}

# A drafting model, the digest and Slack: the lifecycle worker's permissions are what its code calls, and no more.
run "lifecycle_worker_with_a_model_a_digest_and_slack" {
  command = apply
  variables {
    update_model    = "global.anthropic.claude-opus-5-5"
    digest_from     = "updates@example.com"
    slack_client_id = "1234.5678"
  }

  assert {
    condition = [
      for r in flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.resources if contains(s.actions, "rds-db:connect")]) :
      regex("[^/]+$", r)
    ] == ["oryxa_fde_lifecycle"] && local.lifecycle_environment.DB_USER == "oryxa_fde_lifecycle"
    error_message = "the lifecycle worker connects as oryxa_fde_lifecycle only"
  }
  assert {
    condition = toset([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.sid]) == toset([
      "ConnectAsOwnUser", "ReadItsQueue", "DraftThroughTheProfile", "DraftOnTheModelInRegion", "DraftOnTheGlobalModel",
      "SendTheDigest", "ReadSlackTokens", "SlackTokenKeyViaSecretsManager",
    ])
    error_message = "the lifecycle worker's statements are these eight"
  }
  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.actions])) == toset([
      "rds-db:connect", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
      "bedrock:InvokeModel", "ses:SendEmail", "secretsmanager:GetSecretValue", "kms:Decrypt",
    ])
    error_message = "lifecycle: its queue, one model, one SES address, Slack tokens read-only: no S3, no secret write, no generate-data-key"
  }
  # AWS's three statements for a global inference profile, each for this one profile and its model.
  assert {
    condition = (
      flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.resources if s.sid == "DraftThroughTheProfile"])
      == ["arn:aws:bedrock:ap-south-1:000000000000:inference-profile/global.anthropic.claude-opus-5-5"]
      && flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.resources if s.sid == "DraftOnTheModelInRegion"])
      == ["arn:aws:bedrock:ap-south-1::foundation-model/anthropic.claude-opus-5-5"]
      && flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.resources if s.sid == "DraftOnTheGlobalModel"])
      == ["arn:aws:bedrock:::foundation-model/anthropic.claude-opus-5-5"]
    )
    error_message = "the profile in the calling Region, the model in that Region, and the Region-less global model: the three ARNs AWS documents"
  }
  assert {
    condition = (
      jsonencode({ for s in data.aws_iam_policy_document.lifecycle[0].statement : s.sid => { for c in s.condition : c.variable => c.values } if startswith(s.sid, "Draft") }) == jsonencode({
        DraftThroughTheProfile  = { "aws:RequestedRegion" = ["ap-south-1"] }
        DraftOnTheModelInRegion = { "aws:RequestedRegion" = ["ap-south-1"], "bedrock:InferenceProfileArn" = ["arn:aws:bedrock:ap-south-1:000000000000:inference-profile/global.anthropic.claude-opus-5-5"] }
        DraftOnTheGlobalModel   = { "aws:RequestedRegion" = ["unspecified"], "bedrock:InferenceProfileArn" = ["arn:aws:bedrock:ap-south-1:000000000000:inference-profile/global.anthropic.claude-opus-5-5"] }
      })
    )
    error_message = "the model is reachable only through the profile, and the global statement only with an unspecified Region"
  }
  assert {
    condition = (
      jsonencode(flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.resources if s.sid == "SendTheDigest"]))
      == jsonencode(["arn:aws:ses:ap-south-1:000000000000:identity/example.com", "arn:aws:ses:ap-south-1:000000000000:identity/updates@example.com"])
      && jsonencode([for s in data.aws_iam_policy_document.lifecycle[0].statement : [for c in s.condition : [c.variable, c.values]] if s.sid == "SendTheDigest"]) == jsonencode([[["ses:FromAddress", ["updates@example.com"]]]])
    )
    error_message = "mail goes out from the one configured address, through its identity or its domain's"
  }
  assert {
    condition = (
      flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.actions if s.sid == "ReadSlackTokens"]) == ["secretsmanager:GetSecretValue"]
      && flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.resources if s.sid == "ReadSlackTokens"]) == ["arn:aws:secretsmanager:ap-south-1:000000000000:secret:oryxa-fde/dev/slack/*"]
      && flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.actions if s.sid == "SlackTokenKeyViaSecretsManager"]) == ["kms:Decrypt"]
      && flatten([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.resources if s.sid == "ReadItsQueue"]) == [module.queue["lifecycle"].arn]
    )
    error_message = "Slack tokens are read, never written, under the prefix only; the queue is its own"
  }
  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.lifecycle[0].statement : !contains(s.resources, "*") && !anytrue([for r in s.resources : endswith(r, "/*") && !strcontains(r, "slack/")])
    ])
    error_message = "no statement of the lifecycle role takes a bare wildcard resource"
  }
  assert {
    condition = (
      module.lifecycle[0].egress_names == toset(["https", "postgres"]) && length(module.lifecycle[0].ingress_sources) == 0
      && module.lifecycle[0].containers[0].entryPoint == ["/usr/local/bin/oryxa-fde-lifecycle"]
      && module.lifecycle[0].containers[0].stopTimeout == 120 && try(module.lifecycle[0].containers[0].healthCheck, null) == null
      && module.lifecycle[0].containers[0].logConfiguration.options["awslogs-group"] == "/ecs/oryxa-fde-dev-lifecycle"
      && module.lifecycle[0].deployment.minimum_healthy_percent == 0
    )
    error_message = "the lifecycle worker is shaped like the ingest worker: no inbound, its own log group, replaced in place"
  }
  assert {
    condition     = local.lifecycle_environment.UPDATE_MODEL == "global.anthropic.claude-opus-5-5" && local.lifecycle_environment.SLACK_SECRET_PREFIX == "oryxa-fde/dev/slack/" && local.lifecycle_environment.WEB_ORIGIN == "https://fde-dev.example.com"
    error_message = "the model, the Slack prefix the API writes under, and the web origin of the unsubscribe page"
  }
}

run "contract_lifecycle_with_the_digest_and_slack" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    binary           = "oryxa-fde-lifecycle"
    min_rows         = 10
    plain_env_names  = run.lifecycle_worker_with_a_model_a_digest_and_slack.lifecycle_env_names.plain
    secret_env_names = run.lifecycle_worker_with_a_model_a_digest_and_slack.lifecycle_env_names.secret
    features         = ["digest", "slack"]
  }

  assert {
    condition     = output.table_read
    error_message = "the lifecycle table in infra/README.md was not read"
  }
  assert {
    condition     = length(output.missing) == 0 && length(output.unexpected) == 0
    error_message = "the lifecycle task definition and its README table disagree: missing ${join(", ", output.missing)}; unexpected ${join(", ", output.unexpected)}"
  }
  assert {
    condition     = length(output.secrets_as_plain) == 0 && length(output.injected_non_secrets) == 0
    error_message = "no secret reaches the lifecycle worker"
  }
}

# A model alone: no digest, no Slack, so no SES permission, no mail variable and no Slack read.
run "lifecycle_worker_with_only_a_model" {
  command = apply
  variables {
    update_model = "global.anthropic.claude-sonnet-5-5"
  }

  assert {
    condition = toset([for s in data.aws_iam_policy_document.lifecycle[0].statement : s.sid]) == toset([
      "ConnectAsOwnUser", "ReadItsQueue", "DraftThroughTheProfile", "DraftOnTheModelInRegion", "DraftOnTheGlobalModel",
    ])
    error_message = "without digest_from or Slack the lifecycle role has no SES and no Secrets Manager statement"
  }
  assert {
    condition     = !contains(keys(local.lifecycle_environment), "DIGEST_FROM") && !contains(keys(local.lifecycle_environment), "WEB_ORIGIN") && !contains(keys(local.lifecycle_environment), "SLACK_SECRET_PREFIX")
    error_message = "the digest's and Slack's variables are set only while those are on"
  }
}

run "contract_lifecycle_with_only_a_model" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    binary           = "oryxa-fde-lifecycle"
    min_rows         = 10
    plain_env_names  = run.lifecycle_worker_with_only_a_model.lifecycle_env_names.plain
    secret_env_names = run.lifecycle_worker_with_only_a_model.lifecycle_env_names.secret
    features         = []
  }

  assert {
    condition     = length(output.missing) == 0 && length(output.unexpected) == 0
    error_message = "missing ${join(", ", output.missing)}; unexpected ${join(", ", output.unexpected)}"
  }
}

# The small things #128's review left for this issue.
run "an_inference_profile_is_not_an_embedding_model" {
  command = plan
  variables {
    embedding_model = "us.amazon.titan-embed-text-v2:0"
  }
  expect_failures = [var.embedding_model]
}

run "workos_issuer_is_set_only_for_a_custom_auth_domain" {
  command = plan
  variables {
    workos_issuer = "https://auth.example.com/"
  }

  assert {
    condition     = local.api_environment.WORKOS_ISSUER == "https://auth.example.com/" && !contains(keys(local.ingest_environment), "WORKOS_ISSUER")
    error_message = "the API pins the issuer; no worker verifies WorkOS tokens"
  }
}

run "workos_issuer_is_unset_by_default" {
  command = plan

  assert {
    condition     = !contains(keys(local.api_environment), "WORKOS_ISSUER")
    error_message = "the API's default issuer applies unless one is set"
  }
}

run "rejects_a_workos_issuer_that_is_not_https" {
  command = plan
  variables {
    workos_issuer = "http://auth.example.com/"
  }
  expect_failures = [var.workos_issuer]
}

# A WorkOS environment without a custom auth domain issues tokens with a path: the client's own issuer.
run "workos_issuer_accepts_the_workos_user_management_issuer" {
  command = plan
  variables {
    workos_issuer = "https://api.workos.com/user_management/client_01EXAMPLE"
  }

  assert {
    condition     = local.api_environment.WORKOS_ISSUER == "https://api.workos.com/user_management/client_01EXAMPLE"
    error_message = "WorkOS's own issuer, which has a path, is passed to the API unchanged"
  }
}

run "workos_issuer_accepts_a_custom_domain_without_a_trailing_slash" {
  command = plan
  variables {
    workos_issuer = "https://auth.example.com"
  }

  assert {
    condition     = local.api_environment.WORKOS_ISSUER == "https://auth.example.com"
    error_message = "a custom auth domain is an origin, with or without the slash"
  }
}

run "rejects_a_workos_issuer_with_a_query" {
  command = plan
  variables {
    workos_issuer = "https://api.workos.com/user_management/client_01EXAMPLE?x=1"
  }
  expect_failures = [var.workos_issuer]
}

run "rejects_a_workos_issuer_with_a_fragment" {
  command = plan
  variables {
    workos_issuer = "https://api.workos.com/user_management#client_01EXAMPLE"
  }
  expect_failures = [var.workos_issuer]
}

run "rejects_a_workos_issuer_with_userinfo" {
  command = plan
  variables {
    workos_issuer = "https://user@api.workos.com/user_management/client_01EXAMPLE"
  }
  expect_failures = [var.workos_issuer]
}

run "rejects_a_workos_issuer_with_a_wildcard" {
  command = plan
  variables {
    workos_issuer = "https://api.workos.com/user_management/*"
  }
  expect_failures = [var.workos_issuer]
}

run "rejects_a_workos_issuer_with_a_dot_segment" {
  command = plan
  variables {
    workos_issuer = "https://api.workos.com/user_management/../client_01EXAMPLE"
  }
  expect_failures = [var.workos_issuer]
}

run "rejects_a_workos_issuer_with_an_empty_segment" {
  command = plan
  variables {
    workos_issuer = "https://api.workos.com//user_management"
  }
  expect_failures = [var.workos_issuer]
}

run "rejects_a_workos_issuer_path_that_is_not_https" {
  command = plan
  variables {
    workos_issuer = "http://api.workos.com/user_management/client_01EXAMPLE"
  }
  expect_failures = [var.workos_issuer]
}

run "a_drafting_model_must_be_a_global_profile" {
  command = plan
  variables {
    update_model = "anthropic.claude-opus-5-5"
  }
  expect_failures = [var.update_model]
}

run "a_geography_profile_needs_its_own_policy_first" {
  command = plan
  variables {
    update_model = "eu.anthropic.claude-opus-5-5"
  }
  expect_failures = [var.update_model]
}

run "the_digest_needs_the_lifecycle_worker" {
  command = plan
  variables {
    digest_from = "updates@example.com"
  }
  expect_failures = [var.digest_from]
}

run "rejects_a_digest_sender_that_is_not_an_address" {
  command = plan
  variables {
    update_model = "global.anthropic.claude-opus-5-5"
    digest_from  = "Oryxa <updates@example.com>"
  }
  expect_failures = [var.digest_from]
}

run "rejects_an_event_public_key_that_is_not_a_pem_public_key" {
  command = plan
  variables {
    event_public_key = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n"
  }
  expect_failures = [var.event_public_key]
}

run "the_workers_need_their_queues" {
  command = plan
  variables {
    consumers = ["lifecycle"]
  }
  expect_failures = [var.consumers]
}

# ---------------------------------------------------------------- the MCP server (#165)

# oryxa-fde-mcp: a read-only server an FDE's own agent reads project context from (ADR 0006). Behind enable_mcp, off by
# default: nothing of it exists until the lead decides how an agent signs in (infra/README.md). Reached through a tunnel of
# its own at Cloudflare's edge, so it has no listener, no security group ingress, no load balancer and no Cloud Map name.
run "the_mcp_server_does_not_exist_by_default" {
  command = apply

  assert {
    condition = (
      length(module.mcp) == 0 && length(data.aws_iam_policy_document.mcp) == 0
      && output.mcp_env_names == null && output.mcp_hostname == null && output.mcp_tunnel_id == null
    )
    error_message = "without enable_mcp there is no MCP task, role, hostname or tunnel"
  }
  assert {
    condition     = !contains(keys(output.secrets), "cloudflared/mcp-tunnel-token") && contains(keys(output.secrets), "cloudflared/tunnel-token")
    error_message = "the MCP tunnel's token secret exists only with the server; the API's stays"
  }
  assert {
    condition = (
      !contains(keys(local.db_clients), "mcp") && !contains(keys(local.nat_https_clients), "mcp")
      && keys(local.nat_tunnel_clients) == ["api"] && keys(local.spicedb_clients) == ["api", "zed"]
    )
    error_message = "no network rule names an MCP task that does not exist"
  }
  assert {
    condition     = [for w in local.deploy_workers : w.name] == ["ingest"] && toset(keys(jsondecode(aws_ssm_parameter.deploy.insecure_value))) == toset(["cluster", "service", "workers", "api_task_definition", "migrate_task_definition", "migrate_security_group", "subnets", "ecr_repository_url", "image_tag_parameter"])
    error_message = "the deploy rolls no MCP service while it is off"
  }
}

# With the server on: who it signs in as, what it may call (the database, SpiceDB, one embedding model), how it is reached,
# and that it joins the deploy. The task roles get distinct ARNs, since the mock gives every role the same one.
run "the_mcp_server_with_enable_mcp" {
  command = apply
  variables {
    enable_mcp = true
  }
  override_resource {
    target = module.api.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/dev-api-task" }
  }
  override_resource {
    target = module.mcp.aws_iam_role.task
    values = { arn = "arn:aws:iam::000000000000:role/dev-mcp-task" }
  }
  override_resource {
    target = module.mcp.aws_iam_role.execution
    values = { arn = "arn:aws:iam::000000000000:role/dev-mcp-exec" }
  }

  # ---- its login and what it may call: nothing else
  assert {
    condition = [
      for r in flatten([for s in data.aws_iam_policy_document.mcp[0].statement : s.resources if contains(s.actions, "rds-db:connect")]) :
      regex("[^/]+$", r)
    ] == ["oryxa_fde_mcp"] && local.mcp_environment.DB_USER == "oryxa_fde_mcp"
    error_message = "the MCP server connects as oryxa_fde_mcp only: it never takes the API's login"
  }
  assert {
    condition = (
      toset(flatten([for s in data.aws_iam_policy_document.mcp[0].statement : s.actions])) == toset(["rds-db:connect", "bedrock:InvokeModel"])
      && flatten([for s in data.aws_iam_policy_document.mcp[0].statement : s.resources if s.sid == "EmbedOnTheConfiguredModel"]) == ["arn:aws:bedrock:ap-south-1::foundation-model/amazon.titan-embed-text-v2:0"]
      && alltrue([for s in data.aws_iam_policy_document.mcp[0].statement : !contains(s.resources, "*") && length(s.condition) == 0])
    )
    error_message = "the MCP role may connect as its login and embed a query on the one model: no S3, no KMS (no tool reads a file), no secret, no SQS, no other model, no bare wildcard"
  }
  assert {
    condition     = !strcontains(jsonencode(module.company_keys.config.key_policy), "dev-mcp-task")
    error_message = "the MCP role is not a reader of any company key: it reads no file"
  }

  # ---- network: nothing goes in, and the tunnel goes out
  assert {
    condition = (
      length(module.mcp[0].ingress_sources) == 0
      && module.mcp[0].egress_names == toset(["https", "postgres", "spicedb", "tunnel-tcp", "tunnel-udp"])
      && alltrue([for c in module.mcp[0].containers : length(try(c.portMappings, [])) == 0])
    )
    error_message = "no security group admits anything to the MCP task, it publishes no port, and it dials out to HTTPS, the database, SpiceDB and the tunnel's port only"
  }
  assert {
    condition = (
      contains(keys(local.db_clients), "mcp") && contains(keys(local.nat_https_clients), "mcp")
      && keys(local.nat_tunnel_clients) == ["api", "mcp"] && keys(local.spicedb_clients) == ["api", "mcp", "zed"]
    )
    error_message = "the database, the NAT (HTTPS and the tunnel port) and SpiceDB admit the MCP task's group, and the API's connector keeps its own"
  }
  assert {
    condition     = module.spicedb.ingress_sources == toset(["api", "zed", "mcp"])
    error_message = "SpiceDB admits the MCP server, which asks it who may read what"
  }

  # ---- the task: the server on its loopback, its own connector with its own token
  assert {
    condition = (
      [for c in module.mcp[0].containers : c.name] == ["mcp", "cloudflared"]
      && module.mcp[0].containers[0].entryPoint == ["/usr/local/bin/oryxa-fde-mcp"]
      && startswith(module.mcp[0].containers[0].image, "${aws_ecr_repository.api.repository_url}:")
      && module.mcp[0].containers[0].readonlyRootFilesystem && module.mcp[0].containers[1].readonlyRootFilesystem
      && startswith(module.mcp[0].containers[1].image, "cloudflare/cloudflared@sha256:")
    )
    error_message = "the MCP task is the backend image under its own entrypoint, and the pinned cloudflared, both read-only"
  }
  assert {
    condition = (
      local.mcp_environment.LISTEN_ADDR == "127.0.0.1:8081"
      && local.mcp_environment.MCP_ALLOWED_HOSTS == "fde-dev-mcp.example.com" && module.cloudflare.mcp_hostname == "fde-dev-mcp.example.com"
      && local.mcp_environment.MCP_ALLOWED_HOSTS != local.api_environment.WEB_ORIGIN
    )
    error_message = "the server listens on loopback and accepts requests addressed to its own name only (DNS rebinding guard), not the web app's"
  }
  assert {
    condition = (
      module.mcp[0].secret_env_names == toset(["WORKOS_API_KEY", "SPICEDB_PRESHARED_KEY"])
      && local.mcp_secrets == { WORKOS_API_KEY = "api/workos-api-key", SPICEDB_PRESHARED_KEY = "shared/spicedb-preshared-key" }
      && !contains(module.mcp[0].env_names, "DATABASE_URL") && !contains(module.mcp[0].env_names, "TUNNEL_TOKEN")
    )
    error_message = "the MCP container gets the two secrets its binary reads and nothing of the API's (no session key, no signing key), never DATABASE_URL, and not the tunnel token"
  }
  assert {
    condition = (
      [for x in module.mcp[0].containers[1].secrets : x.name] == ["TUNNEL_TOKEN"]
      && [for x in module.api.containers[1].secrets : x.name] == ["TUNNEL_TOKEN"]
      && length(module.mcp[0].containers[1].environment) == 0
      && output.secrets["cloudflared/mcp-tunnel-token"] != output.secrets["cloudflared/tunnel-token"]
    )
    error_message = "each connector holds one secret, its tunnel's token, and the MCP tunnel's is a secret of its own (the mock gives every secret one ARN, so which secret each connector reads is checked by name in the plan below)"
  }
  assert {
    condition = (
      module.mcp[0].containers[1].dependsOn[0].containerName == "mcp" && module.mcp[0].containers[1].dependsOn[0].condition == "START"
      && try(module.mcp[0].containers[0].healthCheck, null) == null
      && module.mcp[0].deployment.minimum_healthy_percent == 100 && local.desired == 0
    )
    error_message = "the binary has no health route, so the connector starts with the process (not 'healthy'); a rollout keeps the old task until the new runs; 0 tasks until start_services"
  }

  # ---- the deploy rolls it, last, and may pass its roles
  assert {
    condition = (
      [for w in jsondecode(aws_ssm_parameter.deploy.insecure_value).workers : w.name] == ["ingest", "mcp"]
      && jsondecode(aws_ssm_parameter.deploy.insecure_value).workers[1] == { name = "mcp", service = "oryxa-fde-mcp", task_definition = "oryxa-fde-dev-mcp" }
    )
    error_message = "the deploy parameter lists the MCP server after the ingest worker"
  }
  assert {
    condition = (
      contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:UpdateService")]), "arn:aws:ecs:ap-south-1:000000000000:service/oryxa-fde-dev/oryxa-fde-mcp")
      && contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), "arn:aws:iam::000000000000:role/dev-mcp-task")
      && contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), "arn:aws:iam::000000000000:role/dev-mcp-exec")
    )
    error_message = "the deploy role may update the MCP service and pass its two roles"
  }
  assert {
    condition     = contains(keys(output.secrets), "cloudflared/mcp-tunnel-token") && output.mcp_hostname == "fde-dev-mcp.example.com"
    error_message = "the MCP tunnel's token secret exists, and the hostname is the one mcp_hostname names"
  }
}

run "contract_mcp" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    binary           = "oryxa-fde-mcp"
    min_rows         = 10
    plain_env_names  = run.the_mcp_server_with_enable_mcp.mcp_env_names.plain
    secret_env_names = run.the_mcp_server_with_enable_mcp.mcp_env_names.secret
    features         = []
  }

  assert {
    condition     = output.table_read
    error_message = "the MCP table in infra/README.md was not read (its heading or row format changed?)"
  }
  assert {
    condition     = length(output.missing) == 0 && length(output.unexpected) == 0
    error_message = "the MCP task definition and its README table disagree: missing ${join(", ", output.missing)}; unexpected ${join(", ", output.unexpected)}"
  }
  assert {
    condition     = length(output.secrets_as_plain) == 0 && length(output.injected_non_secrets) == 0
    error_message = "the MCP server's secrets are injected from Secrets Manager, never set as plain config"
  }
}

# The WorkOS issuer is the API's rule for the MCP server too: it verifies the same tokens.
run "the_mcp_server_pins_the_workos_issuer_when_one_is_set" {
  command = plan
  variables {
    enable_mcp    = true
    workos_issuer = "https://auth.example.com/"
  }

  assert {
    condition     = local.mcp_environment.WORKOS_ISSUER == "https://auth.example.com/"
    error_message = "a custom auth domain applies to the MCP server's tokens as to the API's"
  }
}

# The tunnel, its one hostname and its ingress rule (modules/cloudflare, run on its own).
run "the_mcp_hostname_is_a_tunnel_at_the_edge_and_nothing_in_aws" {
  command = apply
  module {
    source = "../../modules/cloudflare"
  }
  providers = {
    cloudflare = cloudflare
  }
  # The mock gives every tunnel one id; these make the two tunnels, and so what refers to which, distinguishable.
  override_resource {
    target = cloudflare_zero_trust_tunnel_cloudflared.api
    values = { id = "api-tunnel-id" }
  }
  override_resource {
    target = cloudflare_zero_trust_tunnel_cloudflared.mcp
    values = { id = "mcp-tunnel-id" }
  }
  variables {
    account_id     = "mock"
    zone_id        = "mock"
    name           = "oryxa-fde-test"
    web_hostname   = "fde-dev.example.com"
    admin_hostname = "fde-dev-admin.example.com"
    mcp_hostname   = "fde-dev-mcp.example.com"
    api_port       = 8080
    mcp_enabled    = true
    mcp_port       = 8081
    admin_emails   = ["owner@example.com"]
  }

  assert {
    condition = (
      cloudflare_zero_trust_tunnel_cloudflared.mcp[0].name == "oryxa-fde-test-mcp"
      && cloudflare_zero_trust_tunnel_cloudflared.mcp[0].config_src == "cloudflare"
      && cloudflare_zero_trust_tunnel_cloudflared.mcp[0].name != cloudflare_zero_trust_tunnel_cloudflared.api.name
      && output.mcp_tunnel_id == "mcp-tunnel-id" && output.tunnel_id == "api-tunnel-id"
    )
    error_message = "the MCP server has a tunnel of its own, remotely managed, so its token is not the API's"
  }
  assert {
    condition = (
      [for i in cloudflare_zero_trust_tunnel_cloudflared_config.mcp[0].config.ingress : "${coalesce(i.hostname, "*")} ${i.service}"]
      == ["fde-dev-mcp.example.com http://127.0.0.1:8081", "* http_status:404"]
      && cloudflare_zero_trust_tunnel_cloudflared_config.mcp[0].tunnel_id == "mcp-tunnel-id"
    )
    error_message = "the tunnel serves one name, to the connector's own loopback, and answers 404 to any other"
  }
  assert {
    condition = (
      cloudflare_dns_record.mcp[0].name == "fde-dev-mcp.example.com" && cloudflare_dns_record.mcp[0].type == "CNAME"
      && cloudflare_dns_record.mcp[0].proxied == true
      && cloudflare_dns_record.mcp[0].content == "mcp-tunnel-id.cfargotunnel.com"
    )
    error_message = "the MCP host name is a proxied record to the MCP tunnel, so it resolves to Cloudflare and never to an address in AWS"
  }
  assert {
    condition = (
      toset(keys(cloudflare_dns_record.worker)) == toset(["fde-dev.example.com", "fde-dev-admin.example.com"])
      && cloudflare_connectivity_directory_service.api.host.network.tunnel_id == "api-tunnel-id"
      && output.mcp_hostname == "fde-dev-mcp.example.com"
    )
    error_message = "the Worker hostnames and the API's VPC service on its own tunnel are untouched"
  }
}

run "no_mcp_hostname_or_tunnel_while_it_is_off" {
  command = plan
  module {
    source = "../../modules/cloudflare"
  }
  providers = {
    cloudflare = cloudflare
  }
  variables {
    account_id     = "mock"
    zone_id        = "mock"
    name           = "oryxa-fde-test"
    web_hostname   = "fde-dev.example.com"
    admin_hostname = "fde-dev-admin.example.com"
    mcp_hostname   = "fde-dev-mcp.example.com"
    api_port       = 8080
    admin_emails   = ["owner@example.com"]
  }

  assert {
    condition = (
      length(cloudflare_zero_trust_tunnel_cloudflared.mcp) == 0 && length(cloudflare_zero_trust_tunnel_cloudflared_config.mcp) == 0
      && length(cloudflare_dns_record.mcp) == 0 && output.mcp_hostname == null && output.mcp_tunnel_id == null
    )
    error_message = "no tunnel, ingress rule, record or name for the MCP server unless it is enabled"
  }
}

# ---------------------------------------------------------------- host names: explicit, one level under the zone

# Universal SSL covers the zone and one label below it, and the zone also holds the production names, so the names are
# required inputs, validated against the zone, and never derived.
run "host_names_may_be_the_zone_or_one_label_under_it" {
  command = plan
  variables {
    web_hostname   = "example.com"
    admin_hostname = "fde-dev-admin.example.com"
  }
  assert {
    condition     = output.web_hostname == "example.com" && local.api_environment.WEB_ORIGIN == "https://example.com"
    error_message = "the zone itself is a valid name (the production web app's), and WEB_ORIGIN follows it"
  }
}

run "a_two_level_web_name_is_refused" {
  command = plan
  variables {
    web_hostname = "app.fde-dev.example.com"
  }
  expect_failures = [var.web_hostname]
}

run "a_two_level_admin_name_is_refused" {
  command = plan
  variables {
    admin_hostname = "admin.fde-dev.example.com"
  }
  expect_failures = [var.admin_hostname]
}

run "a_two_level_mcp_name_is_refused" {
  command = plan
  variables {
    enable_mcp   = true
    mcp_hostname = "mcp.fde-dev.example.com"
  }
  expect_failures = [var.mcp_hostname]
}

run "a_name_outside_the_zone_is_refused" {
  command = plan
  variables {
    # shares the zone's text as a suffix but is not under it
    web_hostname = "fde-dev-example.com"
  }
  expect_failures = [var.web_hostname]
}

run "an_uppercase_name_is_refused" {
  command = plan
  variables {
    web_hostname = "FDE-dev.example.com"
  }
  expect_failures = [var.web_hostname]
}

run "the_web_and_admin_names_must_differ" {
  command = plan
  variables {
    admin_hostname = "fde-dev.example.com"
  }
  expect_failures = [var.admin_hostname]
}

run "the_mcp_name_must_differ_from_the_others" {
  command = plan
  variables {
    enable_mcp   = true
    mcp_hostname = "fde-dev-admin.example.com"
  }
  expect_failures = [var.mcp_hostname]
}

run "enable_mcp_needs_a_name" {
  command = plan
  variables {
    enable_mcp   = true
    mcp_hostname = null
  }
  expect_failures = [var.mcp_hostname]
}

run "no_mcp_name_is_needed_while_it_is_off" {
  command = plan
  variables {
    mcp_hostname = null
  }
  assert {
    condition     = output.mcp_hostname == null && module.cloudflare.mcp_hostname == null
    error_message = "without enable_mcp no name is needed and none is exposed"
  }
}

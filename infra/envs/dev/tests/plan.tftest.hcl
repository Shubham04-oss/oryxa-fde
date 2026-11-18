# Plans the dev environment and its modules on mock providers: no credentials, no AWS or
# Cloudflare calls (CI's infra job). Catches plan-time errors `tofu validate` cannot (for_each over
# unknown values) and pins the security rules: nothing public, IAM database auth, secrets by
# reference only, every service stopped until start_services, and (since #298) nothing beyond what
# sign-in needs: the API, SpiceDB, the database and the one-off tasks.

mock_provider "aws" {
  # Mocks return random strings; these resources validate ARNs and lists at plan time.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  # The account and region the provider would report; the ARNs the tests compare are built from them.
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
  admin_emails           = ["owner@example.com"]
  workos_client_id       = "client_mock"
  cloudtrail_bucket_name = "oryxa-fde-dev-trail-mock"
  api_image_tag          = "mock"
}

# ---------------------------------------------------------------- the environment

run "dev_plans_without_credentials" {
  command = plan

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
}

# What sign-in needs and nothing else (#298): the API, SpiceDB, the migrate, db-admin and zed tasks, their logins, their
# network rules and the four secrets sign-in reads. A worker, a bus, a queue or a data bucket coming back fails here first.
run "the_environment_holds_only_what_sign_in_needs" {
  command = plan

  assert {
    condition     = keys(local.db_user) == ["api", "migrate", "spicedb"]
    error_message = "three database logins: the API's, the migrator's and SpiceDB's"
  }
  # Every login the tasks use is made by the bootstrap and listed with its use in the README.
  assert {
    condition = alltrue([
      for u in values(local.db_user) :
      strcontains(file("${path.module}/../../sql/01-bootstrap.sql"), u) && strcontains(file("${path.module}/../../README.md"), "| `${u}` |")
    ])
    error_message = "every database login in local.db_user is created by infra/sql/01-bootstrap.sql and in the README's Database logins table"
  }
  assert {
    condition = (
      keys(local.db_clients) == ["api", "db_admin", "migrate", "spicedb"]
      && keys(local.nat_https_clients) == ["api", "db_admin", "migrate", "spicedb", "zed"]
      && keys(local.nat_tunnel_clients) == ["api"]
      && keys(local.spicedb_clients) == ["api", "zed"]
    )
    error_message = "the database, the NAT and SpiceDB admit only the API, SpiceDB and the one-off tasks; only the API task dials the tunnel"
  }
  assert {
    condition = toset(keys(output.secrets)) == toset([
      "api/workos-api-key", "api/session-password", "shared/spicedb-preshared-key", "cloudflared/tunnel-token",
    ])
    error_message = "four secrets: the WorkOS key, the session password, the SpiceDB key and the tunnel token"
  }
  assert {
    condition     = output.secrets["api/session-password"] == "oryxa-fde-dev/api/session-password"
    error_message = "a secret is named oryxa-fde-<env>/<name>"
  }
}

# The API's environment contract (#108): infra/README.md's table, read from the code, is what the API
# task definition must match. A variable the code needs and the task lacks (the API would not start),
# one the task sets that the table does not know (a rename the code never saw), or a secret value set as
# plain config, fails here. The run applies the environment to the mock providers (a plan run exposes no
# outputs to later runs), then ./tests/contract compares the names.
run "the_api_task" {
  command = apply

  # Least privilege: the API calls AWS only to sign in to the database, as its own login.
  assert {
    condition = (
      [for st in data.aws_iam_policy_document.api.statement : st.sid] == ["ConnectAsOwnUser"]
      && flatten([for st in data.aws_iam_policy_document.api.statement : st.actions]) == ["rds-db:connect"]
    )
    error_message = "the API's role holds one statement, rds-db:connect: no S3, KMS, Bedrock, EventBridge or Secrets Manager"
  }
  assert {
    condition     = alltrue([for st in data.aws_iam_policy_document.api.statement : !contains(st.resources, "*")])
    error_message = "no statement of the API's role takes a bare wildcard resource"
  }
  assert {
    condition = (
      module.api.secret_env_names == toset(["WORKOS_API_KEY", "SESSION_PASSWORD", "SPICEDB_PRESHARED_KEY"])
      && !contains(module.api.env_names, "DATABASE_URL")
    )
    error_message = "the API container gets the three secrets sign-in reads, by reference, and never DATABASE_URL"
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

run "contract_of_the_api" {
  command = plan
  module {
    source = "./tests/contract"
  }
  providers = {
    aws = aws
  }
  variables {
    plain_env_names  = run.the_api_task.api_env_names.plain
    secret_env_names = run.the_api_task.api_env_names.secret
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
    task = run.the_api_task.api_task_timing
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

# The container health check and the shutdown grace against the API's source, the Dockerfile and infra/README.md
# (./tests/code reads them as text). Wrong here means: the check runs something the image does not have or the code
# does not dispatch, ECS would kill the check before it gives up, the grace is a value the API refuses to start with,
# or the container is killed before the grace is over.
run "the_api_health_check_and_the_stop_sequence_match_the_code" {
  command = plan
  module {
    source = "./tests/code"
  }
  providers = {
    aws = aws
  }
  variables {
    task = run.the_api_task.api_task_timing
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
  # The image: distroless, nonroot, the two binaries, and nothing else (no busybox for the old check).
  assert {
    condition = (
      length([for i in output.image : i if startswith(i, "FROM ")]) == 1
      && anytrue([for i in output.image : startswith(i, "FROM gcr.io/distroless/cc-debian13:nonroot@sha256:")])
      && contains(output.image, "USER nonroot")
      && contains(output.image, "COPY --chmod=0555 oryxa-fde-api oryxa-fde-ops /usr/local/bin/")
      && length([for i in output.image : i if startswith(i, "COPY ") || startswith(i, "ADD ") || startswith(i, "RUN ")]) == 1
    )
    error_message = "the image is one distroless nonroot stage that adds the API's two binaries and nothing else"
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

# GitHub deploys (#31, #165): only deploy-api.yml on main, in this repository's dev environment, may assume
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

run "deploy_role_reaches_only_the_api_image_the_migrate_task_and_the_api_service" {
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
    error_message = "the one service the deploy role may update is the API's: not SpiceDB"
  }
  assert {
    condition = flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:DescribeServices")
    ]) == flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "ecs:UpdateService")])
    error_message = "the deploy waits on exactly the services it updates"
  }
  assert {
    condition = toset(keys(jsondecode(aws_ssm_parameter.deploy.insecure_value))) == toset([
      "cluster", "service", "api_task_definition", "migrate_task_definition", "migrate_security_group", "subnets",
      "ecr_repository_url", "image_tag_parameter",
    ])
    error_message = "the deploy parameter names the API and the migrate task, and no worker list (deploy-api rolls the API alone)"
  }
}

# What the deploy role may hand a task definition revision to run as (iam:PassRole is the only limit on a family:
# registering takes no resource). The mock gives every role one ARN, so each role below gets its own: a role the deploy
# must not pass (SpiceDB, db-admin, zed) keeps the mock's, which none of the lists may hold.
run "the_deploy_role_passes_only_the_roles_of_the_api_and_the_migrate_task" {
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

  assert {
    condition = toset(flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")
    ])) == toset([for r in ["api-task", "api-exec", "migrate-task", "migrate-exec"] : "arn:aws:iam::000000000000:role/dev-${r}"])
    error_message = "the deploy role passes the API's and the migrate task's task and execution roles, and no other"
  }
  assert {
    condition = (
      [for s in data.aws_iam_policy_document.github_deploy.statement : s.sid if contains(s.actions, "iam:PassRole")] == ["PassOnlyDeployedServiceRoles"]
      && !contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), module.spicedb.task_role_arn)
      && !contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.resources if contains(s.actions, "iam:PassRole")]), module.db_admin.task_role_arn)
    )
    error_message = "one PassRole statement, and never SpiceDB's, db-admin's or zed's roles (the mock's shared ARN)"
  }
  # The deploy parameter is what the workflow reads: the API's service and family, and the migrate task's.
  assert {
    condition = (
      jsondecode(aws_ssm_parameter.deploy.insecure_value).service == "oryxa-fde-api"
      && jsondecode(aws_ssm_parameter.deploy.insecure_value).api_task_definition == "oryxa-fde-dev-api"
      && jsondecode(aws_ssm_parameter.deploy.insecure_value).migrate_task_definition == "oryxa-fde-dev-migrate"
    )
    error_message = "the deploy parameter names the API's service and task family and the migrate task's family"
  }
}

# Drift: an apply after a deploy must build the API and the migrate task from the sha the workflow recorded, never from
# api_image_tag (which only seeds the parameter), or it would roll the API back to an older image.
run "the_api_and_the_migrate_task_run_the_recorded_image_tag" {
  command = plan
  override_data {
    target = data.aws_ssm_parameter.api_image_tag
    values = { insecure_value = "deployed-sha" }
  }

  assert {
    condition = alltrue([
      for c in [module.api.containers[0], module.migrate.containers[0]] :
      c.image == "${aws_ecr_repository.api.repository_url}:deployed-sha"
    ])
    error_message = "the API and the migrate task take the tag deploy-api recorded, not api_image_tag"
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

# The trail logs management events in every Region; it adds a data event selector only for a bucket it is given, and
# dev has no customer data bucket since #298.
run "the_trail_logs_management_events_and_no_data_events_without_a_bucket" {
  command = plan
  module {
    source = "../../modules/cloudtrail"
  }
  providers = {
    aws = aws
  }
  variables {
    name        = "oryxa-fde-test"
    bucket_name = "oryxa-fde-test-trail"
  }

  assert {
    condition = (
      aws_cloudtrail.this.is_multi_region_trail && aws_cloudtrail.this.include_global_service_events
      && aws_cloudtrail.this.enable_log_file_validation
      && aws_cloudtrail.this.kms_key_id == "arn:aws:kms:ap-south-1:000000000000:key/mock"
    )
    error_message = "every Region, global service events, log file validation, its own key"
  }
  assert {
    condition     = [for sel in aws_cloudtrail.this.advanced_event_selector : sel.name] == ["Management events"]
    error_message = "management events only: no data event selector without a data bucket"
  }
  assert {
    condition     = aws_s3_bucket.this.force_destroy == false && aws_s3_bucket_public_access_block.this.restrict_public_buckets
    error_message = "the log bucket is private and destroy may not empty it unless asked"
  }
}

run "the_trail_logs_object_access_on_a_data_bucket_it_is_given" {
  command = plan
  module {
    source = "../../modules/cloudtrail"
  }
  providers = {
    aws = aws
  }
  variables {
    name             = "oryxa-fde-test"
    bucket_name      = "oryxa-fde-test-trail"
    data_bucket_arns = ["arn:aws:s3:::oryxa-fde-test-data"]
  }

  assert {
    condition = (
      [for sel in aws_cloudtrail.this.advanced_event_selector : sel.name] == ["Management events", "Customer data objects"]
      && jsonencode(one([for f in aws_cloudtrail.this.advanced_event_selector[1].field_selector : f.starts_with if f.field == "resources.ARN"])) == jsonencode(["arn:aws:s3:::oryxa-fde-test-data/"])
    )
    error_message = "a named bucket's object reads and writes are logged, under that bucket only"
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

# ---------------------------------------------------------------- the WorkOS issuer

run "workos_issuer_is_set_only_for_a_custom_auth_domain" {
  command = plan
  variables {
    workos_issuer = "https://auth.example.com/"
  }

  assert {
    condition     = local.api_environment.WORKOS_ISSUER == "https://auth.example.com/"
    error_message = "the API pins the issuer it is given"
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


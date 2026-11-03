# Plans the dev environment and its modules on mock providers: no credentials, no AWS or
# Cloudflare calls (CI's infra job). Catches plan-time errors `tofu validate` cannot (for_each over
# unknown values) and pins the security rules: nothing public, IAM database auth, secrets by
# reference only, every service stopped until start_services.

mock_provider "aws" {
  # Mocks return random strings; these resources validate ARNs and lists at plan time.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      master_user_secret = [{
        kms_key_id    = "mock"
        secret_arn    = "arn:aws:secretsmanager:us-west-2:000000000000:secret:mock"
        secret_status = "active"
      }]
    }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-west-2:000000000000:key/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:000000000000:loadbalancer/app/mock/0" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:000000000000:targetgroup/mock/0" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-west-2:000000000000:cluster/mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-west-2:000000000000:task-definition/mock:1" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:mock" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-west-2:000000000000:service/srv-mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-west-2:000000000000:mock" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:us-west-2:000000000000:repository/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-west-2:000000000000:log-group:mock" }
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
  event_bus_arn          = "arn:aws:events:us-west-2:000000000000:event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde"
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

  # The env names crates/oryxa-fde-api reads (infra/README.md). Secrets arrive by reference only.
  assert {
    condition = length(setsubtract([
      "ORYXA_ENV", "AWS_REGION", "PORT", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "SPICEDB_ENDPOINT",
      "SPICEDB_KEY", "EVENT_BUS_ARN", "EVENT_SIGNING_KID", "EVENT_SIGNING_KEY_PEM", "DATA_BUCKET",
      "WORKOS_CLIENT_ID", "WORKOS_API_KEY", "WEB_ORIGIN",
    ], module.api.env_names)) == 0
    error_message = "oryxa-fde-api is missing an env name from the contract"
  }

  assert {
    condition = (
      output.web_hostname == "app.fde-dev.example.com" && output.admin_hostname == "admin.fde-dev.example.com"
    )
    error_message = "hostnames hang off var.domain"
  }
}

run "rejects_a_bus_that_is_not_oryxa_fde" {
  command = plan
  variables {
    event_bus_arn = "arn:aws:events:us-west-2:000000000000:event-busv2/oryxa-dev/abcdefghij0123456789abcde"
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
    kms_key_arn             = "arn:aws:kms:us-west-2:000000000000:key/mock"
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
      && aws_db_instance.this.kms_key_id == "arn:aws:kms:us-west-2:000000000000:key/mock"
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
    condition = alltrue([
      for r in aws_vpc_security_group_ingress_rule.pg : r.cidr_ipv4 == null && r.referenced_security_group_id != null
    ])
    error_message = "5432 only from named security groups, never a CIDR"
  }
}

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
    cluster_arn    = "arn:aws:ecs:us-west-2:000000000000:cluster/mock"
    container_name = "api"
    image          = "example/api:1"
    port           = 8080
    kms_key_arn    = "arn:aws:kms:us-west-2:000000000000:key/mock"
    vpc_id         = "vpc-mock"
    subnet_ids     = ["subnet-a"]
    environment    = { B = "2", A = "1" }
    secrets = {
      KEY      = { arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:key" }
      PASSWORD = { arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:master", key = "password" }
    }
    egress        = { https = { port = 443, cidr = "0.0.0.0/0" } }
    desired_count = 0
  }

  assert {
    condition = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].secrets == [
      { name = "KEY", valueFrom = "arn:aws:secretsmanager:us-west-2:000000000000:secret:key" },
      { name = "PASSWORD", valueFrom = "arn:aws:secretsmanager:us-west-2:000000000000:secret:master:password::" },
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
    cluster_arn    = "arn:aws:ecs:us-west-2:000000000000:cluster/mock"
    container_name = "psql"
    image          = "example/psql:1"
    kms_key_arn    = "arn:aws:kms:us-west-2:000000000000:key/mock"
    vpc_id         = "vpc-mock"
    subnet_ids     = ["subnet-a"]
    egress         = {}
  }

  assert {
    condition     = length(aws_ecs_service.this) == 0
    error_message = "db-admin runs only when started by hand"
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
    account_id          = "mock"
    zone_id             = "mock"
    name                = "oryxa-fde-test"
    domain              = "fde-dev.example.com"
    api_origin_hostname = "internal-oryxa-fde-test-api.us-west-2.elb.amazonaws.com"
    admin_emails        = ["owner@example.com"]
  }

  assert {
    condition = (
      cloudflare_connectivity_directory_service.api.host.hostname == var.api_origin_hostname
      && cloudflare_connectivity_directory_service.api.host.resolver_network.tunnel_id == cloudflare_zero_trust_tunnel_cloudflared.api.id
    )
    error_message = "the Workers VPC service targets the internal ALB"
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

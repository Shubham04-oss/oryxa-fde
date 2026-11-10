# One main container on Fargate (ARM64) in private subnets, plus optional sidecars: task definition,
# its own log group, roles and security group, and optionally the ECS service. Used for oryxa-fde-api
# (with the cloudflared sidecar), SpiceDB and the one-off tasks.
#
# Secrets are Secrets Manager ARNs that ECS injects at task start; the execution role may read
# exactly those ARNs (the main container's and the sidecars'), and decrypt only through Secrets
# Manager. The values never reach config or state. The security group starts closed: every ingress
# and egress rule is named by the caller. Containers of one task share a network namespace, so a
# sidecar reaches the main container on localhost and needs no security group rule for it.

variable "name" {
  description = "Prefix for roles, log group, security group and task family, e.g. oryxa-fde-dev-api."
  type        = string
}

variable "service_name" {
  description = "ECS service name inside the cluster. Null means var.name."
  type        = string
  default     = null
}

variable "run_as_service" {
  description = "false = task definition only, started by hand with `aws ecs run-task` (db-admin)."
  type        = bool
  default     = true
}

variable "cluster_arn" {
  type = string
}

variable "container_name" {
  type = string
}

variable "image" {
  type = string
}

variable "entry_point" {
  description = "Overrides the image's ENTRYPOINT (one-off tool tasks run `sh -c`). Null keeps the image's."
  type        = list(string)
  default     = null
}

variable "command" {
  type    = list(string)
  default = null
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory" {
  type    = number
  default = 512
}

variable "port" {
  description = "Container port, or null if the container listens on nothing."
  type        = number
  default     = null
}

variable "environment" {
  description = "Plain configuration. Never secrets."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Env name => Secrets Manager secret (and optional JSON key) that ECS injects at task start."
  type = map(object({
    arn = string
    key = optional(string)
  }))
  default = {}
}

variable "kms_key_arn" {
  description = "Key the secrets are encrypted with (decrypt only via Secrets Manager)."
  type        = string
}

variable "ecr_repository_arns" {
  description = "ECR repositories the image comes from. Empty for public registries."
  type        = list(string)
  default     = []
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "ingress" {
  description = "Who may reach the container port, by security group, keyed by a static name."
  type        = map(string)
  default     = {}
}

variable "egress" {
  description = "Outbound rules, keyed by a static name: a CIDR or a security group, never both."
  type = map(object({
    port              = number
    protocol          = optional(string, "tcp")
    cidr              = optional(string)
    security_group_id = optional(string)
  }))
}

variable "task_policies" {
  description = "Inline policies for the task role (what the code may call), keyed by a static name."
  type        = map(string)
  default     = {}
}

variable "health_check" {
  description = "Container health check of the main container (a command run inside it, exit 0 = healthy). ECS replaces a task whose essential container fails it, and a rollout waits for it. Null: none."
  type = object({
    command      = list(string)
    interval     = optional(number, 10)
    timeout      = optional(number, 5)
    retries      = optional(number, 3)
    start_period = optional(number, 30)
  })
  default = null
}

variable "sidecars" {
  description = "Extra essential containers in the same task, keyed by container name. They start only after the main container is healthy (or started, if it has no health check) and stop before it."
  type = map(object({
    image        = string
    command      = optional(list(string))
    secrets      = optional(map(object({ arn = string })), {})
    stop_timeout = optional(number)
  }))
  default = {}
}

variable "load_balancer" {
  description = "Target group to register the task in (for an environment that fronts the service with the internal_alb module; dev does not). The object stays known while its ARN is not."
  type        = object({ target_group_arn = string })
  default     = null
}

variable "service_registry" {
  description = "Cloud Map service to register the task in (private DNS)."
  type        = object({ arn = string })
  default     = null
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "single_task" {
  description = "Replace in place on deploy (min 0 %, max 100 %) instead of starting the new task first."
  type        = bool
  default     = false
}

variable "read_only_root" {
  type    = bool
  default = true
}

variable "log_retention_days" {
  type    = number
  default = 14
}

data "aws_region" "current" {}

locals {
  region = data.aws_region.current.region

  # Every secret any container of the task is injected with, for the execution role.
  all_secrets = concat(values(var.secrets), flatten([for c in values(var.sidecars) : values(c.secrets)]))

  log_configuration = { for name in concat([var.container_name], keys(var.sidecars)) : name => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.this.name
      awslogs-region        = local.region
      awslogs-stream-prefix = name
    }
  } }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- execution role (ECS agent)

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = length(local.all_secrets) > 0 ? [1] : []
    content {
      actions   = ["secretsmanager:GetSecretValue"]
      resources = distinct([for s in local.all_secrets : s.arn])
    }
  }

  dynamic "statement" {
    for_each = length(local.all_secrets) > 0 ? [1] : []
    content {
      actions   = ["kms:Decrypt"]
      resources = [var.kms_key_arn]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${local.region}.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [1] : []
    content {
      actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      resources = var.ecr_repository_arns
    }
  }

  # GetAuthorizationToken has no resource-level scoping.
  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [1] : []
    content {
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# ---------------------------------------------------------------- task role (the code)

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "task" {
  for_each = var.task_policies
  name     = each.key
  role     = aws_iam_role.task.id
  policy   = each.value
}

# ---------------------------------------------------------------- network

resource "aws_security_group" "this" {
  name        = "${var.name}-task"
  description = "${var.name} task"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  for_each                     = var.ingress
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.port
  to_port                      = var.port

  lifecycle {
    precondition {
      condition     = var.port != null
      error_message = "ingress needs a container port."
    }
  }
}

resource "aws_vpc_security_group_egress_rule" "this" {
  for_each                     = var.egress
  security_group_id            = aws_security_group.this.id
  cidr_ipv4                    = each.value.cidr
  referenced_security_group_id = each.value.security_group_id
  ip_protocol                  = each.value.protocol
  from_port                    = each.value.port
  to_port                      = each.value.port
}

# ---------------------------------------------------------------- task and service

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode(concat([{
    name                   = var.container_name
    image                  = var.image
    essential              = true
    entryPoint             = var.entry_point
    command                = var.command
    readonlyRootFilesystem = var.read_only_root
    portMappings           = var.port == null ? [] : [{ containerPort = var.port, protocol = "tcp" }]
    environment            = [for k in sort(keys(var.environment)) : { name = k, value = var.environment[k] }]
    secrets = [for k in sort(keys(var.secrets)) : {
      name      = k
      valueFrom = var.secrets[k].key == null ? var.secrets[k].arn : "${var.secrets[k].arn}:${var.secrets[k].key}::"
    }]
    healthCheck = var.health_check == null ? null : {
      command     = concat(["CMD"], var.health_check.command)
      interval    = var.health_check.interval
      timeout     = var.health_check.timeout
      retries     = var.health_check.retries
      startPeriod = var.health_check.start_period
    }
    logConfiguration = local.log_configuration[var.container_name]
    }], [
    for name in sort(keys(var.sidecars)) : {
      name                   = name
      image                  = var.sidecars[name].image
      essential              = true
      command                = var.sidecars[name].command
      readonlyRootFilesystem = var.read_only_root
      environment            = []
      secrets = [for k in sort(keys(var.sidecars[name].secrets)) : {
        name      = k
        valueFrom = var.sidecars[name].secrets[k].arn
      }]
      stopTimeout = var.sidecars[name].stop_timeout
      dependsOn = [{
        containerName = var.container_name
        condition     = var.health_check == null ? "START" : "HEALTHY"
      }]
      logConfiguration = local.log_configuration[name]
    }
  ]))
}

resource "aws_ecs_service" "this" {
  count           = var.run_as_service ? 1 : 0
  name            = coalesce(var.service_name, var.name)
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = var.single_task ? 0 : 100
  deployment_maximum_percent         = var.single_task ? 100 : 200
  health_check_grace_period_seconds  = var.load_balancer == null ? null : 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.load_balancer == null ? [] : [var.load_balancer]
    content {
      target_group_arn = load_balancer.value.target_group_arn
      container_name   = var.container_name
      container_port   = var.port
    }
  }

  dynamic "service_registries" {
    for_each = var.service_registry == null ? [] : [var.service_registry]
    content {
      registry_arn = service_registries.value.arn
    }
  }
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

output "task_family" {
  value = aws_ecs_task_definition.this.family
}

output "service_name" {
  value = var.run_as_service ? aws_ecs_service.this[0].name : null
}

output "env_names" {
  description = "Every env name the container gets (plain and secret), for tests."
  value       = setunion(keys(var.environment), keys(var.secrets))
}

output "plain_env_names" {
  description = "Env names set as plain configuration (visible in the task definition), for tests."
  value       = toset(keys(var.environment))
}

output "secret_env_names" {
  description = "Env names injected from Secrets Manager, for tests."
  value       = toset(keys(var.secrets))
}

output "containers" {
  description = "The task's container definitions, decoded (names, health check, dependencies, secret ARNs; never values), for tests."
  value       = jsondecode(aws_ecs_task_definition.this.container_definitions)
}

output "secret_arns" {
  description = "Secrets the execution role may read, for tests."
  value       = toset([for s in local.all_secrets : s.arn])
}

output "ingress_sources" {
  description = "Security groups admitted to the container port, for tests."
  value       = toset(keys(var.ingress))
}

output "egress_names" {
  description = "Names of the outbound rules, for tests."
  value       = toset(keys(var.egress))
}

output "deployment" {
  description = "Rolling deployment limits (percent of desired_count), for tests. Null for a one-off task."
  value = var.run_as_service ? {
    minimum_healthy_percent = aws_ecs_service.this[0].deployment_minimum_healthy_percent
    maximum_percent         = aws_ecs_service.this[0].deployment_maximum_percent
  } : null
}

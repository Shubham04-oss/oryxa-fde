# One container on Fargate (ARM64) in private subnets: task definition, its own log group, roles
# and security group, and optionally the ECS service. Used for oryxa-fde-api, SpiceDB, cloudflared
# and the one-off db-admin task.
#
# Secrets are Secrets Manager ARNs that ECS injects at task start; the execution role may read
# exactly those ARNs, and decrypt only through Secrets Manager. The values never reach config or
# state. The security group starts closed: every ingress and egress rule is named by the caller.

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

variable "load_balancer" {
  description = "Target group to register the task in. The object stays known while its ARN is not."
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
    for_each = length(var.secrets) > 0 ? [1] : []
    content {
      actions   = ["secretsmanager:GetSecretValue"]
      resources = distinct([for s in values(var.secrets) : s.arn])
    }
  }

  dynamic "statement" {
    for_each = length(var.secrets) > 0 ? [1] : []
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

  container_definitions = jsonencode([{
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
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = local.region
        awslogs-stream-prefix = var.container_name
      }
    }
  }])
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

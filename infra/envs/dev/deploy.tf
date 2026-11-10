# Deploys from GitHub Actions (.github/workflows/deploy-api.yml) with OIDC: no AWS key exists
# anywhere. The role trusts only that workflow, run from main, in the GitHub environment named after
# var.env, and may only push the API image, run the migrate task and update the API and the worker services.
# deploy-workers needs no AWS access, so it cannot assume the role.

# One GitHub OIDC provider per account. Pass github_oidc_provider_arn when the account already has one.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == null ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_oidc_provider_arn = (
    var.github_oidc_provider_arn != null ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
  )

  # The workers one deploy rolls after the API, in this order: the deploy parameter lists them for the workflow, and the
  # role below may update exactly their services and pass exactly their roles. A worker that is not deployed (the
  # lifecycle worker until update_model is set) is not here, so the workflow skips it by config, not by catching an error.
  deploy_workers = concat(
    [{ name = "ingest", service = module.ingest.service_name, task_definition = module.ingest.task_family }],
    local.lifecycle_on ? [{ name = "lifecycle", service = module.lifecycle[0].service_name, task_definition = module.lifecycle[0].task_family }] : [],
    local.mcp_on ? [{ name = "mcp", service = module.mcp[0].service_name, task_definition = module.mcp[0].task_family }] : [],
  )
  # Every task role a deploy may hand to a new task definition revision, and its execution role: the API's, the
  # migrate task's and each worker's (the MCP server's included). Never the one-off db-admin and zed tasks, SpiceDB or any other role.
  deploy_task_roles = concat(
    [module.api.task_role_arn, module.api.execution_role_arn, module.migrate.task_role_arn, module.migrate.execution_role_arn],
    [module.ingest.task_role_arn, module.ingest.execution_role_arn],
    flatten([for m in concat(module.lifecycle, module.mcp) : [m.task_role_arn, m.execution_role_arn]]),
  )
  deploy_service_arns = [
    for s in concat([module.api.service_name], [for w in local.deploy_workers : w.service]) :
    "arn:aws:ecs:${local.region}:${local.account}:service/${aws_ecs_cluster.this.name}/${s}"
  ]
}

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Exact match: only jobs that declare `environment: <env>`, so the environment's rules gate every deploy.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.env}"]
    }
    # And only the deploy workflow as it is on main, so no other workflow or branch gets in, even
    # before the environment's branch rule exists. STS validates this GitHub claim directly.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:job_workflow_ref"
      values   = ["${var.github_repository}/.github/workflows/deploy-api.yml@refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.prefix}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_assume.json
}

data "aws_iam_policy_document" "github_deploy" {
  # GetAuthorizationToken has no resource-level scoping.
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PushApiImage"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
      "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.api.arn]
  }

  # Neither action is scoped to a family (ECS takes no resource for them); PassRole below limits what any new
  # revision can run as, which is what makes a registered revision of any family harmless.
  statement {
    sid       = "TaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "PassOnlyDeployedServiceRoles"
    actions   = ["iam:PassRole"]
    resources = local.deploy_task_roles
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "RunMigrations"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${local.region}:${local.account}:task-definition/${module.migrate.task_family}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "WatchMigrations"
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:aws:ecs:${local.region}:${local.account}:task/${aws_ecs_cluster.this.name}/*"]
  }

  statement {
    sid       = "DeployServices"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = local.deploy_service_arns
  }

  statement {
    sid       = "ReadDeployConfig"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.deploy.arn]
  }

  statement {
    sid       = "RecordDeployedImage"
    actions   = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = [aws_ssm_parameter.api_image_tag.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy-api"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

# What the deploy workflow needs to find, so it hard-codes nothing but this parameter's name. Not secret.
resource "aws_ssm_parameter" "deploy" {
  name = "/${local.prefix}/deploy"
  type = "String"
  insecure_value = jsonencode({
    cluster                 = aws_ecs_cluster.this.name
    service                 = module.api.service_name
    workers                 = local.deploy_workers
    api_task_definition     = module.api.task_family
    migrate_task_definition = module.migrate.task_family
    migrate_security_group  = module.migrate.security_group_id
    subnets                 = local.subnets
    ecr_repository_url      = aws_ecr_repository.api.repository_url
    image_tag_parameter     = aws_ssm_parameter.api_image_tag.name
  })
}

# The sha the API, the workers and the migrate task run. The deploy workflow writes it once the API and every worker
# have settled on it, and every plan reads it back, so an apply never rolls a service back to an older image than the
# last complete deploy. var.api_image_tag only seeds it on the first apply.
resource "aws_ssm_parameter" "api_image_tag" {
  name           = "/${local.prefix}/api-image-tag"
  type           = "String"
  insecure_value = var.api_image_tag

  lifecycle {
    ignore_changes = [insecure_value]
  }
}

data "aws_ssm_parameter" "api_image_tag" {
  name = aws_ssm_parameter.api_image_tag.name
}

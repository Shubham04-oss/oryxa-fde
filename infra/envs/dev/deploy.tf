# Deploys from GitHub Actions (.github/workflows/deploy-api.yml) with OIDC: no AWS key exists
# anywhere. The role trusts only this repository's jobs that run in the GitHub environment named
# after var.env, and may only push the API image, run the migrate task and update the API service.

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
  api_service_arn = "arn:aws:ecs:${local.region}:${local.account}:service/${aws_ecs_cluster.this.name}/${module.api.service_name}"
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

  # Neither action is scoped to a family; PassRole below limits what any new revision can run as.
  statement {
    sid       = "TaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid     = "PassOnlyApiAndMigrateRoles"
    actions = ["iam:PassRole"]
    resources = [
      module.api.task_role_arn, module.api.execution_role_arn,
      module.migrate.task_role_arn, module.migrate.execution_role_arn,
    ]
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
    sid       = "DeployApiService"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [local.api_service_arn]
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
    api_task_definition     = module.api.task_family
    migrate_task_definition = module.migrate.task_family
    migrate_security_group  = module.migrate.security_group_id
    subnets                 = local.subnets
    ecr_repository_url      = aws_ecr_repository.api.repository_url
    image_tag_parameter     = aws_ssm_parameter.api_image_tag.name
  })
}

# The sha the API and migrate tasks run. The deploy workflow writes it after each deploy, and every
# plan reads it back, so an apply never rolls the service back to an older image. var.api_image_tag
# only seeds it on the first apply.
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

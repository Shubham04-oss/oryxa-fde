# Per-company KMS keys (ADR 0003, amendment "per-company keys"; issue #109).
#
# This module holds what is the same for every company; it creates no key. A key is made by an
# operator, per company, with infra/scripts/company-key.sh (a customer is created at run time, so one
# OpenTofu resource per company would mean an apply per customer). The script is a thin wrapper: the
# policy it puts on each key is the `key_policy` below, read from this module's `config` output, so
# the rules are written once and tested by `tofu test`.
#
# Policies are built with jsonencode, not aws_iam_policy_document, so the mock-provider tests can read them.

variable "env" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.env))
    error_message = "env must be 2 to 10 lowercase letters or digits."
  }
}

variable "bucket_name" {
  description = "The data bucket. Taken by name, not ARN, so the bucket's own policy can use this module's statements."
  type        = string
}

variable "operator_arns" {
  description = "IAM users or roles of this account that may assume the provisioning and the offboarding role."
  type        = list(string)
  validation {
    condition     = length(var.operator_arns) > 0 && alltrue([for a in var.operator_arns : can(regex("^arn:aws:iam::[0-9]{12}:(user|role)/[A-Za-z0-9+=,.@_/-]+$", a))])
    error_message = "operator_arns must hold at least one IAM user or role ARN."
  }
}

variable "writer_role_arns" {
  description = "Roles that write and read company files through S3 (today the API's task role). Each is named in every company key's policy, so a role must exist before a key is made and a replaced role needs `company-key.sh sync`."
  type        = list(string)
  validation {
    condition     = length(var.writer_role_arns) > 0 && alltrue([for a in var.writer_role_arns : can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", a))])
    error_message = "writer_role_arns must hold at least one IAM role ARN."
  }
}

variable "reader_role_arns" {
  description = "Roles that only read company files through S3 (the ingest worker and the MCP server, when they run)."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for a in var.reader_role_arns : can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", a))])
    error_message = "reader_role_arns must be IAM role ARNs."
  }
}

variable "require_company_keys" {
  description = "false: a write that names no key still lands under the environment key (sample data only). true: S3 refuses any write that does not name a company key."
  type        = bool
  default     = false
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_partition" "current" {}

locals {
  prefix    = "oryxa-fde-${var.env}"
  account   = data.aws_caller_identity.current.account_id
  region    = data.aws_region.current.region
  partition = data.aws_partition.current.partition

  provisioner_name = "${local.prefix}-company-key-provisioner"
  offboarder_name  = "${local.prefix}-company-key-offboarder"
  # Built from the names, so key policies and the bucket policy can name them without a cycle.
  provisioner_arn = "arn:${local.partition}:iam::${local.account}:role/${local.provisioner_name}"
  offboarder_arn  = "arn:${local.partition}:iam::${local.account}:role/${local.offboarder_name}"

  alias_prefix     = "alias/${local.prefix}/companies/"
  alias_arn_prefix = "arn:${local.partition}:kms:${local.region}:${local.account}:${local.alias_prefix}"
  key_arns         = "arn:${local.partition}:kms:${local.region}:${local.account}:key/*"
  bucket_arn       = "arn:${local.partition}:s3:::${var.bucket_name}"

  # The longest waiting period KMS allows. A key scheduled for deletion cannot be used at once; the
  # wait is the time to cancel a mistake.
  deletion_window_days = 30
  s3_service           = "s3.${local.region}.amazonaws.com"

  # Tags on every company key. `tenant` and `company` are added per company by the script, from validated ids.
  static_tags = { project = "oryxa-fde", env = var.env, purpose = "company-data" }
  tag_keys    = concat(keys(local.static_tags), ["tenant", "company"])
  # On a key the policies below may touch.
  company_key_tags = { "aws:ResourceTag/purpose" = "company-data", "aws:ResourceTag/env" = var.env }

  # ---------------------------------------------------------------- the key policy
  # `{tenant}` and `{company}` are replaced by the script with ids it has checked against
  # [A-Za-z0-9_-]{1,128}, so neither can hold `/`, `*` or `?`. That is what makes the pattern below a
  # prefix of one company's objects (<tenant>/<company>/..., oryxa-fde-context blob.rs).
  #
  # Use is allowed only through S3, only by the named roles, and only for objects under this company's
  # prefix: S3 sends the object ARN as the encryption context when no S3 Bucket Key is in play (and the
  # bucket's ARN when one is, which this pattern refuses), so a company's key cannot encrypt or decrypt
  # another company's object. The account's root principal gets administration only: IAM policies cannot
  # grant use of the key, and an explicit Deny closes use outside S3 (grants included) for everyone.
  use_conditions = {
    StringEquals = { "kms:ViaService" = [local.s3_service], "kms:CallerAccount" = [local.account] }
    StringLike   = { "kms:EncryptionContext:aws:s3:arn" = ["${local.bucket_arn}/{tenant}/{company}/*"] }
  }

  key_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "AccountAdministersTheKeyButCannotUseIt"
          Effect    = "Allow"
          Principal = { AWS = ["arn:${local.partition}:iam::${local.account}:root"] }
          Action = [
            "kms:Describe*", "kms:Get*", "kms:List*", "kms:PutKeyPolicy",
            "kms:TagResource", "kms:UntagResource", "kms:CreateAlias", "kms:DeleteAlias",
            "kms:EnableKeyRotation", "kms:DisableKeyRotation", "kms:UpdateKeyDescription",
          ]
          Resource = ["*"]
        },
        {
          Sid       = "ServingRolesUseTheKeyThroughS3"
          Effect    = "Allow"
          Principal = { AWS = var.writer_role_arns }
          Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
          Resource  = ["*"]
          Condition = local.use_conditions
        },
        {
          Sid       = "ServingRolesCheckTheKeyExists"
          Effect    = "Allow"
          Principal = { AWS = var.writer_role_arns }
          Action    = ["kms:DescribeKey"]
          Resource  = ["*"]
        },
      ],
      length(var.reader_role_arns) == 0 ? [] : [{
        Sid       = "ReadingRolesDecryptThroughS3"
        Effect    = "Allow"
        Principal = { AWS = var.reader_role_arns }
        Action    = ["kms:Decrypt"]
        Resource  = ["*"]
        Condition = local.use_conditions
      }],
      [
        {
          Sid       = "OffboardingRoleSchedulesDeletion"
          Effect    = "Allow"
          Principal = { AWS = [local.offboarder_arn] }
          Action    = ["kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:DescribeKey"]
          Resource  = ["*"]
        },
        {
          Sid       = "OnlyTheOffboardingRoleMayDisableOrDelete"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:DisableKey"]
          Resource  = ["*"]
          Condition = { ArnNotEquals = { "aws:PrincipalArn" = [local.offboarder_arn] } }
        },
        {
          Sid       = "DeletionWaitsTheFullPeriod"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["kms:ScheduleKeyDeletion"]
          Resource  = ["*"]
          Condition = { NumericLessThan = { "kms:ScheduleKeyDeletionPendingWindowInDays" = [tostring(local.deletion_window_days)] } }
        },
        {
          Sid       = "NoUseOutsideS3"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*", "kms:CreateGrant"]
          Resource  = ["*"]
          Condition = { StringNotEquals = { "kms:ViaService" = [local.s3_service] } }
        },
      ],
    )
  }

  # ---------------------------------------------------------------- the bucket policy
  # A bucket policy is static: it cannot take the company out of the object key and compare it with a
  # key. (One statement per company would pass the 20 KB policy limit at about 50 companies.) What it can
  # do is let a write name only keys in the company alias namespace, which only the provisioner can fill
  # (its IAM policy below), and leave the match between prefix and key to the key's own policy above.
  key_header = "s3:x-amz-server-side-encryption-aws-kms-key-id"
  sse_header = "s3:x-amz-server-side-encryption"
  objects    = "${local.bucket_arn}/*"

  bucket_policy_statements = concat(
    [
      {
        Sid       = "DenyWriteNamingAnotherKey"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = local.objects
        Condition = {
          Null          = { (local.key_header) = "false" }
          StringNotLike = { (local.key_header) = "${local.alias_arn_prefix}*" }
        }
      },
      {
        Sid       = "DenyWriteWithAnotherEncryption"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = local.objects
        Condition = {
          Null            = { (local.sse_header) = "false" }
          StringNotEquals = { (local.sse_header) = "aws:kms" }
        }
      },
    ],
    var.require_company_keys ? [
      {
        Sid       = "DenyWriteWithoutCompanyKey"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = local.objects
        Condition = { StringNotLike = { (local.key_header) = "${local.alias_arn_prefix}*" } }
      },
      {
        Sid       = "DenyWriteNotUsingKms"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = local.objects
        Condition = { StringNotEquals = { (local.sse_header) = "aws:kms" } }
      },
    ] : [],
  )

  # ---------------------------------------------------------------- the provisioning identity
  # May create a key, tag it, give it an alias under the fixed prefix, switch on rotation and read it
  # back. May not use a key, change its policy, repoint or delete an alias, disable it or schedule its
  # deletion: it can fill the alias namespace with keys of this shape and nothing else.
  tagged_at_creation = {
    StringEquals = {
      "aws:RequestTag/project" = "oryxa-fde"
      "aws:RequestTag/env"     = var.env
      "aws:RequestTag/purpose" = "company-data"
    }
    # Both ids are always there; the script puts them from validated ids.
    Null                        = { "aws:RequestTag/tenant" = "false", "aws:RequestTag/company" = "false" }
    "ForAllValues:StringEquals" = { "aws:TagKeys" = local.tag_keys }
  }

  provisioner_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CreateCompanyKeysOfThisShapeOnly"
        Effect   = "Allow"
        Action   = ["kms:CreateKey"]
        Resource = "*"
        Condition = merge(local.tagged_at_creation, {
          StringEqualsIfExists = { "kms:KeyUsage" = "ENCRYPT_DECRYPT", "kms:KeySpec" = "SYMMETRIC_DEFAULT" }
          BoolIfExists         = { "kms:MultiRegion" = "false", "kms:BypassPolicyLockoutSafetyCheck" = "false" }
        })
      },
      {
        Sid       = "TagNewKeys"
        Effect    = "Allow"
        Action    = ["kms:TagResource"]
        Resource  = local.key_arns
        Condition = local.tagged_at_creation
      },
      {
        Sid      = "NameKeysUnderTheCompanyAliasPrefixOnly"
        Effect   = "Allow"
        Action   = ["kms:CreateAlias"]
        Resource = "${local.alias_arn_prefix}*"
      },
      {
        Sid       = "AndOnlyKeysTaggedAsCompanyKeys"
        Effect    = "Allow"
        Action    = ["kms:CreateAlias", "kms:EnableKeyRotation", "kms:GetKeyRotationStatus", "kms:GetKeyPolicy", "kms:ListResourceTags", "kms:DescribeKey"]
        Resource  = local.key_arns
        Condition = { StringEquals = local.company_key_tags }
      },
      {
        # A lookup by alias is authorised on the alias ARN when the alias does not exist yet.
        Sid      = "LookUpTheCompanyAliases"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey"]
        Resource = "${local.alias_arn_prefix}*"
      },
    ]
  }

  # May schedule deletion of a company key, 30 days out, and cancel it. Nothing else changes a key.
  offboarder_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ScheduleOrCancelDeletionOfCompanyKeys"
        Effect   = "Allow"
        Action   = ["kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"]
        Resource = local.key_arns
        Condition = {
          StringEquals                     = local.company_key_tags
          NumericGreaterThanEqualsIfExists = { "kms:ScheduleKeyDeletionPendingWindowInDays" = tostring(local.deletion_window_days) }
        }
      },
      {
        Sid       = "ReadTheKeyBeforeDeletingIt"
        Effect    = "Allow"
        Action    = ["kms:DescribeKey", "kms:ListResourceTags"]
        Resource  = local.key_arns
        Condition = { StringEquals = local.company_key_tags }
      },
      {
        Sid      = "LookUpTheCompanyAliases"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey"]
        Resource = "${local.alias_arn_prefix}*"
      },
    ]
  }

  trust = {
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.operator_arns }
      Action    = "sts:AssumeRole"
    }]
  }
}

resource "aws_iam_role" "provisioner" {
  name                 = local.provisioner_name
  description          = "Creates one KMS key per company (infra/scripts/company-key.sh provision). Cannot use, change or delete one."
  assume_role_policy   = jsonencode(local.trust)
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "provisioner" {
  name   = "create-company-keys"
  role   = aws_iam_role.provisioner.id
  policy = jsonencode(local.provisioner_policy)
}

resource "aws_iam_role" "offboarder" {
  name                 = local.offboarder_name
  description          = "Schedules a company's KMS key for deletion (infra/scripts/company-key.sh offboard). The only identity that can."
  assume_role_policy   = jsonencode(local.trust)
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "offboarder" {
  name   = "schedule-company-key-deletion"
  role   = aws_iam_role.offboarder.id
  policy = jsonencode(local.offboarder_policy)
}

output "bucket_policy_statements" {
  description = "Statements for the data bucket's policy (the s3 module's extra_policy_statements)."
  value       = local.bucket_policy_statements
}

output "alias_arn_prefix" {
  description = "arn:aws:kms:<region>:<account>:alias/oryxa-fde-<env>/companies/. Append the company id for the alias that names the company's key."
  value       = local.alias_arn_prefix
}

# What infra/scripts/company-key.sh needs, from `tofu output -json company_keys`. No secret in it.
output "config" {
  value = {
    env                  = var.env
    account_id           = local.account
    region               = local.region
    bucket_name          = var.bucket_name
    alias_prefix         = local.alias_prefix
    tags                 = local.static_tags
    deletion_window_days = local.deletion_window_days
    provisioner_role     = local.provisioner_name
    offboarder_role      = local.offboarder_name
    key_policy           = local.key_policy
  }
}

output "provisioner_role_arn" {
  value = local.provisioner_arn
}

output "offboarder_role_arn" {
  value = local.offboarder_arn
}

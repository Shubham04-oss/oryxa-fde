# One KMS key per company (ADR 0003, issue #109), on mock providers: no credentials, no cloud calls.
# Pins what every company key's policy says, the tags and alias, the bucket policy's rule about which keys a
# write may name, and what the provisioning and offboarding identities can and cannot do.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111122223333" }
  }
  mock_data "aws_region" {
    defaults = { region = "ap-south-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
}

variables {
  env              = "dev"
  bucket_name      = "oryxa-fde-dev-data"
  operator_arns    = ["arn:aws:iam::111122223333:user/operator"]
  writer_role_arns = ["arn:aws:iam::111122223333:role/oryxa-fde-dev-api"]
}

# ---------------------------------------------------------------- the key policy

run "a_company_key_is_usable_only_through_s3_by_the_serving_roles_for_its_own_prefix" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }

  assert {
    condition = toset([for s in output.config.key_policy.Statement : s.Sid]) == toset([
      "AccountAdministersTheKeyButCannotUseIt",
      "ServingRolesUseTheKeyThroughS3",
      "ServingRolesCheckTheKeyExists",
      "OffboardingRoleSchedulesDeletion",
      "OnlyTheOffboardingRoleMayDisableOrDelete",
      "DeletionWaitsTheFullPeriod",
      "NoUseOutsideS3",
    ])
    error_message = "the key policy has exactly these statements (no reader statement while no reader exists)"
  }

  # Use: the named roles, two actions, through S3 only, in this account, for objects under the company prefix.
  assert {
    condition = jsonencode([for s in output.config.key_policy.Statement : s if s.Sid == "ServingRolesUseTheKeyThroughS3"][0]) == jsonencode({
      Sid       = "ServingRolesUseTheKeyThroughS3"
      Effect    = "Allow"
      Principal = { AWS = ["arn:aws:iam::111122223333:role/oryxa-fde-dev-api"] }
      Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
      Resource  = ["*"]
      Condition = {
        StringEquals = { "kms:ViaService" = ["s3.ap-south-1.amazonaws.com"], "kms:CallerAccount" = ["111122223333"] }
        StringLike   = { "kms:EncryptionContext:aws:s3:arn" = ["arn:aws:s3:::oryxa-fde-dev-data/{tenant}/{company}/*"] }
      }
    })
    error_message = "use is only Decrypt and GenerateDataKey, by the named roles, through S3, under <tenant>/<company>/"
  }

  # "Has this company a key?" is a DescribeKey by alias (#183). KMS authorises it against the key, whose own policy must
  # allow the caller (an IAM policy naming the alias ARN does not reach the key): the serving roles, DescribeKey and
  # nothing else, so the API's check works for every key made by the script, and no reader (the ingest worker) can describe.
  assert {
    condition = jsonencode([for s in output.config.key_policy.Statement : s if s.Sid == "ServingRolesCheckTheKeyExists"][0]) == jsonencode({
      Sid       = "ServingRolesCheckTheKeyExists"
      Effect    = "Allow"
      Principal = { AWS = ["arn:aws:iam::111122223333:role/oryxa-fde-dev-api"] }
      Action    = ["kms:DescribeKey"]
      Resource  = ["*"]
    })
    error_message = "the API's role may DescribeKey on every company key through the key policy, and only that"
  }
  assert {
    condition = alltrue([
      for s in output.config.key_policy.Statement :
      !contains(try(s.Action, []), "kms:DescribeKey") || s.Effect == "Allow" && !contains(s.Principal.AWS, "*")
    ]) && length([for s in output.config.key_policy.Statement : s if s.Effect == "Allow" && contains(s.Action, "kms:DescribeKey")]) == 2
    error_message = "DescribeKey is allowed to the serving roles and the offboarding role, and to no one else (the account root's Describe* is administration)"
  }

  # The account administers the key but cannot use it, delete it or disable it, even through an IAM policy.
  assert {
    condition = jsonencode([for s in output.config.key_policy.Statement : s.Action if s.Sid == "AccountAdministersTheKeyButCannotUseIt"][0]) == jsonencode([
      "kms:Describe*", "kms:Get*", "kms:List*", "kms:PutKeyPolicy",
      "kms:TagResource", "kms:UntagResource", "kms:CreateAlias", "kms:DeleteAlias",
      "kms:EnableKeyRotation", "kms:DisableKeyRotation", "kms:UpdateKeyDescription",
    ])
    error_message = "the account root may administer a company key and nothing else: no use, no deletion, no disable, no grants, no alias repointing"
  }

  assert {
    condition = alltrue([
      for s in output.config.key_policy.Statement :
      s.Effect == "Deny" || !contains(s.Principal.AWS, "*")
    ])
    error_message = "no Allow names everyone"
  }

  assert {
    condition = jsonencode([for s in output.config.key_policy.Statement : s if s.Sid == "NoUseOutsideS3"][0]) == jsonencode({
      Sid       = "NoUseOutsideS3"
      Effect    = "Deny"
      Principal = { AWS = ["*"] }
      Action    = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*", "kms:CreateGrant"]
      Resource  = ["*"]
      Condition = { StringNotEquals = { "kms:ViaService" = ["s3.ap-south-1.amazonaws.com"] } }
    })
    error_message = "nobody uses a company key outside S3, and nobody makes a grant"
  }

  # Deletion: the offboarding role only, and never a short wait.
  assert {
    condition = jsonencode([for s in output.config.key_policy.Statement : s if s.Sid == "OnlyTheOffboardingRoleMayDisableOrDelete"][0]) == jsonencode({
      Sid       = "OnlyTheOffboardingRoleMayDisableOrDelete"
      Effect    = "Deny"
      Principal = { AWS = ["*"] }
      Action    = ["kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:DisableKey"]
      Resource  = ["*"]
      Condition = { ArnNotEquals = { "aws:PrincipalArn" = ["arn:aws:iam::111122223333:role/oryxa-fde-dev-company-key-offboarder"] } }
    })
    error_message = "only the offboarding role may schedule deletion, cancel it or disable a company key"
  }
  assert {
    condition     = jsonencode([for s in output.config.key_policy.Statement : s.Condition.NumericLessThan if s.Sid == "DeletionWaitsTheFullPeriod"][0]) == jsonencode({ "kms:ScheduleKeyDeletionPendingWindowInDays" = ["30"] })
    error_message = "a deletion scheduled for fewer than 30 days (the longest wait KMS allows) is refused"
  }
}

run "a_reading_role_may_only_decrypt" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }
  variables {
    reader_role_arns = ["arn:aws:iam::111122223333:role/oryxa-fde-dev-ingest"]
  }

  assert {
    condition = jsonencode([for s in output.config.key_policy.Statement : s if s.Sid == "ReadingRolesDecryptThroughS3"][0]) == jsonencode({
      Sid       = "ReadingRolesDecryptThroughS3"
      Effect    = "Allow"
      Principal = { AWS = ["arn:aws:iam::111122223333:role/oryxa-fde-dev-ingest"] }
      Action    = ["kms:Decrypt"]
      Resource  = ["*"]
      Condition = {
        StringEquals = { "kms:ViaService" = ["s3.ap-south-1.amazonaws.com"], "kms:CallerAccount" = ["111122223333"] }
        StringLike   = { "kms:EncryptionContext:aws:s3:arn" = ["arn:aws:s3:::oryxa-fde-dev-data/{tenant}/{company}/*"] }
      }
    })
    error_message = "a reader gets Decrypt through S3 under the company prefix, no key creation or data key"
  }
  # The writer's statement does not grow a reader.
  assert {
    condition     = jsonencode([for s in output.config.key_policy.Statement : s.Principal.AWS if s.Sid == "ServingRolesUseTheKeyThroughS3"][0]) == jsonencode(["arn:aws:iam::111122223333:role/oryxa-fde-dev-api"])
    error_message = "only the writer role may generate data keys"
  }
}

# The script fills {tenant} and {company} with ids it has checked; the pattern then names one company's prefix.
run "the_template_has_one_place_for_each_id_and_fills_in_to_one_company_prefix" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }

  assert {
    condition     = length(split("{tenant}", jsonencode(output.config.key_policy))) == 2 && length(split("{company}", jsonencode(output.config.key_policy))) == 2
    error_message = "each id appears once, in the encryption-context pattern"
  }
  assert {
    condition = strcontains(
      replace(replace(jsonencode(output.config.key_policy), "{tenant}", "org_01H-x"), "{company}", "cmp_9"),
      "\"arn:aws:s3:::oryxa-fde-dev-data/org_01H-x/cmp_9/*\""
    ) && !strcontains(replace(replace(jsonencode(output.config.key_policy), "{tenant}", "org_01H-x"), "{company}", "cmp_9"), "{tenant}") && !strcontains(replace(replace(jsonencode(output.config.key_policy), "{tenant}", "org_01H-x"), "{company}", "cmp_9"), "{company}")
    error_message = "filled in, the pattern is the prefix <tenant>/<company>/ of the bucket and nothing is left over"
  }
  # The attack the key policy stops: a write under company B's prefix (or the same company id in another tenant)
  # naming company A's key. A's pattern, a prefix with one trailing *, must not cover B's object ARNs.
  assert {
    condition = jsonencode([
      for arn in [
        "arn:aws:s3:::oryxa-fde-dev-data/org_1/cmp_a/documents/d1",
        "arn:aws:s3:::oryxa-fde-dev-data/org_1/cmp_b/documents/d1",
        "arn:aws:s3:::oryxa-fde-dev-data/org_1/cmp_ab/documents/d1",
        "arn:aws:s3:::oryxa-fde-dev-data/org_2/cmp_a/documents/d1",
        "arn:aws:s3:::oryxa-fde-dev-data",
        "arn:aws:s3:::other-bucket/org_1/cmp_a/documents/d1",
        ] : startswith(arn, trimsuffix(replace(replace([
          for s in output.config.key_policy.Statement : s.Condition.StringLike["kms:EncryptionContext:aws:s3:arn"][0] if s.Sid == "ServingRolesUseTheKeyThroughS3"
      ][0], "{tenant}", "org_1"), "{company}", "cmp_a"), "*"))
    ]) == jsonencode([true, false, false, false, false, false])
    error_message = "company A's key covers only A's own objects: not B's, not a longer id, not another tenant, not the bucket ARN a Bucket Key would send"
  }
}

# ---------------------------------------------------------------- alias, tags, waiting period

run "a_company_key_has_the_fixed_alias_prefix_tags_and_the_longest_waiting_period" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }

  assert {
    condition     = jsonencode(output.config.alias_prefix) == jsonencode("alias/oryxa-fde-dev/companies/")
    error_message = "ADR 0003: alias/oryxa-fde-<env>/companies/<company>"
  }
  assert {
    condition     = jsonencode(output.alias_arn_prefix) == jsonencode("arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-dev/companies/")
    error_message = "the alias ARN the API names on write"
  }
  assert {
    condition     = jsonencode(output.config.tags) == jsonencode({ project = "oryxa-fde", env = "dev", purpose = "company-data" })
    error_message = "the script adds tenant and company to these"
  }
  assert {
    condition     = jsonencode(output.config.deletion_window_days) == jsonencode(30)
    error_message = "KMS's longest waiting period"
  }
  assert {
    condition     = output.config.rotation == false
    error_message = "rotation is off unless key_rotation says otherwise (the lead's decision on cost)"
  }
  assert {
    condition     = output.config.account_id == "111122223333" && output.config.region == "ap-south-1" && output.config.bucket_name == "oryxa-fde-dev-data"
    error_message = "the script refuses any other account"
  }
  assert {
    condition     = output.config.provisioner_role == "oryxa-fde-dev-company-key-provisioner" && output.config.offboarder_role == "oryxa-fde-dev-company-key-offboarder"
    error_message = "the script runs as these two roles only"
  }
}

# ---------------------------------------------------------------- the bucket policy

run "without_required_keys_a_write_may_name_no_key_or_a_company_alias_and_nothing_else" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }

  assert {
    condition     = jsonencode([for s in output.bucket_policy_statements : s.Sid]) == jsonencode(["DenyWriteNamingAnotherKey", "DenyWriteWithAnotherEncryption"])
    error_message = "optional mode adds two Deny statements"
  }
  assert {
    condition = jsonencode(output.bucket_policy_statements[0]) == jsonencode({
      Sid       = "DenyWriteNamingAnotherKey"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::oryxa-fde-dev-data/*"
      Condition = {
        Null          = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "false" }
        StringNotLike = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-dev/companies/*" }
      }
    })
    error_message = "a key named in the request must be an alias under the company prefix"
  }
  # What that StringNotLike lets through: only the company alias namespace. The environment key by its ARN, its
  # id or its alias, another account's key and a lookalike are all refused (the pattern has only a trailing *).
  assert {
    condition = jsonencode([
      for k in [
        "arn:aws:kms:ap-south-1:111122223333:key/11111111-2222-3333-4444-555555555555",
        "11111111-2222-3333-4444-555555555555",
        "alias/oryxa-fde-dev",
        "arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-dev",
        "arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-dev/companies",
        "arn:aws:kms:ap-south-1:999999999999:alias/oryxa-fde-dev/companies/cmp_1",
        "arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-prod/companies/cmp_1",
        "arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-dev/companies/cmp_1",
      ] : !startswith(k, trimsuffix(output.bucket_policy_statements[0].Condition.StringNotLike["s3:x-amz-server-side-encryption-aws-kms-key-id"], "*"))
    ]) == jsonencode([true, true, true, true, true, true, true, false])
    error_message = "only an alias under alias/oryxa-fde-dev/companies/ in this account passes"
  }
  assert {
    condition = jsonencode(output.bucket_policy_statements[1].Condition) == jsonencode({
      Null            = { "s3:x-amz-server-side-encryption" = "false" }
      StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }
    })
    error_message = "a write that asks for another kind of encryption (SSE-S3) is refused; no header means the bucket default"
  }
}

run "with_required_keys_a_write_must_name_a_company_key_and_use_kms" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }
  variables {
    require_company_keys = true
  }

  assert {
    condition = jsonencode([for s in output.bucket_policy_statements : s.Sid]) == jsonencode([
      "DenyWriteNamingAnotherKey", "DenyWriteWithAnotherEncryption", "DenyWriteWithoutCompanyKey", "DenyWriteNotUsingKms",
    ])
    error_message = "required mode adds the two statements that refuse a write naming no key"
  }
  assert {
    condition = jsonencode(output.bucket_policy_statements[2].Condition) == jsonencode({
      StringNotLike = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-dev/companies/*" }
    })
    error_message = "no Null guard: a request with no key header (the bucket default, the environment key) is refused"
  }
  assert {
    condition     = jsonencode(output.bucket_policy_statements[3].Condition) == jsonencode({ StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } })
    error_message = "no header, or any value but aws:kms, is refused"
  }
  assert {
    condition     = alltrue([for s in output.bucket_policy_statements : s.Effect == "Deny" && s.Action == "s3:PutObject" && s.Resource == "arn:aws:s3:::oryxa-fde-dev-data/*"])
    error_message = "the rules only ever deny writes: reading an object written before a company's key stays possible"
  }
}

# ---------------------------------------------------------------- the provisioning identity

run "the_provisioner_creates_tagged_company_keys_and_aliases_under_the_prefix_and_nothing_else" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }

  # Everything it may do. A new action is a decision, so it fails here until it is listed.
  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.provisioner.policy).Statement : s.Action])) == toset([
      "kms:CreateKey", "kms:TagResource", "kms:CreateAlias", "kms:GetKeyRotationStatus",
      "kms:GetKeyPolicy", "kms:ListResourceTags", "kms:DescribeKey",
    ])
    error_message = "the provisioner may create, tag, name and read back a key; with rotation off it may not switch rotation on"
  }
  # Never: use a key, change its policy, repoint or delete an alias, disable it, schedule deletion, grant, or kms:*.
  assert {
    condition = !anytrue([
      for a in flatten([for s in jsondecode(aws_iam_role_policy.provisioner.policy).Statement : s.Action]) :
      contains([
        "kms:*", "kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:ReEncrypt", "kms:PutKeyPolicy", "kms:UpdateAlias", "kms:DeleteAlias",
        "kms:DisableKey", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:CreateGrant", "kms:UntagResource",
      ], a)
    ])
    error_message = "the provisioner can neither use a key nor change or retire one"
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.provisioner.policy).Statement :
      s.Resource != "*" || s.Action == ["kms:CreateKey"]
    ])
    error_message = "only kms:CreateKey, which has no resource to name, applies to *"
  }
  # A key is created with exactly these tags, both ids present, and may not be multi-Region or key-pair shaped.
  assert {
    condition = jsondecode(aws_iam_role_policy.provisioner.policy).Statement[0].Condition == {
      StringEquals                = { "aws:RequestTag/project" = "oryxa-fde", "aws:RequestTag/env" = "dev", "aws:RequestTag/purpose" = "company-data" }
      Null                        = { "aws:RequestTag/tenant" = "false", "aws:RequestTag/company" = "false" }
      "ForAllValues:StringEquals" = { "aws:TagKeys" = ["env", "project", "purpose", "tenant", "company"] }
      StringEqualsIfExists        = { "kms:KeyUsage" = "ENCRYPT_DECRYPT", "kms:KeySpec" = "SYMMETRIC_DEFAULT" }
      BoolIfExists                = { "kms:MultiRegion" = "false", "kms:BypassPolicyLockoutSafetyCheck" = "false" }
    }
    error_message = "CreateKey needs the oryxa-fde tags, this env, purpose company-data, a tenant and a company, nothing else, and a plain symmetric key"
  }
  # An alias only under alias/oryxa-fde-<env>/companies/, and only for a key tagged as a company key of this env.
  assert {
    condition = jsonencode([
      for s in jsondecode(aws_iam_role_policy.provisioner.policy).Statement : s.Resource if s.Sid == "NameKeysUnderTheCompanyAliasPrefixOnly"
    ][0]) == jsonencode("arn:aws:kms:ap-south-1:111122223333:alias/oryxa-fde-dev/companies/*")
    error_message = "CreateAlias on the alias resource is limited to the fixed prefix"
  }
  assert {
    condition = jsonencode([
      for s in jsondecode(aws_iam_role_policy.provisioner.policy).Statement : s.Condition if s.Sid == "AndOnlyKeysTaggedAsCompanyKeys"
    ][0]) == jsonencode({ StringEquals = { "aws:ResourceTag/purpose" = "company-data", "aws:ResourceTag/env" = "dev" } })
    error_message = "an alias, rotation and reads reach only keys tagged as this environment's company keys, so the alias cannot be pointed at the environment key"
  }
  # Only the operators named in tfvars may become it, and the session is short.
  assert {
    condition     = jsondecode(aws_iam_role.provisioner.assume_role_policy).Statement[0].Principal == { AWS = ["arn:aws:iam::111122223333:user/operator"] } && aws_iam_role.provisioner.max_session_duration == 3600
    error_message = "the trust names the operators and nobody else; one hour"
  }
}

run "with_rotation_on_the_provisioner_may_switch_it_on_and_the_script_is_told" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }
  variables {
    key_rotation = true
  }

  assert {
    condition     = output.config.rotation == true
    error_message = "the script reads the setting from the config"
  }
  assert {
    condition = toset([
      for s in jsondecode(aws_iam_role_policy.provisioner.policy).Statement : s.Action if s.Sid == "AndOnlyKeysTaggedAsCompanyKeys"
      ][0]) == toset([
      "kms:CreateAlias", "kms:GetKeyRotationStatus", "kms:GetKeyPolicy", "kms:ListResourceTags", "kms:DescribeKey", "kms:EnableKeyRotation",
    ])
    error_message = "rotation can be switched on, only on this environment's company keys, and never off"
  }
}

# ---------------------------------------------------------------- the offboarding identity

run "only_the_offboarder_can_schedule_deletion_and_not_for_fewer_than_30_days" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.offboarder.policy).Statement : s.Action])) == toset([
      "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:DescribeKey", "kms:ListResourceTags",
    ])
    error_message = "the offboarder schedules and cancels deletion and reads; it creates and uses nothing"
  }
  assert {
    condition = jsonencode([
      for s in jsondecode(aws_iam_role_policy.offboarder.policy).Statement : s.Condition if s.Sid == "ScheduleOrCancelDeletionOfCompanyKeys"
      ][0]) == jsonencode({
      StringEquals                     = { "aws:ResourceTag/purpose" = "company-data", "aws:ResourceTag/env" = "dev" }
      NumericGreaterThanEqualsIfExists = { "kms:ScheduleKeyDeletionPendingWindowInDays" = "30" }
    })
    error_message = "company keys of this environment only, with the full waiting period"
  }
  # Nothing else may schedule deletion: the provisioner's policy lacks it (above) and every key says so itself.
  assert {
    condition     = !contains(flatten([for s in jsondecode(aws_iam_role_policy.provisioner.policy).Statement : s.Action]), "kms:ScheduleKeyDeletion")
    error_message = "the provisioner cannot schedule deletion"
  }
  assert {
    condition     = jsondecode(aws_iam_role.offboarder.assume_role_policy).Statement[0].Principal == { AWS = ["arn:aws:iam::111122223333:user/operator"] } && aws_iam_role.offboarder.max_session_duration == 3600
    error_message = "the trust names the operators and nobody else; one hour"
  }
}

# ---------------------------------------------------------------- inputs

run "rejects_no_operators_and_a_policy_that_names_everyone" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }
  variables {
    operator_arns    = []
    writer_role_arns = ["*"]
  }
  expect_failures = [var.operator_arns, var.writer_role_arns]
}

run "rejects_an_operator_that_is_not_an_iam_user_or_role_of_an_account" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }
  variables {
    operator_arns = ["arn:aws:iam::111122223333:root"]
  }
  expect_failures = [var.operator_arns]
}

run "rejects_an_env_name_that_would_leave_the_alias_prefix" {
  command = plan
  module {
    source = "../../modules/company_keys"
  }
  providers = {
    aws = aws
  }
  variables {
    env = "dev/companies"
  }
  expect_failures = [var.env]
}

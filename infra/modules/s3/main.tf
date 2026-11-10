# Adapted from oryxa-platform infra/modules/s3 (2b064a3), unchanged apart from this line, force_destroy and
# extra_policy_statements (the policy is built with jsonencode so the mock-provider tests can read it).
# Private bucket: KMS-encrypted, versioned, public access blocked, TLS only.

variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "force_destroy" {
  description = "Let destroy delete every object version. Only for tearing an environment down."
  type        = bool
  default     = false
}

variable "extra_policy_statements" {
  description = "Statements added to the bucket policy after the TLS-only one (the company key rules, modules/company_keys)."
  type        = any
  default     = []
}

variable "noncurrent_days" {
  description = "Days to keep overwritten object versions."
  type        = number
  default     = 30
}

resource "aws_s3_bucket" "this" {
  bucket        = var.name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    # S3 Bucket Keys cut KMS request costs by ~99%.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

locals {
  tls_only = {
    Sid       = "DenyInsecureTransport"
    Effect    = "Deny"
    Principal = "*"
    Action    = "s3:*"
    Resource  = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = concat([local.tls_only], var.extra_policy_statements)
  })
}

resource "aws_s3_bucket_policy" "this" {
  bucket     = aws_s3_bucket.this.id
  policy     = local.policy
  depends_on = [aws_s3_bucket_public_access_block.this]
}

output "arn" {
  value = aws_s3_bucket.this.arn
}

output "name" {
  value = aws_s3_bucket.this.id
}

output "policy" {
  description = "The bucket policy as applied."
  value       = local.policy
}

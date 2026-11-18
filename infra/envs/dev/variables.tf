# Every variable is listed in infra/README.md. Nothing here is a secret: secret values go into
# Secrets Manager by hand, and the Cloudflare token comes from the environment.

variable "env" {
  type    = string
  default = "dev"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.env))
    error_message = "env must be 2 to 10 lowercase letters or digits."
  }
}

variable "aws_account_id" {
  description = "The AWS account this environment lives in (guard against applying to the wrong one)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "aws_region" {
  description = "Where the environment runs: Mumbai (ap-south-1), chosen by the founder to measure latency from the team and first customers (#144). Customer data at rest stays here (ADR 0003)."
  type        = string
  default     = "ap-south-1"
}

variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  description = "ID of the Cloudflare zone named by cloudflare_zone_name."
  type        = string
}

variable "cloudflare_zone_name" {
  description = "The Cloudflare zone's own name (for example example.com), the zone cloudflare_zone_id identifies. The two host names below must be this name or one label under it."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.cloudflare_zone_name))
    error_message = "cloudflare_zone_name must be a lowercase zone name such as example.com."
  }
}

# No defaults, and no app./admin. pattern: a zone is shared with other environments, and the production names
# (the zone itself, app., admin.) must not be taken by accident. Cloudflare's Universal SSL certificate covers the
# zone and one label below it only, so a deeper name (app.fde-dev.<zone>) would have no certificate: the validations
# below refuse it.
variable "web_hostname" {
  description = "Full host name of the web app (fde-web), which is also the API's WEB_ORIGIN: https://<web_hostname>. The zone itself or one label under it, for example fde-dev.example.com."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.web_hostname))
    error_message = "web_hostname must be a lowercase host name."
  }
  validation {
    condition = (
      var.web_hostname == var.cloudflare_zone_name
      || (endswith(var.web_hostname, ".${var.cloudflare_zone_name}") && !strcontains(trimsuffix(var.web_hostname, ".${var.cloudflare_zone_name}"), "."))
    )
    error_message = "web_hostname must be the zone itself or exactly one label under it: Cloudflare's Universal SSL certificate covers the zone and one level of subdomain only, so a deeper name has no certificate."
  }
}

variable "admin_hostname" {
  description = "Full host name of the admin tools, behind Cloudflare Access. The zone itself or one label under it, and not the web app's, for example fde-dev-admin.example.com."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.admin_hostname))
    error_message = "admin_hostname must be a lowercase host name."
  }
  validation {
    condition = (
      var.admin_hostname == var.cloudflare_zone_name
      || (endswith(var.admin_hostname, ".${var.cloudflare_zone_name}") && !strcontains(trimsuffix(var.admin_hostname, ".${var.cloudflare_zone_name}"), "."))
    )
    error_message = "admin_hostname must be the zone itself or exactly one label under it: Cloudflare's Universal SSL certificate covers the zone and one level of subdomain only, so a deeper name has no certificate."
  }
  validation {
    condition     = var.admin_hostname != var.web_hostname
    error_message = "admin_hostname must differ from web_hostname."
  }
}

variable "admin_emails" {
  description = "Who may open admin_hostname through Cloudflare Access."
  type        = list(string)
}

variable "workos_client_id" {
  description = "WorkOS client id (public). The API key is a secret in Secrets Manager."
  type        = string
}

variable "cloudtrail_bucket_name" {
  description = "Globally unique S3 bucket name for CloudTrail logs."
  type        = string
}

variable "api_image_tag" {
  description = "Seeds /oryxa-fde-<env>/api-image-tag on the first apply; after that the deploy workflow owns the tag."
  type        = string
}

variable "github_repository" {
  description = "owner/name of the repository whose `environment: <env>` jobs may assume the deploy role."
  type        = string
  default     = "Shubham04-oss/oryxa-fde"
  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/name, without wildcards."
  }
}

variable "github_oidc_subject_prefix" {
  description = "The repository's OIDC sub prefix, before `:environment:<env>`. Null is `repo:<github_repository>`; with GitHub's immutable subject on, `repo:<owner>@<owner id>/<name>@<repo id>` (the sub_claim_prefix of `gh api repos/<owner>/<name>/actions/oidc/customization/sub`)."
  type        = string
  default     = null
  validation {
    condition = var.github_oidc_subject_prefix == null || (
      can(regex("^repo:[A-Za-z0-9-]+@[0-9]+/[A-Za-z0-9._-]+@[0-9]+$", var.github_oidc_subject_prefix))
      || can(regex("^repo:[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_oidc_subject_prefix))
    )
    error_message = "github_oidc_subject_prefix must be repo:<owner>@<id>/<name>@<id> or repo:<owner>/<name>, with no wildcard and no :environment."
  }
  # The names in the prefix are the repository's, so the sub and job_workflow_ref conditions name one repository.
  validation {
    condition = var.github_oidc_subject_prefix == null || (
      replace(coalesce(var.github_oidc_subject_prefix, "-"), "/@[0-9]+/", "") == "repo:${var.github_repository}"
    )
    error_message = "github_oidc_subject_prefix must name github_repository's owner and name."
  }
}

variable "github_oidc_provider_arn" {
  description = "The account's existing GitHub OIDC provider. Null creates one (an account holds only one)."
  type        = string
  default     = null
}

variable "start_services" {
  description = "false until the image and every secret value exist: each service runs 0 tasks. Then true."
  type        = bool
  default     = false
}

variable "api_port" {
  description = "Port oryxa-fde-api listens on, on the task's loopback (LISTEN_ADDR). The health check and the Workers VPC service use it; nothing else can reach it."
  type        = number
  default     = 8080
}

variable "api_shutdown_grace_seconds" {
  description = "Seconds the API drains requests and its background loops after SIGTERM (SHUTDOWN_GRACE_SECONDS, shutdown.rs). The api container's stop timeout is this plus 10, and the task's stop sequence (cloudflared's 45 s, then the API's) must fit 120 s, so at most 65, although the code accepts up to 119. The fargate_service module checks the total again."
  type        = number
  default     = 20
  validation {
    condition     = var.api_shutdown_grace_seconds == floor(var.api_shutdown_grace_seconds) && var.api_shutdown_grace_seconds >= 1 && var.api_shutdown_grace_seconds <= 65
    error_message = "api_shutdown_grace_seconds must be a whole number of seconds from 1 to 65: cloudflared's 45 s stop timeout plus this plus 10 must fit Fargate's 120 s stop budget."
  }
}

variable "api_cpu" {
  type    = number
  default = 256
}

variable "api_memory" {
  type    = number
  default = 512
}

variable "spicedb_image" {
  type    = string
  default = "authzed/spicedb:v1.56.2"
}

variable "cloudflared_image" {
  description = "Tunnel connector (2026.10.7), pinned by digest: it runs with the API task's role, so a re-pushed tag must not reach it."
  type        = string
  default     = "cloudflare/cloudflared@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allow_destroy" {
  description = "true only to tear the environment down: lifts RDS deletion protection and lets destroy empty the CloudTrail bucket and ECR."
  type        = bool
  default     = false
}

variable "vpc_cidr" {
  description = "Distinct from the platform's 10.40.0.0/16 so the two can be peered later."
  type        = string
  default     = "10.50.0.0/16"
}

variable "interface_endpoints" {
  description = "PrivateLink endpoints for AWS APIs (about $7.30/month each). Dev: none, the NAT instance carries it."
  type        = set(string)
  default     = []
}

variable "log_retention_days" {
  type    = number
  default = 14
}

# ---- optional API settings (infra/README.md, The environment contract)

variable "workos_issuer" {
  description = "The WorkOS token issuer (WORKOS_ISSUER): the API pins every token's `iss` to it. Needed only with a custom auth domain: that domain. Null: the API derives https://api.workos.com/user_management/<client id>, the issuer without a custom auth domain."
  type        = string
  default     = null
  validation {
    # An https host and an optional path of safe segments: no port, query, fragment, userinfo, wildcard or dot segment.
    condition = var.workos_issuer == null || (
      can(regex("^https://[a-z0-9.-]+(/[A-Za-z0-9_.-]+)*/?$", var.workos_issuer)) &&
      !can(regex("/\\.\\.?(/|$)", var.workos_issuer))
    )
    error_message = "workos_issuer must be an https URL with an optional path of letters, digits, _, - and ., such as https://api.workos.com/user_management/<client id> or https://auth.example.com/."
  }
}

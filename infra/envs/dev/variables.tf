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
  description = "Dev runs in the platform's region until the first region is decided (plan, open decisions)."
  type        = string
  default     = "us-west-2"
}

variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  type = string
}

variable "domain" {
  description = "Base hostname for dev; app. (fde-web) and admin. hang off it."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a lowercase hostname."
  }
}

variable "admin_emails" {
  description = "Who may open admin.<domain> through Cloudflare Access."
  type        = list(string)
}

variable "workos_client_id" {
  description = "WorkOS client id (public). The API key is a secret in Secrets Manager."
  type        = string
}

variable "event_bus_arn" {
  description = "ARN printed by infra/scripts/create-event-bus.sh (EventBridge v2 has no OpenTofu resource)."
  type        = string
  validation {
    condition = can(regex(
      "^arn:aws:events:[a-z0-9-]+:[0-9]{12}:event-busv2/oryxa-fde-[a-z0-9]+/[A-Za-z0-9]+$", var.event_bus_arn,
    ))
    error_message = "event_bus_arn must be an EventBridge v2 bus ARN for oryxa-fde-<env>."
  }
}

variable "event_signing_kid" {
  description = "Key id of the API's event signing key (EVENT_SIGNING_KID). Change it when the key rotates."
  type        = string
  default     = "k1"
}

variable "data_bucket_name" {
  description = "Globally unique S3 bucket name for customer files (one prefix per company)."
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

variable "consumers" {
  description = "Event consumers; each gets oryxa-fde-<env>-<name>.fifo, a -dlq.fifo and an -undelivered queue."
  type        = set(string)
  default     = ["lifecycle", "context-ingestion"]
  validation {
    condition     = alltrue([for c in var.consumers : can(regex("^[a-z0-9-]{1,40}$", c))])
    error_message = "consumer names must be [a-z0-9-]{1,40}, as the consumer kit requires."
  }
}

variable "api_port" {
  type    = number
  default = 8080
}

variable "api_health_check_path" {
  description = "Path the ALB polls; must answer 200 without auth."
  type        = string
  default     = "/healthz"
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
  type    = string
  default = "cloudflare/cloudflared:2026.10.7"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allow_destroy" {
  description = "true only to tear the environment down: lifts RDS deletion protection and lets destroy empty the buckets and ECR."
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

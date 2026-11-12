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
  description = "Where the environment runs: Mumbai (ap-south-1), chosen by the founder to measure latency from the team and first customers (#144). Customer data at rest stays here (ADR 0003). Bedrock embeddings are in-region here; the Claude models are not (agent_region)."
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
  description = "The Cloudflare zone's own name (for example example.com), the zone cloudflare_zone_id identifies. The three host names below must be this name or one label under it."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.cloudflare_zone_name))
    error_message = "cloudflare_zone_name must be a lowercase zone name such as example.com."
  }
}

# No defaults, and no app./admin./mcp. pattern: a zone is shared with other environments, and the production names
# (the zone itself, app., admin., mcp.) must not be taken by accident. Cloudflare's Universal SSL certificate covers the
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

variable "mcp_hostname" {
  description = "Full host name of the MCP server (MCP_ALLOWED_HOSTS and its tunnel's one public name), for example fde-dev-mcp.example.com. Required with enable_mcp, ignored (and may stay null) without it."
  type        = string
  default     = null
  validation {
    condition     = var.mcp_hostname != null || !var.enable_mcp
    error_message = "mcp_hostname is required when enable_mcp is true."
  }
  validation {
    condition     = var.mcp_hostname == null ? true : can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.mcp_hostname))
    error_message = "mcp_hostname must be a lowercase host name."
  }
  validation {
    condition = var.mcp_hostname == null ? true : (
      var.mcp_hostname == var.cloudflare_zone_name
      || (endswith(var.mcp_hostname, ".${var.cloudflare_zone_name}") && !strcontains(trimsuffix(var.mcp_hostname, ".${var.cloudflare_zone_name}"), "."))
    )
    error_message = "mcp_hostname must be the zone itself or exactly one label under it: Cloudflare's Universal SSL certificate covers the zone and one level of subdomain only, so a deeper name has no certificate."
  }
  validation {
    condition     = var.mcp_hostname == null ? true : (var.mcp_hostname != var.web_hostname && var.mcp_hostname != var.admin_hostname)
    error_message = "mcp_hostname must differ from web_hostname and admin_hostname."
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

variable "event_public_key" {
  description = "The public half of the API's event signing key, as an Ed25519 PEM (EVENT_PUBLIC_KEY on the workers, which verify every event with it). Not a secret. Make the pair before the first apply (`openssl genpkey -algorithm ed25519 -out key.pem`, then `openssl pkey -in key.pem -pubout`): the private half goes into Secrets Manager (infra/README.md, Apply order). Rotate both and event_signing_kid together."
  type        = string
  validation {
    condition     = can(regex("^-----BEGIN PUBLIC KEY-----\\s[A-Za-z0-9+/=\\s]+-----END PUBLIC KEY-----\\s*$", var.event_public_key))
    error_message = "event_public_key must be a PEM public key (-----BEGIN PUBLIC KEY-----)."
  }
}

variable "data_bucket_name" {
  description = "Globally unique S3 bucket name for customer files (one prefix per company)."
  type        = string
}

variable "company_key_operator_arns" {
  description = "IAM users or roles of this account that may assume the company-key provisioning and offboarding roles (infra/README.md, Company keys). Role ARNs of SSO roles carry their path."
  type        = list(string)
  validation {
    condition     = length(var.company_key_operator_arns) > 0 && alltrue([for a in var.company_key_operator_arns : can(regex("^arn:aws:iam::[0-9]{12}:(user|role)/[A-Za-z0-9+=,.@_/-]+$", a))])
    error_message = "company_key_operator_arns must hold at least one IAM user or role ARN."
  }
}

variable "company_key_reader_role_arns" {
  description = "Roles other than the ingest worker's that only read company files. Not the MCP server: none of its tools reads a file (infra/README.md, oryxa-fde-mcp), so its role has no S3 or KMS permission and is not a reader. The ingest worker's task role is always a reader and is added by envs/dev, so it must not be listed here. Each is named in every company key's policy, so adding one means `company-key.sh sync` for each company that has a key."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for a in var.company_key_reader_role_arns : !can(regex("role/oryxa-fde-[a-z0-9]+-ingest-task$", a))])
    error_message = "company_key_reader_role_arns must not list the ingest worker's task role: it is added automatically."
  }
}

variable "company_key_rotation" {
  description = "Rotate each company key yearly. Off for now: a rotation adds a billed key version (up to $3 a key a month after two) for little gain on S3 object data. Takes effect for keys made or re-provisioned after the change."
  type        = bool
  default     = false
}

variable "require_company_keys" {
  description = "false: a company file written without naming a key lands under the environment key, which is right for sample data only. true: S3 refuses any write that does not name a company key. Set it true before the first real customer data, and only after the API names company keys on write."
  type        = bool
  default     = false
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

variable "consumers" {
  description = "Event consumers; each gets oryxa-fde-<env>-<name>.fifo, a -dlq.fifo and an -undelivered queue."
  type        = set(string)
  default     = ["lifecycle", "context-ingestion"]
  validation {
    condition     = alltrue([for c in var.consumers : can(regex("^[a-z0-9-]{1,40}$", c))])
    error_message = "consumer names must be [a-z0-9-]{1,40}, as the consumer kit requires."
  }
  validation {
    condition     = contains(var.consumers, "lifecycle") && contains(var.consumers, "context-ingestion")
    error_message = "consumers must include lifecycle and context-ingestion: the two workers read those queues."
  }
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

# ---- optional API features (infra/README.md, API environment contract). Each is off while null: the
# API then starts without it, and no secret or permission for it exists. Turn one on after the thing it
# talks to exists, then put its secret values in (README, secrets).

variable "embedding_model" {
  description = "Bedrock foundation model that embeds document text and search queries (EMBEDDING_MODEL). The API's role may invoke this model only, in aws_region."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
  validation {
    condition = (
      can(regex("^[a-z0-9-]+\\.[a-z0-9.:-]+$", var.embedding_model))
      && !can(regex("^(us|eu|apac|global|au|jp|in|ca|us-gov)\\.", var.embedding_model))
    )
    error_message = "embedding_model must be a foundation model id such as amazon.titan-embed-text-v2:0, not an inference profile (us., eu., apac., global., au., jp., in., ca.): the role's permission names the foundation model's ARN, which a profile id does not make."
  }
}

variable "sandbox_gateway_url" {
  description = "Base URL of the sandbox gateway Worker (SANDBOX_GATEWAY_URL), known after the deploy-workers workflow. Null: agent and eval routes are not mounted."
  type        = string
  default     = null
  validation {
    condition     = var.sandbox_gateway_url == null || can(regex("^https://[a-z0-9.-]+(/.*)?$", var.sandbox_gateway_url))
    error_message = "sandbox_gateway_url must be an https URL."
  }
}

variable "agent_model" {
  description = "Bedrock model or inference profile the agent runs on (AGENT_MODEL). Required with sandbox_gateway_url. The sandbox's outbound handler calls Bedrock, not the API, so the API's role gets no Bedrock permission for it."
  type        = string
  default     = null
  validation {
    condition     = var.sandbox_gateway_url == null || var.agent_model != null
    error_message = "agent_model is required with sandbox_gateway_url."
  }
}

variable "agent_region" {
  description = "Region the agent's Bedrock calls start from (AGENT_REGION); null means aws_region. In ap-south-1 Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 are served only through a cross-Region inference profile, and none has a geography profile for India: `global.anthropic.claude-opus-5-5` lets Bedrock process prompts and outputs in any commercial AWS Region (infra/README.md, Where prompts are processed). A profile tied to a geography keeps processing inside it, but is called from a source Region in that geography, which is what this variable is for (for example `eu.anthropic.claude-opus-5-5` from eu-west-2). The profile id's prefix does not say where requests go: check the profile's destination Regions with GetInferenceProfile from this Region."
  type        = string
  default     = null
}

variable "realtime_url" {
  description = "Base URL of the realtime Worker (REALTIME_URL), with sandbox_gateway_url only. Null: agent output is stored, not streamed."
  type        = string
  default     = null
  validation {
    condition     = var.realtime_url == null || (var.sandbox_gateway_url != null && can(regex("^https://[a-z0-9.-]+(/.*)?$", var.realtime_url)))
    error_message = "realtime_url must be an https URL and needs sandbox_gateway_url."
  }
}

variable "github_app" {
  description = "The GitHub App's public settings: numeric app id, URL slug and OAuth client id. Null: GitHub routes answer 503. Its private key, client secret and webhook secret are Secrets Manager entries."
  type = object({
    app_id    = string
    slug      = string
    client_id = string
  })
  default = null
  validation {
    condition     = var.github_app == null || can(regex("^[0-9]+$", var.github_app.app_id))
    error_message = "github_app.app_id must be the numeric App ID."
  }
}

variable "slack_client_id" {
  description = "The Slack app's client id (public). Null: Slack routes answer 503. Its client secret and signing secret are Secrets Manager entries."
  type        = string
  default     = null
}

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

# ---- the MCP server (infra/README.md, oryxa-fde-mcp and How the MCP server is reached)

variable "enable_mcp" {
  description = "Deploy the MCP server for FDE agents: a task of its own with its own tunnel and the hostname mcp_hostname at Cloudflare's edge (no listener in AWS), the service, its role, the secret for its tunnel and the Cloudflare tunnel, record and ingress rule. Default off, because how an FDE's agent signs in to it is not decided yet (infra/README.md, What is missing before an agent can sign in): with it on, the name answers on the internet and refuses every request without a valid WorkOS token. Off: nothing for it exists, though the binary ships in the image."
  type        = bool
  default     = false
}

variable "mcp_cpu" {
  description = "CPU units of the MCP server's task, shared by the server and its cloudflared sidecar."
  type        = number
  default     = 256
}

variable "mcp_memory" {
  description = "Memory of the MCP server's task in MiB, shared by both containers."
  type        = number
  default     = 512
}

# ---- the queue workers (infra/README.md, The workers)

variable "ingest_cpu" {
  description = "CPU units of the ingest worker. It reads each document into memory and extracts its text in a child process limited to 1 GiB of address space (oryxa-fde-context child.rs), so memory is what it needs."
  type        = number
  default     = 512
}

variable "ingest_memory" {
  description = "Memory of the ingest worker in MiB: the document, its chunks and the 1 GiB child. Fargate allows 1024 to 4096 with 512 CPU units."
  type        = number
  default     = 2048
}

variable "lifecycle_cpu" {
  type    = number
  default = 256
}

variable "lifecycle_memory" {
  type    = number
  default = 512
}

variable "update_model" {
  description = "The Bedrock inference profile that drafts the weekly updates (UPDATE_MODEL on the lifecycle worker). No default and no model is chosen yet (ADR 0003 records the choice before real customer data reaches a model): while it is null the lifecycle worker is not deployed at all, so nothing runs and no Bedrock permission exists for it. From Mumbai the current Claude models are reached only through a `global.` profile, for example `global.anthropic.claude-opus-5-5`, which lets Bedrock process prompts outside India (infra/README.md, Where prompts are processed). Only that form is accepted here: the role's three-statement policy for it is AWS's own, and a geography profile (eu., au., jp., in.) is called from another Region and needs its own statements, which come with that decision."
  type        = string
  default     = null
  validation {
    condition     = var.update_model == null || can(regex("^global\\.[a-z0-9-]+\\.[a-z0-9.:-]+$", var.update_model))
    error_message = "update_model must be a global. inference profile id, such as global.anthropic.claude-opus-5-5; a geography profile needs its own IAM statements."
  }
}

variable "digest_from" {
  description = "The email address the weekly digest is sent from (DIGEST_FROM). Null: no digest is sent. The address, or its domain, must be a verified SES identity in aws_region, and SES must be out of the sandbox there before it can mail anyone but verified addresses (infra/README.md, Verify before apply). Needs update_model: the digest runs in the lifecycle worker."
  type        = string
  default     = null
  validation {
    condition     = var.digest_from == null || can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.digest_from))
    error_message = "digest_from must be a plain email address, such as updates@example.com."
  }
  validation {
    condition     = var.digest_from == null || var.update_model != null
    error_message = "digest_from needs update_model: the digest is sent by the lifecycle worker, which is deployed only with a model."
  }
}

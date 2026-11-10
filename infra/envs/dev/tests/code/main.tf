# Test helper: what the API's source and the image's Dockerfile say about the container health check and the
# shutdown grace, read as text, so `envs/dev` and infra/README.md cannot drift from the code silently. Plans with
# no provider and no resource. Each regex must match: when the code is reshaped the plan fails here, saying which
# constant to look at. The coupling to the Rust source is deliberate: a Rust change that trips it updates infra with it.

variable "task" {
  description = "The API task's health check, plain environment and stop timeouts: the root output api_task_timing."
  type        = any
}

variable "company_key_prefixes" {
  description = "Per task, the COMPANY_KEY_ALIAS_ARN_PREFIX it is set to and the AWS_REGION it runs in. The parser stops the process unless the value has the code's shape and its Region is AWS_REGION."
  type        = map(object({ value = string, region = string }))
  default     = {}
}

locals {
  root     = "${path.module}/../../../../.."
  api_src  = "${local.root}/crates/oryxa-fde-api/src"
  readme   = file("${local.root}/infra/README.md")
  health   = file("${local.api_src}/health.rs")
  shutdown = file("${local.api_src}/shutdown.rs")
  ops      = file("${local.api_src}/bin/ops.rs")
  # Only the code above the tests: the parser's literals, not the examples the tests feed it.
  keys = split("#[cfg(test)]", file("${local.root}/crates/oryxa-fde-context/src/keys.rs"))[0]

  # Instructions only: a comment may say what the image no longer has.
  dockerfile = [
    for l in split("\n", file("${local.root}/infra/docker/oryxa-fde-api.Dockerfile")) : trimspace(l)
    if trimspace(l) != "" && !startswith(trimspace(l), "#")
  ]

  # The README's table row of the `oryxa-fde-ops` subcommand, and of the API variable.
  ops_section = one([for s in split("\n### ", local.readme) : s if startswith(s, "`oryxa-fde-ops`")])
  api_section = one([for s in split("\n### ", local.readme) : s if startswith(s, "`oryxa-fde-api`")])
  ops_row     = one(regexall("(?m)^\\| `healthcheck` \\|[^\n]*$", local.ops_section))
  grace_var   = regex("pub const GRACE_VAR: &str = \"([A-Z_]+)\";", local.shutdown)[0]
  # What `CompanyKeyPrefix::parse` takes: arn:<partition>:kms:<region>:<account>:<head><env><tail>.
  prefix_var   = regex("pub const PREFIX_VAR: &str = \"([A-Z_]+)\";", local.keys)[0]
  alias_head   = regex("\\.strip_prefix\\(\"([^\"]+)\"\\)", local.keys)[0]
  alias_tail   = regex("\\.strip_suffix\\(\"([^\"]+)\"\\)", local.keys)[0]
  partitions   = [for p in regexall("\"([a-z-]+)\"", regex("matches!\\(partition, ([^)]+)\\)", local.keys)[0]) : p[0]]
  account_len  = tonumber(regex("account\\.len\\(\\) == (\\d+)", local.keys)[0])
  word         = "[a-z0-9]+(-[a-z0-9]+)*"
  prefix_shape = "^arn:(${join("|", local.partitions)}):kms:${local.word}:[0-9]{${local.account_len}}:${local.alias_head}${local.word}${local.alias_tail}$"
  grace_row    = one(regexall("(?m)^\\| `${local.grace_var}` \\|[^\n]*$", local.api_section))
}

output "health_timeout_seconds" {
  description = "health.rs TIMEOUT: how long the check waits for /healthz."
  value       = tonumber(regex("pub const TIMEOUT: Duration = Duration::from_secs\\((\\d+)\\);", local.health)[0])
}

output "health_path" {
  description = "health.rs HEALTH_PATH."
  value       = regex("pub const HEALTH_PATH: &str = \"([^\"]+)\";", local.health)[0]
}

output "healthcheck_subcommand_exists" {
  description = "ops.rs dispatches `healthcheck`."
  value       = can(regex("\\[\"healthcheck\"\\] =>", local.ops))
}

output "grace_var" {
  description = "The environment variable shutdown.rs reads."
  value       = local.grace_var
}

output "grace_default_seconds" {
  description = "shutdown.rs DEFAULT_GRACE."
  value       = tonumber(regex("pub const DEFAULT_GRACE: Duration = Duration::from_secs\\((\\d+)\\);", local.shutdown)[0])
}

output "grace_max_seconds" {
  description = "shutdown.rs MAX_GRACE_SECS: the largest grace the API starts with."
  value       = tonumber(regex("const MAX_GRACE_SECS: u64 = (\\d+);", local.shutdown)[0])
}

output "readme_healthcheck_command" {
  description = "The command the README's oryxa-fde-ops table gives for the container health check, without CMD."
  value       = regex("health check: `([^`]+)`", local.ops_row)[0]
}

output "readme_grace_default_seconds" {
  description = "The default the README's API table gives for the grace variable."
  value       = tonumber(regex("^\\| `[A-Z_]+` \\| optional \\| config \\| `(\\d+)`", local.grace_row)[0])
}

output "readme_grace_max_seconds" {
  description = "The upper end of the range the README's API table gives for the grace variable."
  value       = tonumber(regex("1 to (\\d+)", local.grace_row)[0])
}

output "image" {
  description = "The Dockerfile's instructions, comments removed."
  value       = local.dockerfile
}

output "company_key_prefix_var" {
  description = "keys.rs PREFIX_VAR: the variable the API and the ingest worker read the alias prefix from."
  value       = local.prefix_var
}

output "company_key_prefix_shape" {
  description = "The regular expression built from keys.rs's parser literals."
  value       = local.prefix_shape
}

output "company_key_prefix_accepted" {
  description = "Per task: the value has the shape CompanyKeyPrefix::parse takes and names the Region the task runs in (prefix_from)."
  value = {
    for t, p in var.company_key_prefixes : t => can(regex(local.prefix_shape, p.value)) && split(":", p.value)[3] == p.region
  }
}

output "company_key_prefix_rejects_the_wrong_shapes" {
  description = "The shape is not vacuous: the values keys.rs's own test refuses are refused here too."
  value = [
    for v in [
      "arn:aws:kms:ap-south-1:000000000000:alias/oryxa-fde-dev/companies",
      "arn:aws:kms:ap-south-1:000000000000:alias/oryxa-fde-dev/companies/cmp_1",
      "arn:aws:kms:ap-south-1:00000000000:alias/oryxa-fde-dev/companies/",
      "arn:aws:kms:ap-south-1:000000000000:key/oryxa-fde-dev/companies/",
      "arn:aws:kms:ap-south-1:000000000000:alias/oryxa-fde-/companies/",
      "arn:aws:s3:ap-south-1:000000000000:alias/oryxa-fde-dev/companies/",
    ] : can(regex(local.prefix_shape, v))
  ]
}

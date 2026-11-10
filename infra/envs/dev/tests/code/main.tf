# Test helper: what the API's source and the image's Dockerfile say about the container health check and the
# shutdown grace, read as text, so `envs/dev` and infra/README.md cannot drift from the code silently. Plans with
# no provider and no resource. Each regex must match: when the code is reshaped the plan fails here, saying which
# constant to look at. The coupling to the Rust source is deliberate: a Rust change that trips it updates infra with it.

variable "task" {
  description = "The API task's health check, plain environment and stop timeouts: the root output api_task_timing."
  type        = any
}

locals {
  root     = "${path.module}/../../../../.."
  api_src  = "${local.root}/crates/oryxa-fde-api/src"
  readme   = file("${local.root}/infra/README.md")
  health   = file("${local.api_src}/health.rs")
  shutdown = file("${local.api_src}/shutdown.rs")
  ops      = file("${local.api_src}/bin/ops.rs")

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
  grace_row   = one(regexall("(?m)^\\| `${local.grace_var}` \\|[^\n]*$", local.api_section))
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

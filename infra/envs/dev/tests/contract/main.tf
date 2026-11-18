# Test helper: checks one task's environment against its contract table in infra/README.md ("The
# API environment contract": a `### ` heading per binary), so the table cannot drift from `envs/dev`
# silently. Plans with no provider and no resource.

variable "binary" {
  description = "The heading of the table to read, as the README writes it after `### `: oryxa-fde-api."
  type        = string
  default     = "oryxa-fde-api"
}

variable "min_rows" {
  description = "Fewer rows than this means the table was not read."
  type        = number
  default     = 10
}

variable "plain_env_names" {
  description = "Names of the plain config variables on the task definition."
  type        = set(string)
}

variable "secret_env_names" {
  description = "Names of the variables the task gets from Secrets Manager."
  type        = set(string)
}

locals {
  readme = file("${path.module}/../../../../README.md")

  # The text under the binary's heading, up to the next one.
  section = one([for s in split("\n### ", local.readme) : s if startswith(s, "`${var.binary}`")])

  # | `NAME` | needed | kind | ... ; a name listed twice fails the plan.
  rows = {
    for m in regexall("(?m)^\\| `([A-Z][A-Z0-9_]*)` \\| ([a-z, ]+) \\| ([a-z]+) \\|", local.section) :
    m[0] => { needed = split(", ", m[1]), kind = m[2] }
  }

  set = setunion(var.plain_env_names, var.secret_env_names)

  required = toset([for name, r in local.rows : name if contains(r.needed, "always")])
  # May be set: the required, and anything optional. A local-only variable, or one the table does not list, is not.
  allowed = setunion(local.required, toset([for name, r in local.rows : name if contains(r.needed, "optional")]))
  secrets = toset([for name, r in local.rows : name if r.kind == "secret"])
}

output "table_read" {
  description = "True when the table parsed: rows exist, with the values the README defines."
  value = length(local.rows) > var.min_rows && alltrue([
    for name, r in local.rows :
    contains(["config", "secret", "reference"], r.kind) &&
    alltrue([for w in r.needed : contains(["always", "optional", "local only"], w)])
  ])
}

output "missing" {
  description = "Required by the binary, absent from its task definition: it would not start."
  value       = sort(setsubtract(local.required, local.set))
}

output "unexpected" {
  description = "Set on the task definition, but unknown to the table or local only."
  value       = sort(setsubtract(local.set, local.allowed))
}

output "secrets_as_plain" {
  description = "Secret values set as plain config: visible in the task definition."
  value       = sort(setintersection(var.plain_env_names, local.secrets))
}

output "injected_non_secrets" {
  description = "Injected from Secrets Manager but not marked as a secret in the table."
  value       = sort(setsubtract(var.secret_env_names, local.secrets))
}

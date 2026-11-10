# Test helper: checks the API task's environment against the contract table in infra/README.md ("The
# API environment contract"), so the table cannot drift from `envs/dev` silently. Plans with no
# provider and no resource.

variable "plain_env_names" {
  description = "Names of the plain config variables on the API task definition."
  type        = set(string)
}

variable "secret_env_names" {
  description = "Names of the variables the API task gets from Secrets Manager."
  type        = set(string)
}

variable "features" {
  description = "The optional features switched on: agent, realtime, github, slack."
  type        = set(string)
}

locals {
  readme = file("${path.module}/../../../../README.md")

  # The text under the `oryxa-fde-api` heading, up to the next one.
  section = one([for s in split("\n### ", local.readme) : s if startswith(s, "`oryxa-fde-api`")])

  # | `NAME` | needed | kind | ... ; a name listed twice fails the plan.
  rows = {
    for m in regexall("(?m)^\\| `([A-Z][A-Z0-9_]*)` \\| ([a-z, ]+) \\| ([a-z]+) \\|", local.section) :
    m[0] => { needed = split(", ", m[1]), kind = m[2] }
  }

  set = setunion(var.plain_env_names, var.secret_env_names)

  # Needed now: always, plus what each switched-on feature needs.
  required = toset([for name, r in local.rows : name if length(setintersection(r.needed, setunion(["always"], var.features))) > 0])
  # May be set: the required, and anything optional. A variable only a switched-off feature needs, a
  # local-only one, or one the table does not list is not.
  allowed = setunion(local.required, toset([for name, r in local.rows : name if contains(r.needed, "optional")]))
  secrets = toset([for name, r in local.rows : name if r.kind == "secret"])
}

output "table_read" {
  description = "True when the table parsed: rows exist, with the values the README defines."
  value = length(local.rows) > 30 && alltrue([
    for name, r in local.rows :
    contains(["config", "secret", "reference"], r.kind) &&
    alltrue([for w in r.needed : contains(["always", "agent", "realtime", "github", "slack", "optional", "local only"], w)])
  ])
}

output "missing" {
  description = "Required by the API, absent from its task definition: the API would not start."
  value       = sort(setsubtract(local.required, local.set))
}

output "unexpected" {
  description = "Set on the task definition, but unknown to the table or not needed with these features."
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

output "github_deploy_role_arn" {
  description = "Set as AWS_DEPLOY_ROLE_ARN on the GitHub environment named after env (infra/README.md, Deploys)."
  value       = aws_iam_role.github_deploy.arn
}

output "ecr_repository_url" {
  description = "Push oryxa-fde-api images here, tagged with the git sha (api_image_tag)."
  value       = aws_ecr_repository.api.repository_url
}

output "api_vpc_service_id" {
  description = "Workers VPC service for fde-web's `vpc_services` binding to the API."
  value       = module.cloudflare.api_vpc_service_id
}

output "tunnel_id" {
  description = "Copy this tunnel's token from the Cloudflare dashboard into the cloudflared/tunnel-token secret."
  value       = module.cloudflare.tunnel_id
}

output "web_hostname" {
  value = module.cloudflare.web_hostname
}

output "admin_hostname" {
  value = module.cloudflare.admin_hostname
}

output "region" {
  value = local.region
}

output "cluster" {
  value = aws_ecs_cluster.this.name
}

output "run_task_network" {
  description = "What infra/scripts/run-task.sh needs: task definitions, private subnets, security groups."
  value = {
    subnets                  = local.subnets
    db_admin_security_group  = module.db_admin.security_group_id
    spicedb_security_group   = module.spicedb.security_group_id
    db_admin_task_definition = module.db_admin.task_family
    migrate_security_group   = module.migrate.security_group_id
    migrate_task_definition  = module.migrate.task_family
    spicedb_task_definition  = module.spicedb.task_family
    zed_security_group       = module.zed.security_group_id
    zed_task_definition      = module.zed.task_family
  }
}

output "db_address" {
  value = module.db.address
}

output "secrets" {
  description = "Secrets Manager names to fill by hand before start_services = true."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.name }
}

output "queue_urls" {
  value = { for k, q in module.queue : k => q.url }
}

output "eventbus_delivery_role_arn" {
  description = "Role each consumer's FIFO subscriber uses to deliver into its queue."
  value       = module.eventbridge.delivery_role_arn
}

output "data_bucket" {
  value = module.data_bucket.name
}

output "cloudtrail_bucket" {
  value = module.cloudtrail.bucket
}

output "api_env_names" {
  description = "Names, never values, of the variables the API task gets: plain config and injected secrets. The contract test compares them with infra/README.md."
  value = {
    plain  = module.api.plain_env_names
    secret = module.api.secret_env_names
  }
}

output "api_task_timing" {
  description = "The API task's health check, plain environment (names and values; secrets are not in it) and stop timeouts, for tests/code, which compares them with the code's constants. No secret."
  value = {
    health_check = module.api.containers[0].healthCheck
    environment  = { for e in module.api.containers[0].environment : e.name => e.value }
    # ECS waits 30 s when a container sets none.
    stop_timeouts = { for c in module.api.containers : c.name => coalesce(try(c.stopTimeout, null), 30) }
  }
}

output "agent_model_target" {
  description = "The agent's Bedrock model or profile and the Region its calls start from (AGENT_MODEL, AGENT_REGION); null while the agent is off. Not a secret."
  value       = local.agent_on ? { model = var.agent_model, region = local.agent_region } : null
}

output "ingest_env_names" {
  description = "Names, never values, of the variables the ingest worker gets. The contract test compares them with infra/README.md."
  value = {
    plain  = module.ingest.plain_env_names
    secret = module.ingest.secret_env_names
  }
}

output "lifecycle_env_names" {
  description = "The same for the lifecycle worker; null while update_model is null and the worker is not deployed."
  value = local.lifecycle_on ? {
    plain  = module.lifecycle[0].plain_env_names
    secret = module.lifecycle[0].secret_env_names
  } : null
}

output "event_subscribers" {
  description = "What infra/scripts/create-subscriber.sh needs for each worker: the delivery role, and the queue each subscriber feeds. The lifecycle subscriber is created only once its worker is deployed."
  value = {
    delivery_role = module.eventbridge.delivery_role_arn
    consumers     = { for c in ["context-ingestion", "lifecycle"] : c => module.queue[c].url }
  }
}

output "company_keys" {
  description = "Input of infra/scripts/company-key.sh: `tofu output -json company_keys > <file>`. Holds ARNs and the key policy, no secret."
  value       = module.company_keys.config
}

output "company_key_alias_arn_prefix" {
  description = "Append a company id for the alias the API names on write and looks up (the API stream's COMPANY_KEY_ALIAS_ARN_PREFIX, once its code reads it)."
  value       = module.company_keys.alias_arn_prefix
}

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

# RDS for PostgreSQL 17 (ADR 0003), one instance per environment. pgvector ships with RDS and is
# enabled by infra/sql/01-bootstrap.sql. The master password is generated and rotated by RDS in
# Secrets Manager, so it never appears in config or state; only the one-off db-admin task reads it.
#
# Never publicly accessible. Services connect over TLS with IAM database auth, each as its own
# user; only the security groups in `allowed_security_groups` reach 5432. The module takes no CIDRs.
#
# An instance, not the platform's Aurora Serverless: the API and SpiceDB hold connections around
# the clock, so Aurora would rarely pause and its 0.5 ACU floor costs more than a t4g.micro.

variable "name" {
  type = string
}

variable "engine_version" {
  description = "Major version; RDS applies minor upgrades in the maintenance window."
  type        = string
  default     = "17"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 100
}

variable "database_name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets in at least two AZs."
  type        = list(string)
}

variable "allowed_security_groups" {
  description = "Security groups that may connect to 5432, keyed by a static name (ids are unknown until apply)."
  type        = map(string)
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${var.name}-db"
  description = "Postgres for ${var.name}"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "pg" {
  for_each                     = var.allowed_security_groups
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg${split(".", var.engine_version)[0]}"
  family = "postgres${split(".", var.engine_version)[0]}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true # a major upgrade swaps the group without detaching the instance first
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name                             = var.database_name
  username                            = "oryxa_admin"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = var.kms_key_arn
  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = false # ponytail: single AZ in dev; prod sets multi_az

  auto_minor_version_upgrade = true
  backup_retention_period    = var.backup_retention_days
  copy_tags_to_snapshot      = true
  deletion_protection        = var.deletion_protection
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"
}

output "address" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "resource_id" {
  description = "For rds-db:connect ARNs (IAM database auth)."
  value       = aws_db_instance.this.resource_id
}

output "master_secret_arn" {
  description = "Secrets Manager secret holding the master credentials (db-admin task only)."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "security_group_id" {
  value = aws_security_group.this.id
}

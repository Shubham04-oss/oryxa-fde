# Internal Application Load Balancer in front of one Fargate service. No public address: the only
# client is cloudflared (the Workers VPC tunnel), allowed by security group.
#
# ponytail: HTTP between cloudflared and the ALB and between the ALB and the task, inside the VPC
# and limited by security groups. The hop from the Worker to cloudflared is the encrypted tunnel.
# Prod adds an ACM certificate and an HTTPS listener.

variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets in at least two AZs."
  type        = list(string)
}

variable "clients" {
  description = "Security groups that may reach the listener, keyed by a static name."
  type        = map(string)
}

variable "target_security_group_id" {
  type = string
}

variable "target_port" {
  type = number
}

variable "health_check_path" {
  type = string
}

variable "idle_timeout_seconds" {
  type    = number
  default = 60
}

resource "aws_security_group" "this" {
  name        = "${var.name}-alb"
  description = "Internal ALB for ${var.name}"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each                     = var.clients
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "target" {
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.target_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.target_port
  to_port                      = var.target_port
}

resource "aws_lb" "this" {
  name                       = var.name
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = var.subnet_ids
  security_groups            = [aws_security_group.this.id]
  drop_invalid_header_fields = true
  idle_timeout               = var.idle_timeout_seconds
}

resource "aws_lb_target_group" "this" {
  name                 = var.name
  vpc_id               = var.vpc_id
  target_type          = "ip"
  protocol             = "HTTP"
  port                 = var.target_port
  deregistration_delay = 30

  health_check {
    path                = var.health_check_path
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

output "dns_name" {
  value = aws_lb.this.dns_name
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "target_group_arn" {
  value = aws_lb_target_group.this.arn
  # ECS refuses a target group that no listener uses yet.
  depends_on = [aws_lb_listener.http]
}

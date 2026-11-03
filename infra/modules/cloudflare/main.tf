# Cloudflare side of the environment: hostnames, the private link from Workers to the internal
# ALB, and Access in front of admin tools. Worker code, Durable Object migrations, routes and
# secrets ship with `wrangler deploy` from fde-web/ and sandbox/; this module wires what surrounds
# them. Nothing here stores secrets or customer data.
#
# Private link (Workers VPC): cloudflared runs in the VPC's private subnets with this tunnel's
# token and dials out to Cloudflare. The VPC service below routes a Worker's `vpc_services`
# binding through that tunnel to the ALB's hostname, resolved inside the VPC. The API gets no
# public hostname and no inbound port: only Workers in this account bound to the service reach it.

variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "name" {
  description = "Environment prefix, e.g. oryxa-fde-dev."
  type        = string
}

variable "domain" {
  description = "Base hostname for this environment; app. and admin. hang off it."
  type        = string
}

variable "api_origin_hostname" {
  description = "The internal ALB's DNS name, resolved by cloudflared inside the VPC."
  type        = string
}

variable "admin_emails" {
  description = "Who may open admin hostnames through Cloudflare Access."
  type        = list(string)
}

locals {
  web   = "app.${var.domain}"
  admin = "admin.${var.domain}"
}

# Worker hostnames: a proxied placeholder record so a Worker route has something to attach to.
# The routes themselves (app.<domain>/*, admin.<domain>/*) belong to the Workers' wrangler config.
resource "cloudflare_dns_record" "worker" {
  for_each = toset([local.web, local.admin])
  zone_id  = var.zone_id
  name     = each.value
  type     = "AAAA"
  content  = "100::"
  proxied  = true
  ttl      = 1
  comment  = "Worker route placeholder (${var.name})"
}

# ---------------------------------------------------------------- private link

# Remotely managed and token-run. The token is copied into Secrets Manager by hand (README), so it
# never passes through OpenTofu state.
resource "cloudflare_zero_trust_tunnel_cloudflared" "api" {
  account_id = var.account_id
  name       = "${var.name}-api"
  config_src = "cloudflare"
}

resource "cloudflare_connectivity_directory_service" "api" {
  account_id = var.account_id
  name       = "${var.name}-api"
  type       = "http"
  http_port  = 80
  host = {
    hostname = var.api_origin_hostname
    resolver_network = {
      tunnel_id = cloudflare_zero_trust_tunnel_cloudflared.api.id
    }
  }
}

# ---------------------------------------------------------------- Access

resource "cloudflare_zero_trust_access_policy" "admins" {
  account_id = var.account_id
  name       = "${var.name} admins"
  decision   = "allow"
  include    = [for e in var.admin_emails : { email = { email = e } }]
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.account_id
  name             = "${var.name} admin"
  type             = "self_hosted"
  domain           = local.admin
  session_duration = "8h"
  policies         = [{ id = cloudflare_zero_trust_access_policy.admins.id, precedence = 1 }]
}

output "web_hostname" {
  value = local.web
}

output "admin_hostname" {
  value = local.admin
}

output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.api.id
}

output "api_vpc_service_id" {
  description = "For the `vpc_services` binding in fde-web's wrangler config."
  value       = cloudflare_connectivity_directory_service.api.service_id
}

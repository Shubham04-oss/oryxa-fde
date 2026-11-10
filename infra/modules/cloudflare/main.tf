# Cloudflare side of the environment: hostnames, the private link from Workers to the API, and
# Access in front of admin tools. Worker code, Durable Object migrations, routes and
# secrets ship with `wrangler deploy` from fde-web/ and sandbox/; this module wires what surrounds
# them. Nothing here stores secrets or customer data.
#
# Private link (Workers VPC): cloudflared runs as a sidecar in the API's task, in the VPC's private
# subnets, with this tunnel's token, and dials out to Cloudflare. The VPC service below routes a
# Worker's `vpc_services` binding through that tunnel to 127.0.0.1 on the API's port: the connector
# and the API share the task's network namespace. The API gets no public hostname and no inbound
# port: only Workers in this account bound to the service reach it.
#
# The MCP server (var.mcp_enabled) is reached differently, because it is for an FDE's own agent, which is not a Worker
# and cannot use a Workers VPC binding: it has a tunnel of its own, run as a sidecar of its own task, with one public
# hostname on it. The hostname is a proxied record at Cloudflare's edge and points at nothing in AWS: no listener, no load
# balancer, no inbound rule. The tunnel's ingress rule is the only thing behind it, and it answers 404 to any other name.

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

variable "api_port" {
  description = "Port the API listens on, on the loopback of the task that runs the tunnel's connector."
  type        = number
}

variable "mcp_enabled" {
  description = "Create the MCP server's tunnel and its hostname (mcp.<domain>). Off: nothing for it exists."
  type        = bool
  default     = false
}

variable "mcp_port" {
  description = "Port the MCP server listens on, on the loopback of the task that runs its tunnel's connector."
  type        = number
  default     = 8081
}

variable "admin_emails" {
  description = "Who may open admin hostnames through Cloudflare Access."
  type        = list(string)
}

locals {
  web   = "app.${var.domain}"
  admin = "admin.${var.domain}"
  mcp   = "mcp.${var.domain}"
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
  http_port  = var.api_port
  host = {
    ipv4 = "127.0.0.1" # the connector's own loopback, which is the API's (same task)
    network = {
      tunnel_id = cloudflare_zero_trust_tunnel_cloudflared.api.id
    }
  }
}

# ---------------------------------------------------------------- the MCP server's tunnel

# Remotely managed and token-run, like the API's: the token goes into Secrets Manager by hand (README).
resource "cloudflare_zero_trust_tunnel_cloudflared" "mcp" {
  count      = var.mcp_enabled ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-mcp"
  config_src = "cloudflare"
}

# One hostname, one origin: the connector's own loopback, which is the MCP server's (same task). Anything else asked of
# this tunnel is a 404 from the connector.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "mcp" {
  count      = var.mcp_enabled ? 1 : 0
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.mcp[0].id
  config = {
    ingress = [
      { hostname = local.mcp, service = "http://127.0.0.1:${var.mcp_port}" },
      { service = "http_status:404" },
    ]
  }
}

# Proxied: Cloudflare terminates TLS and the name resolves to Cloudflare's edge, never to an address in AWS.
resource "cloudflare_dns_record" "mcp" {
  count   = var.mcp_enabled ? 1 : 0
  zone_id = var.zone_id
  name    = local.mcp
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.mcp[0].id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "MCP server tunnel (${var.name})"
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

output "mcp_hostname" {
  description = "The name an FDE's agent reaches the MCP server at (and its MCP_ALLOWED_HOSTS); null while it is off."
  value       = var.mcp_enabled ? local.mcp : null
}

output "mcp_tunnel_id" {
  description = "Copy this tunnel's token from the Cloudflare dashboard into the cloudflared/mcp-tunnel-token secret; null while the MCP server is off."
  value       = var.mcp_enabled ? cloudflare_zero_trust_tunnel_cloudflared.mcp[0].id : null
}

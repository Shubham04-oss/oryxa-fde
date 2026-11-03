# The environment's VPC, adapted from oryxa-platform infra/modules/vpc (2b064a3) without the
# connector tier. Two subnet tiers, each in two AZs:
#   public   IGW route. Only the NAT instance.
#   private  default route to the NAT instance. Every task, the internal ALB and Postgres.
# Nothing accepts traffic from the internet: no security group here or in the services has a CIDR
# ingress rule wider than the VPC itself.

variable "name" {
  type = string
}

variable "cidr" {
  type    = string
  default = "10.50.0.0/16"
}

variable "interface_endpoints" {
  description = "Extra PrivateLink endpoints (suffix after com.amazonaws.<region>.). Empty: AWS APIs go through the NAT."
  type        = set(string)
  default     = []
}

variable "endpoint_az_count" {
  description = "AZs that get an ENI per interface endpoint (about $7.30/month each per AZ)."
  type        = number
  default     = 1
}

variable "nat_https_clients" {
  description = "Security groups allowed HTTPS (443/tcp) through the NAT instance, keyed by a static name."
  type        = map(string)
}

variable "nat_tunnel_clients" {
  description = "Security groups also allowed the Cloudflare Tunnel port (7844 tcp and udp) through the NAT instance."
  type        = map(string)
  default     = {}
}

variable "nat_instance_type" {
  type    = string
  default = "t4g.nano"
}

data "aws_region" "current" {}

data "aws_availability_zones" "this" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.this.names, 0, 2)
  # /24 per subnet: tier offset + AZ index.
  tiers = { public = 0, private = 20 }
  subnets = merge([for tier, offset in local.tiers : {
    for i, az in local.azs : "${tier}-${i}" => { tier = tier, az = az, cidr = cidrsubnet(var.cidr, 8, offset + i) }
  }]...)
  region = data.aws_region.current.region

  # NAT ingress per client and port, static keys so the plan never depends on security group ids.
  tunnel_ports = { tunnel-tcp = "tcp", tunnel-udp = "udp" }
  nat_egress = merge(
    { https = { protocol = "tcp", port = 443 } },
    { for p, proto in local.tunnel_ports : p => { protocol = proto, port = 7844 } },
  )
  nat_ingress = merge(
    { for k, sg in var.nat_https_clients : "${k}-https" => { sg = sg, protocol = "tcp", port = 443 } },
    merge([for k, sg in var.nat_tunnel_clients : {
      for p, proto in local.tunnel_ports : "${k}-${p}" => { sg = sg, protocol = proto, port = 7844 }
    }]...),
  )
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # private DNS on interface endpoints and the Cloud Map namespace
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "this" {
  for_each          = local.subnets
  vpc_id            = aws_vpc.this.id
  availability_zone = each.value.az
  cidr_block        = each.value.cidr
  tags              = { Name = "${var.name}-${each.key}" }
}

resource "aws_route_table" "this" {
  for_each = local.tiers
  vpc_id   = aws_vpc.this.id
  tags     = { Name = "${var.name}-${each.key}" }
}

resource "aws_route_table_association" "this" {
  for_each       = local.subnets
  subnet_id      = aws_subnet.this[each.key].id
  route_table_id = aws_route_table.this[each.value.tier].id
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.this["public"].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.this["private"].id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat.primary_network_interface_id
}

# ---------------------------------------------------------------- NAT instance (fck-nat)

# ponytail: one fck-nat instance, no ASG or failover. If it stops, every task loses AWS APIs, the
# tunnel and the internet until it is replaced; prod uses fck-nat's HA mode or a NAT gateway per AZ.
data "aws_ami" "fck_nat" {
  most_recent = true
  owners      = ["568608671756"] # fck-nat publisher; verify before apply
  filter {
    name   = "name"
    values = ["fck-nat-al2023-*-arm64-ebs"]
  }
}

resource "aws_security_group" "nat" {
  name        = "${var.name}-nat"
  description = "NAT instance: named services only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "nat" {
  for_each                     = local.nat_ingress
  security_group_id            = aws_security_group.nat.id
  referenced_security_group_id = each.value.sg
  ip_protocol                  = each.value.protocol
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "nat" {
  for_each          = local.nat_egress
  security_group_id = aws_security_group.nat.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = each.value.protocol
  from_port         = each.value.port
  to_port           = each.value.port
}

resource "aws_instance" "nat" {
  ami                         = data.aws_ami.fck_nat.id
  instance_type               = var.nat_instance_type
  subnet_id                   = aws_subnet.this["public-0"].id
  vpc_security_group_ids      = [aws_security_group.nat.id]
  associate_public_ip_address = true
  source_dest_check           = false # required to forward traffic

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    encrypted = true
  }

  tags = { Name = "${var.name}-nat" }
}

# ---------------------------------------------------------------- endpoints

# Free. ECR image layers and the data bucket stay off the NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.this["private"].id]
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "Interface endpoints: HTTPS from inside the VPC"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints" {
  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = var.cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = var.interface_endpoints
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for i in range(var.endpoint_az_count) : aws_subnet.this["private-${i}"].id]
  security_group_ids  = [aws_security_group.endpoints.id]
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "cidr" {
  value = aws_vpc.this.cidr_block
}

output "private_subnet_ids" {
  value = [for i in range(2) : aws_subnet.this["private-${i}"].id]
}

# EventBridge v2 wiring that OpenTofu can express today. Adapted from oryxa-platform
# infra/modules/eventbridge (2b064a3).
#
# Provider gap: hashicorp/aws (checked 6.68.0) has no EventBridge v2 (`eventsv2`) resources, so the
# bus and its subscribers are not managed here:
#   - the bus is created once by infra/scripts/create-event-bus.sh (`aws eventsv2 create-event-bus`);
#   - each consumer's FIFO subscriber is created with that consumer, whose handlers define the filter.
# This module owns the IAM side: the delivery role subscribers use to write into the consumer
# queues, and a publish policy for producers.

variable "name" {
  description = "Bus name, e.g. oryxa-fde-dev."
  type        = string
}

variable "bus_arn" {
  description = "ARN printed by infra/scripts/create-event-bus.sh."
  type        = string
}

variable "consumer_queue_arns" {
  description = "Queues the bus may deliver into (main FIFO queues and their -undelivered queues)."
  type        = list(string)
}

variable "delivery_service_principal" {
  description = "Service principal EventBridge v2 assumes the delivery role with (verified on the platform's dev role)."
  type        = string
  default     = "events.amazonaws.com"
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = [var.delivery_service_principal]
    }
    # Confused-deputy guard: the service may assume this role only on behalf of this account.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "delivery" {
  name               = "${var.name}-eventbus-delivery"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "delivery" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = var.consumer_queue_arns
  }
}

resource "aws_iam_role_policy" "delivery" {
  name   = "deliver-to-consumer-queues"
  role   = aws_iam_role.delivery.id
  policy = data.aws_iam_policy_document.delivery.json
}

# The v2 SDK signs as service "events", so the action is events:PutEvents scoped to the v2 bus ARN.
# ponytail: inferred from the SDK signing name, as in the platform; confirm in the IAM service
# authorization reference before apply.
data "aws_iam_policy_document" "publish" {
  statement {
    actions   = ["events:PutEvents"]
    resources = [var.bus_arn]
  }
}

output "delivery_role_arn" {
  value = aws_iam_role.delivery.arn
}

output "publish_policy_json" {
  value = data.aws_iam_policy_document.publish.json
}

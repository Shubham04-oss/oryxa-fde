# Copied from oryxa-platform infra/modules/sqs_fifo (2b064a3). Names follow the consumer kit with
# env = "fde-<env>", so the platform kit could provision against these queues unchanged.
#
# FIFO queue + FIFO DLQ (+ optional standard "undelivered" queue for EventBridge v2 subscribers).
# Names and attributes match the platform's crates/oryxa-consumer/src/provision.rs exactly: SQS
# CreateQueue is only idempotent when attributes match, so the consumer kit can re-run provisioning
# against queues this module created. Change both together.

variable "name" {
  description = "Base name without .fifo, e.g. oryxa-fde-dev-lifecycle."
  type        = string
}

variable "visibility_timeout_seconds" {
  description = "Must cover a received batch of handler work. The consumer kit uses 60."
  type        = number
  default     = 60
}

variable "max_receive_count" {
  type    = number
  default = 5
}

variable "undelivered_queue" {
  description = "Also create <name>-undelivered (standard), the bus subscriber's on-failure target."
  type        = bool
  default     = false
}

resource "aws_sqs_queue" "dlq" {
  name                        = "${var.name}-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
}

resource "aws_sqs_queue" "this" {
  name                        = "${var.name}.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  sqs_managed_sse_enabled     = true
  visibility_timeout_seconds  = var.visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue" "undelivered" {
  count                   = var.undelivered_queue ? 1 : 0
  name                    = "${var.name}-undelivered"
  sqs_managed_sse_enabled = true
}

output "arn" {
  value = aws_sqs_queue.this.arn
}

output "url" {
  value = aws_sqs_queue.this.url
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}

output "undelivered_arn" {
  value = try(aws_sqs_queue.undelivered[0].arn, null)
}

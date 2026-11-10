#!/usr/bin/env bash
# Creates (or refreshes) the EventBridge v2 FIFO subscriber that delivers one worker's events into its SQS
# FIFO queue. hashicorp/aws has no EventBridge v2 resource (see create-event-bus.sh), so this is the one
# manual step between `tofu apply` (queues, delivery role) and a worker that actually receives events.
# Mirrors the platform consumer kit's `provision` (oryxa-platform crates/oryxa-consumer/src/provision.rs):
# same name (oryxa-fde-<env>-<consumer>), FIFO, filter on exactly the detail types the worker handles,
# group and deduplication ids from the event's metadata, the -undelivered queue as the on-failure target.
# Safe to re-run: an existing subscriber only gets its filter refreshed.
# The owner runs it with credentials for the target account (AWS CLI 2.37.3 or newer); CI never does.
#   infra/scripts/create-subscriber.sh dev <account id> ap-south-1 context-ingestion
#   infra/scripts/create-subscriber.sh dev <account id> ap-south-1 lifecycle --replay
# By default only events published from now on are delivered. --replay (a new subscriber only) starts from the
# oldest event the bus still retains (7 days by default): use it for a worker whose subscriber came late. Both
# workers' handlers are idempotent, so a replayed event is harmless.
set -euo pipefail

usage="usage: create-subscriber.sh <env> <aws account id> <aws region> <context-ingestion|lifecycle> [--replay]"
env="${1:?$usage}"
account="${2:?$usage}"
region="${3:?$usage}"
consumer="${4:?$usage}"
replay="${5:-}"

[[ "$env" =~ ^[a-z][a-z0-9]{1,9}$ ]] || { echo "env must be 2 to 10 lowercase letters or digits" >&2; exit 2; }
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "account id must be 12 digits" >&2; exit 2; }
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "region must look like ap-south-1" >&2; exit 2; }
[[ -z "$replay" || "$replay" == "--replay" ]] || { echo "$usage" >&2; exit 2; }

# The detail types each worker handles. test-create-subscriber.sh checks these against the code, so a handler
# added without its subscription (its events would never arrive) fails CI.
case "$consumer" in
  context-ingestion)
    types=(fde.document.uploaded.v1)
    ;;
  lifecycle)
    types=(
      fde.access-request.status-changed.v1
      fde.agent-run.finished.v1
      fde.eval-run.finished.v1
      fde.pull-request.merged.v1
      fde.pull-request.opened.v1
      fde.update.approved.v1
    )
    ;;
  *)
    echo "consumer must be context-ingestion or lifecycle" >&2
    exit 2
    ;;
esac

# Same guard as allowed_account_ids in the provider: refuse to touch any other account.
actual=$(aws sts get-caller-identity --region "$region" --query Account --output text)
[[ "$actual" == "$account" ]] || { echo "credentials are for account $actual, not $account" >&2; exit 1; }

bus="oryxa-fde-$env"
base="$bus-$consumer"
bus_arn=$(aws eventsv2 list-event-buses --region "$region" --query "EventBuses[?Name=='$bus'].EventBusArn | [0]" --output text)
[[ -n "$bus_arn" && "$bus_arn" != "None" ]] || { echo "no bus $bus in $region: run create-event-bus.sh first" >&2; exit 1; }

# The queues and the delivery role are OpenTofu's: they must exist before a subscriber points at them.
for q in "$base.fifo" "$base-undelivered"; do
  aws sqs get-queue-url --region "$region" --queue-name "$q" --query QueueUrl --output text > /dev/null \
    || { echo "queue $q does not exist: apply infra/envs/dev first" >&2; exit 1; }
done
role_name="$bus-eventbus-delivery"
role_arn=$(aws iam get-role --role-name "$role_name" --query Role.Arn --output text) \
  || { echo "role $role_name does not exist: apply infra/envs/dev first" >&2; exit 1; }

queue_arn="arn:aws:sqs:$region:$account:$base.fifo"
undelivered_arn="arn:aws:sqs:$region:$account:$base-undelivered"
# {"aws:DetailType":["a","b"]}, as the consumer kit builds it, then that text inside the filter's JSON.
pattern=$(printf '%s\n' "${types[@]}" | jq -R . | jq -sc '{"aws:DetailType": .}')
filter=$(jq -nc --arg pattern "$pattern" '{Filters: [{Scope: "SYSTEM_METADATA", Pattern: $pattern}]}')

existing=$(aws eventsv2 list-subscribers --region "$region" --event-bus-arn "$bus_arn" \
  --query "Subscribers[?Name=='$base'].SubscriberArn | [0]" --output text)
if [[ -n "$existing" && "$existing" != "None" ]]; then
  [[ -z "$replay" ]] || echo "$base exists: --replay applies to a new subscriber only, ignored" >&2
  aws eventsv2 update-subscriber --region "$region" --subscriber-arn "$existing" --filter-configuration "$filter" > /dev/null
  echo "refreshed the filter of $base: ${types[*]}" >&2
  echo "$existing"
  exit 0
fi

invoke=$(jq -nc --arg role "$role_arn" --arg target "$queue_arn" '{
  RoleArn: $role,
  SqsParameters: {
    MessageGroupId: "{% $events.SystemMetadata.EventGroupId %}",
    MessageDeduplicationId: "{% $events.SystemMetadata.DeduplicationId %}"
  },
  TargetArn: $target
}')
position=(--starting-position LATEST)
[[ "$replay" != "--replay" ]] || position=(--starting-position POINT_IN_TIME --point-in-time-configuration PointType=HORIZON)

arn=$(aws eventsv2 create-subscriber --region "$region" \
  --name "$base" --event-bus-arn "$bus_arn" --type FIFO \
  --filter-configuration "$filter" \
  --transformer Type=WITH_METADATA \
  --invoke-configuration "$invoke" \
  --retry-policy MaxRetryAttempts=10,MaxEventAgeInSeconds=86400 \
  --on-failure-configuration "Arn=$undelivered_arn" \
  "${position[@]}" \
  --tags "project=oryxa-fde,env=$env" \
  --query SubscriberArn --output text)
echo "created $base: ${types[*]}" >&2
echo "$arn"

#!/usr/bin/env bash
# Creates the EventBridge v2 bus oryxa-fde-<env> and prints its ARN for `event_bus_arn` in tfvars.
# hashicorp/aws has no EventBridge v2 resource yet (checked 6.68.0), so the bus lives outside
# OpenTofu, as in the platform. Safe to re-run: an existing bus is reported, never changed.
# The owner runs it with credentials for the target account (AWS CLI 2.37.3 or newer); CI never does.
#   infra/scripts/create-event-bus.sh dev <account id>
set -euo pipefail

usage="usage: create-event-bus.sh <env> <aws account id> [retention days, default 7]"
env="${1:?$usage}"
account="${2:?$usage}"
retention="${3:-7}"

[[ "$env" =~ ^[a-z][a-z0-9]{1,9}$ ]] || { echo "env must be 2 to 10 lowercase letters or digits" >&2; exit 2; }
[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "account id must be 12 digits" >&2; exit 2; }
[[ "$retention" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "retention must be a number of days" >&2; exit 2; }

# Same guard as allowed_account_ids in the provider: refuse to touch any other account.
actual=$(aws sts get-caller-identity --query Account --output text)
[[ "$actual" == "$account" ]] || { echo "credentials are for account $actual, not $account" >&2; exit 1; }

name="oryxa-fde-$env"
arn=$(aws eventsv2 list-event-buses --query "EventBuses[?Name=='$name'].EventBusArn | [0]" --output text)
if [[ -n "$arn" && "$arn" != "None" ]]; then
  echo "$name already exists" >&2
else
  arn=$(aws eventsv2 create-event-bus --name "$name" \
    --storage-configuration "RetentionPeriodInDays=$retention" \
    --tags "project=oryxa-fde,env=$env" \
    --query EventBusArn --output text)
  echo "created $name" >&2
fi
echo "$arn"

#!/usr/bin/env bash
# One-off Fargate tasks in the environment's private subnets: the database has no public endpoint
# and there is no bastion. The owner runs this with admin credentials for the account; CI never does.
#   infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql   # psql as the RDS master (db-admin task)
#   infra/scripts/run-task.sh migrate                          # oryxa-fde-api migrate, as the migrator
#   infra/scripts/run-task.sh spicedb-migrate                  # spicedb datastore migrate head
#   infra/scripts/run-task.sh spicedb-schema schema/fde.zed    # zed schema write
# Region, cluster, task definitions and network come from `tofu output` in infra/envs/dev (or $TOFU_DIR).
set -euo pipefail

usage="usage: run-task.sh sql <file.sql> | migrate | spicedb-migrate | spicedb-schema <file.zed>"
cmd="${1:?$usage}"
dir="${TOFU_DIR:-$(dirname "$0")/../envs/dev}"

out=$(tofu -chdir="$dir" output -json)
region=$(jq -r '.region.value' <<<"$out")
cluster=$(jq -r '.cluster.value' <<<"$out")
net=$(jq -c '.run_task_network.value' <<<"$out")
subnets=$(jq -c '.subnets' <<<"$net")

# The file travels base64-encoded in one env override (visible in the ECS API, so no secrets in
# it); ECS caps all overrides at 8 KiB.
file_override() {
  local container="$1" var="$2" file="$3" b64
  [[ -f "$file" ]] || { echo "no such file: $file" >&2; exit 2; }
  b64=$(base64 < "$file" | tr -d '\n')
  (( ${#b64} < 7000 )) || { echo "$file is too large for a task override; split it" >&2; exit 2; }
  jq -cn --arg c "$container" --arg v "$var" --arg b "$b64" \
    '{containerOverrides: [{name: $c, environment: [{name: $v, value: $b}]}]}'
}

case "$cmd" in
  sql)
    family=$(jq -r '.db_admin_task_definition' <<<"$net")
    sg=$(jq -r '.db_admin_security_group' <<<"$net")
    overrides=$(file_override psql SQL_B64 "${2:?$usage}")
    ;;
  migrate)
    family=$(jq -r '.migrate_task_definition' <<<"$net")
    sg=$(jq -r '.migrate_security_group' <<<"$net")
    overrides='{}'
    ;;
  spicedb-migrate)
    family=$(jq -r '.spicedb_task_definition' <<<"$net")
    sg=$(jq -r '.spicedb_security_group' <<<"$net")
    overrides=$(jq -cn '{containerOverrides: [{name: "spicedb", command: ["datastore", "migrate", "head",
      "--datastore-engine", "postgres", "--datastore-credentials-provider-name", "aws-iam"]}]}')
    ;;
  spicedb-schema)
    family=$(jq -r '.zed_task_definition' <<<"$net")
    sg=$(jq -r '.zed_security_group' <<<"$net")
    overrides=$(file_override zed SCHEMA_B64 "${2:?$usage}")
    ;;
  *)
    echo "$usage" >&2
    exit 2
    ;;
esac

network=$(jq -cn --argjson s "$subnets" --arg g "$sg" \
  '{awsvpcConfiguration: {subnets: $s, securityGroups: [$g], assignPublicIp: "DISABLED"}}')
task=$(aws ecs run-task --region "$region" --cluster "$cluster" --launch-type FARGATE --task-definition "$family" \
  --network-configuration "$network" --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
echo "started $task; waiting for it to stop (logs: CloudWatch /ecs/$family)" >&2
aws ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task"
code=$(aws ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)
echo "exit code: $code" >&2
[[ "$code" == "0" ]]

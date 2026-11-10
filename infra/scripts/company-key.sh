#!/usr/bin/env bash
# One KMS key per company (ADR 0003, amendment "per-company keys"; issue #109; infra/README.md, Company keys).
# An operator runs this per company, never the API at request time. The rules (key policy, tags, alias
# prefix, accounts, roles) come from OpenTofu's output, so they are written and tested once:
#   tofu -chdir=infra/envs/dev output -json company_keys > "$XDG_RUNTIME_DIR/company-keys.json"
#   infra/scripts/company-key.sh provision "$XDG_RUNTIME_DIR/company-keys.json" <tenant id> <company id>
#
#   provision  creates the key if the company has none, and checks one that exists; safe to re-run.
#              Run it as the provisioning role (output provisioner_role_arn); it can create, tag, name and
#              read keys and nothing else.
#   status     prints the key's state as JSON; exit 0 only for an enabled key of this company, 3 when there
#              is none, 4 for anything else.
#   sync       puts the current policy on an existing key (after a serving role was added or replaced).
#              Needs more than the provisioning role may do: an account administrator runs it.
#   offboard   schedules the key for deletion in 30 days, which makes the company's files, versions and
#              backups unreadable once the wait is over. Run it as the offboarding role (the only identity
#              that can); needs --confirm <tenant>/<company>. Until the wait ends the offboarding role can
#              cancel it.
#
# Every id is checked against [A-Za-z0-9_-]{1,128} before anything else, and the script refuses any account
# but the configured one. --dry-run makes the reads and prints what it would write; it writes nothing.
set -euo pipefail
export LC_ALL=C
export AWS_PAGER=""

usage="usage: company-key.sh <provision|status|sync|offboard> <config.json> <tenant id> <company id> [--dry-run] [--confirm <tenant>/<company>]"
die() {
  echo "error: $*" >&2
  exit 1
}
say() { echo "$*" >&2; }
refuse() {
  echo "error: $*" >&2
  exit 2
}

# An empty id is not "missing": it is an id that fails the check below, with the same exit status.
(($# >= 4)) || {
  echo "$usage" >&2
  exit 2
}
cmd="$1"
config="$2"
tenant="$3"
company="$4"
shift 4
dry=0
confirm=""
while (($#)); do
  case "$1" in
    --dry-run) dry=1 ;;
    --confirm)
      (($# >= 2)) || refuse "--confirm needs <tenant>/<company>"
      confirm="$2"
      shift
      ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
  shift
done

# ---- nothing below reads anything but these checked values
case "$cmd" in provision | status | sync | offboard) ;; *) refuse "unknown command $cmd. $usage" ;; esac
valid_id() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; }
valid_id "$tenant" || refuse "tenant id must be 1 to 128 of A-Z a-z 0-9 _ -"
valid_id "$company" || refuse "company id must be 1 to 128 of A-Z a-z 0-9 _ -"
[[ -f "$config" ]] || refuse "no config file $config (tofu output -json company_keys)"
command -v jq >/dev/null || refuse "jq is needed"
command -v aws >/dev/null || refuse "the AWS CLI is needed"

cfg() { jq -er "$1" "$config" || refuse "config: $1 is missing"; }
env="$(cfg .env)"
account="$(cfg .account_id)"
region="$(cfg .region)"
alias_prefix="$(cfg .alias_prefix)"
window="$(cfg .deletion_window_days)"
provisioner_role="$(cfg .provisioner_role)"
offboarder_role="$(cfg .offboarder_role)"
static_tags="$(cfg '.tags | tojson')"
[[ "$env" =~ ^[a-z][a-z0-9]{1,9}$ ]] || refuse "config: env must be 2 to 10 lowercase letters or digits"
[[ "$account" =~ ^[0-9]{12}$ ]] || refuse "config: account_id must be 12 digits"
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || refuse "config: region must look like ap-south-1"
[[ "$alias_prefix" == "alias/oryxa-fde-$env/companies/" ]] || refuse "config: alias_prefix is not alias/oryxa-fde-$env/companies/"
[[ "$window" == 30 ]] || refuse "config: the waiting period is 30 days, KMS's longest"
[[ "$provisioner_role" =~ ^[A-Za-z0-9+=,.@_-]{1,64}$ && "$offboarder_role" =~ ^[A-Za-z0-9+=,.@_-]{1,64}$ ]] || refuse "config: role names"
[[ "$(jq -r '.env' <<<"$static_tags")" == "$env" ]] || refuse "config: the env tag is not $env"
jq -e '.key_policy.Statement | type == "array" and length > 0' "$config" >/dev/null || refuse "config: no key policy"

alias="${alias_prefix}${company}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The policy for this company: the template with its two ids filled in. The ids hold no brace, so a
# value cannot add or remove a place.
policy="$(jq -c --arg t "$tenant" --arg c "$company" \
  '.key_policy | walk(if type == "string" then gsub("\\{tenant\\}"; $t) | gsub("\\{company\\}"; $c) else . end)' "$config")"
if [[ "$policy" == *"{tenant}"* || "$policy" == *"{company}"* ]]; then die "the key policy still has a placeholder"; fi

kms() { aws kms "$@" --region "$region" --output json; }

# Compares two policies as KMS may store them: single-element lists unwrapped, lists in any order.
canon='walk(if type == "array" then (sort_by(tojson) | if length == 1 then .[0] else . end) else . end)'
same_policy() { [[ "$(jq -S "$canon" <<<"$1")" == "$(jq -S "$canon" <<<"$2")" ]]; }

# ---- who is calling
caller="$(aws sts get-caller-identity --region "$region" --output json)"
actual="$(jq -r .Account <<<"$caller")"
[[ "$actual" == "$account" ]] || die "credentials are for account $actual, not $account"
caller_arn="$(jq -r .Arn <<<"$caller")"
as_role() {
  [[ "$caller_arn" == "arn:aws:sts::$account:assumed-role/$1/"* ]] ||
    die "$cmd runs as the role $1, not as $caller_arn (assume it first: tofu output provisioner_role_arn, offboarder_role_arn)"
}

# ---- the company's key, found by its alias
key_json=""
lookup() { # 0 when the alias exists, 1 when it does not; anything else stops
  local err="$tmp/err"
  if key_json="$(kms describe-key --key-id "$alias" 2>"$err")"; then
    return 0
  elif grep -q NotFoundException "$err"; then
    key_json=""
    return 1
  fi
  die "could not look up $alias: $(head -c 300 "$err")"
}
key_id() { jq -er .KeyMetadata.KeyId <<<"$key_json"; }
key_state() { jq -er .KeyMetadata.KeyState <<<"$key_json"; }

wanted_tags() { jq -nS --argjson s "$static_tags" --arg t "$tenant" --arg c "$company" '$s + {tenant: $t, company: $c}'; }
tags_match() {
  local out
  out="$(kms list-resource-tags --key-id "$(key_id)")"
  [[ "$(jq -r .Truncated <<<"$out")" != true ]] &&
    [[ "$(jq -S '[.Tags[] | {(.TagKey): .TagValue}] | add // {}' <<<"$out")" == "$(wanted_tags)" ]]
}
shape_ok() {
  jq -e '.KeyMetadata | .KeyManager == "CUSTOMER" and .KeySpec == "SYMMETRIC_DEFAULT" and .KeyUsage == "ENCRYPT_DECRYPT"
    and .MultiRegion == false and .Origin == "AWS_KMS"' <<<"$key_json" >/dev/null
}
# An alias that points at another company's key, or at a key of another shape, is never touched.
require_ours() {
  shape_ok || die "$alias names a key that is not a single-Region symmetric customer managed key"
  tags_match || die "$alias names a key whose tags are not this environment's, tenant $tenant and company $company; refusing to touch it"
}
policy_current() { same_policy "$(kms get-key-policy --key-id "$(key_id)" --policy-name default | jq -r .Policy)" "$policy"; }
rotation_on() { [[ "$(kms get-key-rotation-status --key-id "$(key_id)" | jq -r .KeyRotationEnabled)" == true ]]; }

# A write: shown, and not made, under --dry-run.
write() {
  if ((dry)); then
    say "dry run: would run: aws kms $*"
  else
    kms "$@" >/dev/null
  fi
}

do_provision() {
  as_role "$provisioner_role"
  if lookup; then
    local state
    state="$(key_state)"
    [[ "$state" == Enabled ]] || die "the key of $alias is $state; an enabled key is needed (a key pending deletion can be cancelled by the offboarding role)"
    require_ours
    policy_current || die "the key of $alias has a different policy from the current one: an administrator runs 'sync' (a serving role changed?)"
    if ! rotation_on; then
      say "key rotation was off; switching it on"
      write enable-key-rotation --key-id "$(key_id)"
    fi
    say "$alias is provisioned: key $(key_id)"
    return 0
  fi

  local tag_args=() k
  while IFS= read -r k; do tag_args+=("TagKey=$k,TagValue=$(wanted_tags | jq -r --arg k "$k" '.[$k]')"); done < <(wanted_tags | jq -r 'keys[]')
  if ((dry)); then
    say "dry run: $alias does not exist. Would create a key tagged ${tag_args[*]}, name it $alias, switch on rotation. Its policy:"
    jq . <<<"$policy"
    return 0
  fi
  local created id
  created="$(kms create-key --description "oryxa-fde $env: files of company $company (tenant $tenant)" \
    --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT --origin AWS_KMS --no-multi-region \
    --policy "$policy" --tags "${tag_args[@]}")"
  id="$(jq -er .KeyMetadata.KeyId <<<"$created")"
  say "created key $id"
  if ! kms create-alias --alias-name "$alias" --target-key-id "$id" >/dev/null; then
    die "key $id was created but could not be named. Do not re-run (that would make a second key). Name it: aws kms create-alias --region $region --alias-name $alias --target-key-id $id"
  fi
  kms enable-key-rotation --key-id "$id" >/dev/null
  lookup || die "$alias was created but cannot be found"
  require_ours
  policy_current || die "the new key's policy differs from the current one"
  rotation_on || die "key rotation is not on for $id"
  say "$alias is provisioned: key $id"
}

do_status() {
  local state="absent" id="" ok=1
  if lookup; then
    id="$(key_id)"
    state="$(key_state)"
    if shape_ok && tags_match; then ok=0; else state="not-this-company"; fi
  fi
  jq -n --arg alias "$alias" --arg tenant "$tenant" --arg company "$company" --arg state "$state" --arg id "$id" \
    '{alias: $alias, tenant: $tenant, company: $company, state: $state, key_id: (if $id == "" then null else $id end)}'
  [[ "$state" == absent ]] && return 3
  if ((ok == 0)) && [[ "$state" == Enabled ]]; then return 0; fi
  return 4
}

do_sync() {
  lookup || die "$alias does not exist; provision it first"
  require_ours
  [[ "$(key_state)" == Enabled ]] || die "the key of $alias is $(key_state)"
  if policy_current; then
    say "$alias already has the current policy"
    return 0
  fi
  write put-key-policy --key-id "$(key_id)" --policy-name default --policy "$policy"
  say "$alias has the current policy"
}

do_offboard() {
  as_role "$offboarder_role"
  ((dry)) || [[ "$confirm" == "$tenant/$company" ]] || refuse "offboarding schedules the end of a company's files: pass --confirm $tenant/$company"
  lookup || die "$alias does not exist; there is no key to retire"
  require_ours
  local state
  state="$(key_state)"
  case "$state" in
    PendingDeletion)
      say "the key of $alias is already scheduled for deletion on $(jq -r '.KeyMetadata.DeletionDate' <<<"$key_json")"
      return 0
      ;;
    Enabled | Disabled) ;;
    *) die "the key of $alias is $state" ;;
  esac
  write schedule-key-deletion --key-id "$(key_id)" --pending-window-in-days "$window"
  say "$alias is scheduled for deletion in $window days. KMS refuses every use of the key from now (S3 may still serve a data key it cached, for a short while) and deletes it, and with it the company's files, versions and backups, when the wait ends. The offboarding role can cancel until then."
}

case "$cmd" in
  provision) do_provision ;;
  status) do_status ;;
  sync) do_sync ;;
  offboard) do_offboard ;;
esac

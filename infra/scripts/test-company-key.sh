#!/usr/bin/env bash
# Runs company-key.sh against test-company-key-fake-aws.py (a stand-in for the AWS CLI that models the KMS calls it
# makes): ids refused before any call, the account and identity guards, a dry run that writes nothing, creation
# and a second run that changes nothing, a key that is another company's, an alias that could not be created,
# status, sync and offboarding. Needs bash, jq and python3 only; no AWS account, no credentials.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/company-key.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

# The fake goes first on PATH under the name aws.
mkdir "$tmp/bin"
printf '#!/usr/bin/env bash\nexec python3 -I "%s" "$@"\n' "$here/test-company-key-fake-aws.py" >"$tmp/bin/aws"
chmod +x "$tmp/bin/aws"
export PATH="$tmp/bin:$PATH"
export FAKE_AWS_STATE="$tmp/state.json" FAKE_AWS_LOG="$tmp/aws.log"

# What `tofu output -json company_keys` holds, with a short policy that has the same two places for ids and
# lists of one element (which KMS may hand back unwrapped). The real policy is pinned by tofu test.
config="$tmp/config.json"
cat >"$config" <<'JSON'
{
  "env": "dev", "account_id": "111122223333", "region": "ap-south-1", "bucket_name": "oryxa-fde-dev-data",
  "alias_prefix": "alias/oryxa-fde-dev/companies/", "deletion_window_days": 30,
  "tags": {"project": "oryxa-fde", "env": "dev", "purpose": "company-data"},
  "provisioner_role": "oryxa-fde-dev-company-key-provisioner", "offboarder_role": "oryxa-fde-dev-company-key-offboarder",
  "key_policy": {"Version": "2012-10-17", "Statement": [
    {"Sid": "Use", "Effect": "Allow", "Principal": {"AWS": ["arn:aws:iam::111122223333:role/oryxa-fde-dev-api"]},
     "Action": ["kms:Decrypt", "kms:GenerateDataKey"], "Resource": ["*"],
     "Condition": {"StringLike": {"kms:EncryptionContext:aws:s3:arn": ["arn:aws:s3:::oryxa-fde-dev-data/{tenant}/{company}/*"]}}},
    {"Sid": "Deny", "Effect": "Deny", "Principal": {"AWS": ["*"]}, "Action": ["kms:ScheduleKeyDeletion"], "Resource": ["*"]}
  ]}
}
JSON

prov=oryxa-fde-dev-company-key-provisioner
offb=oryxa-fde-dev-company-key-offboarder

# run ROLE ARGS...: sets $out, $code and a fresh log slice in $log.
fresh() { rm -f "$FAKE_AWS_STATE" "$FAKE_AWS_LOG"; : >"$FAKE_AWS_LOG"; }
run() {
  local role="$1"
  shift
  : >"$FAKE_AWS_LOG"
  code=0
  out="$(FAKE_AWS_ROLE="$role" "$script" "$@" 2>&1)" || code=$?
  log="$(cat "$FAKE_AWS_LOG")"
}
check() {
  local name="$1"
  shift
  if "$@"; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    echo "---- output (exit $code)"
    echo "$out"
    echo "---- aws calls"
    echo "$log"
    echo "----"
    failures=$((failures + 1))
  fi
}
has() { grep -qF -- "$1" <<<"$out"; }
logged() { grep -qF -- "$1" <<<"$log"; }
no_calls() { [[ -z "$log" ]]; }
no_writes() { ! grep -Eq '^kms (create-key|create-alias|enable-key-rotation|put-key-policy|schedule-key-deletion)' <<<"$log"; }
exits() { [[ $code == "$1" ]]; }
key_count() { if [[ -e "$FAKE_AWS_STATE" ]]; then jq '.keys | length' "$FAKE_AWS_STATE"; else echo 0; fi; }
count_is() { [[ "$(key_count)" == "$1" ]]; }
no_placeholder() { ! grep -qE '\{tenant\}|\{company\}' <<<"$(stored_policy)"; }
pending() { jq -e '.keys | to_entries[0].value.state == "PendingDeletion"' "$FAKE_AWS_STATE" >/dev/null; }
stored_policy() { jq -r '.keys | to_entries[0].value.policy' "$FAKE_AWS_STATE"; }

# --- ids are checked before anything else: no AWS call, exit 2 ------------------------------------------------------
fresh
# shellcheck disable=SC2016 # $(touch x) is meant literally
for bad in 'a/b' 'a b' '..' '*' 'a*' '' "$(printf 'a%.0s' $(seq 1 129))" 'é' '$(touch x)' 'a;b' 'a,b' 'a=b'; do
  run "$prov" provision "$config" org_1 "$bad"
  check "company id [$bad] is refused" exits 2
  check "company id [$bad]: no AWS call" no_calls
  run "$prov" provision "$config" "$bad" cmp_1
  check "tenant id [$bad] is refused" exits 2
done
run "$prov" provision "$config" org_1 $'cmp_1\n'
check "a trailing newline is refused" exits 2
check "a trailing newline: no AWS call" no_calls
fresh
long="$(printf 'a%.0s' $(seq 1 128))"
run "$prov" provision "$config" "$long" "$long"
check "ids of 128 characters are accepted" exits 0
fresh
run "$prov" provision "$config" org_1
check "a missing id is refused" exits 2
check "...with no AWS call" no_calls
run "$prov" frobnicate "$config" org_1 cmp_1
check "an unknown command is refused" exits 2
run "$prov" provision "$tmp/missing.json" org_1 cmp_1
check "a missing config is refused" exits 2
run "$prov" provision "$config" org_1 cmp_1 --extra
check "an unknown flag is refused" exits 2
check "...with no AWS call" no_calls

# --- the config is checked too -----------------------------------------------------------------------------------
fresh
jq '.alias_prefix = "alias/oryxa-fde-dev/other/"' "$config" >"$tmp/bad1.json"
run "$prov" provision "$tmp/bad1.json" org_1 cmp_1
check "an alias prefix outside the fixed one is refused" exits 2
jq '.deletion_window_days = 7' "$config" >"$tmp/bad2.json"
run "$prov" provision "$tmp/bad2.json" org_1 cmp_1
check "a waiting period under 30 days is refused" exits 2
jq '.account_id = "1234"' "$config" >"$tmp/bad3.json"
run "$prov" provision "$tmp/bad3.json" org_1 cmp_1
check "an account id that is not 12 digits is refused" exits 2
check "...none of them made an AWS call" no_calls

# --- the account and identity guards ---------------------------------------------------------------------------------
fresh
FAKE_AWS_ACCOUNT=999999999999 run "$prov" provision "$config" org_1 cmp_1
check "another account is refused" exits 1
check "...naming both accounts" has "credentials are for account 999999999999, not 111122223333"
check "...before any write" no_writes
run "$offb" provision "$config" org_1 cmp_1
check "provisioning as the offboarding role is refused" exits 1
check "...before any write" no_writes
run "$prov" offboard "$config" org_1 cmp_1 --confirm org_1/cmp_1
check "offboarding as the provisioning role is refused" exits 1
check "...before any write" no_writes

# --- a dry run reads and writes nothing ------------------------------------------------------------------------------
fresh
run "$prov" provision "$config" org_1 cmp_1 --dry-run
check "dry run of a new company succeeds" exits 0
check "dry run says it would create the key" has "alias/oryxa-fde-dev/companies/cmp_1 does not exist. Would create a key tagged"
check "dry run shows both tags" has "TagKey=tenant,TagValue=org_1"
check "dry run shows the filled-in policy" has "arn:aws:s3:::oryxa-fde-dev-data/org_1/cmp_1/*"
check "dry run writes nothing" no_writes
check "dry run made no key" count_is 0

# --- provisioning ---------------------------------------------------------------------------------------------------
export FAKE_AWS_NORMALISE=1 # KMS hands the policy back with one-element lists unwrapped
run "$prov" provision "$config" org_1 cmp_1
check "provision succeeds" exits 0
check "provision made one key" count_is 1
check "the key is created with the tenant and company tags" logged "TagKey=tenant,TagValue=org_1"
check "the key carries the company tag" logged "TagKey=company,TagValue=cmp_1"
check "the key is symmetric, single-Region, KMS-made" logged "--key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT --origin AWS_KMS --no-multi-region"
check "the alias is the fixed prefix and the company" logged "create-alias --alias-name alias/oryxa-fde-dev/companies/cmp_1"
check "rotation is switched on" logged "enable-key-rotation"
check "the stored policy has this company's prefix" grep -qF "arn:aws:s3:::oryxa-fde-dev-data/org_1/cmp_1/*" <<<"$(stored_policy)"
check "the stored policy has no placeholder left" no_placeholder
run "$prov" provision "$config" org_1 cmp_1
check "a second run succeeds" exits 0
check "a second run says it is provisioned" has "is provisioned: key"
check "a second run writes nothing, though KMS unwrapped the lists" no_writes
check "a second run made no second key" count_is 1
run "$prov" provision "$config" org_1 cmp_2
check "another company gets its own key" count_is 2
check "...and its own alias" logged "alias/oryxa-fde-dev/companies/cmp_2"

# A policy that changed under the key is reported, not overwritten.
jq '.key_policy.Statement[0].Action = ["kms:Decrypt"]' "$config" >"$tmp/changed.json"
run "$prov" provision "$tmp/changed.json" org_1 cmp_1
check "a changed policy fails the check" exits 1
check "...says how to fix it" has "'sync'"
check "...and writes nothing" no_writes
# Rotation switched off by hand is switched back on (the one thing provision may repair).
jq '(.keys[] | select(.rotation) ) |= (.rotation = false)' "$FAKE_AWS_STATE" >"$tmp/s.json" && cp "$tmp/s.json" "$FAKE_AWS_STATE"
run "$prov" provision "$config" org_1 cmp_1 --dry-run
check "dry run notices rotation off but writes nothing" no_writes
check "...and says what it would do" has "dry run: would run: aws kms enable-key-rotation"
run "$prov" provision "$config" org_1 cmp_1
check "rotation is switched back on" logged "enable-key-rotation"

# An alias that points at another company's key is never touched.
run "$prov" provision "$config" org_9 cmp_1
check "a tenant that does not own the key is refused" exits 1
check "...saying so" has "refusing to touch it"
check "...and writes nothing" no_writes

# The alias cannot be created: the new key is named in the message and no second key is made on a re-run hint.
fresh
FAKE_AWS_FAIL=create-alias run "$prov" provision "$config" org_1 cmp_1
check "a failed alias fails the run" exits 1
check "...and names the key and the command that finishes the job" has "aws kms create-alias --region ap-south-1 --alias-name alias/oryxa-fde-dev/companies/cmp_1 --target-key-id"
check "...with the key left tagged" count_is 1

# A key pending deletion is not provisioned over.
fresh
run "$prov" provision "$config" org_1 cmp_1
run "$offb" offboard "$config" org_1 cmp_1 --confirm org_1/cmp_1
run "$prov" provision "$config" org_1 cmp_1
check "provisioning a company whose key is pending deletion fails" exits 1
check "...saying why" has "is PendingDeletion"

# --- status ---------------------------------------------------------------------------------------------------------
fresh
run "$prov" status "$config" org_1 cmp_1
check "status of a company with no key exits 3" exits 3
check "...and says absent" has '"state": "absent"'
run "$prov" provision "$config" org_1 cmp_1
run "$prov" status "$config" org_1 cmp_1
check "status of a company with a key exits 0" exits 0
check "...and says Enabled" has '"state": "Enabled"'
run "$prov" status "$config" org_2 cmp_1
check "status for another tenant's key exits 4" exits 4
check "...and says not-this-company" has '"state": "not-this-company"'
check "status writes nothing" no_writes

# --- sync -----------------------------------------------------------------------------------------------------------
run admin sync "$tmp/changed.json" org_1 cmp_1 --dry-run
check "sync --dry-run shows the write" has "dry run: would run: aws kms put-key-policy"
check "sync --dry-run writes nothing" no_writes
run admin sync "$tmp/changed.json" org_1 cmp_1
check "sync puts the changed policy" logged "put-key-policy --key-id"
run "$prov" provision "$tmp/changed.json" org_1 cmp_1
check "after sync the new policy is the current one" exits 0
run admin sync "$tmp/changed.json" org_1 cmp_1
check "sync of a current policy does nothing" no_writes
run admin sync "$config" org_1 cmp_7
check "sync of a company with no key fails" exits 1

# --- offboarding ----------------------------------------------------------------------------------------------------
fresh
run "$prov" provision "$config" org_1 cmp_1
run "$offb" offboard "$config" org_1 cmp_1
check "offboarding needs --confirm" exits 2
check "...and does nothing without it" no_writes
run "$offb" offboard "$config" org_1 cmp_1 --confirm org_1/cmp_2
check "a wrong --confirm is refused" exits 2
check "...and does nothing" no_writes
run "$offb" offboard "$config" org_1 cmp_1 --dry-run
check "offboard --dry-run needs no --confirm" exits 0
check "...shows the 30-day schedule" has "dry run: would run: aws kms schedule-key-deletion"
check "...and schedules nothing" no_writes
run "$offb" offboard "$config" org_2 cmp_1 --confirm org_2/cmp_1
check "offboarding another tenant's company key is refused" exits 1
check "...and schedules nothing" no_writes
run "$offb" offboard "$config" org_1 cmp_5 --confirm org_1/cmp_5
check "offboarding a company with no key fails" exits 1
run "$offb" offboard "$config" org_1 cmp_1 --confirm org_1/cmp_1
check "offboarding schedules the deletion" exits 0
check "...for 30 days, the longest wait" logged "schedule-key-deletion --key-id"
check "...with --pending-window-in-days 30" logged "--pending-window-in-days 30"
check "the key is pending deletion" pending
run "$offb" offboard "$config" org_1 cmp_1 --confirm org_1/cmp_1
check "offboarding twice succeeds" exits 0
check "...says it is already scheduled" has "already scheduled for deletion on 2026-12-10"
check "...and schedules nothing again" no_writes
run "$prov" status "$config" org_1 cmp_1
check "a key pending deletion is not an enabled key: status exits 4" exits 4

if ((failures)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all company-key checks passed"

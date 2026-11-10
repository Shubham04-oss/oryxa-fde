#!/usr/bin/env bash
# Tests create-subscriber.sh against a fake `aws` that records its calls: a new subscriber, a replay, an existing
# one (filter refreshed, never recreated), the guards (wrong account, no bus, no queue, no role, bad arguments),
# and that the detail types each worker is subscribed to are the ones its code handles. Needs bash, jq, awk and
# sed only; no credentials, no network.
# The conditions are evaluated by `check` (SC2016), and the variables they read are used there too (SC2034).
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
script="$here/create-subscriber.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
failures=0

# The fake: one line per call in $FAKE_LOG; each answer is what the real command's --query would print.
cat >"$tmp/bin/aws" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
case "$1 $2" in
  "sts get-caller-identity") echo "${FAKE_ACCOUNT:-000000000000}" ;;
  "eventsv2 list-event-buses") echo "${FAKE_BUS:-arn:aws:events:ap-south-1:000000000000:event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde}" ;;
  "sqs get-queue-url") [[ "$*" != *"${FAKE_NO_QUEUE:-@none@}"* ]] || exit 254; echo "https://sqs.example/q" ;;
  "iam get-role") [[ -z "${FAKE_NO_ROLE:-}" ]] || exit 254; echo "arn:aws:iam::000000000000:role/oryxa-fde-dev-eventbus-delivery" ;;
  "eventsv2 list-subscribers") echo "${FAKE_SUBSCRIBER:-None}" ;;
  "eventsv2 create-subscriber") echo "arn:aws:events:ap-south-1:000000000000:subscriber/created" ;;
  "eventsv2 update-subscriber") ;;
  *) echo "unexpected call: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$tmp/bin/aws"

# run_case ENV_ASSIGNMENTS... -- ARGS...: sets $out (stdout), $err (stderr), $code and $log (the calls).
run_case() {
  local envs=()
  while [[ $1 != -- ]]; do envs+=("$1"); shift; done
  shift
  export FAKE_LOG="$tmp/calls.log"
  : >"$FAKE_LOG"
  code=0
  out="$(env "${envs[@]}" PATH="$tmp/bin:$PATH" "$script" "$@" 2>"$tmp/err")" || code=$?
  err="$(cat "$tmp/err")"
  log="$(cat "$FAKE_LOG")"
}

# check NAME CONDITION: the condition is a shell expression, evaluated here, so it sees $out, $err, $code and $log.
check() {
  local name="$1"
  if eval "$2"; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    echo "     code=$code out=$out err=$err"
    failures=$((failures + 1))
  fi
}

called() { grep -q -- "$1" <<<"$log"; }
not_called() { ! grep -q -- "$1" <<<"$log"; }
# The detail types of the filter the last create-subscriber or update-subscriber call sent, sorted, one per line.
filter_types() {
  grep -E 'eventsv2 (create|update)-subscriber' <<<"$log" | head -1 | sed -E 's/.*--filter-configuration ([^ ]+).*/\1/' |
    jq -r '.Filters[0].Pattern | fromjson | ."aws:DetailType"[]' | sort
}

args=(dev 000000000000 ap-south-1)

# ---- a new subscriber for the ingest worker
run_case FAKE_X=1 -- "${args[@]}" context-ingestion
check "creates the ingest subscriber" 'test "$code" = 0 && called "eventsv2 create-subscriber"'
check "named after the environment and consumer" 'called "--name oryxa-fde-dev-context-ingestion "'
check "on the environment's bus" 'called "event-busv2/oryxa-fde-dev/abcdefghij0123456789abcde"'
check "FIFO, with metadata" 'called "--type FIFO" && called "Type=WITH_METADATA"'
check "into the worker's own FIFO queue" 'called '\''"TargetArn":"arn:aws:sqs:ap-south-1:000000000000:oryxa-fde-dev-context-ingestion.fifo"'\'''
check "with the delivery role" 'called '\''"RoleArn":"arn:aws:iam::000000000000:role/oryxa-fde-dev-eventbus-delivery"'\'''
check "grouped and deduplicated by the event's metadata" 'called '\''EventGroupId'\'' && called '\''DeduplicationId'\'''
check "failures go to the -undelivered queue" 'called "Arn=arn:aws:sqs:ap-south-1:000000000000:oryxa-fde-dev-context-ingestion-undelivered"'
check "from now on by default" 'called "--starting-position LATEST" && not_called "POINT_IN_TIME"'
check "filters on exactly the document upload" 'test "$(filter_types)" = "fde.document.uploaded.v1"'
check "prints the subscriber arn" 'test "$out" = "arn:aws:events:ap-south-1:000000000000:subscriber/created"'
check "every call but IAM's (global) names the region" 'test "$(grep -v "^iam " <<<"$log" | grep -vc -- "--region ap-south-1")" = 0'

# ---- replay
run_case FAKE_X=1 -- "${args[@]}" lifecycle --replay
check "replay starts at the horizon" 'called "--starting-position POINT_IN_TIME" && called "PointType=HORIZON"'
check "the lifecycle subscriber has its own name and queue" 'called "--name oryxa-fde-dev-lifecycle " && called "oryxa-fde-dev-lifecycle.fifo"'

# ---- an existing subscriber is refreshed, never recreated
run_case FAKE_SUBSCRIBER=arn:aws:events:ap-south-1:000000000000:subscriber/old -- "${args[@]}" context-ingestion
check "updates the filter of an existing subscriber" 'test "$code" = 0 && called "eventsv2 update-subscriber" && not_called "create-subscriber"'
check "and says which" 'test "$out" = "arn:aws:events:ap-south-1:000000000000:subscriber/old"'
run_case FAKE_SUBSCRIBER=arn:aws:events:ap-south-1:000000000000:subscriber/old -- "${args[@]}" context-ingestion --replay
check "a replay of an existing subscriber is ignored, with a word" 'test "$code" = 0 && not_called "create-subscriber" && grep -q "ignored" <<<"$err"'

# ---- the guards: nothing is created
run_case FAKE_ACCOUNT=111111111111 -- "${args[@]}" context-ingestion
check "refuses another account" 'test "$code" = 1 && not_called "eventsv2" && grep -q "not 000000000000" <<<"$err"'
run_case FAKE_BUS=None -- "${args[@]}" context-ingestion
check "refuses when the bus is missing" 'test "$code" = 1 && not_called "create-subscriber" && grep -q "create-event-bus.sh" <<<"$err"'
run_case FAKE_NO_QUEUE=-undelivered -- "${args[@]}" context-ingestion
check "refuses when a queue is missing" 'test "$code" = 1 && not_called "create-subscriber" && grep -q "apply" <<<"$err"'
run_case FAKE_NO_ROLE=1 -- "${args[@]}" context-ingestion
check "refuses when the delivery role is missing" 'test "$code" = 1 && not_called "create-subscriber"'
run_case FAKE_X=1 -- "${args[@]}" billing
check "refuses an unknown consumer" 'test "$code" = 2 && test -z "$log"'
run_case FAKE_X=1 -- Dev 000000000000 ap-south-1 lifecycle
check "refuses a bad environment name" 'test "$code" = 2 && test -z "$log"'
run_case FAKE_X=1 -- dev 0000 ap-south-1 lifecycle
check "refuses a bad account id" 'test "$code" = 2 && test -z "$log"'
run_case FAKE_X=1 -- dev 000000000000 mumbai lifecycle
check "refuses a bad region" 'test "$code" = 2 && test -z "$log"'
run_case FAKE_X=1 -- "${args[@]}" lifecycle --now
check "refuses an unknown option" 'test "$code" = 2 && test -z "$log"'

# ---- the subscriptions are what the code handles
# The detail types a source file names, before its tests: `Type::DETAIL_TYPE` and `<Type as ..>::DETAIL_TYPE`.
handled() {
  awk '/#\[cfg\(test\)\]/ { exit } { print }' "$1" | grep -o '[A-Z][A-Za-z]*\( as [A-Za-z_:]*>\)\?::DETAIL_TYPE' |
    sed 's/^\([A-Za-z]*\).*/\1/' | sort -u |
    while read -r type; do
      sed -n -E "s/^ *$type => \"([^\"]+)\", ordered by .*/\1/p" "$repo/crates/oryxa-fde-events/src/lib.rs"
    done | sort
}
run_case FAKE_X=1 -- "${args[@]}" context-ingestion
subscribed_ingest="$(filter_types)"
run_case FAKE_X=1 -- "${args[@]}" lifecycle
subscribed_lifecycle="$(filter_types)"
check "the ingest worker is subscribed to what it handles" 'test -n "$subscribed_ingest" && test "$subscribed_ingest" = "$(handled "$repo/crates/oryxa-fde-context/src/ingest.rs")"'
check "the lifecycle worker is subscribed to what it handles" 'test -n "$subscribed_lifecycle" && test "$subscribed_lifecycle" = "$(handled "$repo/crates/oryxa-fde-lifecycle/src/rules.rs")"'

if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"

#!/usr/bin/env bash
# Runs smoke-test.sh against smoke-stub.py on a random loopback port: a full pass of each stage, a failure in the
# middle that cleans up, the skips, a session that rotates mid-run, and the session hand-over checks. Needs bash,
# curl, jq and python3 only; no deployed environment, no credentials.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
smoke="$here/smoke-test.sh"
tmp="$(mktemp -d)"
stub_pid=""
failures=0

stop_stub() {
  if [[ -n $stub_pid ]]; then
    kill "$stub_pid" 2>/dev/null || true
    wait "$stub_pid" 2>/dev/null || true
    stub_pid=""
  fi
}
trap 'stop_stub; rm -rf "$tmp"' EXIT

session="stubsession0123456789abcdef"
(umask 077 && printf '%s\n' "$session" >"$tmp/session")

# start_stub FLAGS: a fresh stub, with its port in $port and its request log in $log.
start_stub() {
  stop_stub
  log="$tmp/stub.log"
  : >"$log"
  python3 -I "$here/smoke-stub.py" "$1" "$log" >"$tmp/stub.out" &
  stub_pid=$!
  for _ in $(seq 1 100); do
    port="$(sed -n 's/^PORT //p' "$tmp/stub.out")"
    [[ -n $port ]] && return 0
    sleep 0.1
  done
  echo "the stub did not start" >&2
  exit 1
}

# run_case FLAGS ARGS...: sets $out and $code. The environment is the person's: a session file and the stub's origin.
run_case() {
  local flags="$1"
  shift
  start_stub "$flags"
  code=0
  out="$(SMOKE_BASE_URL="http://127.0.0.1:$port" SMOKE_SESSION_FILE="${SESSION_FILE:-$tmp/session}" \
    SMOKE_POLL_INTERVAL=0.1 SMOKE_REQUEST_TIMEOUT=5 SMOKE_INGEST_TIMEOUT=2 SMOKE_RUN_TIMEOUT=2 \
    "$smoke" "$@" 2>&1)" || code=$?
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
    echo "---- stub log"
    cat "$log"
    echo "----"
    failures=$((failures + 1))
  fi
}
has() { grep -qF -- "$1" <<<"$out"; }
logged() { grep -qF -- "$1" "$log"; }
not_logged() { ! grep -qF -- "$1" "$log"; }
logged_times() { [[ "$(grep -cxF -- "$1" "$log")" == "$2" ]]; }
exits() { [[ $code == "$1" ]]; }
no_secret() { ! grep -qF -- "$session" <<<"$out" && ! grep -qF stubreissued <<<"$out"; }
no_leak() { ! grep -q '^LEAK' "$log"; }

# --- stage A -------------------------------------------------------------------------------------------------
run_case - a
check "A passes" exits 0
check "A reports a=passed" has "result: a=passed"
check "A removed its task" logged "DELETE /api/v1/companies/cmp_1/projects/prj_1/tasks/tsk_1"
check "A says what it left behind" has "left behind"
check "A never prints the session" no_secret
check "A sends no cookie to /healthz" no_leak
check "A moved the stage" logged "PUT /api/v1/companies/cmp_1/projects/prj_1/stage"

# A failure in the middle stops there, names the step, and still removes the task.
run_case today-missing a b c
check "failure exits non-zero" exits 1
check "failure names the step" has "FAIL [a] Today: the new task is not in /v1/today"
check "failure cleans up" has "cleanup: removed the task"
check "failure removes the task once" logged_times "DELETE /api/v1/companies/cmp_1/projects/prj_1/tasks/tsk_1" 1
check "failure stops before the stage move" not_logged "PUT /api/v1/companies/cmp_1/projects/prj_1/stage"
check "failure reports a=FAILED" has "result: a=FAILED"
check "failure never prints the session" no_secret

# The API reseals the session: the run follows the new cookie, and says the old one is spent.
run_case rotate a
check "a rotating session still passes" exits 0
check "a rotating session is reported" has "the cookie you supplied is spent"
check "a rotating session is never printed" no_secret

# A write from another origin is refused as cross-site, and the message says what to check.
start_stub -
code=0
out="$(SMOKE_BASE_URL="http://localhost:$port" SMOKE_SESSION_FILE="$tmp/session" SMOKE_POLL_INTERVAL=0.1 "$smoke" a 2>&1)" || code=$?
check "a wrong origin fails on csrf" has "csrf: the write was refused as cross-site"
check "a wrong origin exits non-zero" exits 1

# An expired or wrong session is a plain 401 message.
(umask 077 && printf '%s\n' "wrong0123456789wrong0123456789" >"$tmp/bad")
SESSION_FILE="$tmp/bad" run_case - a
check "a bad session fails on /v1/me" has "FAIL [a] who am I (/v1/me): wanted HTTP 200; HTTP 401"
check "a bad session exits 1" exits 1
unset SESSION_FILE

# --- session hand-over ---------------------------------------------------------------------------------------
cp "$tmp/session" "$tmp/loose" && chmod 644 "$tmp/loose"
SESSION_FILE="$tmp/loose" run_case - a
check "a world-readable session file is refused" has "readable by you only"
check "a world-readable session file exits 2" exits 2
check "a world-readable session file is never sent" test ! -s "$log"
unset SESSION_FILE
code=0
out="$(env -u SMOKE_SESSION -u SMOKE_SESSION_FILE SMOKE_BASE_URL=http://127.0.0.1:1 "$smoke" a 2>&1)" || code=$?
check "no session is a clear refusal" has "no session: set SMOKE_SESSION_FILE"
check "no session exits 2" exits 2
code=0
out="$(SMOKE_SESSION="$session" SMOKE_BASE_URL=http://example.com "$smoke" a 2>&1)" || code=$?
check "a cookie never goes over plain http" has "must be https"
check "plain http refusal exits 2" exits 2
check "plain http refusal never prints the session" no_secret
code=0
out="$(SMOKE_SESSION="short" SMOKE_BASE_URL=https://app.example.com "$smoke" a 2>&1)" || code=$?
check "a malformed session is refused" has "does not look like"

# The value may come from the environment instead of a file.
start_stub -
code=0
out="$(SMOKE_SESSION="__Host-fde_session=$session" SMOKE_BASE_URL="http://127.0.0.1:$port" SMOKE_POLL_INTERVAL=0.1 "$smoke" a 2>&1)" || code=$?
check "the session from the environment works, with or without the cookie name" exits 0
check "the session from the environment is never printed" no_secret

# --- stage B -------------------------------------------------------------------------------------------------
run_case - b
check "B skips without SMOKE_WORKERS" has "SKIP [b] workers: not deployed"
check "B skipping exits 0" exits 0
check "B skip is in the result" has "b=skipped"
check "B skip uploads nothing" not_logged "POST /api/v1/companies/cmp_1/documents"

export SMOKE_WORKERS=1
run_case - b
check "B passes" exits 0
check "B reports b=passed" has "b=passed"
check "B found the passage" has "the known passage is found by search"
run_case ingest-stuck b
check "B times out with a plain message" has "still pending after 2s; is the ingest worker running"
check "B timeout exits 1" exits 1
run_case ingest-fails b
check "B reports an ingest failure" has "the document failed (unreadable)"
unset SMOKE_WORKERS

# --- stage C -------------------------------------------------------------------------------------------------
run_case - c
check "C skips without a repository" has "SKIP [c] agent: no sample repository"
check "C skipping exits 0" exits 0
export SMOKE_AGENT_REPO=oryxa-sample/hello
run_case no-agent c
check "C skips when the agent routes are off" has "the agent routes are off"
check "C route-off skip exits 0" exits 0
run_case - c
check "C passes" exits 0
check "C sees events" has "events are arriving"
check "C ends in a result" has "ending in a result"
check "C reports c=passed" has "c=passed"
run_case run-fails c
check "C reports a failed run" has "agent run: it failed (timed_out)"
check "C failure exits 1" exits 1
run_case run-waits c
check "C does not approve" has "waiting for an approval"
check "C cancels a run it stops on" logged "POST /api/v1/companies/cmp_1/projects/prj_1/agent-runs/run_1/cancel"
unset SMOKE_AGENT_REPO

# --- all stages ----------------------------------------------------------------------------------------------
SMOKE_WORKERS=1 SMOKE_AGENT_REPO=oryxa-sample/hello run_case - all
check "all stages pass" exits 0
check "all stages share one company" logged_times "POST /api/v1/companies" 1
check "all stages report" has "result: a=passed b=passed c=passed"
SMOKE_WORKERS=1 run_case - all
check "all with B only: C skips" has "c=skipped"

if ((failures)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all smoke-test checks passed"

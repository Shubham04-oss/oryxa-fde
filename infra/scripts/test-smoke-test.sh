#!/usr/bin/env bash
# Runs smoke-test.sh against smoke-stub.py on a random loopback port: a pass, the failures it must name, a session
# that rotates mid-run, and the session hand-over checks. Needs bash, curl, jq and python3 only; no deployed
# environment, no credentials.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
smoke="$here/smoke-test.sh"
tmp="$(mktemp -d)"
# The script's own temporary files go here, so the test can see they are removed.
mkdir "$tmp/t"
export TMPDIR="$tmp/t"
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
  # Emptied here, not by the child's redirect, so the loop below never reads the previous stub's port.
  : >"$tmp/stub.out"
  python3 -I "$here/smoke-stub.py" "$1" "$log" >>"$tmp/stub.out" &
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
    SMOKE_REQUEST_TIMEOUT=5 "$smoke" "$@" 2>&1)" || code=$?
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
lacks() { ! grep -qF -- "$1" <<<"$out"; }
exits() { [[ $code == "$1" ]]; }
no_secret() { ! grep -qF -- "$session" <<<"$out" && ! grep -qF stubreissued <<<"$out"; }
no_leak() { ! grep -q '^LEAK' "$log"; }
no_temp() { [[ -z "$(ls -A "$TMPDIR")" ]]; }

# --- a pass ---------------------------------------------------------------------------------------------------
run_case -
check "passes" exits 0
check "reports passed" has "result: passed"
check "names the organisation and role" has "signed in to organisation 'Test org' as admin"
check "asks for health, then who is signed in" logged "GET /api/v1/me"
check "never prints the session" no_secret
check "sends no cookie to /healthz" no_leak
check "removes its temporary files" no_temp

# Tracing, and a ~/.curlrc asking for verbose output and a trace, never print the session.
mkdir "$tmp/home"
printf 'verbose\ntrace-ascii = -\n' >"$tmp/home/.curlrc"
start_stub -
code=0
out="$(HOME="$tmp/home" SMOKE_BASE_URL="http://127.0.0.1:$port" SMOKE_SESSION_FILE="$tmp/session" \
  bash -x "$smoke" 2>&1)" || code=$?
check "under bash -x and a verbose ~/.curlrc it still passes" exits 0
check "bash -x and a verbose ~/.curlrc never print the session" no_secret

# --- failures ------------------------------------------------------------------------------------------------
run_case down
check "an API that does not answer fails on health" has "FAIL [health] health (/api/healthz): wanted HTTP 200; HTTP 502 (upstream)"
check "an API that does not answer exits 1" exits 1
check "an API that does not answer reports FAILED" has "result: FAILED"
check "an API that does not answer stops before /v1/me" not_logged "GET /api/v1/me"
check "a failure removes its temporary files" no_temp

run_case no-org
check "a /v1/me without an organisation fails" has "FAIL [me] who am I: the response has no organisation"
check "a /v1/me without an organisation exits 1" exits 1

# An expired or wrong session is a plain 401 message.
(umask 077 && printf '%s\n' "wrong0123456789wrong0123456789" >"$tmp/bad")
SESSION_FILE="$tmp/bad" run_case -
check "a bad session fails on /v1/me" has "FAIL [me] who am I (/v1/me): wanted HTTP 200; HTTP 401"
check "a bad session exits 1" exits 1
check "a bad session is never printed" lacks wrong0123456789wrong0123456789
unset SESSION_FILE

# An interrupt stops the run, cleans up and says so.
start_stub slow
SMOKE_BASE_URL="http://127.0.0.1:$port" SMOKE_SESSION_FILE="$tmp/session" "$smoke" >"$tmp/int.out" 2>&1 &
smoke_pid=$!
for _ in $(seq 1 100); do grep -q "ok   health" "$tmp/int.out" && break; sleep 0.1; done
kill -TERM "$smoke_pid"
code=0
wait "$smoke_pid" || code=$?
out="$(cat "$tmp/int.out")"
check "an interrupt exits 130" exits 130
check "an interrupt is reported" has "result: INTERRUPTED"
check "an interrupt removes its temporary files" no_temp

# The API reseals the session: the run follows the new cookie, and says the old one is spent.
run_case rotate
check "a rotating session still passes" exits 0
check "a rotating session is reported" has "the cookie you supplied is spent"
check "a rotating session is never printed" no_secret

# --- arguments and session hand-over -------------------------------------------------------------------------
run_case - a
check "an argument is refused" has "usage: smoke-test.sh"
check "an argument exits 2" exits 2
cp "$tmp/session" "$tmp/loose" && chmod 644 "$tmp/loose"
SESSION_FILE="$tmp/loose" run_case -
check "a world-readable session file is refused" has "readable by you only"
check "a world-readable session file exits 2" exits 2
check "a world-readable session file is never sent" test ! -s "$log"
unset SESSION_FILE
code=0
out="$(env -u SMOKE_SESSION -u SMOKE_SESSION_FILE SMOKE_BASE_URL=http://127.0.0.1:1 "$smoke" 2>&1)" || code=$?
check "no session is a clear refusal" has "no session: set SMOKE_SESSION_FILE"
check "no session exits 2" exits 2
code=0
out="$(SMOKE_SESSION="$session" SMOKE_BASE_URL=http://example.com "$smoke" 2>&1)" || code=$?
check "a cookie never goes over plain http" has "must be https"
check "plain http refusal exits 2" exits 2
check "plain http refusal never prints the session" no_secret
code=0
out="$(SMOKE_SESSION="short" SMOKE_BASE_URL=https://app.example.com "$smoke" 2>&1)" || code=$?
check "a malformed session is refused" has "does not look like"

# The value may come from the environment instead of a file.
start_stub -
code=0
out="$(SMOKE_SESSION="__Host-fde_session=$session" SMOKE_BASE_URL="http://127.0.0.1:$port" "$smoke" 2>&1)" || code=$?
check "the session from the environment works, with or without the cookie name" exits 0
check "the session from the environment is never printed" no_secret

if ((failures)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all smoke-test checks passed"

#!/usr/bin/env bash
# A scripted check of a deployed environment's public address, going through the web app the way a
# browser does (`/api/*` on the web origin, the session cookie, the CSRF header). Since #298 the API serves
# sign-in only, so it checks health and /v1/me, reads only, and stops at the first failure.
#   SMOKE_BASE_URL=https://<web_hostname> SMOKE_SESSION_FILE=~/.oryxa-smoke-session infra/scripts/smoke-test.sh
# The session cookie (`__Host-fde_session`) comes from the person running this: SMOKE_SESSION_FILE (a file only
# its owner can read) or SMOKE_SESSION (the value). It is never an argument and never printed. infra/README.md
# ("Smoke test") says how to get it and how to retire it.
set -euo pipefail
# Tracing (`bash -x`, or xtrace in SHELLOPTS) would print the cookie as it is read and written: always off.
set +x

usage="usage: smoke-test.sh   (environment: see infra/README.md, Smoke test)"

COOKIE_NAME="__Host-fde_session"
REQ_TIMEOUT="${SMOKE_REQUEST_TIMEOUT:-30}"

STEP="-"
STATUS=""
COOKIE=""
ROTATED=0
WORK=""

say() { printf '%s\n' "$*"; }
fail() {
  printf 'FAIL [%s] %s\n' "$STEP" "$*" >&2
  exit 1
}
ok() { say "  ok   $*"; }

# --- configuration -------------------------------------------------------------------------------------------

[[ $REQ_TIMEOUT =~ ^[0-9]+$ && $REQ_TIMEOUT -gt 0 ]] || { say "SMOKE_REQUEST_TIMEOUT must be whole seconds, not $REQ_TIMEOUT" >&2; exit 2; }
(($# == 0)) || { say "$usage" >&2; exit 2; }

BASE="${SMOKE_BASE_URL:-}"
BASE="${BASE%/}"
[[ -n $BASE ]] || { say "set SMOKE_BASE_URL to the web app's origin, e.g. https://<web_hostname> (the API's WEB_ORIGIN). $usage" >&2; exit 2; }
# An origin only (the paths are this script's), and a cookie must not cross plain http except to this machine.
origin_re='^https?://[][A-Za-z0-9.:-]+$'
local_re='^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$'
[[ $BASE =~ $origin_re ]] || { say "SMOKE_BASE_URL must be an origin (scheme and host, no path or login)" >&2; exit 2; }
if [[ $BASE == http://* && ! $BASE =~ $local_re ]]; then
  say "SMOKE_BASE_URL must be https (plain http is for localhost only)" >&2
  exit 2
fi

read_session() {
  local file="${SMOKE_SESSION_FILE:-}" value=""
  if [[ -n $file ]]; then
    [[ -f $file && -r $file ]] || { say "SMOKE_SESSION_FILE is not a readable file" >&2; exit 2; }
    # Group or others able to read it would let any local user sign in as the test user.
    [[ -z $(find "$file" -maxdepth 0 -perm /077) ]] || { say "SMOKE_SESSION_FILE must be readable by you only (chmod 600)" >&2; exit 2; }
    value="$(tr -d '\r\n ' <"$file")"
  elif [[ -n ${SMOKE_SESSION:-} ]]; then
    value="${SMOKE_SESSION//[$'\r\n ']/}"
    unset SMOKE_SESSION # curl and jq need not inherit it
  else
    say "no session: set SMOKE_SESSION_FILE (or SMOKE_SESSION) to the $COOKIE_NAME cookie of a test user; see infra/README.md, Smoke test" >&2
    exit 2
  fi
  value="${value#"$COOKIE_NAME"=}"
  # The charset of a sealed cookie; also keeps anything that could end a header or a config line out.
  [[ $value =~ ^[A-Za-z0-9._~+/=%*-]{20,4096}$ ]] || { say "the session does not look like a $COOKIE_NAME cookie value (value only, 20 to 4096 characters)" >&2; exit 2; }
  COOKIE="$value"
}

# Strips the cookie value from anything printed, whatever produced it.
redact() {
  local s="$1"
  [[ -n $COOKIE ]] && s="${s//"$COOKIE"/<session>}"
  printf '%s' "$s"
}

# --- requests ------------------------------------------------------------------------------------------------

# curl reads its headers from files in a private directory, never from its command line (`ps` shows that).
write_auth() { printf 'header = "Cookie: %s=%s"\n' "$COOKIE_NAME" "$COOKIE" >"$WORK/auth.cfg"; }

# api PATH: one GET, with the session unless NO_SESSION=1. Sets STATUS (000 when nothing answered) and leaves the
# body in $WORK/body. Never exits.
api() {
  local path="$1"
  # --disable first: a ~/.curlrc must not add verbose, trace or redirect-following to a request with the cookie.
  # Like the web client, the CSRF header goes on every request (common.cfg).
  local args=(--disable --silent --show-error --connect-timeout 10 --max-time "$REQ_TIMEOUT"
    --config "$WORK/common.cfg" -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}')
  [[ ${NO_SESSION:-0} == 1 ]] || args+=(--config "$WORK/auth.cfg")
  : >"$WORK/body"
  local rc=0
  STATUS="$(curl "${args[@]}" "$BASE$path" 2>"$WORK/curl-error")" || rc=$?
  if ((rc != 0)); then
    STATUS=000
    return 0
  fi
  adopt_reissued_cookie
}

# The API reseals the session after a refresh (WorkOS refresh tokens are single use), so the old cookie may be
# spent: carry on with the one it hands back, in memory only. Nothing is written to the person's file.
adopt_reissued_cookie() {
  local line value
  line="$(grep -i "^set-cookie: *$COOKIE_NAME=" "$WORK/headers" | tail -n 1 | tr -d '\r')" || return 0
  value="${line#*=}"
  value="${value%%;*}"
  if [[ $value =~ ^[A-Za-z0-9._~+/=%*-]{20,4096}$ ]] && ! grep -qi 'max-age=0' <<<"$line"; then
    COOKIE="$value"
    ROTATED=1
    write_auth
  fi
}

# Why a response was not the one wanted, in a few plain words and never a body.
why() {
  local code=""
  code="$(jq -r 'if type == "object" and (.error | type) == "string" then .error else empty end' "$WORK/body" 2>/dev/null)" || true
  [[ $code =~ ^[a-z_]{1,64}$ ]] || code=""
  case "$STATUS" in
    000) printf 'no answer: %s' "$(redact "$(head -n 1 "$WORK/curl-error")")" ;;
    401) printf 'HTTP 401: the session was not accepted (expired, from another environment, or signed out); sign in again and copy a fresh cookie' ;;
    *) printf 'HTTP %s%s' "$STATUS" "${code:+ ($code)}" ;;
  esac
}

# expect STATUS WHAT: stops with a plain message unless the last request answered STATUS.
expect() { [[ $STATUS == "$1" ]] || fail "$2: wanted HTTP $1; $(why)"; }

field() { jq -er "$1" "$WORK/body" 2>/dev/null; }

# --- cleanup -------------------------------------------------------------------------------------------------

cleanup() {
  local code=$?
  trap - EXIT
  if ((ROTATED)); then
    say "note: the API refreshed the session during the run, so the cookie you supplied is spent; sign in again for the next run"
  fi
  [[ -n $WORK ]] && rm -rf "$WORK"
  if ((code == 129 || code == 130)); then
    say "result: INTERRUPTED"
  elif ((code != 0)); then
    say "result: FAILED"
  else
    say "result: passed"
  fi
  exit "$code"
}

# --- checks --------------------------------------------------------------------------------------------------

check() {
  STEP=health
  NO_SESSION=1 api /api/healthz
  expect 200 "health (/api/healthz)"
  ok "health"
  STEP=me
  api /api/v1/me
  expect 200 "who am I (/v1/me)"
  local org role
  org="$(field .organisation.name)" || fail "who am I: the response has no organisation"
  role="$(field .role)" || fail "who am I: the response has no role"
  org="$(LC_ALL=C tr -d '[:cntrl:]' <<<"$org")" # a name is shown, so no terminal escapes
  role="$(LC_ALL=C tr -d '[:cntrl:]' <<<"$role")"
  ok "signed in to organisation '$org' as $role"
}

# --- main ----------------------------------------------------------------------------------------------------

read_session
umask 077
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'exit 129' HUP
WORK="$(mktemp -d)"
printf 'header = "X-Oryxa-Request: 1"\nuser-agent = "oryxa-fde-smoke/1"\n' >"$WORK/common.cfg"
write_auth

say "smoke test against $BASE"
check

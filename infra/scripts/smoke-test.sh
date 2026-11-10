#!/usr/bin/env bash
# A scripted pass against a deployed environment's public address, going through the web app the way a
# browser does (`/api/*` on the web origin, the session cookie, the CSRF header and origin on writes).
#   SMOKE_BASE_URL=https://app.<domain> SMOKE_SESSION_FILE=~/.oryxa-smoke-session infra/scripts/smoke-test.sh [a] [b] [c | k | all]
# Stages (default `a`; they run in the order given, and the run stops at the first failure):
#   a  core: health, /v1/me, company, project, task, Today, stage checklist, stage move with a reason
#   b  workers: upload a sample document, wait for ingest, find a passage by search   (needs SMOKE_WORKERS=1)
#   c  agent: a run on a sample repository, events arrive, it finishes                (needs SMOKE_AGENT_REPO)
#   k  company keys: a new company has no key, an operator gives it one while this waits, then an upload
#      is ingested under it. Not in `all`: it waits for a person   (needs SMOKE_COMPANY_KEYS=1 and SMOKE_WORKERS=1)
# The session cookie (`__Host-fde_session`) comes from the person running this: SMOKE_SESSION_FILE (a file only
# its owner can read) or SMOKE_SESSION (the value). It is never an argument and never printed. infra/README.md
# ("Smoke test") says how to get it, what it creates and what it cannot remove.
set -euo pipefail
# Tracing (`bash -x`, or xtrace in SHELLOPTS) would print the cookie as it is read and written: always off.
set +x

usage="usage: smoke-test.sh [a] [b] [c] [k] | all   (environment: see infra/README.md, Smoke test)"

COOKIE_NAME="__Host-fde_session"
REQ_TIMEOUT="${SMOKE_REQUEST_TIMEOUT:-30}"
INGEST_TIMEOUT="${SMOKE_INGEST_TIMEOUT:-180}"
RUN_TIMEOUT="${SMOKE_RUN_TIMEOUT:-900}"
KEY_TIMEOUT="${SMOKE_KEY_TIMEOUT:-300}"
POLL="${SMOKE_POLL_INTERVAL:-3}"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
NAME="oryxa-smoke-$RUN_ID"

STAGE="-"
STATUS=""
COOKIE=""
ROTATED=0
ORG="" COMPANY="" PROJECT="" TASK="" TASK_REMOVED=0 DOC="" RUN="" RUN_ENDED=0
SUMMARY=()
SKIPPED=0
WORK=""

say() { printf '%s\n' "$*"; }
fail() {
  printf 'FAIL [%s] %s\n' "$STAGE" "$*" >&2
  exit 1
}
ok() { say "  ok   $*"; }

# --- configuration -------------------------------------------------------------------------------------------

for v in REQ_TIMEOUT INGEST_TIMEOUT RUN_TIMEOUT KEY_TIMEOUT; do
  [[ ${!v} =~ ^[0-9]+$ && ${!v} -gt 0 ]] || { say "SMOKE_*TIMEOUT must be whole seconds, not ${!v}" >&2; exit 2; }
done
[[ $POLL =~ ^[0-9]+(\.[0-9]+)?$ ]] || { say "SMOKE_POLL_INTERVAL must be a number of seconds" >&2; exit 2; }

BASE="${SMOKE_BASE_URL:-}"
BASE="${BASE%/}"
[[ -n $BASE ]] || { say "set SMOKE_BASE_URL to the web app's origin, e.g. https://app.<domain>. $usage" >&2; exit 2; }
# An origin only: the API compares the Origin header to WEB_ORIGIN byte for byte, and a cookie must not
# cross plain http except to this machine.
origin_re='^https?://[][A-Za-z0-9.:-]+$'
local_re='^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$'
[[ $BASE =~ $origin_re ]] || { say "SMOKE_BASE_URL must be an origin (scheme and host, no path or login)" >&2; exit 2; }
if [[ $BASE == http://* && ! $BASE =~ $local_re ]]; then
  say "SMOKE_BASE_URL must be https (plain http is for localhost only)" >&2
  exit 2
fi

stages=()
for a in "$@"; do
  case "$a" in
    a | b | c | k) stages+=("$a") ;;
    all) stages+=(a b c) ;;
    *) say "$usage" >&2; exit 2 ;;
  esac
done
((${#stages[@]})) || stages=(a)

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

# api METHOD PATH [BODY [CONTENT_TYPE]] [--no-session]
# Sets STATUS (000 when nothing answered) and leaves the body in $WORK/body. Never exits, so cleanup can use it.
api() {
  local method="$1" path="$2" body="${3:-}" type="${4:-application/json}"
  # --disable first: a ~/.curlrc must not add verbose, trace or redirect-following to a request with the cookie.
  local args=(--disable --silent --show-error --connect-timeout 10 --max-time "$REQ_TIMEOUT"
    --config "$WORK/common.cfg" -X "$method" -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}')
  [[ ${NO_SESSION:-0} == 1 ]] || args+=(--config "$WORK/auth.cfg")
  # Like the web client: the CSRF header always, the origin on writes (a browser sends none on a read).
  [[ $method == GET ]] || args+=(-H "Origin: $BASE")
  if [[ -n $body ]]; then
    printf '%s' "$body" >"$WORK/request"
    args+=(-H "Content-Type: $type" --data-binary "@$WORK/request")
  elif [[ $method != GET ]]; then
    args+=(--data-binary '')
  fi
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
    403) if [[ $code == csrf ]]; then
      printf 'HTTP 403 csrf: the write was refused as cross-site; SMOKE_BASE_URL must be exactly the web app origin (the API'"'"'s WEB_ORIGIN)'
    else printf 'HTTP 403%s' "${code:+ ($code)}"; fi ;;
    *) printf 'HTTP %s%s' "$STATUS" "${code:+ ($code)}" ;;
  esac
}

# expect STATUS WHAT: stops with a plain message unless the last request answered STATUS.
expect() { [[ $STATUS == "$1" ]] || fail "$2: wanted HTTP $1; $(why)"; }

field() { jq -er "$1" "$WORK/body" 2>/dev/null; }
# An id from a response goes into later URLs, so it is checked first.
valid_id() { [[ $1 =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; }
id_of() {
  local id
  id="$(field .id)" || fail "$1: the response has no id"
  valid_id "$id" || fail "$1: the response has an id that is not a plain identifier"
  printf '%s' "$id"
}

# --- cleanup -------------------------------------------------------------------------------------------------

cleanup() {
  local code=$?
  trap - EXIT
  # A second interrupt while the API calls below run still removes the cookie file.
  trap '[[ -n $WORK ]] && rm -rf "$WORK"; exit 130' INT TERM HUP
  if [[ -n $WORK && -f $WORK/auth.cfg ]]; then
    if [[ -n $TASK && $TASK_REMOVED == 0 ]]; then
      api DELETE "/api/v1/companies/$COMPANY/projects/$PROJECT/tasks/$TASK"
      if [[ $STATUS == 204 ]]; then say "cleanup: removed the task"; else say "cleanup: could not remove task $TASK ($(why))"; fi
    fi
    if [[ -n $RUN && $RUN_ENDED == 0 ]]; then
      api POST "/api/v1/companies/$COMPANY/projects/$PROJECT/agent-runs/$RUN/cancel"
      if [[ $STATUS == 202 || $STATUS == 409 ]]; then say "cleanup: cancelled agent run $RUN"; else say "cleanup: could not cancel agent run $RUN ($(why))"; fi
    fi
  fi
  if [[ -n $COMPANY ]]; then
    say "left behind (the API cannot delete these): company '$NAME' $COMPANY${PROJECT:+, project $PROJECT}${DOC:+, document $DOC}${RUN:+, agent run $RUN}"
  fi
  if ((ROTATED)); then
    say "note: the API refreshed the session during the run, so the cookie you supplied is spent; sign in again for the next run"
  fi
  [[ -n $WORK ]] && rm -rf "$WORK"
  if ((code == 129 || code == 130)); then SUMMARY+=("$STAGE=INTERRUPTED"); elif ((code != 0)); then SUMMARY+=("$STAGE=FAILED"); fi
  ((${#SUMMARY[@]})) && say "result: ${SUMMARY[*]}"
  exit "$code"
}

# --- stages --------------------------------------------------------------------------------------------------

preflight() {
  STAGE=a
  NO_SESSION=1 api GET /api/healthz
  expect 200 "health (/api/healthz)"
  ok "health"
  api GET /api/v1/me
  expect 200 "who am I (/v1/me)"
  local org role
  org="$(field .organisation.name)" || fail "who am I: the response has no organisation"
  role="$(field .role)" || fail "who am I: the response has no role"
  org="$(LC_ALL=C tr -d '[:cntrl:]' <<<"$org")" # a name is shown, so no terminal escapes
  # The tenant id stage k names in the command it asks the operator to run; checked before it is printed.
  ORG="$(field .organisation.id)" && valid_id "$ORG" || ORG=""
  ok "signed in to organisation '$org' as $role (use a test organisation: the run creates a company in it)"
}

need_company() {
  [[ -n $COMPANY ]] && return 0
  api POST /api/v1/companies "$(jq -cn --arg n "$NAME" '{name: $n, summary: "Created by infra/scripts/smoke-test.sh; safe to ignore"}')"
  expect 201 "create company"
  COMPANY="$(id_of "create company")"
  ok "company $COMPANY ($NAME)"
}

need_project() {
  need_company
  [[ -n $PROJECT ]] && return 0
  api POST "/api/v1/companies/$COMPANY/projects" "$(jq -cn --arg n "$NAME" '{name: $n, summary: "Created by infra/scripts/smoke-test.sh; safe to ignore"}')"
  expect 201 "create project"
  PROJECT="$(id_of "create project")"
  [[ "$(field .stage)" == discover ]] || fail "create project: a new project should start in discover"
  ok "project $PROJECT, in discover"
}

stage_a() {
  STAGE=a
  need_project
  local p="/api/v1/companies/$COMPANY/projects/$PROJECT"
  api POST "$p/tasks" "$(jq -cn --arg t "$NAME task" '{title: $t, status: "todo"}')"
  expect 201 "create task"
  TASK="$(id_of "create task")"
  ok "task $TASK"

  api GET /api/v1/today
  expect 200 "Today (/v1/today)"
  jq -e --arg id "$TASK" '[.items[]? | select(.kind == "task" and .task.id == $id)] | length == 1' "$WORK/body" >/dev/null 2>&1 \
    || fail "Today: the new task is not in /v1/today"
  ok "the task is on Today"

  api GET "$p/stage-checklist"
  expect 200 "stage checklist"
  [[ "$(field .stage)" == discover ]] || fail "stage checklist: should read the discover stage"
  local open
  open="$(field '[.items[] | select(.met | not)] | length')" || fail "stage checklist: the response has no items"
  ok "the discover checklist reads ($open open)"

  if ((open > 0)); then
    api PUT "$p/stage" '{"stage":"scope"}'
    expect 409 "stage move without a reason, with $open items open"
    [[ "$(field .error)" == rejected_checklist_open ]] || fail "stage move without a reason: wanted rejected_checklist_open"
    ok "a move with items open and no reason is refused"
  fi
  api PUT "$p/stage" "$(jq -cn --arg r "$NAME: smoke test, moving on with a reason" '{stage: "scope", reason: $r}')"
  expect 200 "stage move with a reason"
  [[ "$(field .stage)" == scope ]] || fail "stage move: the project did not move to scope"
  api GET "$p/stage-checklist"
  expect 200 "stage checklist after the move"
  [[ "$(field .stage)" == scope ]] || fail "stage checklist: should read the scope stage after the move"
  ok "the project moved to scope with a reason"

  api DELETE "$p/tasks/$TASK"
  expect 204 "remove task"
  TASK_REMOVED=1
  api GET /api/v1/today
  expect 200 "Today after removing the task"
  if jq -e --arg id "$TASK" '[.items[]? | select(.kind == "task" and .task.id == $id)] | length == 0' "$WORK/body" >/dev/null 2>&1; then
    ok "the task is removed"
  else
    fail "Today: the removed task is still listed"
  fi
}

stage_b() {
  STAGE=b
  if [[ ${SMOKE_WORKERS:-0} != 1 ]]; then
    say "SKIP [b] workers: not deployed (set SMOKE_WORKERS=1 once the ingest worker runs)"
    SKIPPED=1
    return 0
  fi
  need_company
  upload_ingest_search
}

# Uploads a sample document to the run's company, waits for the ingest worker, and finds its passage by search.
upload_ingest_search() {
  # One alphanumeric word that exists nowhere else, so a hit is this document and nothing else.
  local marker="smokemarker${RUN_ID//-/}"
  local text
  text="# $NAME"$'\n\n'"This is a sample document made by the smoke test. The passage to find: $marker is the code word of this run."$'\n'
  api POST "/api/v1/companies/$COMPANY/documents?name=$NAME.md" "$text" text/markdown
  expect 201 "upload document"
  DOC="$(id_of "upload document")"
  ok "document $DOC uploaded"

  local deadline=$((SECONDS + INGEST_TIMEOUT)) st
  while :; do
    api GET "/api/v1/companies/$COMPANY/documents/$DOC"
    expect 200 "read document"
    st="$(field .status)" || fail "read document: the response has no status"
    case "$st" in
      ingested) break ;;
      failed) fail "ingest: the document failed ($(field '.failure // "no reason given"' | tr -cd 'a-z_ '))" ;;
      pending) ;;
      *) fail "ingest: unknown status" ;;
    esac
    ((SECONDS < deadline)) || fail "ingest: the document was still pending after ${INGEST_TIMEOUT}s; is the ingest worker running and reading its queue (context-ingestion)?"
    sleep "$POLL"
  done
  field '.chunks > 0' >/dev/null || fail "ingest: the document is ingested with no chunks"
  ok "the document is ingested ($(field .chunks) chunks)"

  deadline=$((SECONDS + 30))
  while :; do
    api GET "/api/v1/companies/$COMPANY/search?q=$marker&limit=5"
    expect 200 "search"
    jq -e --arg d "$DOC" --arg m "$marker" '[.[]? | select(.document == $d and (.text | contains($m)))] | length >= 1' "$WORK/body" >/dev/null 2>&1 && break
    ((SECONDS < deadline)) || fail "search: the known passage was not found in 30s (the document is ingested, so look at the search index and the embedding call)"
    sleep "$POLL"
  done
  ok "the known passage is found by search"
}

stage_c() {
  STAGE=c
  local repo="${SMOKE_AGENT_REPO:-}" base="${SMOKE_AGENT_BASE:-main}"
  if [[ -z $repo ]]; then
    say "SKIP [c] agent: no sample repository (set SMOKE_AGENT_REPO=owner/name, and SMOKE_AGENT_BASE if its branch is not main)"
    SKIPPED=1
    return 0
  fi
  [[ $repo =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ && $base =~ ^[A-Za-z0-9._/-]{1,200}$ ]] \
    || { say "SMOKE_AGENT_REPO must be owner/name and SMOKE_AGENT_BASE a branch name" >&2; exit 2; }
  need_project
  local p="/api/v1/companies/$COMPANY/projects/$PROJECT"
  api GET "$p/agent-runs"
  # Routes that are not mounted answer a bare 404; one with an error code (a missing project) is a failure.
  if [[ $STATUS == 404 ]] && ! field '.error' >/dev/null; then
    say "SKIP [c] agent: the agent routes are off (the API has no SANDBOX_GATEWAY_URL)"
    SKIPPED=1
    return 0
  fi
  expect 200 "list agent runs"

  local body
  body="$(jq -cn --arg t "$NAME: read the README and reply with its first heading. Change nothing; open no pull request." \
    --arg o "${repo%%/*}" --arg n "${repo#*/}" --arg b "$base" '{task: $t, repository: {owner: $o, name: $n, base: $b}}')"
  api POST "$p/agent-runs" "$body"
  if [[ $STATUS == 409 ]]; then fail "start run: the project's agent budget is used up"; fi
  expect 202 "start run"
  RUN="$(id_of "start run")"
  ok "agent run $RUN queued on $repo@$base"

  local deadline=$((SECONDS + RUN_TIMEOUT)) st events=0 seen=0
  while :; do
    api GET "$p/agent-runs/$RUN"
    expect 200 "read run"
    st="$(field .state)" || fail "read run: the response has no state"
    case "$st" in
      finished) RUN_ENDED=1; break ;;
      failed) RUN_ENDED=1; fail "agent run: it failed ($(field '.failure // "no reason given"' | tr -cd 'a-z_ '))" ;;
      waiting_for_approval) fail "agent run: it is waiting for an approval, which the smoke test never gives (the task is read-only; check the approval list)" ;;
      queued | running) ;;
      *) fail "agent run: unknown state" ;;
    esac
    api GET "$p/agent-runs/$RUN/events"
    expect 200 "read run events"
    events="$(field '.events | length')" || fail "read run events: the response has no events list"
    if ((events > 0 && seen == 0)); then
      seen=1
      ok "events are arriving ($events so far, run $st)"
    fi
    ((SECONDS < deadline)) || fail "agent run: still $st after ${RUN_TIMEOUT}s (the sandbox may be busy, or the gateway unreachable; it will be cancelled)"
    sleep "$POLL"
  done
  api GET "$p/agent-runs/$RUN/events"
  expect 200 "read run events"
  field '.events | length > 0' >/dev/null || fail "agent run: it finished without any events"
  [[ "$(field '.events[-1].type')" == result ]] || fail "agent run: its last event is not a result"
  ok "the run finished, with $(field '.events | length') events ending in a result"
}

# Company keys (infra/README.md, "Before require_company_keys is switched on"). A company made by this run has no key until
# an operator provisions one, which this cannot do, so it prints the command and waits, a bounded time. Then an upload
# is written under the company's own key and the ingest worker reads it back under the same key.
stage_k() {
  STAGE=k
  if [[ ${SMOKE_COMPANY_KEYS:-0} != 1 || ${SMOKE_WORKERS:-0} != 1 ]]; then
    say "SKIP [k] company keys: set SMOKE_COMPANY_KEYS=1 (the API has COMPANY_KEY_ALIAS_ARN_PREFIX) and SMOKE_WORKERS=1 (the ingest worker runs)"
    SKIPPED=1
    return 0
  fi
  need_company
  local c="/api/v1/companies/$COMPANY" has
  api GET "$c/key"
  expect 200 "company key check"
  has="$(field '.has_key | tostring')" || fail "company key check: the response has no has_key"
  [[ $has == false ]] || fail "company key check: a company made a moment ago already has a key (is the check answering for the right company?)"
  ok "the new company has no key yet"
  if [[ ${SMOKE_KEYS_REQUIRED:-0} == 1 ]]; then
    api POST "$c/documents?name=$NAME.md" "# $NAME" text/markdown
    expect 409 "upload without a key, with keys required"
    [[ "$(field .error)" == company_key_missing ]] || fail "upload without a key: wanted company_key_missing"
    ok "an upload without a key is refused (company_key_missing)"
  fi
  say "  now, as the provisioning role: infra/scripts/company-key.sh provision <company-keys.json> ${ORG:-<tenant id>} $COMPANY   (waiting up to ${KEY_TIMEOUT}s)"
  local deadline=$((SECONDS + KEY_TIMEOUT))
  until api GET "$c/key" && [[ $STATUS == 200 && "$(field '.has_key | tostring' 2>/dev/null)" == true ]]; do
    [[ $STATUS == 200 ]] || fail "company key check: wanted HTTP 200; $(why)"
    ((SECONDS < deadline)) || fail "company key: still none after ${KEY_TIMEOUT}s (was it provisioned for this tenant and company? the API believes a no for about 5 s)"
    sleep "$POLL"
  done
  ok "the company has a key"
  upload_ingest_search
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

say "smoke test $NAME against $BASE (stages: ${stages[*]})"
preflight
for s in "${stages[@]}"; do
  say "stage $s"
  SKIPPED=0
  "stage_$s"
  if ((SKIPPED)); then SUMMARY+=("$s=skipped"); else SUMMARY+=("$s=passed"); fi
done

#!/usr/bin/env bash
# The gate's real-image checks for pid 1, the clean start and setuid files (ADR 0004, "The gate's tests"; #156, #160),
# on Docker. The `sandbox-image` job in .github/workflows/ci.yml runs them on the product image (linux/amd64):
#   docker build --platform linux/amd64 -t oryxa-sandbox -f sandbox/image/Dockerfile sandbox
#   sandbox/image/test/real-image.sh oryxa-sandbox
# Each container has no network, no mounts and no credentials, and is removed on exit, pass or fail. Docker is a
# stand-in for the Cloudflare runtime: its kernel settings (ptrace scope, capabilities, seccomp) are the host's, so
# the first deployed sandbox runs `oryxa-isolation-check pid1` through the gateway as well (sandbox/image/README.md).
set -euo pipefail

image=${1:?usage: real-image.sh <image>}
prefix=${NAME_PREFIX:-fde-real-image}
fresh="$prefix-$$-init"
old="$prefix-$$-agent-pid1"
noreap="$prefix-$$-sleep-pid1"
cleanup() { docker rm -f "$fresh" "$old" "$noreap" >/dev/null 2>&1 || true; }
trap cleanup EXIT

failed=0
# check <pass|fail> <what> <command...>: the command's exit status must be the one wanted.
check() {
  local want=$1 what=$2 got
  shift 2
  if "$@"; then got=pass; else got=fail; fi
  if [[ $got == "$want" ]]; then
    echo "PASS  $what"
  else
    echo "FAIL  $what (wanted $want, got $got)"
    failed=$((failed + 1))
  fi
}
# start <name> <docker run arguments, the image among them...>
start() { docker run -d --name "$1" --network none --memory 1g --pids-limit 256 "${@:2}" >/dev/null; }
as_agent() { docker exec -u 1001:1001 "$@"; }
as_root() { docker exec -u 0:0 "$@"; }
# What an earlier run can leave behind: a plain child, a detached session with its own child, a stopped process,
# and a leader whose main thread exited alone, so it shows as a zombie while its other thread runs on.
plant() {
  as_agent -d "$1" sh -c 'sleep 600 & setsid sh -c "sleep 600 & exec sleep 600" & sleep 600 & kill -STOP $!; wait'
  as_agent -d "$1" sh -c 'case $(uname -m) in x86_64) n=60 ;; aarch64) n=93 ;; esac
    exec python3 -I -c "import ctypes, sys, threading, time
threading.Thread(target=lambda: [time.sleep(0.05) for _ in iter(int, 1)]).start()
ctypes.CDLL(None).syscall(int(sys.argv[1]), 0)" "$n"'
  sleep 1
}
# Fails when pid 1's status cannot be read, as well as when any of its user ids is the agent's.
pid1_not_agent() {
  local line
  line=$(docker exec "$1" grep '^Uid:' /proc/1/status) || return 1
  echo "      pid 1 ${line//$'\t'/ }"
  [[ " ${line//$'\t'/ } " != *" 1001 "* ]]
}
# Passes only when the scan ran and its zombie check is the one that failed.
zombies_left() {
  local out
  out=$(as_root "$1" oryxa-isolation-check no-agent) || true
  grep -q '^FAIL  no agent zombie waits to be reaped' <<<"$out"
}
# Fails when the search fails, as well as when it finds a file.
no_setid_files() {
  local found
  found=$(as_root "$1" find / -xdev -perm /6000 -type f) || return 1
  [[ -z $found ]] || { sed 's/^/      /' <<<"$found"; return 1; }
}
clean_start() {
  as_root "$1" node --input-type=module -e 'import { startClean } from "/opt/oryxa-harness/dist/clean.js"; await startClean();'
}

echo "== the image as built: pid 1 is tini, running as init"
start "$fresh" "$image"
check pass "pid 1 does not run as agent" pid1_not_agent "$fresh"
check pass "no file is setuid or setgid" no_setid_files "$fresh"
check pass "an agent process can neither attach to pid 1 nor write its memory" as_agent "$fresh" oryxa-isolation-check pid1
plant "$fresh"
check fail "before the clean start, the scan sees what was left running" as_root "$fresh" oryxa-isolation-check no-agent
check pass "the clean start succeeds" clean_start "$fresh"
check pass "after the clean start, no agent process is left, not even a zombie" \
  as_root "$fresh" oryxa-isolation-check no-agent

echo "== control: pid 1 is sleep, as the image was before #160, so nothing reaps"
start "$noreap" --entrypoint sleep "$image" infinity
plant "$noreap"
check pass "the clean start succeeds, since a zombie runs nothing" clean_start "$noreap"
check pass "the processes it killed stay as zombies" zombies_left "$noreap"

echo "== control: pid 1 started as agent, as the image did before #156"
# Pid 1 must be sleep itself: under tini, killing its child as agent would stop the container and fake the refusals.
start "$old" --user 1001:1001 --entrypoint sleep "$image" infinity
check fail "the uid check finds pid 1 running as agent" pid1_not_agent "$old"
check fail "the pid 1 check finds pid 1 running as agent" as_agent "$old" oryxa-isolation-check pid1
check fail "the clean start refuses, since no kill reaches pid 1" clean_start "$old"
check fail "the scan still finds pid 1" as_root "$old" oryxa-isolation-check no-agent
check pass "pid 1 is still running" docker exec "$old" true

echo "{\"failed\": $failed}"
exit $((failed == 0 ? 0 : 1))

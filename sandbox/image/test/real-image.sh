#!/usr/bin/env bash
# The gate's real-image checks for pid 1 and the clean start (ADR 0004, "The gate's tests"; #156), on Docker. The CI
# job that runs them on the product image (linux/amd64) comes in a lead-reviewed PR:
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
cleanup() { docker rm -f "$fresh" "$old" >/dev/null 2>&1 || true; }
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
start() { docker run -d --name "$1" --network none --memory 1g --pids-limit 256 "${@:2}" "$image" >/dev/null; }
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
clean_start() {
  as_root "$1" node --input-type=module -e 'import { startClean } from "/opt/oryxa-harness/dist/clean.js"; await startClean();'
}

echo "== the image as built: pid 1 runs as init"
start "$fresh"
check pass "pid 1 does not run as agent" pid1_not_agent "$fresh"
check pass "an agent process can neither attach to pid 1 nor write its memory" as_agent "$fresh" oryxa-isolation-check pid1
plant "$fresh"
check fail "before the clean start, the scan sees what was left running" as_root "$fresh" oryxa-isolation-check no-agent
check pass "the clean start succeeds" clean_start "$fresh"
check pass "after the clean start, no process with an agent user id is left" \
  as_root "$fresh" oryxa-isolation-check no-agent

echo "== control: pid 1 started as agent, as the image did before #156"
start "$old" --user 1001:1001
check fail "the uid check finds pid 1 running as agent" pid1_not_agent "$old"
check fail "the pid 1 check finds pid 1 running as agent" as_agent "$old" oryxa-isolation-check pid1
check fail "the clean start refuses, since no kill reaches pid 1" clean_start "$old"
check fail "the scan still finds pid 1" as_root "$old" oryxa-isolation-check no-agent

echo "{\"failed\": $failed}"
exit $((failed == 0 ? 0 : 1))

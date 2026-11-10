#!/usr/bin/env bash
# Runs the cases of the spike from a fresh lab and writes the fixtures. All of them take about ten minutes.
#   LAB_DIR=/path/to/scratch ./record.sh [sessions] [sockets] [forged] [egress] [hostile] [bedrock]   (default: all)
# Needs the image (docker build -t fde-123-opencode -f opencode-spike/Dockerfile opencode-spike). Leaves nothing
# running: the lab is removed at the end, pass or fail.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
LAB_DIR="${LAB_DIR:?}"
export LAB_DIR
# The cases stay in $LAB_DIR after the lab is removed, so make-fixtures.mjs can be run again on them.
trap 'KEEP_LOGS=1 "$here/lab.sh" down' EXIT
KEEP_LOGS="${KEEP_CASES:-0}" "$here/lab.sh" down
"$here/lab.sh" up
# The container must have no DNS search domains: the host's would otherwise appear in the sink's log.
if docker exec fde-123-oc grep -q '^search' /etc/resolv.conf; then echo "record.sh: the lab container has DNS search domains" >&2; exit 1; fi
sections=("${@:-sessions sockets forged egress hostile bedrock}")
sections=(${sections[@]})
want() { [[ " ${sections[*]} " == *" $1 "* ]]; }
cfg="$here/config"
INT=(--env OPENCODE_CONFIG_DIR=/etc/oryxa-spike/opencode --env OPENCODE_DISABLE_PROJECT_CONFIG=1
  --env OPENCODE_DISABLE_CLAUDE_CODE=1 --env OPENCODE_DISABLE_MODELS_FETCH=1 --env OPENCODE_DISABLE_AUTOUPDATE=1
  --env OPENCODE_DISABLE_FILEWATCHER=1 --env OPENCODE_DISABLE_FREE_MODELS=1 --env OPENCODE_FLAGS=todo
  --env NPM_CONFIG_UPDATE_NOTIFIER=false)
# s: a session under the intended settings. Arguments after the name go to case.sh.
s() { local name="$1" scenario="$2"; shift 2; "$here/case.sh" "$name" --etc-config "$cfg/intended.json" "${INT[@]}" -- --prompt "[scenario:$scenario] go" "$@" --timeout-ms 60000 | tail -1; }

want sessions && {
s s-healthz healthz --answer allow_once
s s-reject again --answer reject_once
s s-always again --answer allow_always
s s-once again --answer allow_once
s s-cancel longshell --answer allow_once --cancel-after-ms 4000
s s-readonly readonly --answer allow_once
# The same session with ripgrep on PATH: grep and glob work and nothing is downloaded.
"$here/case.sh" s-readonly-rg --etc-config "$cfg/intended.json" "${INT[@]}" --env PATH=/opt/rg:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -- --prompt "[scenario:readonly] go" --answer allow_once --timeout-ms 60000 | tail -1
s s-forbidden forbidden --answer allow_once
s s-usage usage-detail --answer allow_once
"$here/case.sh" internal-tools --etc-config "$cfg/intended.json" "${INT[@]}" -- --prompt "[scenario:internal] go" --answer allow_once --timeout-ms 40000 | tail -1
"$here/case.sh" worktree-remove --etc-config "$cfg/intended.json" "${INT[@]}" -- --prompt "[scenario:worktree-remove] go" --answer reject_once --timeout-ms 40000 | tail -1
}
want sockets && {
"$here/case.sh" sockets --etc-config "$cfg/intended.json" "${INT[@]}" --sockets-after 6 -- --prompt "[scenario:slowshell] go" --answer allow_once --timeout-ms 60000 | tail -1
}
want forged && {
"$here/lab.sh" perms 0755
for m in http stdin; do "$here/case.sh" forge-$m-readable --etc-config "$cfg/intended.json" "${INT[@]}" -- --prompt "[scenario:forge-$m] go" --answer first-only --timeout-ms 20000 | tail -1; done
"$here/lab.sh" perms 0711
for m in http stdin; do "$here/case.sh" forge-$m-execonly --etc-config "$cfg/intended.json" "${INT[@]}" -- --prompt "[scenario:forge-$m] go" --answer first-only --timeout-ms 20000 | tail -1; done
}
want egress && "$here/net-matrix.sh" > "$LAB_DIR/net-matrix.out"
want hostile && {
"$here/case.sh" clean --etc-config "$cfg/intended.json" "${INT[@]}" -- --prompt "[scenario:healthz] go" --answer allow_once --timeout-ms 60000 | tail -1
"$here/case.sh" hostile-open --config "$cfg/base.json" --seed "$here/hostile-seed.sh" --env NPM_CONFIG_UPDATE_NOTIFIER=false -- --prompt "[scenario:healthz] go" --answer allow_once --timeout-ms 40000 | tail -1
# The same hostile files, but leaving the stub model in place so the model's requests show what was loaded.
"$here/case.sh" hostile-open-instructions --config "$cfg/base.json" --seed "$here/hostile-seed.sh" --seed "$here/keep-stub-model.sh" --env OPENCODE_DISABLE_MODELS_FETCH=1 --env NPM_CONFIG_UPDATE_NOTIFIER=false -- --prompt "[scenario:healthz] go" --answer allow_once --timeout-ms 40000 | tail -1
"$here/case.sh" hostile-protected --etc-config "$cfg/intended.json" --seed "$here/hostile-seed.sh" "${INT[@]}" -- --prompt "[scenario:healthz] go" --answer allow_once --timeout-ms 60000 | tail -1
# With skills allowed to be offered, does anything from the hostile home or repository surface, and does a fresh home stop it?
"$here/case.sh" hostile-skill-ask --etc-config "$cfg/intended-skill-ask.json" --seed "$here/hostile-seed.sh" "${INT[@]}" -- --prompt "[scenario:healthz] go" --answer allow_once --timeout-ms 60000 | tail -1
"$here/case.sh" hostile-skill-ask-fresh-home --etc-config "$cfg/intended-skill-ask.json" --seed "$here/hostile-seed.sh" "${INT[@]}" \
  --env HOME=/tmp/fde-run-1 --env XDG_DATA_HOME=/tmp/fde-run-1/data --env XDG_STATE_HOME=/tmp/fde-run-1/state \
  --env XDG_CACHE_HOME=/tmp/fde-run-1/cache --env XDG_CONFIG_HOME=/tmp/fde-run-1/config --env TMPDIR=/tmp/fde-run-1 \
  -- --prompt "[scenario:healthz] go" --answer allow_once --timeout-ms 60000 | tail -1
"$here/case.sh" home-auth --etc-config "$cfg/intended.json" --seed "$here/home-auth-seed.sh" "${INT[@]}" -- --prompt "[scenario:hello] go" --answer allow_once --timeout-ms 40000 | tail -1
"$here/case.sh" home-fresh --etc-config "$cfg/intended.json" --seed "$here/home-auth-seed.sh" "${INT[@]}" \
  --env HOME=/tmp/fde-run-1 --env XDG_DATA_HOME=/tmp/fde-run-1/data --env XDG_STATE_HOME=/tmp/fde-run-1/state \
  --env XDG_CACHE_HOME=/tmp/fde-run-1/cache --env XDG_CONFIG_HOME=/tmp/fde-run-1/config --env TMPDIR=/tmp/fde-run-1 \
  -- --prompt "[scenario:hello] go" --answer allow_once --timeout-ms 40000 | tail -1
# What the process reads from the home directory (needs a readable binary so strace can decode paths).
"$here/lab.sh" perms 0755
"$here/case.sh" strace-hostile --etc-config "$cfg/intended.json" --seed "$here/hostile-seed.sh" "${INT[@]}" -- --prompt "[scenario:hello] go" \
  --answer allow_once --timeout-ms 60000 --cmd strace --cmd-arg -f --cmd-arg -qq --cmd-arg -e \
  --cmd-arg trace=openat,statx,newfstatat,readlink,access --cmd-arg -o --cmd-arg /scratch/cases/strace-hostile/strace.txt \
  --cmd-arg opencode --cmd-arg acp | tail -1
"$here/lab.sh" perms 0711
}
want bedrock && {
# Q8: Bedrock on the wire, with placeholder credentials only.
B=(--etc-config "$cfg/bedrock.json" "${INT[@]}" --env AWS_REGION=us-east-1)
"$here/case.sh" bedrock-keys "${B[@]}" --env AWS_ACCESS_KEY_ID=placeholder-access-key-id --env AWS_SECRET_ACCESS_KEY=placeholder-secret-access-key -- --prompt "[scenario:hello] go" --answer allow_once --timeout-ms 40000 | tail -1
"$here/case.sh" bedrock-token "${B[@]}" --env AWS_ACCESS_KEY_ID=placeholder-access-key-id --env AWS_SECRET_ACCESS_KEY=placeholder-secret-access-key --env AWS_SESSION_TOKEN=placeholder-session-token -- --prompt "[scenario:hello] go" --answer allow_once --timeout-ms 40000 | tail -1
"$here/case.sh" bedrock-bearer "${B[@]}" --env AWS_BEARER_TOKEN_BEDROCK=placeholder-bearer-not-real -- --prompt "[scenario:hello] go" --answer allow_once --timeout-ms 40000 | tail -1
"$here/case.sh" bedrock-nocreds "${B[@]}" -- --prompt "[scenario:hello] go" --answer allow_once --timeout-ms 40000 | tail -1
"$here/case.sh" bedrock-host --etc-config "$cfg/bedrock-real-host.json" "${INT[@]}" --env AWS_REGION=us-east-1 --env AWS_ACCESS_KEY_ID=placeholder-access-key-id --env AWS_SECRET_ACCESS_KEY=placeholder-secret-access-key -- --prompt "[scenario:hello] go" --answer allow_once --timeout-ms 15000 | tail -1
}
ONLY="$(IFS=,; echo "${sections[*]}")" node "$here/make-fixtures.mjs"

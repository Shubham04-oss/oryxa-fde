#!/usr/bin/env bash
# Runs one ACP session in the lab from a clean state and keeps what it produced under $LAB_DIR/cases/<name>/:
# the ACP frames, the sink's DNS/HTTP/TLS log, the stub model's request log, the packet capture, and the sockets
# listening while it ran. The agent's home is wiped first, so a case starts from nothing unless it seeds something.
#   LAB_DIR=... ./case.sh <name> [--env K=V]... [--config <file>] [--seed <script>] [--sockets-after <s>]
#                         [--no-repo] -- <acp-client.mjs args>
# --etc-config installs a file as /etc/oryxa-spike/opencode/opencode.json (root-owned, for OPENCODE_CONFIG_DIR).
# --keep-home leaves /home/agent as the previous case left it. --config installs the file as the global config (~/.config/opencode/opencode.json); --seed is a shell script run
# as the agent after the wipe and before the sample repo is written (used to plant a hostile home or repository).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
LAB_DIR="${LAB_DIR:?}"
name="$1"; shift
envs=(); etc_config=""; config=""; seeds=(); sockets_after=""; repo=1; keep_home=0
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --env) envs+=(-e "$2"); shift 2 ;;
    --config) config="$2"; shift 2 ;;
    --etc-config) etc_config="$2"; shift 2 ;;
    --seed) seeds+=("$2"); shift 2 ;;
    --sockets-after) sockets_after="$2"; shift 2 ;;
    --no-repo) repo=0; shift ;;
    --keep-home) keep_home=1; shift ;;
    *) echo "unknown $1" >&2; exit 2 ;;
  esac
done
shift || true
oc() { docker exec -i "${envs[@]}" fde-123-oc "$@"; }
plain() { docker exec -i fde-123-oc "$@"; }
out="$LAB_DIR/cases/$name"
"$here/lab.sh" reload
"$here/lab.sh" clearlogs
[ "$keep_home" = 1 ] || plain sh -c 'rm -rf /home/agent/.[!.]* /home/agent/* 2>/dev/null; true'
plain sh -c 'rm -rf /tmp/fde-run-* /scratch/forge-*.txt /workspace/* /workspace/.[!.]* /scratch/work 2>/dev/null; mkdir -p /scratch/work; true'
[ -z "$config" ] || [ "$keep_home" = 1 ] || { plain sh -c 'mkdir -p ~/.config/opencode && cat > ~/.config/opencode/opencode.json' < "$config"; }
# A root-owned config directory, as the gateway would write it; the agent can read but not change it.
[ -z "$etc_config" ] || docker exec -i -u root fde-123-oc sh -c 'mkdir -p /etc/oryxa-spike/opencode && cat > /etc/oryxa-spike/opencode/opencode.json && chmod -R go-w /etc/oryxa-spike' < "$etc_config"
[ "$repo" = 0 ] || plain /spike/sample-repo.sh
for seed in "${seeds[@]}"; do plain sh -s < "$seed"; done
if [ -n "$sockets_after" ]; then
  ( sleep "$sockets_after"; "$here/lab.sh" sockets > "$LAB_DIR/sockets.$name.txt" 2>&1
    plain sh -c 'ss -tulnp 2>/dev/null; true' >> "$LAB_DIR/sockets.$name.txt"
    # Can a peer on the network reach the listener? Probe it from the stub-model container.
    port="$(awk '$1=="tcp" && $2=="LISTEN" && $5 ~ /^127\.0\.0\.1:/ {split($5,a,":"); print a[2]; exit}' "$LAB_DIR/sockets.$name.txt")"
    [ -z "$port" ] || echo "probe from fde-123-model to 10.123.0.10:$port -> $(docker exec fde-123-model node -e "fetch('http://10.123.0.10:$port/').then(r=>console.log('HTTP '+r.status),e=>console.log(String(e.cause?.code||e)))")" >> "$LAB_DIR/sockets.$name.txt" ) &
fi
plain rm -rf "/scratch/cases/$name"; plain mkdir -p "/scratch/cases/$name"
set +e
oc sh -c 'cd /workspace/repo 2>/dev/null || cd /workspace; exec node /spike/acp-client.mjs "$@"' sh "$@" --out "/scratch/cases/$name/frames.jsonl"
status=$?
set -e
wait
sleep 1
plain sh -c "cp /scratch/forge-*.txt /scratch/cases/$name/ 2>/dev/null; ls /workspace /scratch 2>/dev/null | grep -E '^PWNED|^REDIRECTED' > /scratch/cases/$name/markers.txt; ls /workspace/repo | grep -E '^(REDIRECTED|PWNED)' >> /scratch/cases/$name/markers.txt; true"
for f in sink.jsonl model.jsonl packets.txt; do plain cp "/scratch/logs/$f" "/scratch/cases/$name/$f"; done
[ -f "$LAB_DIR/sockets.$name.txt" ] && plain cp "/scratch/sockets.$name.txt" "/scratch/cases/$name/sockets.txt" 2>/dev/null || true
echo "case $name: client exit $status"

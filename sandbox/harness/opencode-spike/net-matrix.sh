#!/usr/bin/env bash
# Question 5: which hosts does OpenCode try to reach, and which setting stops each? Every case runs one ACP session
# in the lab (no route out; the sink answers every name and logs it) and prints the hosts the sink saw.
#   LAB_DIR=... ./net-matrix.sh > net-matrix.out
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
LAB_DIR="${LAB_DIR:?}"
cfg="$here/config"
intended_env=(--env OPENCODE_CONFIG_DIR=/etc/oryxa-spike/opencode --env OPENCODE_DISABLE_PROJECT_CONFIG=1
  --env OPENCODE_DISABLE_CLAUDE_CODE=1 --env OPENCODE_DISABLE_MODELS_FETCH=1 --env OPENCODE_DISABLE_AUTOUPDATE=1
  --env OPENCODE_DISABLE_FILEWATCHER=1 --env OPENCODE_DISABLE_FREE_MODELS=1 --env OPENCODE_FLAGS=todo
  --env NPM_CONFIG_UPDATE_NOTIFIER=false)
variant() { # name jq-filter-on-intended-config
  jq "$2" "$cfg/intended.json" > "$LAB_DIR/cfg-$1.json"
}
hosts() { jq -r 'select(.kind=="dns" and .qtype==1 or .kind=="tls" or .kind=="http")|(.name // .sni // .host)' "$LAB_DIR/cases/$1/sink.jsonl" | sort | uniq -c | sed 's/^ */    /'; }
show() { echo "== $1: $2"; local out; out="$(hosts "$1")"; if [ -z "$out" ]; then echo "    (no host reached the sink)"; else echo "$out"; fi; }
run() { # name description etc-config scenario [case args...]
  local name="$1" desc="$2" etc="$3" scenario="$4"; shift 4
  "$here/case.sh" "$name" --etc-config "$etc" "$@" -- --prompt "[scenario:$scenario] go" --answer allow_once --timeout-ms 60000 >/dev/null
  show "$name" "$desc"
}

# 1. Defaults: global config only, nothing disabled.
"$here/case.sh" default --config "$cfg/base.json" -- --prompt "[scenario:hello] go" --answer allow_once >/dev/null
show default "global config only, no switches"
"$here/case.sh" models-fetch-off --config "$cfg/base.json" --env OPENCODE_DISABLE_MODELS_FETCH=1 -- --prompt "[scenario:hello] go" --answer allow_once >/dev/null
show models-fetch-off "OPENCODE_DISABLE_MODELS_FETCH=1"
# 2. Each unwanted feature switched on in the (root-owned) config, then the intended config again.
variant websearch-on '.websearch={"provider":"random"} | .permission.websearch="allow" | .permission.webfetch="allow"'
run websearch-on "websearch and webfetch allowed" "$LAB_DIR/cfg-websearch-on.json" forbidden "${intended_env[@]}"
variant share-auto '.share="auto"'
run share-auto 'share: "auto"' "$LAB_DIR/cfg-share-auto.json" healthz "${intended_env[@]}"
variant plugin-npm '.plugin=["spike-plugin-example@1.0.0"]'
run plugin-npm 'plugin: ["spike-plugin-example@1.0.0"]' "$LAB_DIR/cfg-plugin-npm.json" hello "${intended_env[@]}"
variant mcp-remote '.mcp={"spike":{"type":"remote","url":"https://mcp.spike.example/mcp"}}'
run mcp-remote 'mcp: remote server' "$LAB_DIR/cfg-mcp-remote.json" hello "${intended_env[@]}"
variant mcp-local '.mcp={"spike":{"type":"local","command":["node","-e","require(\"node:dns\").lookup(\"mcp-local.spike.example\",()=>{});setTimeout(()=>{},9000)"]}}'
run mcp-local 'mcp: local server (a process OpenCode starts)' "$LAB_DIR/cfg-mcp-local.json" hello "${intended_env[@]}"
run otel 'OTEL_EXPORTER_OTLP_ENDPOINT set' "$cfg/intended.json" hello "${intended_env[@]}" --env OTEL_EXPORTER_OTLP_ENDPOINT=http://otel.spike.example:4318 --env OTEL_TRACES_EXPORTER=otlp
run intended 'the intended settings' "$cfg/intended.json" healthz "${intended_env[@]}"

#!/bin/sh
# For the run without protections: keep the stub model reachable, so the stub's request log shows which hostile files
# OpenCode loaded. The repository's own model, provider, npm plugin and remote MCP entries come out (a plugin that
# cannot be installed makes session/new fail), and the stub's provider is merged into the hostile home config.
set -eu
cd /workspace/repo
jq 'del(.model, .small_model, .provider, .plugin, .mcp)' opencode.json > opencode.json.new && mv opencode.json.new opencode.json
jq -s '.[1] * .[0]' ~/.config/opencode/opencode.json /spike/config/base.json > /tmp/home-config.new
mv /tmp/home-config.new ~/.config/opencode/opencode.json

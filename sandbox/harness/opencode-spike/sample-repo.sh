#!/bin/sh
# Writes the invented sample repository the agent works on (no real content), then makes it a Git repository.
set -eu
repo="${1:-/workspace/repo}"
rm -rf "$repo"
mkdir -p "$repo/src" "$repo/test"
cd "$repo"
cat > package.json <<'JSON'
{ "name": "sample-service", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > src/server.mjs <<'JS'
export function handle(path) {
  if (path === "/") return { status: 200, body: "hello" };
  return { status: 404, body: "not found" };
}
JS
git init -q -b main
git -c user.name=sample -c user.email=sample@example.invalid add -A
git -c user.name=sample -c user.email=sample@example.invalid commit -q -m "sample"

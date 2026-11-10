#!/usr/bin/env bash
# Prints rust=true or rust=false: may the Rust jobs (lint, test, platform-base, deny) skip this change?
# Usage: rust-changed.sh        diffs HEAD^1..HEAD (on a PR, HEAD is the merge commit)
#        rust-changed.sh -      reads the changed paths from stdin (used by test-rust-changed.sh)
# Fails closed: any path not on the skip list, an empty list or any error prints rust=true.
set -uo pipefail

# Paths that may skip the Rust jobs. Any file Rust code reads from outside crates/ (include_str!, fs reads,
# build.rs) must stay off this list; see docs/ci.md for the ones found today.
SKIP='^(docs/|fde-web/|realtime/|sandbox/gateway/|sandbox/image/|sandbox/harness/(src/|README\.md$|package(-lock)?\.json$|tsconfig[^/]*\.json$)|infra/(envs|modules|docker|scripts)/|infra/README\.md$|README\.md$|LICENSE$|CLAUDE\.md$)'

if [ "${1:-}" = - ]; then
  files=$(cat) || { echo rust=true; exit 0; }
else
  # --no-renames: a rename lists both the old and the new path, so moving a file out of crates/ still counts.
  files=$(git diff --no-renames --name-only HEAD^1 HEAD) || { echo rust=true; exit 0; }
fi
[ -n "$files" ] || { echo rust=true; exit 0; }

# The paths that force the Rust jobs go to stderr, so the log shows why; stdout stays the one result line.
grep -Ev "$SKIP" <<<"$files" >&2
case $? in
  1) echo rust=false ;; # every path is on the skip list
  *) echo rust=true ;;
esac

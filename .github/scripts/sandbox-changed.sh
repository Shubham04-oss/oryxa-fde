#!/usr/bin/env bash
# Prints sandbox=true or sandbox=false: must the sandbox-image job (build the image, run the real-image checks) run?
# Usage: sandbox-changed.sh        diffs HEAD^1..HEAD (on a PR, HEAD is the merge commit)
#        sandbox-changed.sh -      reads the changed paths from stdin (used by test-sandbox-changed.sh)
# The sibling of rust-changed.sh, with the opposite shape: that one is an allowlist of paths that may skip, this one
# an allowlist of paths that run the job (the whole docker build context, and the workflow and scripts that build it).
# Fails closed: an empty list or any error prints sandbox=true.
set -uo pipefail

# sandbox/ is the build context of sandbox/image/Dockerfile (the gateway's wrangler.jsonc builds it the same way).
RUN='^(sandbox/|\.github/workflows/ci\.yml$|\.github/scripts/)'

if [ "${1:-}" = - ]; then
  files=$(cat) || { echo sandbox=true; exit 0; }
else
  # --no-renames: a rename lists both the old and the new path, so moving a file out of sandbox/ still counts.
  files=$(git diff --no-renames --name-only HEAD^1 HEAD) || { echo sandbox=true; exit 0; }
fi
[ -n "$files" ] || { echo sandbox=true; exit 0; }

# grep writes into a variable, never to stderr, so a failed write to stderr cannot change its exit status.
matching=$(grep -E "$RUN" <<<"$files")
case $? in
  1) echo sandbox=false ;; # no changed path is in the build context or is the workflow or its scripts
  *)
    # The paths that run the job go to stderr, so the log shows why; stdout stays the one result line.
    printf '%s\n' "$matching" >&2 || true
    echo sandbox=true
    ;;
esac

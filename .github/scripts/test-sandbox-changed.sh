#!/usr/bin/env bash
# Tests sandbox-changed.sh without building anything. Run by the `infra` job and by hand: bash .github/scripts/test-sandbox-changed.sh
set -uo pipefail
script="$(cd "$(dirname "$0")" && pwd)/sandbox-changed.sh"
fail=0

# expect <true|false> <name> <path>...  : the paths are one change list
expect() {
  local want=$1 name=$2 got
  shift 2
  got=$(printf '%s\n' "$@" | bash "$script" - 2>/dev/null)
  if [ "$got" = "sandbox=$want" ]; then echo "ok   $name -> $got"; else echo "FAIL $name -> $got (want sandbox=$want)"; fail=1; fi
}

# Runs the job: the build context (all of sandbox/), the workflow and its scripts.
expect true "Dockerfile" sandbox/image/Dockerfile
expect true "real-image.sh" sandbox/image/test/real-image.sh
expect true "harness source (built into the image)" sandbox/harness/src/clean.ts
expect true "harness lockfile" sandbox/harness/package-lock.json
expect true "gateway (in the build context)" sandbox/gateway/src/index.ts
expect true "the workflow" .github/workflows/ci.yml
expect true "a filter script" .github/scripts/sandbox-changed.sh
expect true "the Rust filter script" .github/scripts/rust-changed.sh
expect true "one sandbox path among skippable ones" docs/ci.md fde-web/package.json sandbox/image/README.md
expect true "sandbox path among Rust ones" crates/oryxa-fde-api/src/lib.rs sandbox/harness/src/main.ts
expect true "empty list (fail closed)"

# Skips: nothing the job builds or runs changed.
expect false "docs only" docs/ci.md
expect false "web only" fde-web/src/routes/index.tsx
expect false "Rust crates only" crates/oryxa-fde-api/src/lib.rs vendor/oryxa-platform/LICENSE
expect false "infra and root files" infra/modules/vpc/main.tf README.md CLAUDE.md Cargo.lock
expect false "another workflow" .github/workflows/deploy-api.yml
expect false "realtime Worker" realtime/src/index.ts
# Anchored at the repo root, and whole names: lookalikes do not run the job.
expect false "sandbox in a crate" crates/oryxa-fde-agent/sandbox/x.txt
expect false "sandbox-like top-level name" sandbox-extra/x.md
expect false "sandbox as a file, not a directory" sandbox
expect false "workflow named like ci.yml" .github/workflows/ci.yml.bak
expect false "scripts-like dir" .github/scripts-extra/x.sh

# A stderr that cannot be written (full or closed) must not change the answer.
got=$(printf 'docs/a.md\nsandbox/image/Dockerfile\n' | bash "$script" - 2>/dev/full)
if [ "$got" = sandbox=true ]; then echo "ok   stderr /dev/full, sandbox path -> $got"; else echo "FAIL stderr /dev/full, sandbox path -> $got"; fail=1; fi
got=$(printf 'docs/a.md\nsandbox/image/Dockerfile\n' | bash "$script" - 2>&-)
if [ "$got" = sandbox=true ]; then echo "ok   stderr closed, sandbox path -> $got"; else echo "FAIL stderr closed, sandbox path -> $got"; fail=1; fi
got=$(printf 'docs/a.md\n' | bash "$script" - 2>/dev/full)
if [ "$got" = sandbox=false ]; then echo "ok   stderr /dev/full, docs only -> $got"; else echo "FAIL stderr /dev/full, docs only -> $got"; fail=1; fi

# The real diff: a rename out of sandbox/ must list the old path too.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(
  cd "$tmp" && git init -q . && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false
  mkdir -p sandbox/image docs && echo FROM scratch > sandbox/image/Dockerfile && echo a > docs/a.md
  git add -A && git commit -qm base
  git mv sandbox/image/Dockerfile docs/Dockerfile && git commit -qm rename
  got=$(bash "$script" 2>/dev/null)
  if [ "$got" = sandbox=true ]; then echo "ok   rename sandbox/image/Dockerfile -> docs/Dockerfile -> $got"; else echo "FAIL rename out of sandbox/ -> $got"; exit 1; fi
  echo b >> docs/a.md && git commit -qam docs
  got=$(bash "$script" 2>/dev/null)
  if [ "$got" = sandbox=false ]; then echo "ok   docs-only commit via git diff -> $got"; else echo "FAIL docs-only commit via git diff -> $got"; exit 1; fi
) || fail=1

# A diff error (no HEAD^1 here: not a repository) fails closed.
nogit=$(mktemp -d)
got=$(cd "$nogit" && GIT_CEILING_DIRECTORIES=$(dirname "$nogit") bash "$script" 2>/dev/null)
rmdir "$nogit"
if [ "$got" = sandbox=true ]; then echo "ok   diff error -> $got"; else echo "FAIL diff error -> $got"; fail=1; fi

exit $fail

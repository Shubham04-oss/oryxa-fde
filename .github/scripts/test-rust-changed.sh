#!/usr/bin/env bash
# Tests rust-changed.sh without compiling anything. Run by the `infra` job and by hand: bash .github/scripts/test-rust-changed.sh
set -uo pipefail
script="$(cd "$(dirname "$0")" && pwd)/rust-changed.sh"
fail=0

# expect <true|false> <name> <path>...  : the paths are one change list
expect() {
  local want=$1 name=$2 got
  shift 2
  got=$(printf '%s\n' "$@" | bash "$script" - 2>/dev/null)
  if [ "$got" = "rust=$want" ]; then echo "ok   $name -> $got"; else echo "FAIL $name -> $got (want rust=$want)"; fail=1; fi
}

# Skippable: only paths on the skip list.
expect false "docs only" docs/ci.md
expect false "web only" fde-web/src/routes/index.tsx
expect false "docs, web, realtime, README together" docs/plan.md fde-web/package.json realtime/src/index.ts README.md
expect false "harness source" sandbox/harness/src/session.ts sandbox/harness/package-lock.json
expect false "infra modules and scripts" infra/modules/vpc/main.tf infra/envs/dev/main.tf infra/scripts/x.sh

# Runs everything: anything Rust reads from outside crates/ and vendor/, and anything unknown.
expect true "harness fixtures (read by oryxa-fde-agent contract test)" sandbox/harness/test/fixtures/x
expect true "harness fixtures, real name" sandbox/harness/test/fixtures/session.events.jsonl
expect true "bootstrap SQL (read by oryxa-fde-store live test)" infra/sql/01-bootstrap.sql
expect true "SpiceDB schema (include_str! in live tests)" schema/fde.zed
expect true "rustfmt.toml" rustfmt.toml
expect true "rust-toolchain.toml" rust-toolchain.toml
expect true "Cargo.lock" Cargo.lock
expect true "deny.toml" deny.toml
expect true "new unknown top-level file" brand-new-file.txt
expect true "new unknown top-level dir" newdir/a.md
expect true "new .cargo dir" .cargo/config.toml
expect true "workflow" .github/workflows/ci.yml
expect true "crates file" crates/oryxa-fde-api/src/lib.rs
expect true "vendor file" vendor/oryxa-platform/crates/oryxa-core/src/lib.rs
expect true "one Rust path among skippable ones" docs/ci.md fde-web/package.json crates/oryxa-fde-api/openapi.json
expect true "unknown path hidden by a skippable-looking prefix" docs-extra/x.md
# The skip list is anchored at the repo root: a skippable name inside crates/ or vendor/ still runs Rust.
expect true "skippable names nested in crates/" crates/oryxa-fde-api/README.md crates/oryxa-fde-agent/docs/x.md
expect true "skippable names nested in vendor/" vendor/oryxa-platform/LICENSE vendor/oryxa-platform/docs/x.md
# File entries match whole names, not prefixes.
expect true "file named like a skippable file" README.md.bak
expect true "harness file named like package.json" sandbox/harness/package.json.rs
expect true "docs as a file, not a directory" docs
expect true "harness test dir" sandbox/harness/test/session.test.ts
expect true "empty list (fail closed)"

# A stderr that cannot be written (full or closed) must not change the answer.
got=$(printf 'docs/a.md\ncrates/a/x.rs\n' | bash "$script" - 2>/dev/full)
if [ "$got" = rust=true ]; then echo "ok   stderr /dev/full, Rust path -> $got"; else echo "FAIL stderr /dev/full, Rust path -> $got"; fail=1; fi
got=$(printf 'docs/a.md\ncrates/a/x.rs\n' | bash "$script" - 2>&-)
if [ "$got" = rust=true ]; then echo "ok   stderr closed, Rust path -> $got"; else echo "FAIL stderr closed, Rust path -> $got"; fail=1; fi
got=$(printf 'docs/a.md\n' | bash "$script" - 2>/dev/full)
if [ "$got" = rust=false ]; then echo "ok   stderr /dev/full, docs only -> $got"; else echo "FAIL stderr /dev/full, docs only -> $got"; fail=1; fi

# The real diff: a rename out of crates/ must list the old path too.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(
  cd "$tmp" && git init -q . && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false
  mkdir -p crates/a docs && echo 'fn main() {}' > crates/a/x.rs && echo a > docs/a.md
  git add -A && git commit -qm base
  git mv crates/a/x.rs docs/x.rs && git commit -qm rename
  got=$(bash "$script" 2>/dev/null)
  if [ "$got" = rust=true ]; then echo "ok   rename crates/a/x.rs -> docs/x.rs -> $got"; else echo "FAIL rename out of crates/ -> $got"; exit 1; fi
  echo b >> docs/a.md && git commit -qam docs
  got=$(bash "$script" 2>/dev/null)
  if [ "$got" = rust=false ]; then echo "ok   docs-only commit via git diff -> $got"; else echo "FAIL docs-only commit via git diff -> $got"; exit 1; fi
) || fail=1

# A diff error (no HEAD^1 here: not a repository) fails closed.
nogit=$(mktemp -d)
got=$(cd "$nogit" && GIT_CEILING_DIRECTORIES=$(dirname "$nogit") bash "$script" 2>/dev/null)
rmdir "$nogit"
if [ "$got" = rust=true ]; then echo "ok   diff error -> $got"; else echo "FAIL diff error -> $got"; fail=1; fi

exit $fail

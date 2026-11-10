#!/usr/bin/env bash
# Tests rust-reads-check.sh without compiling anything. Run by the `infra` job and by hand: bash .github/scripts/test-rust-reads-check.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
check="$here/rust-reads-check.sh"
fail=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# 1. The scan finds what Rust reads from outside crates/ and vendor/ in this repository today.
found=$(bash "$check" --list "$repo")
for want in schema/fde.zed sandbox/harness/test/fixtures/session.events.jsonl infra/sql/01-bootstrap.sql; do
  if grep -qxF "$want" <<<"$found"; then ok "scan finds $want"; else bad "scan misses $want"; fi
done
if grep -qE '^sandbox/harness/test/fixtures/' <<<"$found"; then ok "scan finds the harness fixtures"; else bad "scan misses the harness fixtures"; fi
if grep -Eq '^(crates|vendor)/' <<<"$found"; then bad "scan lists a path inside crates/ or vendor/"; else ok "scan skips paths inside crates/ and vendor/"; fi

# 2. The real skip list passes.
if bash "$check" "$repo" >/dev/null; then ok "real skip list passes"; else bad "real skip list fails"; fi

# 3. Mutation: put each known path's directory on the skip list in a scratch copy of rust-changed.sh; the check must fail.
for prefix in 'schema/' 'sandbox/harness/test/' 'infra/sql/'; do
  mut="$tmp/mutant.sh"
  sed "s#^SKIP='^(#SKIP='^($prefix|#" "$here/rust-changed.sh" >"$mut"
  if cmp -s "$mut" "$here/rust-changed.sh"; then bad "mutation $prefix did not change the script"; continue; fi
  if out=$(bash "$check" "$repo" "$mut" 2>&1); then out=; fi
  if grep -q "^FAIL" <<<"$out"; then ok "skip list with $prefix is caught"; else bad "skip list with $prefix was NOT caught"; fi
done

# 4. A made-up tree: every way a literal can leave a crate, and the ones that must not count.
t="$tmp/tree"
mkdir -p "$t/crates/a/src" "$t/crates/a/tests" "$t/crates/b/src" "$t/vendor/p/crates/c/src" "$t/vendor/p/schema" "$t/vendor/p/target/x"
touch "$t/crates/a/Cargo.toml" "$t/crates/b/Cargo.toml" "$t/vendor/p/crates/c/Cargo.toml"
cat >"$t/crates/a/tests/t.rs" <<'RS'
const A: &str = include_str!("../../../docs/spec.md");
const B: &[u8] = include_bytes!("../../../fde-web/logo.bin");
RS
cat >"$t/crates/a/src/lib.rs" <<'RS'
fn x() { let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../realtime/c.json"); }
const OK: &str = include_str!("../migrations/1.sql");
RS
cat >"$t/crates/b/src/lib.rs" <<'RS'
mod m { include!("../../../README.md"); }
RS
cat >"$t/vendor/p/crates/c/src/lib.rs" <<'RS'
const S: &str = include_str!("../../../schema/p.zed");
RS
echo 'const T: &str = include_str!("../../../../../outside.txt");' >"$t/vendor/p/target/x/skipped.rs"
got=$(bash "$check" --list "$t" | tr '\n' ' ')
want='README.md docs/spec.md fde-web/logo.bin realtime/c.json '
if [ "$got" = "$want" ]; then ok "made-up tree: found '$got'"; else bad "made-up tree: found '$got', want '$want'"; fi
if bash "$check" "$t" >/dev/null 2>&1; then bad "made-up tree on the skip list passed"; else ok "made-up tree on the skip list fails"; fi

# 5. Fails closed: a missing or broken rust-changed.sh, a missing root.
if bash "$check" "$repo" "$tmp/nope.sh" >/dev/null 2>&1; then bad "missing rust-changed.sh passed"; else ok "missing rust-changed.sh fails"; fi
printf '#!/bin/sh\nexit 3\n' >"$tmp/broken.sh"
if bash "$check" "$repo" "$tmp/broken.sh" >/dev/null 2>&1; then bad "failing rust-changed.sh passed"; else ok "failing rust-changed.sh fails"; fi
if bash "$check" "$tmp/no-such-root" >/dev/null 2>&1; then bad "missing root passed"; else ok "missing root fails"; fi

exit $fail

#!/usr/bin/env bash
# Fails if rust-changed.sh would let a change skip the Rust jobs although Rust code reads that path from outside
# crates/ and vendor/. It scans the Rust sources for string literals with "../" (every include_str!, include_bytes!,
# include! and #[path] that leaves its crate, "../" joined onto CARGO_MANIFEST_DIR, a run-time read from the crate
# directory), resolves each one against both the including file and its crate, and asks rust-changed.sh about each
# result. No compiling.
# Usage: rust-reads-check.sh [--list] [repo-root [rust-changed.sh]]
#   --list   print the paths Rust reads from outside crates/ and vendor/, and stop
# ponytail: finds literals only; a path built at run time (Path::join("..")) is not seen. Review catches that, and
# docs/ci.md says so.
set -uo pipefail

list_only=false
if [ "${1:-}" = --list ]; then
  list_only=true
  shift
fi
root=$(cd "${1:-$(dirname "$0")/../..}" && pwd) || exit 2
filter=${2:-$root/.github/scripts/rust-changed.sh}

# normalize <path>: resolve . and .. lexically; a path that climbs above the root keeps its leading ".."
normalize() {
  local -a out=() parts=()
  local part IFS=/
  # read -a splits without glob expansion, so a literal with * stays as written
  read -r -a parts <<<"$1"
  for part in "${parts[@]}"; do
    case $part in
      '' | .) ;;
      ..) if [ "${#out[@]}" -gt 0 ] && [ "${out[${#out[@]}-1]}" != .. ]; then unset "out[${#out[@]}-1]"; else out+=(..); fi ;;
      *) out+=("$part") ;;
    esac
  done
  echo "${out[*]}"
}

# crate_dir <dir>: the nearest ancestor (inside root) holding a Cargo.toml
crate_dir() {
  local d=$1
  while [ "$d" != . ] && [ "$d" != / ] && [ ! -f "$root/$d/Cargo.toml" ]; do d=$(dirname "$d"); done
  echo "$d"
}

hits=$(cd "$root" && grep -rnoE --include='*.rs' --exclude-dir=target '"[^"]*\.\./[^"]*"' crates vendor 2>/dev/null)
rc=$?
# 0 = matches, 1 = none; anything else is a scan error
if [ "$rc" -gt 1 ]; then
  echo "rust-reads-check: scanning the Rust sources failed (grep exit $rc)" >&2
  exit 2
fi

paths=$(
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file=${hit%%:*}
    rest=${hit#*:}
    lit=${rest#*:}
    lit=${lit#\"}
    lit=${lit%\"}
    dir=$(dirname "$file")
    # include_str! and friends resolve from the including file; CARGO_MANIFEST_DIR joins, build.rs and run-time
    # reads (cargo runs tests in the crate) from the crate. Which one applies can sit on another line, so try both.
    normalize "$dir/$lit"
    normalize "$(crate_dir "$dir")/$lit"
  done <<<"$hits" | grep -Ev '^(crates|vendor|\.\.)(/|$)' | sort -u
)

if $list_only; then
  [ -z "$paths" ] || echo "$paths"
  exit 0
fi
[ -f "$filter" ] || { echo "rust-reads-check: no filter script at $filter" >&2; exit 2; }

status=0
checked=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  checked=$((checked + 1))
  got=$(printf '%s\n' "$path" | bash "$filter" - 2>/dev/null) || got="error"
  if [ "$got" = rust=true ]; then
    echo "ok   $path -> $got"
  else
    echo "FAIL $path is read by Rust but rust-changed.sh answers '$got' (want rust=true); take it off the skip list"
    status=1
  fi
done <<<"$paths"
echo "rust-reads-check: $checked path(s) read from outside crates/ and vendor/"
exit $status

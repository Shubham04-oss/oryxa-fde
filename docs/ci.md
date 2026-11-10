# CI runners and caching

## Runners

Every job runs on GitHub-hosted runners (`runs-on: ubuntu-latest`). There are no self-hosted
runners: the repository may be public, and a self-hosted runner must never run code from a fork PR.
A new job uses `ubuntu-latest`, and no workflow may name a `self-hosted` label.

Every job must clean up after itself: service containers on random host ports, containers named
with the run id and removed in an `if: always()` step.

## Release builds

Release and deploy builds (`deploy-api`'s `build`) use no compile cache, no restored cache and a fresh
`CARGO_HOME`. They compile everything from the registry, so nothing a PR's CI cached can end up in
a release.

## Caching

| What | How |
| --- | --- |
| Rust build output and registry | `Swatinem/rust-cache` with `cache-targets: true`, one entry per job |
| pnpm store (`fde-web`) | `actions/setup-node` with `cache: pnpm` |
| npm (`sandbox/*`) | `actions/setup-node` with `cache: npm` |
| OpenTofu providers | `actions/cache` on `TF_PLUGIN_CACHE_DIR` |
| Docker images | pulled each run |

Rust jobs get the first row from one step after the toolchain:
`- uses: ./.github/actions/rust-cache` with a `shared-key` of the job's own (`lint`, `test`,
`platform-base`). Keep one key per job, so a job has one entry rather than one per crate.

Only `main` saves a cache (`save-if` in the action); a PR run restores main's entry and never writes. That
keeps the repository's 10 GB Actions cache limit for main's few large entries instead of PR churn. The first
run after a `Cargo.lock` or toolchain change on `main` is cold. We do not use sccache in GitHub Actions mode:
it writes one cache entry per compiled object, which filled the limit with thousands of entries and evicted
constantly. `CARGO_INCREMENTAL=0` and debug info off keep entries small.

## Concurrency

Runs share the group `ci-<ref>`. A new push to a pull request cancels that PR's run in progress, because only
the latest commit matters. A push to `main` never cancels the run in progress (`cancel-in-progress` is true for
`pull_request` events only), so each `main` run that starts finishes: its `check` goes green or red on its own
result and `main` writes the caches. A group runs one run and keeps one pending, so a `main` run that is still queued when
a newer push arrives is replaced by the newer one and ends as cancelled. That commit never gets a result of its own,
but the newer run tests a superset of it. We do not key the group by commit for pushes: every `main` push would then run
at once, none dropped, at the cost of a full set of jobs per merge (about 8 minutes of two parallel Rust jobs plus the
web, schema, infra and sandbox jobs) and several runs racing to write the same cache entry. Do that only if a
commit on `main` must have its own result.

## Which jobs run

The `changes` job decides whether a PR can skip the Rust jobs (`lint`, `test`, `platform-base`, `deny`). It is an
allowlist: `.github/scripts/rust-changed.sh` skips only when every changed path is on its skip list, so any new or
unknown path, including a new top-level one, runs everything. The skip list is `docs/`, `fde-web/`, `realtime/`,
`sandbox/gateway/`, `sandbox/image/`, `sandbox/harness/` (`src/`, `README.md`, `package*.json`, `tsconfig*.json`),
`infra/{envs,modules,docker,scripts}/`, `infra/README.md`, `README.md`, `LICENSE` and `CLAUDE.md`. It diffs with
`--no-renames`, so a file moved out of `crates/` lists its old path and runs the Rust jobs.

**A file Rust code reads from outside `crates/` must stay off the skip list.** Today that is
`schema/fde.zed` (`include_str!` in the api and agent live tests), `sandbox/harness/test/fixtures/*` (agent contract
test), `infra/sql/01-bootstrap.sql` (store live test), and `vendor/` (the vendored workspace and its own
`build.rs`/`include_str!`), plus the toolchain and lint config the jobs use: `rustfmt.toml`, `rust-toolchain.toml`,
`Cargo.*`, `deny.toml`. A PR that adds a new `include_str!`, `include_bytes!`, `sqlx::migrate!` or run-time
file read of such a path keeps it off the list, and `test-rust-changed.sh` gets a case for it.

The `infra` job enforces this rule instead of leaving it to review. `.github/scripts/rust-reads-check.sh` scans the Rust
sources under `crates/` and `vendor/` for every string literal with a `../` (`include_str!`, `include_bytes!`,
`include!`, `#[path]`, and `../` joined onto `CARGO_MANIFEST_DIR`), resolves each one against the including file (or the
crate for `CARGO_MANIFEST_DIR`), and fails if `rust-changed.sh` answers `rust=false` for a path outside `crates/` and
`vendor/`. It compiles nothing. `test-rust-reads-check.sh` proves it: it must find the three paths above, it must
fail when each one is added to a scratch copy of the skip list, and it must handle a made-up tree and fail closed
when the filter script is missing or broken. It sees string literals only, so a path built at run time
(`Path::join("..")`) still needs the review rule. `.github/scripts/**` and `.github/actions/**` steer CI as much as
the workflows do, so like them they are hands-off without lead review (`CLAUDE.md`).

The Rust jobs skip on a job-level `if`, never a workflow-level `paths:` filter: GitHub counts a skipped job as passed
for required checks, but a filtered-out workflow leaves them pending. A diff error, an empty diff or a script
error runs everything, and every push to `main` runs everything. A failed write of the log line to stderr cannot
change the answer. `.github/scripts/test-rust-changed.sh` tests the filter against made-up change lists, a real rename
and an unwritable stderr; the `infra` job runs it on every PR.

`check` is the required status check. It stays as a small job over `lint` (fmt, clippy) and `test` (unit and
live tests) that passes when both passed or were skipped, so the required name never changes when the Rust
jobs are split further.

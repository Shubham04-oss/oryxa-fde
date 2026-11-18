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
| OpenTofu providers | `actions/cache/restore` on `TF_PLUGIN_CACHE_DIR` in every run; only `main` saves it (`actions/cache/save`, after `init`) |
| Docker images | pulled each run (Postgres, SpiceDB, zed) |

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
web, schema and infra jobs) and several runs racing to write the same cache entry. Do that only if a
commit on `main` must have its own result.

## Which jobs run

| Job | What it checks | Runs |
| --- | --- | --- |
| `changes` | whether a PR may skip the Rust jobs (below) | always |
| `lint` | `cargo fmt --check`, `cargo clippy` with warnings as errors | Rust changes |
| `test` | unit tests, then the live tests against a Postgres 17 service container and SpiceDB (`serve-testing`, started as a step and removed in an `if: always()` step); nothing needs pgvector since #296, so the service is plain `postgres:17` | Rust changes |
| `check` | the required status check over `lint` and `test` (below) | always |
| `platform-base` | the vendored platform workspace builds and passes its own unit tests | Rust changes |
| `deny` | `cargo deny check` | Rust changes |
| `schema` | `zed validate` on `schema/fde.validation.yaml` | always |
| `web` | `fde-web`: the generated API client matches `openapi.json`, typecheck, lint, format, tests, build, and no dev mock in the build | always |
| `infra` | `tofu fmt`, `validate` and `test` on mock providers (no credentials), shellcheck, the smoke test against its stub, the Rust-skip filter's tests and the skip-list check, and actionlint over every workflow | always |

The `changes` job decides whether a PR can skip the Rust jobs (`lint`, `test`, `platform-base`, `deny`). It is an
allowlist: `.github/scripts/rust-changed.sh` skips only when every changed path is on its skip list, so any new or
unknown path, including a new top-level one, runs everything. The skip list is `docs/`, `fde-web/`,
`infra/{envs,modules,docker,scripts}/`, `infra/README.md`, `README.md`, `LICENSE` and `CLAUDE.md`. It diffs with
`--no-renames`, so a file moved out of `crates/` lists its old path and runs the Rust jobs.

**A file Rust code reads from outside `crates/` must stay off the skip list.** Today that is
`schema/fde.zed` (`include_str!` in the API's live tests) and `vendor/` (the vendored workspace and its own
`build.rs`/`include_str!`), plus the toolchain and lint config the jobs use: `rustfmt.toml`, `rust-toolchain.toml`,
`Cargo.*`, `deny.toml`. A PR that adds a new `include_str!`, `include_bytes!`, `sqlx::migrate!` or run-time
file read of such a path keeps it off the list, and `test-rust-changed.sh` gets a case for it.

The `infra` job enforces this rule instead of leaving it to review. `.github/scripts/rust-reads-check.sh` scans the Rust
sources under `crates/` and `vendor/` for every string literal with a `../` (`include_str!`, `include_bytes!`,
`include!`, `#[path]`, `../` joined onto `CARGO_MANIFEST_DIR`, a run-time read from the crate directory), resolves
each one against both the including file and its crate (the `CARGO_MANIFEST_DIR` or the constant can sit on another
line), and fails if `rust-changed.sh` answers `rust=false` for a path outside `crates/` and
`vendor/`. It compiles nothing. `test-rust-reads-check.sh` proves it: it must find `schema/fde.zed`, it must
fail when that path is added to a scratch copy of the skip list, and it must handle a made-up tree and fail closed
when the filter script is missing or broken. It sees string literals only, so a path built at run time
(`Path::join("..")`) still needs the review rule. `.github/scripts/**` and `.github/actions/**` steer CI as much as
the workflows do, so like them they are hands-off without lead review (`CLAUDE.md`).

The Rust jobs skip on a job-level `if`, never a workflow-level `paths:` filter: GitHub counts a skipped job as passed
for required checks, but a filtered-out workflow leaves them pending. A diff error, an empty diff or a script
error runs everything, and every push to `main` runs everything. A failed write of the log line to stderr cannot
change the answer. `.github/scripts/test-rust-changed.sh` tests the filter against made-up change lists, a real rename
and an unwritable stderr; the `infra` job runs it on every PR.

The `infra` job's `tofu test` plans `infra/envs/dev` and its modules on mock providers and pins the security rules of
the environment (nothing public, IAM database auth, secrets by reference, least-privilege roles, the deploy role's
trust); it also reads the API's environment contract table in `infra/README.md` and constants from the API's source
(`infra/envs/dev/tests/code`), so a Rust change to those constants fails it until infra follows. Those reads are
OpenTofu's, not Rust's, so they do not bear on the skip list.

`check` is the required status check. It stays as a small job over `lint` (fmt, clippy) and `test` (unit and
live tests) that passes when both passed or were skipped, so the required name never changes when the Rust
jobs are split further.

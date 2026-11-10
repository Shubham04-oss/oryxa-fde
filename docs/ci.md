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

## Which jobs run

The `changes` job decides whether a PR touches a Rust-relevant path (`crates/`, `vendor/`, `Cargo.*`,
`rust-toolchain.toml`, `deny.toml`, `schema/`, `.github/`). If not, `lint`, `test`, `platform-base` and `deny`
skip. They skip on a job-level `if`, never a workflow-level `paths:` filter: GitHub counts a skipped job as
passed for required checks, but a filtered-out workflow leaves them pending. A diff error runs everything,
and every push to `main` runs everything.

`check` is the required status check. It stays as a small job over `lint` (fmt, clippy) and `test` (unit and
live tests) that passes when both passed or were skipped, so the required name never changes when the Rust
jobs are split further.

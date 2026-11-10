# CI runners and caching

## Runners

Every job runs on GitHub-hosted runners (`runs-on: ubuntu-latest`). There are no self-hosted
runners: the repository may be public, and a self-hosted runner must never run code from a fork PR.
A new job uses `ubuntu-latest`, and no workflow may name a `self-hosted` label.

Every job must clean up after itself: service containers on random host ports, containers named
with the run id and removed in an `if: always()` step.

## Release builds

Release and deploy builds (`deploy-api`'s `build`) use no sccache, no restored cache and a fresh
`CARGO_HOME`. They compile everything from the registry, so nothing a PR's CI cached can end up in
a release.

## Caching

| What | How |
| --- | --- |
| Compiled Rust crates | sccache in the GitHub Actions cache |
| Cargo registry and git deps | rust-cache, with targets off |
| Build output | fresh each run |
| pnpm store (`fde-web`) | `actions/setup-node` with `cache: pnpm` |
| npm (`sandbox/*`) | `actions/setup-node` with `cache: npm` |
| OpenTofu providers | `actions/cache` on `TF_PLUGIN_CACHE_DIR` |
| Docker images | pulled each run |

Rust jobs get the Rust rows from one step after the toolchain: `- uses: ./.github/actions/rust-cache`.

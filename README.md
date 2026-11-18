# oryxa-fde

The FDE workspace: one place where forward deployed engineers run every customer company and
project they work on, from discovery to handoff, with a coding agent in each company's sandbox.

**Working on this repo? Read [CLAUDE.md](CLAUDE.md), then [docs/plan.md](docs/plan.md) and
[docs/adr/](docs/adr/).**

It builds on the Oryxa platform base. `oryxa-core`, `oryxa-authn`, `oryxa-authz` and `oryxa-events`
are vendored unchanged in `vendor/oryxa-platform` at the commit in `vendor/oryxa-platform/PLATFORM_REV`.
Refresh them with `scripts/sync-platform.sh <commit>`; never edit them here.

| Crate | Owns |
| --- | --- |
| `oryxa-fde-store` | Postgres migrations and the sign-in limits' counters; the runtime login check |
| `oryxa-fde-api` | The HTTP API (Axum): WorkOS sign-in, the session cookie, sign-out and `/v1/me`; spec in `crates/oryxa-fde-api/openapi.json`. `oryxa-fde-ops` runs migrations and the container health check |

Since the reset of 18 November 2026 (#296) the repository is sign-in only: the web app in `fde-web/` and the two
crates above. Everything else is in git history.

`schema/fde.zed` is the SpiceDB schema (ADR 0002); `zed validate schema/fde.validation.yaml` checks it.

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test --manifest-path vendor/oryxa-platform/Cargo.toml --workspace   # the vendored base
cargo deny check
```

## Licence

Proprietary, not open source. Copyright (c) 2026 Oryxa AI Private Limited, all rights reserved.
The source is visible for reference only. Copying, use, deployment or derivative works are not
permitted, and contributions are accepted only from invited contributors. See [LICENSE](LICENSE).

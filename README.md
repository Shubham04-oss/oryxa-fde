# oryxa-fde

The FDE workspace, reset to its first piece: signing in. Today it is a web app where a person signs in
with WorkOS (or our own sign-in screens, behind a flag), sees who they are signed in as and in which
organisation, and signs out; and the API behind it, on AWS in `infra/`. What it is meant to grow into
is in [docs/direction.md](docs/direction.md).

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

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
| `oryxa-fde-core` | FDE ids, `CompanyScope` and `ProjectScope` (every company-scoped call takes one), the project stage machine |
| `oryxa-fde-events` | FDE event payloads (source `oryxa.fde`, ids only) on the `oryxa-events` contract; the SQS consumer loop (`sqs` feature) |
| `oryxa-fde-store` | Postgres tables, migrations and row-level security for companies, projects and their lifecycle records; the audit log, the outbox and its relay |
| `oryxa-fde-api` | The HTTP API (Axum): WorkOS token verification, SpiceDB checks, companies, projects, members, lifecycle records and documents; spec in `crates/oryxa-fde-api/openapi.json`. `oryxa-fde-ops` runs migrations and replays dead events |
| `oryxa-fde-context` | Documents in S3, the ingestion consumer (`oryxa-fde-ingest`: text, Markdown, PDF, DOCX to chunks and embeddings) and hybrid search |
| `oryxa-fde-mcp` | The read-only MCP server for coding agents (`oryxa-fde-mcp`): context search, scope, decisions and tasks of one project |

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

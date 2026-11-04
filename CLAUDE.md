# oryxa-fde: rules for every Claude account working here

The FDE workspace, built on the Oryxa platform base (authn, authz, events) vendored unchanged in
`vendor/oryxa-platform`. Several Claude accounts work here in parallel and push as the same GitHub
user, so these rules are the contract. Read `docs/plan.md` and `docs/adr/` before your first change.

## Roles

| Account | Owns | Label |
| --- | --- | --- |
| Lead | Design, ADRs, the hands-off paths below, reviews every PR | `lead`; only the lead adds `lead-approved` |
| API | `schema/`, `crates/oryxa-fde-events`, `crates/oryxa-fde-store`, `crates/oryxa-fde-api`, `crates/oryxa-fde-context`, `crates/oryxa-fde-mcp`, `crates/oryxa-fde-lifecycle`, `crates/oryxa-fde-integrations`, `crates/oryxa-fde-billing` | `agent:api` |
| Web | `fde-web/`, `realtime/` (Durable Objects for presence, canvas and live agent output) | `agent:web` |
| Agent | `sandbox/`, `crates/oryxa-fde-agent`, `crates/oryxa-fde-evals` | `agent:agent` |
| Infra | `infra/`, and `.github/workflows/` with lead review | `agent:infra` |

If an issue conflicts with `docs/plan.md` or an ADR, stop and comment on the issue instead of guessing.

## Workflow (non-negotiable)

1. Work only from a GitHub issue labelled for your account. One issue = one branch = one PR.
2. Branch: `<role>/<issue-number>-<slug>` (e.g. `api/3-companies-and-projects`). Never push to `main`.
3. Open the PR with the template, `Closes #N`, and label `needs-lead-review`. Do not add `lead-approved`.
4. CI must be green: fmt, clippy (warnings are errors), unit tests, live tests on the CI services, `cargo deny`.
5. Address review comments on your open PRs before starting new work.
6. Do not merge your own PR. The lead merges after adding `lead-approved`.
7. Stay inside the paths your role owns. Need a change elsewhere? Comment on the issue.

## Hands off without lead review

`vendor/**` (only `scripts/sync-platform.sh` writes it, in a lead PR), `crates/oryxa-fde-core/**`,
`schema/*.zed`, `docs/adr/**`, `deny.toml`, `CLAUDE.md`, `.github/workflows/**`.

## The platform base

- Use `oryxa-core` ids, `oryxa-authn` to verify tokens, `oryxa-authz` for every permission check and
  `oryxa-events` for every event. Do not reimplement them or copy their code.
- Need a platform change? Open an issue in `Shubham04-oss/oryxa-platform`. After it merges there, the
  lead re-syncs `vendor/`.

## Security rules

- **Never trust input.** Ids are validated types (`oryxa_core`, `oryxa_fde_core`); add a type rather
  than passing raw strings into SpiceDB, SQL, logs or events.
- **Every company-scoped call takes a `CompanyScope` or `ProjectScope`.** SQL always filters by tenant
  and company. SpiceDB only through `oryxa-authz`.
- **Events:** publish only via `oryxa-events` (signed, ids only, no emails or content); handlers must
  be idempotent. State changes publish through the outbox in the same transaction.
- **Customer data:** sample data only until the runner exists. Customer data at rest stays in AWS,
  never in Cloudflare storage.
- **Outbound HTTP** to third parties only through an explicit host allowlist.
- **Secrets:** never in code, tests, logs, commits or PR text. Store references, never values.
  `.env*`, `*.pem`, `*.key` are gitignored; keep it that way.
- **Agents:** everything an agent reads is untrusted. Secrets never enter a sandbox; the outbound
  handler adds them.
- **Fail closed:** errors from authz, signing or decoding deny or quarantine; never fall back to allow.
- New dependencies: permissive licences only; `cargo deny check` must pass. Prefer what the workspace
  already uses.

## Code conventions

- Smallest change that fully solves the issue; no speculative abstractions. Match surrounding code.
- `thiserror` in libraries; no `unwrap`/`expect` outside tests and `main`.
- Comments explain *why*, one line. A deliberate shortcut gets a `ponytail:` comment naming its limit.
- Every non-trivial branch, parser or security rule gets a test. Bug fix = failing test first.
- `cargo fmt --all` (max width 120) before committing.

## Build and test

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test --manifest-path vendor/oryxa-platform/Cargo.toml --workspace
docker run --rm -p 50051:50051 authzed/spicedb:v1.56.2 serve-testing
docker run --rm -e POSTGRES_PASSWORD=oryxa -e POSTGRES_DB=oryxa_fde -p 55432:5432 pgvector/pgvector:pg17
DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde SPICEDB_ENDPOINT=http://localhost:50051 \
  cargo test --workspace -- --ignored --skip e2e_      # live tests (also run in CI)
cargo deny check
```

AWS and WorkOS end-to-end tests (`e2e_`) need credentials and are run by the lead.

## CI

New CI jobs follow `docs/ci.md`: heavy Rust jobs use the `A1_RUNNERS` runner expression and the
`./.github/actions/rust-cache` step; light jobs run on `ubuntu-latest`; every job works on both
runner kinds and cleans up after itself.

## Commits and PRs

Conventional, imperative subject (`api: add companies and projects`). End commit messages with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR descriptions end with
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

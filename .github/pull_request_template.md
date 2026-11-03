Closes #

## What changed
<!-- One or two sentences. -->

## How it was tested
- [ ] `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] Live tests (SpiceDB/Postgres) if this touches storage, authz or events
- [ ] New logic has a test (bug fix: failing test first)

## Security checklist (CLAUDE.md)
- [ ] Inputs validated (typed ids); `CompanyScope`/`ProjectScope` on every company-scoped call
- [ ] Events via `oryxa-events` only; ids only, no secrets, emails or customer content
- [ ] Outbound HTTP through an allowlist; no new dependency without `cargo deny` passing
- [ ] Touches a hands-off path? Say which and why:

🤖 Generated with [Claude Code](https://claude.com/claude-code)

# 0001: Vendor the platform base

Status: accepted, 3 November 2026.

## Context
The FDE workspace reuses `oryxa-core`, `oryxa-authn`, `oryxa-authz` and `oryxa-events` from
`Shubham04-oss/oryxa-platform` as they are. That repo is private. A git dependency would need read
access to it from CI and from every cloud session, which is not set up and may not be possible
from cloud sessions.

## Decision
Copy the four crates, plus `oryxa-spicedb-proto` and the protos, schema and policies their builds
read, into `vendor/oryxa-platform` with `scripts/sync-platform.sh <commit>`. It is a nested
workspace so the crates keep the platform's own settings. `PLATFORM_REV` records the commit.
Nobody edits it by hand. Platform changes go to the platform repo first, then the lead re-syncs.

## Consequences
- CI and cloud sessions build with no access to the platform repo.
- Platform fixes reach FDE only on a re-sync, so the lead re-syncs after each platform release.
- If a git dependency becomes easy later, replace the path dependencies in the root `Cargo.toml`.

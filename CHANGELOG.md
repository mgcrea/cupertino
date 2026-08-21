# Changelog

Notable changes to this repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every published artifact follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Releases are tagged per artifact, and a tag names what it publishes: `mail-v0.1.0`,
`notes-v0.1.0`, `reminders-v0.1.0`, `core-v0.1.0` for the npm packages, and `app-v1.0.0` for the
signed macOS app. GitHub release notes are generated from commits; this file is the curated
summary.

## [Unreleased]

**Nothing is published yet.** The signed `Cupertino.app` and the `@mgcrea/mcp-apple-*` packages
land together at the first release. Until then this section is the running record.

### Added

- Mail, Notes and Reminders MCP servers — 41 tools total, reads always registered and writes
  invisible unless enabled.
- `packages/core` — the shared osascript boundary, TCC-aware error taxonomy, read-only SQLite
  ladder and stdio server runner.
- `Cupertino.app` — a menu bar app holding one Full Disk Access grant on behalf of every server,
  with `cupertino-bridge` relaying stdio to a per-user unix socket.
- `scripts/audit-network.sh`, gating the "no network connections" claim in CI and runnable by
  anyone against the `.app` they downloaded.
- Phase-0 probes for Messages, Calendar and Safari.
- `LICENSE` (MIT, `packages/*`) and `apps/apple/LICENSE` (source-available).

[unreleased]: https://github.com/mgcrea/mcp-cupertino/commits/main

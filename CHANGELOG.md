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
- `LICENSE` (MIT, `packages/*`) and `apps/apple/LICENSE` (source-available), plus `apps/apple/EULA`
  and the succession commitments in `docs/succession.md` that it incorporates by reference.
- Offline licence keys — Ed25519, verified locally against a public key compiled into the app, with
  no activation server and no phone-home. The relay refuses without one; `allowWrites` is untouched
  in every state, because writes are a safety control and never the paywall.
- `apps/api` — a Cloudflare Worker turning a Stripe payment into a key, storing which key went to
  whom in D1, and emailing it. Refunds and lost disputes revoke; a won dispute restores.
- `make revocations` — regenerates the revocation list baked into each build. Revocation lands at
  build time because the app is not allowed to ask anyone anything at run time.

[unreleased]: https://github.com/mgcrea/mcp-cupertino/commits/main

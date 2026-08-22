# Changelog

Notable changes to this repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every published artifact follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Releases are tagged per artifact, and a tag names what it publishes: `mail-v0.1.0`,
`notes-v0.1.0`, `reminders-v0.1.0`, `core-v0.1.0` for the npm packages, and `app-v1.0.0` for the
signed macOS app. GitHub release notes are generated from commits; this file is the curated
summary.

## [Unreleased]

### Added

- **Updates.** Cupertino can now check for updates and install them. 1.0.0 shipped with no way to
  reach the people running it, which for an app holding Full Disk Access means a security fix that
  never arrives — and it means a refunded licence key keeps working, since the revocation list is
  baked in at build time and only lands when someone updates.
- A consent card, asked once, and an **Updates** section in Settings › General with a Check Now
  button.

### Changed

- **The network claim.** Cupertino used to make no network connections at all, and that sentence was
  on the front page. It is now: _makes one network connection, and only if you ask for it._ Said
  plainly, because people bought 1.0.0 on the stronger version — the app gained a network
  capability, and the honest thing is to say so rather than to quietly reword a page.

  What has not changed: automatic checks are **off** in the shipped bundle and stay off until you
  answer the card or press Check Now; nothing is even constructed until then; the check reads one
  file and sends no identifier with it, not your licence key and not a machine id; updates never
  install without somebody clicking Install; and the licence is still verified entirely offline.

  `scripts/audit-network.sh` now checks the exception rather than being weakened around it. It
  discovers every binary in the bundle instead of naming two by hand, allows Sparkle a specific list
  of symbols and fails on anything beyond it, and asserts against the shipped `Info.plist` that
  automatic checks are off. Worth knowing why: a Sparkle-linked app passes a naive symbol audit,
  because `URLSession` is named inside the framework and never in the app binary. Run unchanged, the
  old script would have called this app network-free.

### Note for 1.0.0 users

1.0.0 has no updater in it, so it cannot pull this one down. Updating to 1.1.0 is a manual
download this once — after that the mechanism is there. `brew upgrade --cask cupertino` also works.

## [1.0.0] - 2026-08-22

First signed release of `Cupertino.app`. The `@mgcrea/mcp-apple-*` packages are not on npm yet —
the servers ship inside the bundle, and a host that would rather run them directly can build them
from source.

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
  no activation server and no phone-home. The relay refuses without a key or an open trial window;
  `allowWrites` is untouched in every state, because writes are a safety control and never the
  paywall.
- A 30-minute trial, started by hand from the licence pane or the menu bar and never armed on its
  own. Every surface at full function, with the write toggles behaving exactly as they will after
  paying — it answers whether Cupertino works against your own mail, which is a different question
  from whether it is worth the money and is asked first. The deadline is held in memory and never
  written to disk, so quitting and reopening starts another one and nothing pretends otherwise.
  When the window closes the servers it started are stopped: an MCP host opens one stdio connection
  and holds it for the life of the editor, so refusing only new connections would have handed out a
  half hour that really expired whenever somebody next quit their editor.
- `apps/api` — a Cloudflare Worker turning a Stripe payment into a key, storing which key went to
  whom in D1, and emailing it. Refunds and lost disputes revoke; a won dispute restores.
- `make revocations` — regenerates the revocation list baked into each build. Revocation lands at
  build time because the app is not allowed to ask anyone anything at run time.
- Client wiring beyond Claude — one-click config for Claude Desktop, Cursor, LM Studio and
  Windsurf, and a copyable command for Claude Code, Visual Studio Code and Codex. The split is not
  about popularity: the app merges only into strict JSON it can rewrite without destroying
  something, and hands over a line to paste for JSONC, TOML, and the one file running sessions
  write to concurrently. Claude Code also gained a status of its own, read-only — it is how a
  config left behind by a new surface becomes visible instead of silently incomplete.
- `make wiring-check` — a standalone `swiftc` gate over `ClientWiringMerge`, asserting that a merge
  keeps every unrelated key, leaves a recoverable backup, migrates a legacy `apple-*` entry only
  when this app wrote it, and cannot leave a truncated config or a stray temp file.

[unreleased]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.0.0...HEAD
[1.0.0]: https://github.com/mgcrea/mcp-cupertino/releases/tag/app-v1.0.0

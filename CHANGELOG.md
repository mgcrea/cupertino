# Changelog

Notable changes to this repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every published artifact follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

<!-- <generated:version> generated from package.json by `make version` — do not edit by hand -->

Releases are tagged per artifact, and a tag names what it publishes: `mail-v1.2.2`,
`notes-v1.2.2`, `reminders-v1.2.2`, `core-v1.2.2` for the npm packages, and `app-v1.2.2` for the
signed macOS app. GitHub release notes are generated from commits; this file is the curated
summary.
<!-- </generated:version> -->

## [Unreleased]

### Added

- **Calendar answers "when am I free".** `apple_calendar_find_availability` returns the gaps between
  events, inside working hours, long enough to hold a meeting of a given length. It is not
  `list_events` with arithmetic bolted on: it returns the COMPLEMENT of what it read, so every
  shortfall that merely under-informs a listing instead invents a slot that is already booked. The
  busy set is complete or there is no answer — a saturated scan, a store that expands no repeating
  events, and a window past the occurrence cache's edge each return `degraded: true` with a reason
  rather than a short list. An empty `slots` means booked; `degraded` means unknown, and the two are
  never the same value. Declined and cancelled events do not block time; all-day events do not
  either, but they are reported next to the slots so a holiday is visible before it is booked over.
  Working hours default to 09:00–18:00 on weekdays and are set by `APPLE_CALENDAR_WORKDAY_START`,
  `APPLE_CALENDAR_WORKDAY_END` and `APPLE_CALENDAR_WORKDAYS`.
- **Messages can save an attachment.** `apple_messages_save_attachment` copies a photo, video, PDF or
  voice memo out of a conversation. Mail and Notes have had this since 1.0; Messages listed
  attachments and then left you with no way to get one. Write-gated like the other two, because it
  puts a file on the user's disk — it sends no Apple Event and changes nothing in Messages, so the
  claim that writes-off means no Automation grant still holds. Attachments now carry an `id` (the
  attachment's guid, never its reusable ROWID) on `apple_messages_get_message`. An attachment iCloud
  has offloaded is reported as offloaded rather than as a failure.
- **Every server now exposes prompts and resources, not just tools.** Three resources per surface:
  `cupertino://<surface>/guide` is the operating manual and is STATIC, so it still reads on a server
  whose every grant is denied — which is exactly when it is worth reading;
  `cupertino://<surface>/diagnostics` serves the diagnostics tool's own payload, addressable without
  spending a call and before the confusing answer rather than after it; and
  `cupertino://<surface>/inventory` holds the accounts, mailboxes, folders, lists or calendars that
  every other tool takes as an argument. Contacts, Messages and Safari register only the first two —
  a contact is reached by searching and never by naming its store, chats are unbounded, and history,
  tabs and the Reading List are three queries rather than three folders. A resource read that fails
  returns `degraded` DATA rather than a JSON-RPC error, because a protocol error would delete the
  diagnostics report at the one moment anyone wants it. The scheme is `cupertino://` and not
  `apple://`: a URI scheme is a namespace claim, and taking Apple's would read as the affiliation
  the README disclaims.
- **Thirteen workflow prompts, one to three per surface.** They hold what no tool description can:
  not what a call does, but what order the calls go in. `apple_mail_triage` searches instead of
  paging; `apple_mail_draft_reply` reads the thread first and fills the body, because
  `reply_to_message` without one leaves an EMPTY draft that must never be reported as a written
  reply; `apple_reminders_capture_action_items` searches before creating, because nothing on that
  surface deduplicates; `apple_calendar_schedule` says out loud that nobody was invited, since this
  server has no `attendees` parameter anywhere on purpose; `apple_contacts_who_is` refuses to guess
  between ambiguous matches; `apple_messages_send` confirms the handle before an action with no
  undo, and treats `reconciliation: "pending"` as SENT rather than as something to retry. Each
  prompt embeds its surface guide, so a host expanding one hands the model the reference with the
  task. Write-gated prompts follow the write tools exactly — with writes off they are not refused,
  they are not registered.
- **Mail can create a mailbox.** `apple_mail_create_mailbox` makes the folder that
  `apple_mail_move_messages` needs to move into — nested with `/`, or local under On My Mac when no
  account is named. Calling it for a name that already exists does nothing and says so, so it is
  safe to call before a move. On a server account it creates the folder ON THE SERVER, which syncs
  to every device; the tool's description says so and it takes `confirm`.

### Fixed

- **Four tools returned their payload wrapped twice.** `wrap()` JSON-encodes whatever its body
  returns, and `apple_messages_get_message`, `apple_contacts_get_contact`,
  `apple_contacts_create_contact` and `apple_contacts_update_contact` had bodies that returned
  `ok(…)` themselves — so the text a client received was a serialised tool result with the real
  answer one decode further in. The same mistake swallowed `fail()`: a ref that no longer resolved
  came back as a SUCCESSFUL call carrying `isError` as data. All four now use `wrapResult()`.
  Nothing caught it because every assertion read a field off the parsed text and got `undefined`,
  which reads as "absent" rather than "wrapped twice"; there are now tests on the envelope itself.

## [1.2.2] - 2026-08-24

Three fixes to how the app survives things going wrong around it.

### Fixed

- **The menu bar stops responding.** `StatusModel.refresh()` asked TCC about every Apple Events
  surface synchronously, and SwiftUI runs `refresh()` inside a layout pass.
  `AEDeterminePermissionToAutomateTarget` does not prompt when told not to, but not prompting is not
  the same as not blocking: it is a synchronous IPC and can park on a semaphore indefinitely.
  Measured on 1.2.1 build 192 — two samples 60 seconds apart with the same stack, 2396 of 2396
  samples, 11 seconds of CPU across 11 hours. The run loop never came back, so clicks did nothing
  and no bridge could finish a handshake. The permission read now happens off the main thread and
  publishes back, so a stalled answer leaves the previous glyph on screen instead of freezing the
  app.
- **A bridge could abort while reporting a broken pipe.** `warn` wrote through
  `-[NSFileHandle writeData:]`, which reports a failed write by raising an Objective-C exception
  rather than returning an error — and Swift cannot catch it. An MCP host that exits closes stdout,
  the socket and stderr together, so the run that most needed a diagnostic was exactly the run where
  emitting it killed the relay. `warn` and `hostLog` now use `write(2)` and drop the line rather
  than the process.
- **Two copies of Cupertino no longer fight over the socket.** `openSocket` unlinked the socket path
  unconditionally before binding. That clears a stale entry after a crash, and it also evicts a live
  one: with a checkout's Debug build and the installed app both reachable from MCP config, whichever
  started last took the path silently and left the other accepting connections nobody could reach —
  no error anywhere, and a menu bar that looked healthy. The host now connects to the path first. An
  answer means another copy is serving and this one refuses with a message that names the situation;
  no answer means the entry really is stale and it is cleared as before.

## [1.2.1] - 2026-08-23

A packaging fix: the MCP servers inside the app bundle now start.

### Fixed

- **The bundled servers start.** `@mgcrea/mcp-apple-core` resolves through its `exports` to
  `dist/index.js`, which the release job never built — and an unresolvable specifier is not an
  error to rolldown, it is an external one. It said `Module not found, treating it as an external
dependency`, externalised the import and exited 0. The bare specifier then landed in a bundle
  that carries no `node_modules`, so a surface could raise `ERR_MODULE_NOT_FOUND` on startup and
  the MCP host would sit on `Connecting…` until it timed out. `make servers` now builds the
  workspace packages it inlines rather than assuming something else already did.

### Added

- **`scripts/verify-servers.sh`.** Signing, notarisation and the network audit all describe the
  bundle; none of them runs it. This asserts that no server imports a specifier the bundle does
  not contain, then spawns each server under the runtime shipped beside it and makes it answer
  `initialize`. It runs in `make servers` (static half, no runtime needed), before signing in
  `make bundle`, and against the built artifact in CI. Point it at a `.app` you downloaded and it
  answers the same question CI asked.

## [1.2.0] - 2026-08-22

Two new surfaces, taking Cupertino from five Apple apps to seven. Both ship inside the bundle;
the single Full Disk Access grant and the write toggles work exactly as they already did.

### Added

- **Safari.** History, live tabs and the Reading List, read-only — there is no write tool in this
  surface at all, so the Writes toggle does not appear for it. Measured against a captured schema
  fixture rather than assumed: the tab/history join rate and the Reading List counts in
  `docs/safari.md` come from that run.
- **Messages.** Chats, messages and search, plus a `send` gated behind the Messages write toggle
  like every other write in the app.

  Worth knowing why it is shaped this way: Messages has no Apple Events read path. Every read
  through the scripting dictionary fails, and it answers _"Application isn't running"_ even while
  it is running, because it is a windowless background process that declines to wake for a script.
  So reads go through the file lane and Apple Events is a write lane and nothing else. `send` picks
  its target by chat guid from `list_chats`, since Messages will not enumerate participants for a
  script, and then finds the sent row afterwards, because Apple Events hands back no identifier for
  what it just sent. About 3% of messages keep their text only in an archived `NSArchiver` blob
  that SQL cannot reach; this server decodes it rather than returning an empty body.

### Fixed

- **Allow… on a surface whose app is closed.** The button re-ran the same call and wrote back the
  same state, so it did nothing, twice. `AEDeterminePermissionToAutomateTarget` does not launch its
  target even when asked to prompt — measured on macOS 26.6, `askUserIfNeeded: true` still returns
  `procNotFound` while the app is closed. Cupertino now opens the target without activating it,
  polls until TCC can answer, then asks: 53ms on a closed Contacts.app in testing.

  This was unreachable for as long as every surface was an app people leave open, which is why
  Contacts is what exposed it — it sits closed on most Macs, so "not running" is that surface's
  normal state rather than an edge case. Button labels and destinations now come from one place, so
  the popover, the Settings pane and the surface detail cannot drift apart; the Settings pane also
  gains a real control where it previously fell through to an icon with nothing to click.

### Shipped in 1.1.0, not written down

Present in the 1.1.0 build and missing from its notes, recorded here so they are not lost. If you
are on 1.1.0 you already have these.

- The menu bar glyph now lights when a client is connected, so the icon itself says whether
  anything is talking to Cupertino right now. The main window's footer gained a live client count.
- Surfaces that only read no longer show a permanently-pending Automation prompt or a Writes toggle
  that gates nothing; they say _"not needed — this surface reads only"_ instead.
- Cupertino has its own accent color rather than following whatever accent System Settings happens
  to be set to.
- A window someone had resized by hand came back the wrong size, because SwiftUI re-applied its own
  fitted width on a layout pass landing after the window was already shown. A size you chose now
  wins.

### Internal

- Local builds derive `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` from the nearest `app-v*`
  tag and the commit count, the same way CI does. A `make install` app used to inherit the pbxproj
  default and call itself 1.0 — below the appcast's build number, so Sparkle offered a developer
  their own build as an update.

## [1.1.0] - 2026-08-22

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

[unreleased]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.2.2...HEAD
[1.2.2]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.2.1...app-v1.2.2
[1.2.1]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.2.0...app-v1.2.1
[1.2.0]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.1.0...app-v1.2.0
[1.1.0]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.0.0...app-v1.1.0
[1.0.0]: https://github.com/mgcrea/mcp-cupertino/releases/tag/app-v1.0.0

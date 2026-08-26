# Changelog

Notable changes to this repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every published artifact follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

<!-- <generated:version> generated from package.json by `make version` — do not edit by hand -->

Releases are tagged per artifact, and a tag names what it publishes: `mail-v1.3.0`,
`notes-v1.3.0`, `reminders-v1.3.0`, `core-v1.3.0` for the npm packages, and `app-v1.3.0` for the
signed macOS app. GitHub release notes are generated from commits; this file is the curated
summary.
<!-- </generated:version> -->

## [Unreleased]

## [1.3.0] - 2026-08-26

Two new mutations for Mail (a mailbox, and a rewrite of an unsent draft) and one for Messages
(saving an attachment), plus Calendar's first read of the negative space between events. Every
server also exposes prompts and resources now, not only tools — see
[docs/prompts-and-resources.md](docs/prompts-and-resources.md).

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
- **Mail can rewrite an unsent draft.** `apple_mail_update_draft` replaces a saved draft's body.
  Mail offers no way to edit one — `message.content` is read-only and the dictionary has no `open`
  and no `edit` command — so the tool recreates the draft and deletes the original only once the
  replacement is confirmed present in Drafts, never the other way round. It refuses rather than
  doing damage: a reply or forward draft (recreating it would drop `In-Reply-To` and silently start
  a new thread), a draft carrying attachments (they cannot be re-attached), and anything outside the
  Drafts mailbox (deleting a sent message and writing a lookalike is not editing). In every refusal
  the original is untouched. The dictionary evidence behind all of this is now written down in
  [docs/mail-compose.md](docs/mail-compose.md), including that `outgoing message.html content` is
  documented by Apple as "Does nothing at all (deprecated)" — a write-only property that accepts
  every assignment and does nothing, which is the first thing anyone tries. Two further findings
  came from probing a live Mail and contradict the dictionary outright:
  `account.draftsMailbox` is declared readable and raises "Can't get object." on every account
  (iCloud, IMAP, Exchange), so the Drafts mailbox is discovered through the unified All Drafts
  mailbox instead of trusting the documented property; and a freshly saved draft's row id is
  rewritten by sync within seconds, killing any reference held across it, so the original is
  refetched by id immediately before deletion. `save()` itself works and lands in under 400 ms.
- **`APPLE_<SURFACE>_EXPOSE_PROMPTS` turns the prompts and resources off**, defaulting to ON — the
  opposite of `ALLOW_WRITES`, and deliberately. That one is a safety invariant; this is a cost knob
  in the family of `MAX_RESULTS`, and modelling it on the write gate would muddy the gate that
  matters. Measured across all seven servers with writes on, the prompt and resource listings come
  to ~3.4k tokens against ~18.5k for the tool definitions — about 18% on top of a bill tools
  dominate either way, with resource contents costing nothing until something reads one. One flag
  covers both, because a prompt embeds its surface guide and prompts without resources would name a
  `cupertino://…/guide` that nothing serves. With it off the capability is never declared, so a
  client asking gets "method not found" rather than an empty list. `diagnostics` reports the flag on
  every surface, since that tool is still registered when the resources are not.
- **The app shows each surface's live tool, prompt and resource catalog.** A Capabilities card on
  the surface detail pane spawns that surface's server and asks it directly — `initialize`,
  `tools/list`, `prompts/list`, `resources/list` — rather than keeping a hand-written copy that could
  drift from the servers it describes. Cached per surface AND per write setting, so flipping Allow
  writes re-probes instead of showing a stale list: that is the point, because this is the only place
  the app's long-standing claim that writes-off means the mutating tools (and now the prompts that end
  in one) are never registered rather than refused is actually demonstrated, on screen, live.
- **Mail can create a mailbox.** `apple_mail_create_mailbox` makes the folder that
  `apple_mail_move_messages` needs to move into — nested with `/`, or local under On My Mac when no
  account is named. Calling it for a name that already exists does nothing and says so, so it is
  safe to call before a move. On a server account it creates the folder ON THE SERVER, which syncs
  to every device; the tool's description says so and it takes `confirm`.

### Fixed

- **The Activity window under-reported what an agent did.** `RequestObserver` named the tool behind
  a `tools/call` and counted it, but let `prompts/get` and `resources/read` fall through as bare
  method names that counted as nothing — so expanding a write workflow like `apple_mail_draft_reply`
  logged less than a single read. Both now log what they reached for, and both count. The footer
  under the log grew to match ("Tool, prompt and resource names only — never arguments, message
  contents or results"): it is load-bearing rather than decoration, and the alternative to growing
  it was leaving it false.
- **The host stopped answering after about 64 sessions, silently.** `ServerHost` ran every blocking
  part of a session — the two pumps, the stderr drain, and the `group.wait()` that outlives them —
  on libdispatch's global queues, which are a bounded pool of roughly 64 threads per QoS. A blocked
  thread is not an available one, so sessions consumed the pool rather than sharing it, and past the
  limit newly submitted blocks were never scheduled at all. The block that never ran was
  `serve(client)`: `accept` kept succeeding, so every new bridge completed its `connect`, wrote its
  handshake, and then waited forever on a reply from a function that had not started. Nothing logged
  an error, because from the host's side nothing had failed. Measured on a host up three days: 68
  threads parked in `_dispatch_group_wait_slow`, `acceptLoop` healthy and blocked in `accept`, 68
  server processes still alive because their pumps had never run to hand them an EOF, 955 open
  descriptors, and a probe getting zero bytes back in eight seconds from a socket that accepted it
  in two. Pumps, drains and sessions now each get a thread of their own, and the stderr drain is no
  longer a member of the group that gates teardown — logging is not plumbing, and a group member
  that only ends when the child exits makes every teardown hostage to the child agreeing to go.
- **A wedged host produced immortal bridges instead of an error.** `cupertino-bridge` waited on the
  handshake reply with no deadline and nothing watching stdin, so a host that accepted but never
  answered left the relay alive indefinitely — 67 of them parented to launchd, each still pinning a
  session's descriptors and threads on the app side, which fed the condition that caused it. The
  handshake now has a 15s `SO_RCVTIMEO` and says what it means, and the relay ends when _either_
  direction closes: previously only Cupertino hanging up could end it, so a host that quit was never
  reason enough for the bridge to stop.

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

[unreleased]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.3.0...HEAD
[1.3.0]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.2.2...app-v1.3.0
[1.2.2]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.2.1...app-v1.2.2
[1.2.1]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.2.0...app-v1.2.1
[1.2.0]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.1.0...app-v1.2.0
[1.1.0]: https://github.com/mgcrea/mcp-cupertino/compare/app-v1.0.0...app-v1.1.0
[1.0.0]: https://github.com/mgcrea/mcp-cupertino/releases/tag/app-v1.0.0

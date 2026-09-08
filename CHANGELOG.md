# Changelog

Notable changes to this repository. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every published artifact follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

<!-- <generated:version> generated from package.json by `make version` — do not edit by hand -->

Releases are tagged per artifact, and a tag names what it publishes: `mail-v1.19.1`,
`notes-v1.19.1`, `reminders-v1.19.1`, `core-v1.19.1` for the npm packages, and `app-v1.19.1` for the
signed macOS app. GitHub release notes are generated from commits; this file is the curated
summary.
<!-- </generated:version> -->

## [Unreleased]

### Added

- **A Chat pane, so the tools can be tried without wiring an editor first.** Until now the only way
  to see Cupertino do anything was to install an MCP client, configure it, and ask it a question —
  three steps before the first sign of life, and the app could only ever describe its servers.
  The new pane under Activity picks a surface, loads as many of its tools as fit, and lets you ask
  in plain words.

  The answers come from Apple's on-device model, which is the only choice that keeps
  `scripts/audit-network.sh` true: the pane adds no network reach, no API key and nothing to send.
  It also works before a licence is entered, because what a licence buys is letting *other* apps in
  — a self-check is not a relay.

  The calls are real ones. The pane dials the app's own socket with the same handshake
  `cupertino-bridge` sends, so a tool call from here goes to the same supervised child, under the
  same write gate and the same surface switch, and shows up in the Log and Connections panes like
  anybody else's. Tool calls are drawn above the model's prose, with the arguments it invented,
  because the calls are the evidence and the prose is a small model's account of them.

  The on-device model holds 4,096 tokens and Mail alone lists 4,858 tokens of tool schema, so the
  pane cannot offer a surface's tools — only as many as fit. It costs each tool, sorts the ones
  callable with no arguments first (a set of only `get_*(id)` tools gives the model nothing to open
  with), fills a 1,800-token budget greedily, and says in the header what it spent and in the picker
  what it left out. `make chat-check` asserts that arithmetic with no app and no model, and
  `make chat-check-real` puts every shipped tool schema through the same rule — all 131 of them
  convert.

  A question may make six tool calls, and a reply is capped at 400 tokens. Neither is tidiness:
  a model looping on a failing tool would otherwise spend six minutes of call deadlines before
  anybody could type again, and a model that starts enumerating fills the window, overflows, and
  gets silently trimmed — so the only symptom is a conversation that has forgotten its own
  opening. Stopping a reply ends the turn immediately and drops the stopped question from what
  the model remembers, which the row says out loud.

  With writes enabled for a surface, the pane honours it: the model can change your data, behind an
  acknowledgement that names the surface and gates the Send button.

- **A client that already fetches tool schemas on its own is never fronted.** "Load tools on
  demand" reads as a decision about a surface, but a surface feeds every wired client at once, and
  they do not agree about what they need. Claude Code and Claude Desktop both load an MCP server's
  schemas only when they are about to use them, so fronting either paid the facade's whole cost to
  buy back only the tool names — and worse, their own tool search then indexed the facade's four
  generic entries instead of the surface's twenty real ones.

  Cupertino now writes `--client=<id>` beside `--server=<id>` when it configures a client, so the
  host knows which config a connection came from and can leave those two alone. Which clients
  defer is an allowlist backed by evidence, with a per-client override
  (`defaults write … defersSchemas.<client> on|off`) for when it is wrong in either direction. An
  unrecognised client, or a config written before this existed, does not defer — the behaviour
  every client had before. Existing wirings are not invalidated: the staleness check compares the
  command and never the arguments, so nothing needs re-configuring, though a client that has not
  been re-configured carries no id until it is.

- **A listing too small to be worth searching is served whole, whatever the switch says.** A
  facade costs its own declarations and buys back only what the real listing would have cost, so
  below a certain size the trade is a loss that looks exactly like a working facade. A surface is
  now fronted only when its listing has at least twice as many tools as the facade replacing it
  **and** costs at least twice as many bytes. Measured with writes on, Contacts (7 tools) and
  Messages (8) fail the first test at 1.4x and 1.6x while passing the second at 2.6x and 3.8x —
  which is why both terms are needed: a handful of fat schemas outweighs a facade made of prose,
  so a floor counting bytes alone would front them and buy nothing but a coarser permission
  prompt.

## [1.19.1] - 2026-09-08

### Fixed

- **`apple_safari_read_page` returned a single-page app's pre-boot shell, forever.** The extension
  captured a page once, at `document_idle`, and again only after a route change — before a
  single-page app has rendered anything. The only capture of x.com was therefore its loading shell:
  an empty `<title>` and the static "Something went wrong … privacy related extensions" block X
  ships in every response, easy to misread as a real error rather than an uninitialized page. The
  store is keyed by URL, so that snapshot was the **permanent** answer for the page; no amount of
  waiting before `read_page` improved it, because nothing ever captured a second time.

  The content script now re-captures once the page settles: a `MutationObserver` fires after the DOM
  holds still for 500ms, with a 5-second deadline for pages that never go fully quiet — a live
  timeline (video, ads, ticking timestamps) would otherwise never trigger a debounce on its own. A
  route change reuses the same watcher instead of a fixed delay, and a settled capture identical to
  the one already sent is skipped rather than resent.

## [1.19.0] - 2026-09-08

### Added

- **`apple_desktop_hover`, because a click is not a pointer.** The desktop surface could press,
  click, type and read a tree, and still could not make a tooltip appear. `click` posts a press and
  a release and nothing in between, so a tracking area sees a button go down inside it having never
  seen the pointer arrive — which means every control that only exists under the cursor was
  unreachable: a tooltip, a hover readout, SwiftUI's `onContinuousHover`. Driving a chart's hover
  band is what found it, and the workaround was a throwaway `CGEvent` script outside the repo.

  Addressed by `handle` in preference to a coordinate, and for a sharper reason than the other
  verbs have. A point from `ui_tree` was true when the walk ran; a window that has moved since — and
  one being driven moves often — leaves it aimed at bare desktop, where a hover **misses in
  silence**. There is no control to fail to press and nothing to report, just a readout that never
  appears. So the handle form re-reads the element's frame at call time. It also brings the target
  application forward first and refuses to post if it did not come, because a hover is delivered
  only to the frontmost application; the same reasoning the simulator surface already applies to a
  tap.

  It is the first verb here that is refused on account of the person at the keyboard. A hover takes
  the physical pointer for as long as it sweeps, which is worse than a click rather than better, so
  it declines while somebody is using the Mac. The check could not be `secondsSinceUserInput()`
  alone: that reads `.combinedSessionState`, which counts Cupertino's own events, so a plain idle
  test would have refused every hover after the first — biting hardest when the agent is working
  alone, the case it exists to allow. The driving indicator already knows whether the last input was
  ours, and the idle floor sits under its linger so a sequence composes. The reading is returned
  with the answer, for the before/after comparison `apple_desktop_user_activity` describes.

  Annotated non-destructive and idempotent, unlike `click`: moving the pointer twice to the same
  place leaves the same state and presses nothing.

- **The simulator surface introduces itself on connect.** A client loads the `initialize` result's
  `instructions` without being asked to; the guide resource is pull-only and goes unread unless
  something names its uri, which is the wrong shape for the handful of facts that change a caller's
  very first move. `InProcessRPC.dispatch` takes an optional instructions string and omits the key
  entirely when it is nil, so a surface that declares none answers byte for byte as it did before.
  Simulator declares a short one — only what changes that first move — and points at the guide for
  the rest.

### Changed

- **The role-filter guidance was drawn from Catalyst apps alone.** The advice about filtering
  `apple_desktop_find_elements` by role came from a sample where controls report as
  `AXGenericElement`, `AXStaticText` and `AXImage` far more often than `AXButton`. That is true of
  Catalyst and was overstated as the norm. Re-measured across 21 regular apps: Catalyst still misses
  about 80% of them (Maps, Messages, Calendar, System Settings), while AppKit and plain SwiftUI apps
  miss only about a fifth, and widening the filter to the whole button family clears most of that.
  The rule does not change — the stragglers are exactly the clickable heading or row a caller cannot
  predict, and asking for pressable costs nothing — but the tool description and `docs/desktop.md`
  no longer claim the miss rate is typical.

### Fixed

- **`apple_desktop_activate` was refusing every target, and it was never a permission.** Cupertino
  is an `LSUIElement` broker nobody ever clicks, which since macOS 14 is on its own enough for
  `NSRunningApplication.activate()` to refuse — whatever the target, and with no grant that changes
  it. Measured on macOS 26.6.2: refused for `com.apple.mail` and `com.apple.finder` alike when
  called from Cupertino, while the same `activate()` on Mail from a freshly launched command-line
  process returned true and moved the foreground. `.activateIgnoringOtherApps` is not the way out
  either, having been deprecated and a no-op since macOS 14.

  When LaunchServices says no and the app holds Accessibility, the driver now sets `AXFrontmost` on
  the target's application element instead — measured raising Mail from behind another app with
  `err=0`. Either path is then checked against the window server's own `frontmostBundleId` rather
  than the return value of the call that did it, because activation is asynchronous and a caller
  that posts a keystroke before it lands types into whatever was already in front. That check is
  what `apple_desktop_hover` leans on when it declines to post into an application that did not
  come forward.

## [1.18.0] - 2026-09-07

### Added

- **What changed, readable after you have already updated.** Release notes existed in exactly one
  place a user could reach: the sheet Sparkle puts up while it asks permission to install. That
  sheet is gone the moment you press Install, which left the one person most likely to want them
  — somebody who has just replaced an app holding Full Disk Access — with nowhere to look but
  `CHANGELOG.md` on GitHub. Settings has a **What's New** pane now, beside Updates, because the
  two are halves of one question: what did this build change, and is there a newer one. General
  keeps the version and the build number, which answer _which_ build this is — the question you
  ask with a bug report open, not the one you ask after updating.

  It is generated, not bundled. `make changelog` compiles the last five releases of
  `CHANGELOG.md` into `Changelog.swift` the same way `make surfaces` compiles `surfaces.json` into
  `SurfaceCatalog.swift`, and `changelog-check` fails CI if the two drift — so the notes in the
  app are the notes in the repository, or the build goes red. `### Internal` sections are dropped
  at generation time rather than hidden at render time, so repo-facing prose never reaches the
  binary. `[Unreleased]` is emitted separately and shown only in a Debug build, which matters here
  because CI asserts only that a `## [<version>]` section exists, not that it is the top one.

  The parse behind it is shared with `changelog-notes.mjs`, which renders the appcast, so the two
  cannot disagree about what a bullet is — and the appcast's own guards, on a missing section and
  an empty one, stay where they were. `scripts/lib/changelog.test.mjs` is written against the
  shapes this file actually contains rather than tidy examples: a bullet with no bold headline, a
  headline with a code span inside it, prose between a `###` heading and its first bullet, and a
  freely named section like `### Note for 1.0.0 users`. One assertion is deliberately about code
  spans rather than the word "undefined", because 1.3.0's prose is _about_ a field that read back
  as `undefined` and the blunt check fails on a correct render.

  Entries whose bold lead is a whole sentence get it pulled onto its own line; entries that bold
  only the subject and run on — "…**filled the page**, because the text column pass ran to the
  limit" — are left as one flowing paragraph, because splitting those puts a line break before a
  comma.

  Anything that shipped since the version you last read is marked, and says so from the menu bar
  panel and the sidebar footer as well as in Settings — once, until you look. A fresh install is
  treated as caught up rather than greeted with five unread releases.

### Fixed

- **The Simulator's tab bar was there all along; the walker could not see it.** `docs/simulator.md`
  recorded the tab bar as "genuinely childless, not merely unwalked": every children attribute on
  the `AXGroup` answers 0. That was measured correctly and concluded wrongly. Hit-testing the
  group's frame returns four `AXRadioButton`s, each naming that group as its `AXParent` and each
  taking `AXPress` — the edge is one-way, the children know the parent and the parent does not
  list them. A walk that descends only `AXChildren` stopped there and reported the walk complete,
  which is worse than a truncated one because nothing said so.

  `AccessibilityDriver.walk` now sweeps the frame of a container whose children link is empty with
  `AXUIElementCopyElementAtPosition`, keeps every distinct hit whose parent chain leads back to the
  container, and walks those as its children; `apple_desktop_expand` and
  `apple_simulator_ui_tree` on such a handle do the same. The answer carries `recovered` when it
  happened. On the screen that found it the walk went from 8 elements to 17: the tab bar's four
  items and, from a navigation bar with the same broken link, a heading, a search field and three
  toolbar buttons. Measured across seven Mac apps first: a hit-test costs 0.3–3 ms and a whole
  tree holds at most five containers that qualify, so the sweep runs on every walk rather than
  behind a switch.

  The part worth knowing as a caller: the recovered tab items carry their SF Symbol name as `id`
  (`leaf`, `checkmark.circle`, `calendar`, `cross.case`), which does not change with the device's
  language. WebDriverAgent gives the same tabs no identifier at all, only the translated label —
  so on this one point the Accessibility lane addresses more stably than the runner does. The
  tool descriptions say so, and the sentence that called the tab bar an empty container is gone.

- **Turning on "Reach any application" could remove Screen's capture tool rather than widen it.**
  The `surface` argument's `enum` IS the scope, so lifting the gate has to lift the constraint —
  but it did that by setting the key to `nil`, and `"enum": null` is not valid JSON Schema. A
  client that validates the tool list drops the whole tool instead of reporting the fault, so the
  switch meant to broaden capture silently took it away. The key is omitted now when the gate is
  off. `screen-check` asserts on the serialized bytes, because a `[String: Any]` lookup reads an
  absent key and a null one identically — which is exactly why the check it already had passed.

### Security

- **`find_codes` says which service delivered a code, because `confidence` cannot.** iMessage is
  authenticated against an Apple ID; SMS and RCS sender IDs are not, and can be forged — the `From`
  on a text is a routing hint the sending network fills in, not a credential. `confidence` measures
  how cleanly a code was extracted from the message text, and all of that text is
  attacker-controlled, so a spoofed SMS naming a domain scores `high` exactly like a real one;
  `ageSeconds` does not help either, since a planted code is fresh. Every match now carries
  `service`, and the tool description says what it does and does not mean. Deliberately **not**
  done: filtering or down-ranking SMS matches. Genuine codes arrive overwhelmingly that way — this
  store holds 796 SMS handles against 265 iMessage and 15 RCS — so the point is not to discard
  them, it is not to treat a code as proof of anything.

## [1.17.0] - 2026-09-07

### Added

- **A `simulator` surface.** Simulator.app bridges a simulated device's accessibility tree into the
  Mac's, so an iOS app's own controls are readable and pressable with no WebDriverAgent and no
  runner process — and until now reaching them cost switching Desktop to "Reach any application",
  which opens every window on the Mac to touch a developer's own app. The new surface is served
  in-process, pinned to `com.apple.iphonesimulator` with no switch that widens it, and answers in
  **iOS points**: the device screen is found as the `AXGroup` whose size is the device's point size
  times the window scale, the scale is measured against CoreSimulator's own `profile.plist` rather
  than assumed to be 1, and every `rect` and `point` can be handed to `ios_simulator_tap` unchanged.
  Four read tools and, behind writes, `press`, `tap`, `swipe`, `type`, `key` and `press_button`.
  Deliberately absent: boot, install, launch, screenshots, push and staging, which need no grant and
  belong to `@mgcrea/mcp-ios-simulator`. Measured in [docs/simulator.md](docs/simulator.md): a
  click lands only once the Simulator is frontmost, a drag arrives as a touch pan, and the Simulator
  forwards key codes rather than characters, so typing goes one key at a time on the Mac's layout.

### Fixed

- **A depth-capped walk silently dropped every sibling after the first branch that hit the cap.**
  The depth bound set the same "stopped" flag the node and time bounds do, and the walk returns on
  that flag before visiting the next node — so a depth-1 listing of a window with eleven children
  answered one and named `depth(1)` as the reason, which is true and useless. Found by the first
  simulator probe; the cap is reported and no longer stops anything.

- **A message addressed to a group could be delivered privately to one person.** The send lane
  passed a group chat's first participant as its handle, and the JXA ladder guesses a one-to-one
  chat id from a handle whenever the chat lookup above it throws. Reconciliation then polled the
  group and found nothing, so it reported `pending` — "do not send again" — for a message that had
  been sent, to the wrong recipient. A group ref now carries no handle at all.

- **Every Maps favourite carried a wrong Apple place id, and synced it.** The donor's `ZMUID` is a
  64-bit integer read deliberately as text because a real one is past `MAX_SAFE_INTEGER`; the write
  put it back through a JavaScript number, which SQLite binds as a double. The id landed rounded —
  measured 233 away — in a CloudKit-mirrored store, so it reached every device on the account.

- **A pruned audit log reported itself as tampered with.** Retention drops whole segments, and the
  verifier started every run from genesis, so the oldest surviving record was always a broken link
  and the Activity pane went red saying a record had been removed. It now seeds from the surviving
  segment's own link and reports "verifies from segment N". A mislabelled first segment and a gap
  in the middle are still failures. Retention's 30-day bound also never ran on a Mac that logs a
  few hundred calls a day, because pruning only happened on a 4 MB rotation.

- **A mailbox filter that matched nothing searched everything instead.** An empty set of index
  rowids read the same as "no filter asked for", so a scoped Mail search could return other
  accounts' messages and a per-mailbox count could report the whole archive. It refuses now, naming
  the mailboxes the index actually holds.

- **Notes ignored the account allowlist and the folder argument whenever it could read the store.**
  Both failed open, and only on machines with Full Disk Access — which is exactly where they
  matter. Both now take the slower Apple Events lane rather than answering with what was not asked
  for.

- **Date arguments were parsed six different ways, and three of them were wrong.** An unreadable
  date became `NaN`, which SQLite binds as `NULL`, so Mail answered a date written in words with
  zero results and no error. A bare day meant UTC midnight in some places and local midnight in
  others. An upper bound naming a day excluded that whole day. `2026-02-30T09:00` silently became
  2 March. There is one grammar now, in core, and it refuses what it cannot read.

- **Mail's composer waited on the wrong signal, and asked the wrong object who had focus.** Two
  fixes from before this release: the readable state is not ready when the window appears, so the
  focus is polled; and focus is a property of the application, not of the element being addressed.

- **`find_codes` could miss a code that was right there.** Its limit capped the messages scanned
  before the user's own replies were filtered out, so an ordinary few minutes of conversation
  pushed the code off the page. Direction is now a database predicate, and the limit applies to the
  codes returned.

- **Messages search returned nothing recent once older results filled the page**, because the text
  column pass ran to the limit before the archived-blob pass got a look — and every message since
  March 2026 lives only in a blob. The two passes are merged by date now.

- **`update_event` ignored `end` and `durationMinutes` unless `start` came with them**, reporting
  success and changing nothing.

- **Contacts' diagnostics said the surface registers no mutating tool**, while two have been
  registered behind its write flag.

- **A search could invalidate the element handles it had just issued**, because the handle store
  emptied itself at capacity while a search was still filling it.

- **An attachment whose name is not ASCII could be neither listed nor saved.** A filename is the
  one MIME parameter that routinely is not ASCII, and it has two encodings; neither was handled.
  One returned nothing, so the attachment was reported as having no filename at all; the other
  came back verbatim, so saving it wrote a file literally named `=?utf-8?Q?...?=`.

- **Safari reported when a page was first visited using only the visits inside the window asked
  for**, while the visit count beside it stayed the page's lifetime total. A search of last week
  said a page had been first visited last Tuesday when it had been open since 2019.

- **A full page of calendar events was indistinguishable from a quiet week.** The existing
  truncation flag is about how far the store's expansion reaches, so a dense day answered with the
  default fifty read as the whole day. There is a `hasMore` beside it now.

- **Counting messages by a phone number only worked if you spelled it the way the store does**,
  while sending to that same number resolved it properly — in the same server, against a
  description promising both spellings work.

- **Mail grouped by UTC days while filtering by local ones**, so a message that arrived at 23:30
  counted against the next day.

- **A wedged server was never cleaned up.** Closing its input is a request to exit, and one that
  ignored it held a thread, three pipes and a process for as long as the app ran.

- **A malformed request got no answer at all** from the three surfaces the app serves itself, so a
  client that sent broken JSON waited forever instead of being told.

### Changed

- **The driving notice is an on-screen panel, not a menu bar badge.** See the correction under
  1.16.0: the badge could never render. The panel does not take focus and does not steal a
  keystroke from the sequence it is reporting on.

- **Simulator.app is a brokered application.** The `simulator` surface's entry in the manifest puts it
  into the set Desktop reaches without "Reach any application" and Screen can capture, by design;
  the Desktop guide's paragraph about it is no longer gated on the reach and sends a caller to the
  `simulator` surface for iOS-point coordinates. Every "the eight applications Cupertino brokers"
  string now says nine.

- **The Desktop guide's writes-on line names all eight driving verbs.** It listed six; `focus` and
  `activate` were registered and unmentioned.

- **Walk bounds have a ceiling**, so a budget of an hour cannot hold a session thread for one.
  `find_elements` also declares the `window` argument it has always honoured.

- **The handshake has a deadline on the app's side too.** A process that connected and sent nothing
  used to hold a thread and a descriptor until it exited.

- **Notes and Reminders listings say when they were cut short.** `apple_notes_list_notes`,
  `apple_notes_search_notes`, `apple_reminders_list_reminders` and
  `apple_reminders_search_reminders` now answer with an object — `notes` or `reminders`, plus
  `source` and `hasMore` — rather than a bare array. **This changes the output shape of four
  shipped tools.** A caller that indexed the result directly has to read the named field instead.

  The reason is that all four truncated silently, and two of the three bounds involved are nothing
  the caller asked for. The Apple Events lane stops at its own cap (200 notes, 500 reminders)
  regardless of `limit`, because a bulk read costs about 700ms per property whatever the library
  size — so asking for 500 and receiving 200 was indistinguishable from asking for 500 and there
  being 200. The Reminders index lane over-fetches from SQL and applies the date, flag and priority
  filters afterwards in JS; when those reject nearly everything, the window runs out before the
  page fills and the answer comes back short. `hasMore` reports that more matched than the page
  carries; a `note` field appears only when a lane bound rather than `limit` is what ended the
  list, so it names something the reader can act on. Both diagnostics tools now report the cap.

### Security

- **`click`, `type` and `key` now light the driving notice.** They are the most invasive verbs
  here — landing at a screen point, or in whatever is frontmost — and they were the only ones that
  did it without saying so.

- **The application support directory is 0700**, and an existing one is tightened rather than left
  as it was found. The socket is created under a private umask rather than narrowed a moment later.

- **Saving an attachment no longer checks and then writes**, which was two steps with a window
  between them, and it refuses a bad destination before doing the work rather than after.

- **A failed audit write is reported instead of swallowed**, so a full disk stops looking like
  tampering after the fact.

### Internal

- CI runs the Desktop server's own check, which is the only gate on its refusal paths, and a
  release is refused if the CHANGELOG has no entry for the tag.
- `dispatch-check` compares tool lists as canonical JSON. It compared the wire text, and Swift seeds
  a dictionary's hashing per instance, so two identical lists differed at byte 22: the "a gate
  changes something" assertion passed for free on every gated surface, and the "no gate changes
  nothing" assertion failed on the first surface without one. It also pins that nothing — no gate,
  no lent scope — moves the simulator surface's reach, and CI runs `simulator-check`.
- The README check now reads the per-surface tool tables and the prose under them, not just the
  Surfaces table. Eleven registered tools were missing, and Safari's section still called the
  surface read-only while registering five write tools.

## [1.16.0] - 2026-09-06

### Added

- **Mail's composer runs on Cupertino's own Accessibility driver now, behind one grant instead of
  two.** Reply and forward reached the composer through System Events, which costs a second TCC
  grant — Automation to System Events — on top of Accessibility, and 47.4 ms per attribute read.
  Driven natively the same reads cost 0.202 ms. Both grants always had to be given; only one of
  them has to exist.

  The split between the two halves is forced rather than chosen: a JXA object reference cannot
  outlive the `osascript` process that made it, so opening and addressing the draft stays an Apple
  Events call and returns the subject, which is what the native half finds the window by.
  Everything after — the paste, the read-back, the send — is Accessibility. That makes the send
  command-shift-D rather than the button named "Send", which is correctness rather than
  convenience: a French Mail says "Envoyer" and the shortcut is not localised.

  **System Events stays as the fallback**, because the npm packages are published artifacts that
  have to keep working with no Cupertino on the machine.

  One behaviour is deliberately given up and reported rather than hidden. The System Events path
  discards a composer when a paste provably did not land, so a retry is safe. This one cannot:
  closing an unsaved composer raises a save sheet whose buttons are localised, and pressing a
  button by a name that is only right in English is worse than pressing none. A failed compose now
  leaves the window on screen and says so — strictly safer, since nothing anybody wrote is
  destroyed, and strictly less tidy.

- **Maps can reach the objects its SQL lane cannot.** `apple_maps_save_place`,
  `apple_maps_remove_saved_place` and `apple_maps_add_place_to_guide` drive the place card through
  the same driver. They do not replace the store lane and could not — pressing Add lands an unfiled
  saved place and never touches a favourites row — but they reach the Places library and guide
  membership, the second of which was listed as unbuilt. Reading the guides beats the store's own
  answer: eleven guides came back live where `apple_maps_list_collections` reports ten.

  **Filing into a guide works and cannot be verified, so the tool refuses to claim it.** Pressing a
  row does select it, and nothing in the tree says so — the label carries a stale count that reads
  identically before and after. So it returns `filed: "unverified"` and says it must not be
  reported as done.

  Registered only when Cupertino is hosting the server, since the Accessibility grant belongs to
  the app.

- **Four more Desktop verbs, three of them the kind whose absence makes a write land somewhere
  else.** `focus` — raising a window is not focusing a field, and the keystroke that follows goes
  wherever the focus actually is, so it reads the focus back and reports whether it took.
  `activate` — synthetic keystrokes are posted to the session and land in whatever is frontmost, so
  `type` and `key` against a named app need this first. `get_attribute` — for the one field a
  caller needs that the walk's fixed set does not carry. And `user_activity`, below.

- **The Mac says when it is being driven, and notices when somebody else is using it.** Driving is
  the one capability here that competes with the person at the keyboard: a synthetic keystroke goes
  to whatever is frontmost and a click goes to a screen point, so somebody typing during a sequence
  does not slow it down, it corrupts it.

  `apple_desktop_user_activity` reports seconds since a person last touched the machine. It reports
  _when_, never what — no key, no position, no content — which is why it needs no grant and
  registers as a read. Measured against how long a sequence took, that figure separates "they typed
  just before we started" from "they typed into the middle of it", and every refusal in the Mail
  and Maps lanes now appends the finding when there is one. It stays silent when the machine was
  quiet, deliberately: "nobody touched it" invites the reader to stop looking.

  It exists because of a misdiagnosis rather than a theory. Three Maps failures were blamed on
  interference and turned out to be bugs in the lane; one was blamed on the lane and turned out to
  be interference.

  A menu bar indicator lights while an interface is being driven, and the popover says which app.
  macOS supplies an indicator for the microphone and the screen; it supplies none for
  Accessibility, which is the wider grant. It expires rather than being switched off, because
  nothing tells the app an agent has finished and an explicit end would leave it lit forever the
  first time a client disconnected mid-sequence.

  **Correction, added after release: the badge described above never appeared.** A menu bar item's
  button cannot be recoloured while its window is closed, which is the only state it is ever in.
  What actually shows the notice is an on-screen panel, added in Unreleased below.

### Changed

- **A node server can borrow the app's Accessibility driver over the socket it already has.** This
  is what lets Mail's composer run natively without anyone switching on the Desktop surface — the
  consent governing Mail's own window is Mail's — while equally not escaping Mail being switched
  off. The handshake line naming the borrower is a claim and nothing rests on it: `LOCAL_PEERPID`,
  answered by the kernel and unspoofable by the peer, is what turns "I am the mail server" into a
  check. Without it any same-user process could borrow the app's grant.

- **Desktop's reach is a value now rather than a switch**, so it can be narrowed as well as
  widened. A borrowed driver is pinned to one bundle id, and no user-facing gate can move it. The
  tool descriptions get a real third branch rather than folding it into the brokered wording — a
  description promising the brokered set to a caller that can reach one app is an invitation to try
  the other seven and collect a refusal each time.

### Fixed

- **`apple_desktop_key` could have quit Mail with an unsaved composer open, silently, and only for
  people not typing on a US layout.** It shipped with a table holding no letters at all, so
  command-V could not be expressed. The obvious repair is the US map, and it is destructive: a
  `CGKeyCode` names a physical position, not a letter. Measured on an AZERTY Mac, `a` resolves to
  12 and `w` to 6, which in the US table are `q` and `z` — so "select all before pasting a reply"
  would have sent command-Q. The map is built by asking the current input source what each of the
  128 codes produces, and cached on the input source id so switching layout rebuilds it.

- **`apple_desktop_find_elements` reported `matched` from the whole walk instead of the filtered
  set** — one control found and an answer saying 136 matched, which reads as a truncated result and
  is precisely the confusion the field was added to prevent. The byte cap was wrong the same way,
  measured against elements that were never going to be sent.

- **`apple_maps_diagnostics` reported that the server registers no mutating tool while it registers
  two**, and had been wrong since the write lane shipped. Diagnostics is the one thing this repo
  says must never lie. It now reports the real lane: URL-scheme seeding, raw SQL, the Recents side
  effect and the CloudKit blast radius, keyed on whether writes are on.

- **The "Load tools on demand" control was drawn on three surfaces where it did nothing.** Desktop,
  Screen and Sound are served in process, and the facade reaches a server through the spawn path's
  environment, which an in-process server never reads. Moving the picker changed nothing, which
  reads as a bug in the facade rather than in the card. It is gated on the node runtime now.

- **`make desktop-check` counted a check that had vanished.** A case added for `matched` was
  written so that on a machine without Maps it did not fail — it disappeared, and the suite went 51
  to 50 while still printing "passed". Skips are counted and named now. The count is the only line
  most people read.

- **Three findings this repo had published are retracted, having been measured wrong.** A
  background application's menus _do_ open — the original write-up was a single A/B with no
  repetition and no control; re-run as six alternating trials the menu opened every time in both
  conditions. What actually governs it is the session boundary: closing the connection dismisses an
  open menu. Safari's page text was called "an absence rather than a price" on a census that was
  measuring System Events; natively the same Safari has one web area, 26 links and 10,735
  characters. And a Maps delete does not alternate between taking effect and raising an alert —
  both shapes are real and a driver must handle either, not expect them to take turns.

  The retractions are kept in full rather than quietly deleted, because how each was got wrong is
  more useful than the answer.

## [1.15.0] - 2026-09-06

### Added

- **Cupertino can drive any app on the Mac now, not only the seven it brokers.** The new Desktop
  surface reads and operates interfaces through the Accessibility API: list what is running, walk a
  window's element tree, find a control by name, press it, expand a disclosure. It is a capability
  rather than a broker — there is no target app, and it reaches whatever is in front of you.

  This lane had been closed three times here, on numbers that were measuring something else. Every
  Accessibility measurement this project took before it went through `osascript` and System Events,
  one Apple Event per attribute, so the 33.6 ms round trip in the Safari notes and the ~14 s place
  card in the Maps notes were the price of the transport rather than of the API. Called natively the
  same Maps card walks in 0.177 s, and 13,960 nodes across seven apps average 1.24 ms a round trip.
  86% of pressable elements carry an identifier, title or description, so a control is addressed by
  name rather than by guessing at coordinates.

  **It arrives switched off, with its writes gated,** the way Screen and Sound do. The Accessibility
  grant is per-process and all-or-nothing: it hands over every window on the machine, far past
  anything Cupertino is asked to broker, so it is switched on by the person who wants it rather than
  found already on.

- **A tool list can be traded for a searchable index now.** Listing every tool across the eight
  servers with writes on costs ~106 KB — roughly 26.5k tokens, paid by every client on every
  connect, whether or not one tool is ever called. `*_LAZY_TOOLS`, off by default, swaps the list
  for `search_tools`, `describe_tool` and `call_tool`, plus a separate `call_write_tool` when writes
  are on, so a host's read/write permission boundary survives the facade rather than collapsing into
  one anonymous name. `diagnostics` stays eagerly listed, since it is what every surface guide
  points at first on a refusal.

  In the app it is a per-surface **Load tools on demand** control, defaulted app-wide in General and
  overridable in each surface's Access card. Activity still names the tool that actually ran —
  `apple_mail_send_message`, not the dispatcher that carried it.

### Changed

- **Every tool listing is 4.6% smaller, on every server and without opting in to anything.** The MCP
  SDK stamps a generated `"$schema"` key onto every `inputSchema` and `outputSchema` it emits, and
  nothing in the protocol ever reads it back. It is dropped from the outgoing listing now.

### Fixed

- **The Maps notes no longer describe a favourite that never got written.** Four claims there had
  been read off read-only dumps of the interface; pressing the control for real falsifies all four.
  It opens a naming sheet instead of writing a favourite, what lands is an unfiled saved place
  rather than a favourites row, the control is not a toggle, and the state bit lives on the sibling
  button beside it. Only the addressing claim survived.

- **The website describes what actually ships now.** Desktop was missing from the surface list
  entirely; the whole list sat under "each surface is its own npm package", true of only eight of
  the eleven; and the menu-bar mock captioned every row "automation allowed", including Maps and the
  three capabilities, which send no Apple Event at all. The site reads `KIND`, `USES_APPLE_EVENTS`
  and `SUPPORTS_WRITES` generated from `surfaces.json` now, so a card or a caption cannot drift from
  the manifest again.

- **The pricing note no longer promises a ladder that was retired.** The surface list claimed that
  adding a surface raises the price, and `docs/licensing.md` carried the promise and its retraction
  in one document — a table still saying "rising with the surface count" above a section describing
  the ladder as retired. The price stayed flat across the whole 1.x line through three new surfaces,
  and listing one commits to support at the price already paid.

## [1.14.0] - 2026-09-04

### Changed

- **Screen and Sound arrive switched off.** Every surface that brokers an Apple app is on when
  Cupertino is installed; those two now are not. Their grants are the ones that do not stop at the
  surface being brokered — `kTCCServiceScreenCapture` is per-process and sees every window on the
  display, and the microphone hears the room, neither scoped by macOS to the thing Cupertino is
  asked for. A capability that reaches that far past what it brokers should be switched on by the
  person who wants it rather than found already on.

  The default is per surface now, `defaultEnabled` in `surfaces.json` and generated into
  `Surface.all`, rather than the constant `true` that `SurfaceSettings.isEnabled` and three
  `@AppStorage` initialisers each spelled out on their own. A surface added later declares what it
  should be in the same manifest entry that declares everything else about it, and the app and the
  relay cannot drift into disagreeing about which surfaces exist.

  **On a Mac where they are on today, they go off.** Neither ever wrote a `surfaceEnabled` key —
  1.8.0 and 1.11.0 shipped them on by absence — so an untouched switch now reads the new default.
  The entries already in a client's configuration stay there, flagged in that client's pane as
  naming a switched-off surface, until the next Configure takes them out. Switching either surface
  back on in the surface list restores it and rewrites the entry.

### Fixed

- **Visual Studio Code is actually wired now.** 1.13.0's notes announced it and the build did not
  carry it: the `vscode` entry never reached `ClientWiring.swift` before that release commit, so the
  client that had just been taken off the paste-a-command list was on no list at all. It is there
  now, merged into `~/Library/Application Support/Code/User/mcp.json` — strict JSON under `servers`,
  written by VS Code itself, and not the JSONC `settings.json` the two files were conflated as.

- **The website's buttons no longer flash blue before the page finishes loading.** The design tokens
  sat in the last 13% of a 33 KB stylesheet, and Safari paints from a partially parsed sheet at
  around 250 ms, so on a cold load every colour var resolved invalid and the buttons rendered in the
  browser's link blue. Tokens are their own file now, imported first.

## [1.13.0] - 2026-09-04

### Changed

- **Visual Studio Code is configured with one click, not a pasted command.** It was held back on
  the grounds that its config is JSONC and re-serialising it would delete somebody's comments. That
  was a mix-up between two files: `settings.json` is the JSONC one, and `User/mcp.json` — where VS
  Code actually keeps MCP servers, under a `servers` key rather than `mcpServers` — is strict JSON,
  written by VS Code itself.

  The residual worry does not survive being looked at either. Every write begins with a read and
  `JSONSerialization` throws on a comment, so a file somebody has commented reads as unreadable and
  the write refuses. It fails closed: it cannot strip a comment it cannot parse.

- **ChatGPT & Codex is configured with one click too, and `~/.codex/config.toml` is spliced rather
  than re-serialised.** That file is the one config here that is genuinely not safe to round-trip —
  twenty-nine `[projects."…"]` tables, a `[features]` block and a multi-line string full of
  markdown on the machine this was written against. `ClientWiringTOML`, ported from Bastion,
  replaces the lines that hold MCP servers and quotes every other byte verbatim, so a wire produces
  a diff with one hunk in it and an unwire gives the file back exactly.

  It also gets what a pasted command could never give it: a real status. The row now reports
  `configured`, `incomplete` or `points elsewhere` like every other client, and it reports the one
  thing no JSON client can — `enabled = false`, which Codex honours and which the ChatGPT app is
  reported to set on servers it did not expect. An entry in that state still points where it
  should, so it audits as configured while Codex runs none of it; the row says so.

- **The row is called "ChatGPT & Codex" rather than "Codex CLI"**, because the ChatGPT app, the
  Codex CLI and the Codex IDE extension all read that one file — the ChatGPT app bundles the Codex
  binary and names it in `CODEX_CLI_PATH`. The old name sent somebody who had installed only
  ChatGPT looking for a row that was already there.

  The reason recorded for ChatGPT having no row of its own was also wrong, and is corrected: it did
  not "take remote HTTP connectors only and cannot spawn a local stdio server at all". Connectors
  are remote-only; the Codex lane inside the same app runs local stdio servers and ships three of
  its own in that file. It has no row because it is not a separate client.

- **`apple_mail_query` is on every mail server now, not only the read-only ones.** It was held back
  on budget grounds — a tool costs listing tokens on every connect, and this one had to prove it
  saves more than it costs — and the measurement in [mail-query.md](docs/mail-query.md) settled
  that a while ago: 64x on a grouped question, against a ~716-token listing.

  What the budget argument missed is that `allowWrites` is a per-surface switch, so the only way to
  reach a lane that reaches nothing but the index was to give up send, reply, move and delete for
  Mail across every client at once. Nobody makes that trade, which made the tool invisible to
  almost everyone — including the website, which has been listing it as a plain read tool.

- **Client rows show the editor's real icon instead of an SF Symbol.** Cursor, VS Code and every
  other row in the sidebar, the client detail header and Settings' automation table now draw the
  installed app's own icon, looked up by bundle id or by path. `SurfaceIcon.swift` becomes
  `AppIcon.swift` and the lookup is shared, so surface icons and client icons stop being two
  unrelated pieces of code that happened to render the same size.

  Two knock-on fixes. Cursor's fallback symbol moves from the chevron-brackets glyph to
  `cursorarrow`, because the brackets now belong to VS Code and having both wear them was the
  reason the fallbacks read as interchangeable; and ChatGPT & Codex gains a bundle id
  (`com.openai.codex`) so its row can resolve to a real icon rather than being the one client that
  could never have one.

  Lookups are disabled under a screenshot capture. The goldens would otherwise depend on which
  editors happen to be installed on the Mac doing the capturing, which is a gate that fails for a
  reason that has nothing to do with the change under test.

### Removed

- **Nothing has to be pasted into a terminal any more.** With both remaining clients written, the
  copy-a-command lane had no users: the `Recipe` templates, the shell quoting, the two copy
  buttons, the "VS Code has no command that removes a server" paragraph and the `unknown` status
  that existed only because a pasted client could never report one are all gone. Zed and Goose are
  still the reason to remember it existed, and neither is JSON or TOML, so the honest way to add
  them is a third `Wiring` case rather than a snippet maintained blind.

## [1.12.0] - 2026-09-03

### Added

- **A pane per MCP client, in the main window.** The seven clients Cupertino knows about were seven
  rows in a Settings form — a name, a glyph and one button each. They are a sidebar section now,
  and selecting one opens the file: its full path, the entry that would be written for every
  switched-on surface, what is under each of those keys right now, and the servers in that same
  file Cupertino did not write. The dot beside a client in the sidebar and the sentence at the top
  of its pane are the same computation over the same read, so they cannot disagree.

  The reason it is a pane rather than a bigger row: this feature writes files somebody else owns —
  `~/.claude.json` on the machine it was built against holds twelve servers and a hundred project
  blocks — and a form row had space to summarise that in one sentence and nowhere to show it. Ported
  from Bastion, which solved the same problem one repo over.

- **Remove Cupertino's entries.** The other direction of Configure, and deliberately not reachable
  from it: one button writes what is switched on, the other takes out everything `isOurs` claims,
  including an entry left by a copy of the app that has since moved and a key from before the
  `apple-*` rename. Until now nothing removed them at all.

- **Remove… on a server Cupertino did not write.** The last step of moving a hand-configured Apple
  server over: it is running through Cupertino now, and the entry that starts its own copy is still
  there. It refuses a key `isOurs` claims, so it cannot become a second route to the button above,
  and it names the key, the file and the backup before it writes anything.

- **Unwiring a project folder.** Forgetting a folder only ever dropped it from a list in this app
  and left its entries in Claude Code's config, where they went on giving every session opened there
  a tool list nobody had asked for. Forget and Unwire are two buttons now, because they were always
  two acts.

- **`make wiring-check-real`.** The same merge assertions, run read-only against the real client
  configs on this Mac. Fixtures are written by whoever is asserting things about them; the shapes
  that break a merge are the ones nobody thought to fixture.

### Changed

- **Configure refuses to overwrite a server it did not write.** `cupertino-<surface>` reserves a
  namespace precisely so a collision cannot happen by accident — and for as long as nothing checked,
  the accident that could not happen was also the one that would be silently overwritten. The pane
  names the keys and offers to overwrite them anyway; the refusal is the default. Nothing else about
  the write changed: same stamp, same backup, same atomic swap.

- **Settings has no Clients section.** Everything true of one client now lives in that client's pane,
  the way everything true of one surface already lived in its own. The project-folder controls moved
  with it, into Claude Code's pane, since both files they write are Claude Code's.

- **The sidebar puts Activity above Clients**, and is slightly wider. Clients is the only section
  whose length is a property of the machine rather than of this app, and a variable-length list above
  two fixed rows is how Log and Connections end up below the fold on somebody else's computer. They
  did: the first version of this pushed Activity off every window and every marketing plate.

- **A surface's "still listed by N clients" button goes to the client that lists it** rather than to
  a settings pane listing all of them.

### Fixed

- **Every update dialog since 1.1.0 showed literal `###` headings and `- ` bullets.** Sparkle renders
  an appcast item's `<description>` as HTML, and `make appcast` sliced the raw markdown section
  straight into the CDATA — so the release notes shown to someone deciding whether to replace an app
  that holds Full Disk Access were the one piece of this release process nobody could see while
  writing it. `scripts/changelog-notes.mjs` renders the section instead: headings, bullets with their
  continuation paragraphs, bold, italic, code and links, with no dependency. It keeps the guard that
  refuses a version whose CHANGELOG section is missing, and escapes `]]>` so a stray one cannot close
  the CDATA early.

## [1.11.0] - 2026-09-03

### Added

- **`apple_messages_count_messages` — counting, grouped, on the Messages surface.** Totals with a
  sent/received split, and `groupBy` over day, month, chat, handle or direction. It aggregates in
  SQL over every match, so "who do I message most" or "was August busier than July" costs one small
  result rather than a page of conversations tallied by hand — and past the first `limit`, tallying
  a listing does not merely cost more, it returns the wrong number.

  It is the counting half of Mail's query lane and deliberately not the rest. Projection was
  dropped: `select` pays on mail because a mail row is metadata around a small payload, while a
  message row's bulk is its text. Per-chat totals were already there, from the `COUNT()` behind
  `apple_messages_list_chats` — so the groupings that ship are the ones that tool cannot answer, of
  which `handle` is the one worth having: a person can hold several conversations, and only this
  adds them together.

  **There is no text filter, and that is a boundary rather than an omission.** Message bodies from
  March 2026 onward live only in `attributedBody`, which is why `search_messages` carries a
  JavaScript decode pass. No `GROUP BY` reaches inside a blob, so a counted text filter would be
  right for 2016-2025 and quietly wrong for everything since, with nothing on the result to say so.
  What this lane counts, it counts completely; anything about what was said stays with the search
  tool.

  Two traps are pinned by tests: tapbacks are excluded by default (2,788 rows that nobody typed),
  and every count is `COUNT(DISTINCT m."ROWID")`, because the chat join is one row per
  (chat, message) pair and a message filed in two chats would otherwise count twice. Day and month
  buckets are LOCAL calendar dates — texting peaks after midnight, and a UTC bucket moves those
  messages into the previous day. Mail's buckets are still UTC; `docs/messages.md` lists aligning
  them as open.

### Changed

- **The footer's "More apps" column lists three siblings rather than one.** Bastion, DevPulse and
  D1Explorer, each with a one-line blurb as its `title`. A single link beside four full columns read
  as an unfinished list, and three is a short recommendation rather than a link farm: every one of
  these is an `mgcrea.io` subdomain, and a full mesh between all nine would be the latter. The list
  is its own `FOOTER_APPS` constant, kept apart from the `SIBLING_APP` that feeds the homepage card
  — the two are sized for different places and were drifting toward one shape that fits neither.

### Fixed

- **The Sound pane advertised the Screen surface's tools.** The Capabilities card does not keep a
  list of its own — it asks the server and renders the answer, which is what lets it demonstrate
  that a gated tool is never registered rather than refused later. For the two surfaces the app
  hosts itself it asked `ScreenServer` for all of them, so Sound's pane listed
  `apple_screen_list_targets` and `cupertino://screen/guide`, and switching **Allow microphone
  recording** on made `apple_screen_capture_surface` appear, because the gate was read by position
  rather than by ID. The write flag was accepted and then dropped, so `apple_sound_set_volume` could
  not have shown up even once the right server answered.

  Only the card was wrong. `ServerHost` dispatched correctly the whole time, so a real MCP client
  always reached the right server — which is also why nothing caught it: `make screen-check` and
  `make sound-check` each drive one server directly, and both servers were fine.

  Which server serves which surface, and what each one has to be told, now lives in one place
  (`InProcessServers`) used by both the host and the card, and `make dispatch-check` asserts that
  every in-process surface answers under its own name with its own `apple_<id>_*` tools and
  `cupertino://<id>/*` resources, under every combination of the write flag and its gates.

- **`docs/sound.md` named a `play` tool that was never built**, and left `diagnostics` off the same
  row. `afplay` went with it: nothing shells out to it, so listing it as part of the free half's
  lane described a capability the surface does not have.

## [1.10.0] - 2026-09-02

### Added

- **`apple_mail_query`, projection and aggregation over the Mail index.** "Top ten senders" or
  "unread per account" is now a `GROUP BY` the server runs, rather than a page of rows pulled into
  the context for the model to tally. It takes the same filters as `apple_mail_search_messages` and
  shares its WHERE-clause builder, so a filter that narrows a listing cannot silently miss the
  aggregate.

  **Aggregation always runs before `limit`, never after.** `limit` caps the number of groups
  returned, and the envelope carries `totalRows` — messages aggregated, never capped — alongside
  `truncated`, so a top-N answer cannot be mistaken for "top N among the page we happened to
  return." That distinction is the whole reason to have the tool: an aggregate computed over a
  truncated page is not a wrong number so much as a confidently wrong one.

  It registers on read-only servers only, for now. Not because it is unsafe with writes on — it
  reaches nothing but the index — but because every tool costs listing tokens on every connect, and
  this one has to prove it saves more than it costs before it goes on the surface most clients see.
  A Code-Mode-style single `execute` tool was considered and rejected first; it relocates the
  tool-surface cost rather than removing it, and collapses per-operation permissioning into one
  opaque call. See [docs/mail-query.md](docs/mail-query.md).

- **The site credits Magenta Creations with the mark**, in the footer, the same form every mgcrea
  site uses. "Unofficial. Not affiliated with Apple" says who this is not, not who made it.

### Changed

- The Microphone row in a surface's Access card now says **"Ask…"** when the button raises the system
  prompt and "Allow…" when it opens the pane, matching the menu-bar popover — it had said "Allow…" in
  both states. Answering the prompt also updates the row now, instead of leaving it reading
  "Microphone needed" until something else triggered a refresh.

### Fixed

- **The Microphone permission could not be granted at all.** 1.9.0 shipped the `sound` surface
  without `com.apple.security.device.audio-input` in the app's entitlements. The app is unsandboxed,
  but the hardened runtime gates resource access too, and without that key macOS does not refuse the
  recording — it refuses to ask: `AVCaptureDevice.requestAccess` returned `false` with no consent
  dialog, and wrote no TCC row. So Cupertino never appeared in Privacy & Security › Microphone, and
  that pane — unlike Full Disk Access, Screen Recording and Accessibility — has no "+" button to add
  it with. The "Allow…" button opened a window with nothing in it to switch on.

  Upgrading is the whole fix. There is no stale grant to clear and no `tccutil reset` to run, because
  the refusal was never recorded.

  `scripts/spike-app-tcc` missed this because it signed its bundle without `--options runtime`; it now
  signs hardened with the app's own entitlements, so a lane that passes describes the app that ships.

## [1.9.0] - 2026-09-01

### Added

- **A tenth surface, `sound`, and the second the app serves in-process.**
  `apple_sound_list_devices`, `get_volume`/`set_volume`, `set_muted`,
  `set_default_device`, `speak`, `recording_status` and `diagnostics` need no grant at all;
  `start_recording`/`stop_recording` sit behind a new `allowRecording` gate that needs the
  Microphone permission.

  **`allowRecording` is independent of `allowWrites`, deliberately.** Volume, routing and speech are
  mutations, but they are not recording, and a caller that wants to set the output device should not
  have to grant the ability to record a room to get it.

  Recordings are written as CAF and never m4a: a truncated m4a is a total loss, where a truncated
  CAF still opens. A recording is exactly the file you do not get a second attempt at.

- **Report an Issue, Send Feedback and Cupertino Support in the Help menu**, matching the rest of
  the fleet. `trackerURL` points at this repository rather than the shared tracker, since Cupertino
  has a public repo of its own, and `preferIssueTracker` orders the tracker above the form to match.
  The site gains the `/support/` page that third link needs — it was the only one with a
  `/feedback/` and no `/support/` — linked from the footer.

- **The site cross-links Bastion as a sibling app**, from one `SIBLING_APP` constant feeding both
  the homepage section and the footer column, so the name, URL and icon cannot drift apart. It
  claims no interoperability: neither repo documents running these servers under Bastion, and a
  cross-promo card is the wrong place to invent one.

### Changed

- **One status verdict per surface, instead of an automation-only glyph.** `StatusModel` and
  `SurfaceStatus` weigh every requirement a manifest entry can declare — Automation, the store
  grant, store readability — into a single health value. The old glyph drew Screen grey with "not
  needed" while every capture refused, and drew Mail green while its store was unreadable.

- **Automation is asked for only when it would be spent.** `Surface` gains `appleEventsScope`
  (`always | writes | nil`): Messages and Contacts script their app only in order to write, so with
  `allowWrites` off they were being polled for a grant they would never use.

- **The JSON-RPC plumbing shared by in-process servers lives in `InProcessRPC`.** Framing,
  envelopes and the blocking-task bridge moved out of `ScreenServer` once a second in-process server
  needed them — extracted rather than copied, which is the drift `surfaces.json` exists to end.

### Fixed

- **The screen capability's icon fallback names an SF Symbol that exists.** It declared `displays`;
  the symbol is `display`, so `NSImage` returned nil and the row would have rendered blank on any
  Mac where `iconPath` had moved. That fallback is mandatory in `surfaces.json` precisely to prevent
  a blank, and a name nobody had checked bought none of it. `make screen-check` now resolves every
  capability's symbol through `NSImage` and confirms its `iconPath` is present — symbol lookup works
  in a bare CLI with no `NSApplication`, so it stays a build gate rather than something only a
  running app would reveal.

- **CI runs the sound surface's gate.** `make sound-check` existed, passed, and was wired into
  nothing — so the second in-process server had the same hole the first one shipped with: a gate
  that only runs when somebody remembers it. It is CI-safe by construction, driving
  `SoundServer.handle` directly and asserting that the gated half stays invisible on a machine with
  no microphone permission, which is exactly what a runner is.

- **README's Surfaces table lists Sound.** The table is hand-maintained prose rather than generated,
  and `make readme-check` — which compares each row's claimed tool count against the registrations
  in the tree — was red on `main`: Sound had shipped with no row at all. It now reads 10 tools,
  counted from the server rather than from the commit message that introduced it.

## [1.8.0] - 2026-09-01

### Added

- **A fifth surface, `screen`, brokering ScreenCaptureKit rather than an Apple app.**
  `apple_screen_list_targets`, `apple_screen_diagnostics` and `apple_screen_capture_surface`, the
  last behind `allowCapture` — off by default, and superseding the one-time-code gates Messages and
  Safari each carried.

  **It has no npm package and could not have one.** The Screen Recording grant lives in the app, so
  the server has to live there too. `surfaces.json` gains a `runtime` field (`node | swift`), the
  generator enforces the `bundleId`/`npmName` rules that each runtime implies, and `ServerHost`
  answers this surface's JSON-RPC directly through `ScreenServer` instead of spawning a node child.
  Everything that loops over surfaces for a reason unrelated to packaging — the bridge, the closed
  table, the settings UI — still takes every surface unchanged; only the lists that actually mean
  "has a node package" read the new `NODE_SURFACES`.

  Identity was measured rather than assumed: an `LSUIElement` Developer ID bundle holds
  `kTCCServiceScreenCapture`, its spawned children inherit it, and the grant survives both
  re-signing and the bundle moving.

- **Settings separates apps from capabilities, and each has a real icon.** `surfaces.json` carries
  an explicit `kind` (`app | capability`) rather than inferring one from a missing `bundleId`. An
  app takes its icon from LaunchServices as before; a capability names its own `iconPath` — Apple's
  own Settings extension, so it sits beside the app icons instead of reading as a different kind of
  row — with a mandatory `symbol` fallback, because Apple's extension names under `/System` are not
  predictable (`DisplaysExt.appex` sits beside `Sound.appex`).

  `screen` is the first capability. The sidebar splits into two titled sections so it no longer
  reads as an app nobody can find in their Applications folder, and the automation caption gains a
  case of its own: "not needed — there is no app to script", rather than the app-only "reads only"
  framing.

- **Claude Code is a drop-in client instead of a copy-a-command one.** The app writes
  `~/.claude.json` directly — top-level `mcpServers` for the client row, `projects[<dir>].mcpServers`
  for local-scope folders — behind a stamp-and-retry guard that refuses a merge computed from bytes
  a concurrent session has since replaced, and a `0600` mode on any file this app creates.

  The previous refusal rested on two claims that do not hold. The file's mode survives the swap;
  and the concurrency risk is the same read-modify-write that `claude mcp add` performs from a
  second process, so handing over the command relocated the race rather than avoiding it — while
  giving up the one advantage this app has, which is that it reads back the file it wrote and can
  report a clobbered entry.

### Fixed

- **The in-process server is gated by something.** The screen surface shipped with no test of any
  kind while every node surface has a suite, and `scripts/verify-servers.sh` structurally cannot
  cover it: it scans a `cli.js` for bare imports and spawns it under the bundled runtime, and a
  surface the app serves itself has neither. `make bundle` runs only that script, so a broken
  in-process server would have reached a signature — which is the exact failure verify-servers.sh
  was written for, after three releases shipped servers that died on their first line.

  `make screen-check` drives `ScreenServer.handle` directly: no socket, no app launch, no licence,
  no TCC grant, so CI runs it as a build gate. It pins the handshake, that a notification draws no
  reply, both states of the capture gate, the closed-table refusals, that the capture schema offers
  no surface without an app, and that an unreadable window list renders as `null` rather than as an
  empty list — absent and EPERM being different findings. Each assertion was checked by
  reintroducing the bug it describes.

  `make smoke-swift` handshakes app-served surfaces through the bridge, and is deliberately **not**
  a build gate: the socket is claimed by bundle identifier, so on any machine with Cupertino
  installed it would test the installed copy and pass while the artifact is broken.

- **"Install and Relaunch" worked, having read as broken.** The relaunch was held until
  `Sessions.live` emptied, but a session is a connection held open for a client's lifetime rather
  than a tool call, so it was rarely empty and the held install never fired. Sparkle's postpone hook
  only fires for an explicit click in the first place — automatic updates are off — so this deferred
  nothing it was meant to. The EOF it was guarding against is still handled unconditionally a few
  milliseconds later, in `updaterWillRelaunchApplication`, which SIGTERMs every server for an
  ordinary shutdown.

- **The Capabilities card no longer fails with an error about a file it does not use.**
  `SurfaceCatalog` spawned a node server through `ServerLocator` for every surface, which for a
  swift-hosted one failed with "dev.json is unusable" — a real error about something with no bearing
  on a server that is not a node process. It drives `ScreenServer.handle` directly for that runtime
  now, so the card still demonstrates the real tool list rather than describing it a second time.

- **The screen surface's detail pane names the permission it actually needs.** Access showed only
  "Automation — not needed" and no Screen Recording row at all, so the surface read as ready while
  every tool would refuse. That row is wired to `Permissions.screenRecording()`, and its button
  opens the settings pane rather than re-calling `CGRequestScreenCaptureAccess`, which only ever
  prompts once. The Store card is hidden for a capability instead of asserting that everything goes
  through Apple Events, and the write-gate caption no longer describes a gate a surface with no
  mutating tools does not have.

- **"Include contents" says what it actually redacts.** The toggle and its caption described only
  the argument half of `CallCapture`'s redaction — a mail body, a message, a note's text — and said
  nothing about the result half, which is withheld entirely on the grounds that every word of it was
  answered by the server. A reader would reasonably have expected return values in the log. It is
  relabelled from "Include message contents", since it governs nine surfaces and the app-wide log
  and "message" fit only two of them, and the caption now names «redacted», the literal string that
  appears.

## [1.7.0] - 2026-09-01

### Added

- **Messages can send a photo, not only text.** `apple_messages_send_message` takes an
  `attachmentId` — the same `attachment.guid` `apple_messages_save_attachment` takes — and forwards
  that file to the conversation. It runs the same source boundary as saving does: the path resolves
  inside `~/Library/Messages` or the send is refused.

  **The two file lanes are gated differently, and that is the whole design.** `attachmentId` reaches
  only files Messages itself already stores, so its blast radius is bounded by construction and it
  ships behind `ALLOW_WRITES` like the rest of sending. Naming an arbitrary local path is a
  different act — an exfiltration primitive, and one this surface is unusually exposed to, because
  the untrusted text that would drive it arrives through this server's own read tools. So `filePath`
  exists as a parameter only when `APPLE_MESSAGES_ALLOW_FILE_SEND` is set, and it is off by default.

  Absent rather than refused: with the flag off, `filePath` is not in the tool's schema at all. A
  parameter that exists and always says no is a parameter a model keeps filling in. There is no
  directory confinement on it, deliberately — any client that can also write files defeats one with
  a single copy, so it would read as a boundary while being a speed bump.

  One call sends one thing, because Messages' `send` takes a file **or** a string. A captioned photo
  is two calls, and a call naming two payloads is refused rather than guessed at.

- **Safari can click, type and scroll on a page — through the extension, with no Apple Event and
  no TCC grant at all.** `apple_safari_page_elements` lists what is clickable with a short id
  apiece; `apple_safari_click`, `apple_safari_fill` and `apple_safari_scroll` act on those ids
  behind the write gate. `page_elements` is ungated: enumerating changes nothing, and it is the
  same class of act as reading a page, which this surface already does.

  **It is the capability `do JavaScript` would have bought, taken through the one door that is
  consented per website.** That verb is still refused for the reasons it always was — global,
  permanent, unscoped, state unreadable. The extension is the same power granted one site at a
  time, visibly, revocably.

  The channel is files in the extension's own container, which is writable as well as readable by
  a same-user process. Nothing else was good enough: `dispatch message to extension`, Safari's
  hidden verb for waking an extension, was measured accepting an empty dictionary and a bogus
  extension identifier without complaint and returning nothing — a message that went nowhere
  cannot be told from one that arrived, which is the same silent failure `do JavaScript` was
  rejected for.

  Two properties the tool descriptions carry because a caller cannot infer them: commands are
  **at-most-once** — a click that times out may still have landed, and must never be retried
  automatically — and element ids **die on navigation**, so a click that loaded something
  invalidates every id the caller holds. Elements are addressed by id rather than CSS selector
  precisely because a stale selector does not fail, it clicks the wrong thing.

  Verified against a fake extension, not against Safari: exercising the real one needs a notarized
  build, since Safari will not list an extension whose container app is not stapled.

- **Notes can attach a file to a note, and reading attachment bytes back actually works.**
  `apple_notes_add_attachment` puts a file into a note — the only way to get an image in there,
  since an `<img>` in the body is dropped. It goes through the Standard Suite's
  `make new attachment ... withData:`, licensed by note's hidden `<element type="attachment">`
  even though every property on the attachment class itself reads `access="r"`.

  **`save_attachment`'s file lane had never saved a single real attachment.** It resolved against
  the attachment id, but `ICAttachment` carries no path of its own and the id Apple Events hands
  back contains slashes, so no directory was ever named after it. Its tests passed because the
  fixture used a shape the dictionary does not return — the failure was invisible from inside the
  suite. The bytes live behind `ZMEDIA`, a foreign key to the `ICMedia` row holding the identifier,
  generation and filename segments, and `#findMedia` resolves through that row now, established
  against a live store by `scripts/probe-notes-media.mjs`.

  It also corrects a claim these docs had been making: attachment bytes were called the one pure
  capability gain of the file lane. They are not. Notes answers `save attachment ... in <file>`
  itself, over Apple Events, with no Full Disk Access at all — the file lane buys speed here, not
  capability.

- **Every server publishes to the MCP Registry.** Each surface ships a `server.json`, and a
  `publish-registry` job pushes it once the npm publish for that tag has landed. A client that does
  not already know these packages exist finds them through the registry, which is also what feeds
  the third-party directories; `docs/alternatives.md` records why that was worth automating, which
  is that every rival is listed in several and this was listed in none.

  **It runs after `publish-npm`, never beside it.** The registry proves ownership by fetching the
  just-published tarball's `package.json` from registry.npmjs.org and checking its `mcpName`
  against `server.json`'s `name`, so a job running in parallel races the very publish it is
  validating and fails on a version npm has not seen yet. Authentication is GitHub OIDC against the
  `io.github.mgcrea/*` namespace, so there is no registry token to store, rotate, or leak from a
  laptop. A tag whose package has no `server.json` — `core`, `app`, `api` — is resolved and
  skipped rather than failed, and a version already in the registry is a notice rather than a red
  run over a release that already completed.

  `scripts/generate-version.mjs` owns both version fields in each `server.json`, so what the
  registry receives agrees with the tag by construction rather than by a second bump somebody has
  to remember.

### Fixed

- **The Safari extension's manifest version tracks the app again.** `manifest.json` said `1.0`
  while the appex around it correctly said 1.6.0 — the bundle version comes from
  `MARKETING_VERSION` at build time, so Safari and `pluginkit` always showed the right number and
  nothing ever surfaced the stale one. `scripts/generate-version.mjs` owns the field now, so
  `make version-check` fails on drift like it does for every other copy of the version. MV3 allows
  only one to four dot-separated integers, so a pre-release suffix is dropped rather than copied.

  It was not cosmetic. The extension now stamps `extensionVersion` on every capture and result,
  and the server uses it to name the one cause of silence a caller cannot diagnose: a Sparkle
  update swaps the appex immediately, but an already-open tab keeps running the previous content
  script, orphaned and unable to answer. That is indistinguishable from "not allowed on this site"
  and has a completely different fix, so the timeout now says to reload the tab — but only when a
  capture stamped with another version proves it, never on a guess.

  **`page_elements` never hands out a credential.** It reports what a text field holds, and
  `input[type=password]` is a text field — the first cut of it returned passwords and card numbers,
  from a tool marked read-only whose description did not mention values at all. A field classified
  as a credential now comes back `redacted: "credential"` with `hasValue` and no value, and no
  setting returns it. The classification runs in the content script rather than the server, because
  a result crosses the boundary as a file in the appex container: redacting afterwards would mean
  writing the secret down first.

- **Safari can read a one-time 2FA code, behind `APPLE_SAFARI_ALLOW_CODES`.** Off by default, its
  own gate rather than the write gate — reaching a read through `allowWrites` would mean granting
  the right to click a button in order to see a number.

  A code on a page is in one of two places and they need different mechanisms. In a FIELD, where
  AutoFill put it: `page_elements` returns its value under this flag. Rendered as TEXT, which is
  the ordinary case: `apple_safari_find_codes` scans the live DOM, because there is no input to
  enumerate and `read_page` cannot help either — a code delivered by XHR into an already-open tab
  was never captured.

  The page returns bounded excerpts and judges nothing; extraction runs on the server, on the same
  heuristic Messages uses. That heuristic moved to `@mgcrea/mcp-apple-core` when Safari became its
  second caller, rather than being duplicated into a second copy that would drift. It is the first
  heuristic in core, which has otherwise been plumbing, and it is **reused rather than
  re-validated**: its test table is SMS-shaped, and a web page is a much richer source of digit
  runs. `low` confidence cannot occur on this lane at all — the only route to it is a shortcode
  sender, and a page has none — so a digit run with no keyword near it yields nothing.

  **There is no `ageSeconds` here and there cannot be.** A message carries the time it arrived; a
  paragraph does not, and an expired code reads exactly like a live one. `pageAgeSeconds` bounds
  the age from above and never from below.

  `apple_safari_fill` stopped forbidding it, which it had done since before any of this existed —
  its description told a caller to never put a one-time code through it, so the two halves of this
  feature contradicted each other and the read was useless. Filling a code is now the case it names
  first. A password or a card number is still not: nothing here can read either, so a value about to
  go through that tool came from somewhere else. It also now says what it cannot do — a site that
  splits a code across six single-character boxes takes one string into one element and will not
  work, so enumerate again and check rather than assuming it took.

  It reads a code a **website shows**. It does not reach Passwords.app, whose four lanes are all
  closed and stay closed — `docs/passwords.md` now carries a table of the four questions so the two
  do not get conflated, and records the extension as a fifth lane it had not evaluated.

- **A tool's `limit` can no longer quietly exceed the ceiling its own description advertises.**
  Twenty-odd call sites spelled `limit ?? maxResults` by hand in five different ways, and three
  surfaces did it with no `Math.min` at all — so their real ceiling was `maxResults` while
  `limitArg`'s description told the model the default was 25. A model that trusted the description
  and omitted the argument could get eight times the rows it asked for. `resolveLimit(limit,
maxResults, fallback)` in `@mgcrea/mcp-apple-core` replaces every one of those spellings across
  all eight surfaces, and is now the only place a caller's limit meets the configured ceiling.

- **`apple_safari_read_page` bounds what it returns.** `maxChars` was optional with no fallback, so
  a call that omitted it got the whole capture — up to the extension's own caps of 256 KiB of text
  or 1 MiB of html, a quarter of a million tokens out of a tool a model reaches for casually. It
  defaults to 32,768 characters now, the same call `get_message_source` already made for its own
  byte budget.

- **`apple_messages_list_messages` honours `defaultRangeDays` when it is given only a `from`.**
  `client.window` was called with the parsed `from`/`to` and nothing else, so naming just a start
  ran all the way to now, however far back that start was. The setting has been in the config since
  this surface shipped, with a comment describing exactly this behaviour, and nothing ever read it —
  Safari already closed an open-ended range this way and Messages did not. `find_codes` keeps its
  own open-ended call, where "until now" is genuinely what is meant.

- **The Safari extension's toolbar icon renders as a disc rather than a squircle**, which is the
  shape Safari actually masks a toolbar item to.

### Changed

- **Updates is its own pane in Settings, instead of a section partway down General.** It was
  under the version number on the theory that somebody wondering whether they are current has
  already looked there, which holds only for people who scroll. Automatic checking is off until
  asked for, so Check Now is the only way an unopted build ever looks at all, and it was the
  second card on a page otherwise about launching at login and where the bundle lives. The pane
  repeats the version in its first row, so "am I current" is still answered in one place.

- **Mail's message rows carry `ref` alone, not `ref` plus the three fields it is built from.**
  `id`, `accountUuid` and `mailbox` are exactly what a `MessageIdentity` is assembled out of — it
  names them now — so repeating them on every row of every list paid for the same identity twice,
  measured at 38% of a 25-row reply. Both call sites still carry them internally and drop them once
  `ref` exists. A caller that was reading those fields off a row should read them off `ref`, which
  is the value every tool taking a message already wants.

- **Tool results are compact JSON.** Every result went through `null, 2` pretty-printing; measured
  against these servers' own response shapes that added 25-41% to the payload depending on how many
  short keys a row carries, worst on exactly the lists already big enough to matter. A model has no
  use for the indentation.

## [1.6.0] - 2026-08-31

### Added

- **The Activity log can be kept, not just watched.** Settings ▸ Activity turns on a durable log:
  append-only files under Application Support, readable only by you, with retention by age and by
  size. Off by default, and with it off nothing about the app changes — the log stays a ring in
  memory that is cleared when Cupertino quits.

  **Message contents take three separate switches to reach disk.** One to record them at all, one
  to keep a log, and one more to let contents into the file, with a warning on the last. A mail
  body, a message and a note's text all arrive as tool arguments, so "record arguments" and "write
  my mail to a file" are two different decisions and are asked as two different questions.

  **Each record carries a hash of the one before it**, so an edited field, a removed record or a
  truncated file can be detected — and the pane says exactly that much. It catches tampering by
  something that does not know it is a chain. It is not proof against anyone who can write the
  file, because they can recompute it, and claiming otherwise would be the kind of security
  sentence nobody can check. Retention drops whole files at a time for the same reason: a chain
  cannot lose a record from the middle and still verify.

- **The log can be exported, and signed if you want it.** Export writes the log alongside a
  manifest naming each file, its record count and its digest. The count is the part that matters:
  a chain cannot detect its own truncation, because cutting off the end leaves a shorter chain
  that still verifies.

  Signing is optional and off unless asked for. It proves an export came from this Mac and was not
  altered afterwards; it does not prove the log was not curated before it was signed, and it means
  nothing to someone who has not been given the key some other way — so the pane shows a
  fingerprint to send them once. A new Mac makes a new key, and exports already signed keep
  verifying against the old one.

- **The Activity log has a search.** It matches the tool name, the surface and the arguments and
  results a call carried, so "which call touched that note" is answerable without reading the
  feed. A row whose match falls past the truncated preview opens itself, rather than appearing in
  the results with no visible reason for being there.

- **Logs and Settings are one click from the menu bar.** Two glyphs beside Quit, with ⌘L and ⌘,
  while the panel is open. The log is the destination the panel argues for: every line in it is a
  count of calls, and "what were those calls" is the question the summary raises and cannot
  answer.

- **Safari can open a page and save one for later.** `apple_safari_open_url` opens a URL in a new
  tab or in the tab the user is looking at, and `apple_safari_add_reading_list_item` saves one to
  the Reading List. Both are Apple Events behind `APPLE_SAFARI_ALLOW_WRITES`, so Safari is the
  first surface whose write lane needs no Full Disk Access at all — and the last surface that had
  no write lane. `supportsWrites` in `surfaces.json` flips with them.

  The reason it was false gets a correction rather than a reversal. It read "opening a URL or
  adding to the Reading List is an Apple Event that navigates a real, visible browser", which is
  true of the first and false of the second: `add reading list item` opens nothing and loads
  nothing. That is why it was the verb to build first.

  **No `do JavaScript`, and a navigation verb is where that decision gets tested.** Navigating a
  tab to a `javascript:` URL is that verb through the front door — same capability, without the
  developer-menu toggle, through a tool whose description says it opens web pages. Measured on
  macOS 26.6: Safari **accepts** such a URL, with no refusal and no toggle involved, so this is
  the boundary rather than a precaution. Both writes take an http/https allowlist, enforced before
  any Apple Event is sent and again inside the JXA, and `test/writes.test.ts` asserts a refusal
  dispatches nothing at all. Clicking and filling belong to the extension lane, where Safari
  grants one website at a time; they are not built.

  Three disclosures the caller cannot infer, all carried in the tool output or its description:
  these verbs LAUNCH Safari when it is not running; a Reading List add FETCHES the page in the
  background, so saving a link contacts that host from the user's browser; and an add is
  `verified: true` or `null`, never `false` — Safari writes `Bookmarks.plist` on its own
  schedule, so an add that worked is routinely invisible a moment later, and a caller that read
  that as failure would retry into a duplicate that no verb can remove.

  The JXA was written from the dictionary and measured afterwards, which is the reverse of how
  every other lane here landed — `scripts/probe-safari-write.mjs` is the instrument, and it found
  the uncertain idiom sound: `tab-push` in 166 ms, `current-tab` in 108 ms, the Reading List add
  in 148 ms, and the `open location` fallback never fired. It also found the shipped tool
  advertising a `title` parameter Safari overrules: a custom title survives only for a URL that
  does not resolve, which is both why the description now calls it best-effort and how the
  background fetch was discovered. Safari commits an add to `Bookmarks.plist` after a measured 2 s,
  which is why the confirmation is two looks a beat apart rather than the immediate re-read it
  started as — that one could never have found anything.

### Changed

- **The Safari pane reports the extension.** Safari is the only surface with three independent
  lanes, and its pane rendered two of them: Access is the Apple Events lane, Store is the file
  lane, and the extension — the only route to page content, and the only thing
  `apple_safari_read_page` runs on — was not shown at all. A Page content card now sits between
  Store and Capabilities, saying whether the extension is enabled, how many pages it has captured
  and how fresh the newest one is, with the two setup steps behind a disclosure.

  It belongs in the app because it cannot live anywhere else: a disabled extension leaves its last
  captures on disk and stops adding more, so `apple_safari_diagnostics` goes on reporting a healthy
  store that answers with an ever-older page. Only Safari knows the switch is off, and only the
  containing app may ask it. The count is what makes the row worth more than the switch — Safari
  grants the extension one website at a time, so "enabled" and "allowed nowhere" look identical
  until something counts the captures. Verified against the running extension: 4 captures and a
  261-second newest age, the same two numbers `apple_safari_diagnostics` reported off the same
  directory.

### Fixed

- **A composer shrunk to hide the citation-stripping flash stayed shrunk.** Mail persists the
  compose window's frame, so the [1, 1] window pushed off-screen while quotes were stripped was
  inherited by the next composer opened by hand — and on a send that only saves a draft, that was
  the very window the caller had just been told to review in Mail. The frame is read before the
  window moves (once off-screen the window server answers with what it clamped to, not what you
  chose) and restored, position first, before the caller sees the window again — on the failure
  path too, so a strip that throws does not cost you your composer. A window whose geometry cannot
  be read back is left alone rather than hidden with no way to put it back.

- **The Safari extension row no longer offers a button that cannot work.** It showed "Open Safari…"
  for every state that was not enabled, including `notInstalled` — which is the normal answer on a
  locally built app, where the appex is stripped because Safari will not list an extension whose
  container is not notarized. The button is now absent in the two states nothing in Safari can
  resolve, the same way the Automation row stopped offering "Allow…" for states that cannot be
  re-prompted.

- **"Open Safari…" opens Safari's Extensions settings**, with Cupertino selected, rather than
  launching the browser and leaving someone to find a three-level menu. There is still no
  `x-apple.systempreferences:` pane for it, which is why this was a plain launch; there is a
  `SFSafariApplication` call that does exactly this, and the launch is kept as its fallback.

- **The extension's state was only read when a window opened.** It is the one status here that
  someone changes in another app and comes straight back to check, and it is re-read on every visit
  to the Safari pane now.

- **A Safari error that was not "no such extension" reported as "not installed".** `SFErrorCode` has
  three values and only the first means that; the other two are "we could not ask", which is a
  state the enum already had. Reporting them as a missing extension is the one answer that sends
  someone to reinstall the app.

- **`notInstalled` claimed a cause that was only true of a local build.** It said "not in this build
  — a locally built app ships no extension" to everyone. In a release build the likely cause is
  different and so is the fix: Safari will not list an extension whose container is translocated or
  outside `/Applications`, which `InstallLocation` already knew and no row was asking it.

## [1.5.0] - 2026-08-31

### Added

- **Safari can read what a page actually says.** `apple_safari_read_page` returns a tab's readable
  text or its raw HTML — the capability this surface has never had and the one most often expected
  of it. It arrives through a Safari web extension rather than Apple Events, so it needs no Full
  Disk Access and no Automation grant. Verified end to end against a real capture rather than only
  in tests: Hacker News, 3,681 characters of text, through the built server over stdio, on a run
  that reported `history=UNREADABLE` in the same breath. The three Safari lanes are independent,
  and this is the one that needs no grant at all.

  macOS does offer a built-in route — "Allow JavaScript from Apple Events" — and it is a skeleton
  key: one switch, no scope, and afterwards any process that can send Apple Events runs script in
  any tab, including whatever is logged in. Its state cannot even be read back, so nothing can tell
  you it is on. The extension is asked per website instead.

  The hand-off is a file, because nothing can push into a running MCP server: `ServerHost` spawns
  node with a fixed environment and there is no channel afterwards. The extension writes captures
  into its own appex container, which is 0700, owned by the user and not TCC-protected, so the
  unsandboxed server reads it with no grant and no app group — measured with a negative control, a
  shell denied on `History.db`, `~/Library/Mail` and `chat.db` still reads three appex containers.
  It is a cache and says so: a 30 minute TTL, 20 entries, 256 KB of text.

  Settings grows a row under Page content saying whether the extension is switched on, with a
  button into Safari, where that switch actually lives — there is no system preferences pane for
  it. Only the containing app can ask: a standalone binary calling the same API is refused with
  `SFErrorDomain` error 1. A disabled extension leaves its last captures on disk and simply stops
  adding more, so without this the store keeps looking healthy while answering with an ever-older
  page.

- **The Activity log records what a call was made with, not just its name.** A per-surface capture
  mode chooses between names only, arguments, and arguments with results. Content is blanked by
  default, and separately: a mail body, a message and a note's text all arrive as arguments, so the
  prose inside them is dropped while the structure — which tool, which mailbox, which recipient —
  is kept. Nothing is written to disk; the log stays a bounded in-memory ring.

- **Messages can read one-time codes**, behind `APPLE_MESSAGES_ALLOW_CODES`. `find_codes` is a
  read, and the reason it needs a switch of its own rather than riding on `allowWrites` is what it
  completes: this server already holds the conversation history while a sibling holds Mail, which
  between them is the password-reset channel. Adding live authentication codes to that assembles an
  account-takeover primitive out of parts that were each individually reasonable, so it defaults
  off. It ships in place of a Passwords surface, which does not exist.

- **Safari tells the frontmost tab from the merely active one.** `active` is selected in its own
  window, so two open windows produced two active tabs and nothing said which one a person was
  actually looking at. `apple_safari_list_tabs` now also reads Safari's own `frontmost` property
  and each window's front-to-back index, marks at most one tab `frontmost`, and takes
  `only: "active" | "frontmost"` to narrow the result. When that order cannot be read it says
  `windowOrderUnknown`, so a caller asking for it gets an explanation rather than a silent empty
  list.

  The history enrichment behind it was rebuilt at the same time. Safari shares no id between the
  live-tab and history lanes, so the join is a URL and nothing else, and the old one was a single
  exact lookup plus a query-stripping retry run as up to 2N individual reads. An ordered ladder now
  tries fragment, trailing slash, scheme, `www.` and tracking parameters before falling back to
  that query strip as the weakest rung, resolves a whole tab set in one chunked SQL `IN`, and
  reports which rung answered so a caller can tell a faithful match from a loose one.

- **Surfaces can be switched off, in Settings › Surfaces.** A surface that is off is not served at
  all: it is left out of the server keys Cupertino writes into a client's config, pruned from the
  configs it has already written, and refused at the bridge if an older config still asks for it.

  The cost this removes is the one `ProjectScope` already measured — eight servers wired into every
  client means every session carries tool definitions for surfaces nobody uses. Turning one off is
  how you stop paying for the ones you do not want, without giving up the ones you do.

  Switching a surface off also stops its running servers with `SIGTERM`. An MCP host opens one
  stdio connection when the editor launches and keeps it for the life of that editor, so refusing
  new connections alone would have left the tools sitting in a session that outlived the decision.

  Clients configured before the change keep the entry until you press Update, and the Clients pane
  now says which ones still hold it. Claude Code and Codex get a copyable removal command; Visual
  Studio Code has no command that removes a server, so that row explains the manual edit instead.

  Absence means enabled, so nothing changes for an existing install and a surface added in a later
  version still arrives switched on.

### Changed

- **Every per-surface control now lives in the main window, and Settings keeps only what has no
  surface.** Automation and the write toggles left the Permissions pane for the surface detail
  pane, which already carried both. Permissions is now Full Disk Access, Accessibility and System
  Events — the three grants that cannot be expressed per app.

  The main window has had one pane per surface for a while, and that pane's own note records these
  facts having once been "scattered between the popover, the Permissions tab and the log filter"
  with nothing answering "is Mail working" in one place. A second copy in Settings was that
  scattering, still going.

- The sidebar dims a switched-off surface rather than hiding it, and drops its automation glyph — a
  TCC grant reported against a server that will never start is a true fact about the wrong subject.
  Right-clicking a row turns it off without leaving the list. The detail pane replaces Access and
  Capabilities with a single card saying what is off; Capabilities in particular no longer spawns
  the server, which is the one thing a switched-off surface must not do.

- **Screenshot runs no longer resize the developer's own windows.** `HostedWindow` named a frame
  autosave even under screenshot mode, so every `make screenshots` wrote the capture's pinned size
  back into `UserDefaults` under the key the real window reads. Found as a Settings window
  remembered at 1000x772 against a main window at 1120x572 — `DemoSeed`'s two pinned sizes plus a
  titlebar, exactly — which is a Settings window 200pt taller than the one it opens in front of.

  Closing that leak exposed what it had been hiding: the main window passed no `contentSize` at
  all, and its captures had been relying on the leaked frame to come out at 1120x540 rather than
  SwiftUI's 780x492 fitting size. It now pins its own, the way the Settings window already did.

  Both windows also set `tabbingMode = .disallowed`. Neither is a document, and on a Mac set to
  "Prefer tabs when opening documents: Always" macOS was free to absorb Settings as a tab of the
  main window.

- The Settings window opens a little smaller, at 720x520, so the main window's sidebar stays visible
  behind it.

- The two Settings App Store plates were re-aimed. `settings` now photographs the Clients pane,
  which nothing showed before; `writes` is the main window on a surface with writes off, where the
  capabilities card reports seven tools against Mail's twenty. The write gate used to be pictured
  as a row of toggles, which showed the control — this shows the consequence, and the numbers come
  off the real server rather than a fixture.

- **The menu bar glyph is a setting sun**: a solid disc clipped by a stroked horizon, replacing the
  thin-wave mark it had before. The cut is a `clipPath` rather than the canvas's own mask —
  measured through `NSImage`'s SVG rep, the mask's soft edge leaves about 25% residual alpha along
  the cut and bridges the disc and the horizon into one shape. The connected state adds a halo
  whose gap was swept rather than chosen: 2.4 units is one step past where the ring's antialiased
  edge stops fusing with the disc at 2x.

- **The website gained a Safari section, a privacy policy, a feedback form, and the EULA at
  `/terms`.** The Safari section is about the permission rather than the feature, which is the same
  argument the rest of the site already makes about Full Disk Access and terminals: reading a web
  page is unremarkable, and what you hand over in order to do it is not. The EULA is rendered from
  `apps/apple/EULA` rather than restated, so the document a buyer agrees to at checkout is the one
  the app was built with. The feedback form exists for the reports that should not be public — a
  useful Cupertino bug report quotes a subject line, a chat, an account name or a contact, and the
  issue tracker is public and permanent. Organization and WebSite JSON-LD were added alongside.

- The menu bar popover groups its buttons by what they do: "Open Cupertino" sits left, and
  "Settings…" moves right to join "Quit". What opens something is on one side, what leaves is on
  the other, and Settings belongs with the second — it is a window you go to, not a thing the
  panel itself does.

### Fixed

- **The Activity log pane rendered nothing at all.** Its footer caption grew a second sentence when
  arguments started being recorded, and it carried `fixedSize(horizontal: false, vertical: true)` —
  a request for whatever height the text needs at the width it is proposed. Inside that `HStack` the
  proposed width is near zero, so the caption wrapped into a column 2060pt tall, the split view
  adopted that as its ideal height, and a 572pt window laid its entire contents out at y = -587.
  Sidebar, log and footer all existed in the accessibility tree and none of them was on screen.

  The ask is now bounded with `lineLimit(3)` instead — three, not the two the capture needs, because
  this window goes down to 780pt wide and truncating a privacy claim with an ellipsis is the one
  way this footer must not fail. `layoutPriority` and a flexible `frame` were
  both tried and neither reaches it — the fix is not to ask for an unbounded height in the first
  place. It was latent under the one-line caption, which wrapped tall enough to be wrong and short
  enough to fit.

  Found by the screenshot pipeline: the `activity` and `prompt` plates came out as empty windows,
  and because both were empty they were also byte-identical, which `appshot check`'s duplicate
  detection reports as a staging failure rather than a visual change.

- **Settings no longer opens as a tab of the main window.** `NSWindow.tabbingMode` defaults to
  `.automatic`, so on a Mac with Desktop & Dock → "Prefer tabs when opening documents" set to
  Always, macOS tabs any two same-class titled, resizable windows together. Neither of this app's
  windows is a document and neither has a second instance to be tabbed with, so Settings was
  absorbed as a tab of the main window and ⌘, appeared to do nothing — the pane it opened was
  behind the tab already showing.

- **Maps is no longer described as read-only.** The Permissions pane derived its Automation caption
  from `usesAppleEvents` alone, where false meant "not needed — this surface reads only". That held
  for every surface until Maps, which is the only one with `usesAppleEvents` false that writes
  anyway, through SQL into its Core Data store rather than an Apple Event. So the one surface that
  reached the false branch was the one the sentence was wrong about, and 1.4.0 shipped it next to a
  working write toggle. It branches on `supportsWrites` now; the grant is equally not needed either
  way, and only the reason differs.

- **A green Accessibility row that was not actually working.** This shipped in the 1.4.0 build and
  is recorded here because it was never announced. One bundle identifier can hold several
  Accessibility entries at once — one per path and signature it has been granted at, so an
  installed copy, a debug build and every earlier reinstall each get their own — and the app's
  `AXIsProcessTrusted()` check and the servers' functional check can match different ones. `tccutil
reset` reported clearing four entries for `io.mgcrea.cupertino` on the machine that surfaced it.
  The cure is clearing them and granting once from the running bundle, then never granting again.
  Diagnostics, the Settings hint and the code comments now say that instead of the retracted claim
  that Accessibility simply does not inherit.

## [1.4.0] - 2026-08-30

### Added

- **Maps can write, and does it without an Apple Event.** `apple_maps_add_favorite` and
  `apple_maps_remove_favorite` ship behind `APPLE_MAPS_ALLOW_WRITES`, making Maps the first
  surface here whose writes send no Apple Event at all — `usesAppleEvents` stays false.

  Maps has no scripting dictionary and no App Intents registered on macOS, so the write is
  SQL into its Core Data store. The one thing that cannot be synthesised is the GEO place
  record, so it is never synthesised: the place is opened through the `maps://` URL scheme,
  Maps mints the record into Recents, and it is copied. The insert needs three tables — not
  the eight the app touches — and Core Data mirrors it to iCloud by itself, confirmed on a
  second device.

  Two costs the tools state rather than hide: adding a place the store does not know leaves
  an entry in the user's Recents, and because the store is CloudKit-mirrored the write
  reaches every device on the account. There is no local-only insert here.

- **`apple_maps_list_unfiled_places` reaches the saved places that are in no Guide.**
  Resolving collection membership exposed a gap it could not close: 30 collection items,
  18 filed in a Guide, 12 in none — and no tool could list the 12.
  `apple_maps_list_collections` reported the 18 and said nothing about the rest, so the
  counts simply did not add up.

  They are not debris. `Z_PRIMARYKEY.Z_MAX` equals the live count for both `Collection`
  (10) and `CollectionItem` (30), so Core Data has never deleted either — the leftovers
  theory is disproved by the store. Correlated against the rest of it, **7 of the 12 exist
  nowhere else**: not a favourite, not in another Guide, not in recents. Those were
  reachable only by guessing a search term. `apple_maps_list_collections` now also carries
  an `unfiled` count so the shortfall is visible rather than silent.

  The filter guards its subquery — `NOT IN` is false for EVERY row once the subquery
  yields a single NULL, so an unguarded version reports "no unfiled places" whatever the
  store holds. A test inserts a NULL join row and fails without the guard.

- **Maps can list the places in a Guide.** Collection membership turned out to be
  `Z_6PLACES(Z_6COLLECTIONS, Z_7PLACES)`, a Core Data MANY-TO-MANY join table —
  `Z_PRIMARYKEY` decodes ordinal 6 as `Collection` and 7 as `CollectionItem`. Because a
  many-to-many leaves no column on either entity, the four names guessed from Core Data
  convention (`ZCOLLECTION`, `ZCOLLECTION1`, `ZPARENTCOLLECTION`, `ZOWNINGCOLLECTION`)
  could not have contained the answer, and `apple_maps_list_collection_places` returned
  nothing for every one of the 10 Guides.

  The key is now DISCOVERED BY RUNNING THE JOIN and scored against `ZPLACESCOUNT`, Maps'
  own count per Guide, accepting only a candidate that reproduces all ten numbers exactly.
  That bar is the point: `ZCOLLECTIONITEM.ZMAPITEM` joins `ZCOLLECTION` for 3 of 10
  collections purely because map-item and collection row ids are both small integers, so a
  resolver picking the best-covered joinable column — the rule this file already uses for
  coordinates — would have filed places under the wrong Guides and looked like it worked.
  Scoring also survives Apple renaming the relationship, which a hard-coded `Z_6PLACES`
  would not.

  Membership being many-to-many, one place can sit in several Guides, so the query asks
  `IN (SELECT ...)` rather than joining. 30 item rows, 18 of them in a Guide; the other 12
  belong to no collection at all.

  Apple's own schema says so, which is the confirmation: Core Data maintains
  `ZPLACESCOUNT` with a trigger that counts `Z_6PLACES.Z_6COLLECTIONS`. The oracle is
  therefore DERIVED from the mechanism, so an exact match is guaranteed for the real
  relationship and coincidental for everything else.

  `scripts/probe-maps.mjs` never asked the question — it enumerated columns but not `Z_*`
  tables, so the join table was invisible to it. It now scores every mechanism against
  `ZPLACESCOUNT` and prints the winner. The offline fixture was the second reason this
  survived: it was HAND-WRITTEN and declared a `ZCOLLECTION` column the real store does not
  have, so the suite proved membership worked against a column that never existed — the
  same shape as the `ZMUID` overflow below, a comfortable fixture passing while the real
  store failed. It is now captured by `pnpm probe:maps --write`, and recapturing it turned
  24 green tests red — every one of them a test that had been proving something about a
  schema Apple does not ship.

- **Captured fixtures no longer carry Core Data's triggers.** `writeFixture` omits them.
  Maps' store has eight that maintain derived columns by calling
  `NSCoreDataDATriggerUpdatedAffectedObjectValue`, a private function that exists only
  inside Core Data, so replaying them into `node:sqlite` made every INSERT into a
  triggered table fail with "no such function" — 18 tests at once, none of whose messages
  named the cause. A fixture replays SHAPE; the behaviour those triggers implement is Core
  Data's, not the store's. The header records how many were dropped, and the fingerprint
  still counts every object.

- **Maps refs are now stable across an iCloud re-sync.** `ZIDENTIFIER`, a Core Data UUID, is
  set and distinct on every favourite, collection, collection item and recent on a real
  store, so refs carry it instead of the Core Data row id and survive the renumbering a
  re-sync causes. A store without it falls back to row ids and keeps the old
  session-scoped caveat. The column is adopted only when it is populated AND distinct on
  every row — a partially populated one would give durable refs for newly saved places and
  fail silently for everything already there.

  It was found by DIFFING THE STORE WHILE MAPS SAVED A PLACE, not by reading the schema.
  `pnpm probe:maps` never reported it, because a probe can only report columns somebody
  thought to look for.

### Changed

- **The read-only verdict was retracted, and the measurement that produced it kept.**
  `pnpm probe:maps-write` ([scripts/probe-maps-write.mjs](scripts/probe-maps-write.mjs))
  snapshots the store, waits for a place to be saved by hand, and diffs. Saving one place
  moves eight tables and bumps ten `Z_MAX` counters, including a ~1.2 KB GEO protobuf and
  two ~3 KB encoded `CKRecord`s, plus the `NSPersistentHistoryTracking` rows the CloudKit
  exporter reads to decide what to upload. `mapssyncd` holds the store open even with Maps
  quit, so there is no quiet moment either.

  That measurement is what closed the lane, and closing it was the wrong inference: it
  recorded **what Maps does**, and a write only has to do **what Maps requires**. Three of
  those eight tables are all it takes, once the GEO record is minted by Maps itself through
  the `maps://` URL scheme rather than synthesised. Reading the first number as the second
  is the mistake, and it was made three times before it was caught.

  The App Intents lane was checked too and stays closed: Maps ships strings for `Add Places
to List` and `Remove Places From List`, but the actions are not registered in Shortcuts on
  macOS 26.6 — Maps is a Catalyst app carrying the iOS resource bundle, so the strings ship
  regardless. The Accessibility lane is open and simply unbuilt: with a place card open Maps
  exposes named, pressable `Favorite` and `Add` controls, 219 of its 236 pressable elements
  carry names, and the grants inherit into the app's servers. All four lanes are recorded in
  [docs/maps.md](docs/maps.md) with what would have to change for each answer to flip.

### Fixed

- **The social card said "8 Apple apps".** `SPELLED` in
  [apps/website/src/config.ts](apps/website/src/config.ts) ran out at "seven" the day Maps
  shipped, and its fallback is `String(length)` — so the one heading rendered into
  `og-image.png` used the exact spec-sheet digit that array exists to prevent. Nothing in CI
  reads a picture, so it was invisible to every gate. The list is padded past the current
  count on purpose: one that ends at today's number fails silently again on the ninth
  surface.

## [1.3.1] - 2026-08-27

### Added

- **Maps is the eighth surface, and the first that cannot send an Apple Event.**
  `@mgcrea/mcp-apple-maps` reads the places saved on this Mac — favourites, collections (Guides)
  and recents — with real coordinates and addresses, through `apple_maps_list_favorites`,
  `apple_maps_list_collections`, `apple_maps_list_collection_places`, `apple_maps_list_recents`,
  `apple_maps_search_places`, `apple_maps_get_place` and `apple_maps_diagnostics`. Configuration is
  `APPLE_MAPS_STORE`, `APPLE_MAPS_INDEX_MODE`, `APPLE_MAPS_MAX_RESULTS` and
  `APPLE_MAPS_EXPOSE_PROMPTS`.

  Maps ships no scripting dictionary, so `usesAppleEvents` is FALSE for the first time in
  `surfaces.json` — which means adding this surface did **not** widen the Apple Events consent
  string the app asks for. It also means there is no second lane: without Full Disk Access this
  server returns an error rather than an empty list, because an empty list of favourites reads
  exactly like a person who has saved none.

  Read-only, and for a firmer reason than Safari's. The store is mirrored to iCloud by
  `NSPersistentCloudKitContainer`: a write is an edit to one replica of a synchronising object
  graph, underneath a running app that is also editing it, with `NSCK*` bookkeeping tables a
  third-party writer would not maintain. `APPLE_MAPS_ALLOW_WRITES` is accepted and ignored, and
  `tools.test.ts` asserts the tool list is identical with it on and off.

  Two bugs were caught only by running against a real store, and both are the kind a comfortable
  fixture cannot reach. `ZMUID` is a 64-bit Apple place id — a real one reads
  `-2679868148951248105` — and `node:sqlite` THROWS past `Number.MAX_SAFE_INTEGER` rather than
  truncating, so reading it as a number failed the entire favourites listing rather than that one
  field; it is now `CAST(... AS TEXT)`, which is the rule `docs/surfaces.md` already stated. And 12
  of 20 linked favourites carry `ZMUID = 0`, a sentinel rather than an id, now reported as null so
  two unrelated places cannot be taken for the same place.

  Columns are resolved by COVERAGE rather than by name, which no other surface has needed:
  `ZHISTORYITEM` carries both `ZLATITUDE` (1 row of 33) and `ZLATITUDE1` (19 of 33), and taking the
  first recognised name would report that Maps holds almost no coordinates.

- **`pnpm probe:maps`, and two spikes recording how this surface was nearly lost.**
  `scripts/probe-maps.mjs` reports the entity shapes, resolves the id bridge by running the join
  rather than reading column names, and detects the date epoch. `scripts/spike-maps-store.mjs`
  answers "is there a store behind the grant at all", and refuses to report a negative unless it can
  first open four stores that shipped surfaces read daily — Maps was declared "no file lane" three
  times by processes that never checked they could see anything. `scripts/spike-maps-ax.mjs` is the
  record of the Accessibility lane that was measured and rejected: readable, but ~14 s per read with
  no coordinates and no stable identifier, against 0 ms and both from the file lane.

### Fixed

- **`looksLikeDateColumn` never matched a single Core Data column.** Its token boundary was `_`,
  written for snake_case schemas like Calendar's `start_date`; Core Data has no underscores, so
  `ZCREATETIME` and `ZLASTVISITEDDATE` silently returned false in every Notes, Contacts and Maps
  store. A date detector that quietly finds nothing is exactly what `docs/surfaces.md` means by
  "dates are the richest source of silent errors". The new rule matches on SUFFIX rather than
  substring, because substring matching recreates the `calENDar_id` trap in a new alphabet —
  "update" contains "date", so `ZUPDATECOUNT` and `ZVALIDATED` would have read as timestamps.

- **Wire a single project folder, instead of every session on the Mac.** Settings ▸ Clients has a
  **Project folders** section: choose a folder, and Cupertino's servers are wired for that folder
  alone. Until now the app only offered `claude mcp add --scope user`, which is right for someone
  with three projects and wrong at ninety — measured on a real install, 12 of 93 tracked project
  directories had ever called a Cupertino tool, so 87% of sessions were carrying ~73 tool
  definitions they never used.

  A radio picks which file holds the entry. Both are read by Claude Code; only one is a file this
  app is willing to write.

  - **Your Claude Code config** adds it to `~/.claude.json` under the folder's path, leaving the
    folder untouched. The app will not write that file — it holds API credentials and running
    sessions write to it concurrently — so this hands over a command to paste, with the `cd`
    included, because local scope files the server under whatever directory the CLI ran from and a
    command pasted in the wrong terminal wires the wrong folder and reports success.
  - **A .mcp.json file** writes `.mcp.json` in the folder, where any Claude Code session opened
    there picks it up. That file is strict JSON with servers under `mcpServers`, the same shape as
    the four clients the app already writes, so it goes through the same merge, backup and atomic
    swap.

  The scope is a control next to the button rather than a preference in Settings: the choice is
  per-folder, and a global setting would be right for whichever kind of repo someone has more of
  and quietly wrong for the rest. The last choice is remembered, which is the part a preference
  would have bought.

### Fixed

- **Settings reported Full Disk Access as granted while every protected store was unreadable.**
  `Permissions.diskAccess()` walked the surface stores and returned `granted` on the first one it
  could open — and `Library/Application Support/AddressBook` opens without the grant, because it is
  gated by the Contacts TCC service, a different permission. So Contacts answered the question on
  behalf of Mail, Messages, Safari, Notes, Reminders and Calendar, and answered it wrongly. Measured
  with the grant absent: those six all denied, AddressBook readable, a green tick in Settings in the
  same second that `apple_mail_diagnostics` reported `fullDiskAccess: denied` and every mail lane
  fell back to Apple Events. The probe is now TCC's own database, which is present on every Mac and
  readable under exactly one condition. A permission row that lies is worse than no row: it sends
  someone looking for the fault everywhere except where it is.
- **The Settings item and its ⌘, were missing from the app menu.** Not because inserting them
  failed — the insertion succeeded at launch, with no error logged — but because SwiftUI installs
  its own `NSApp.mainMenu` after the delegate returns, and builds another whenever the activation
  policy flips, each replacement discarding what came before. Re-asserting the item on
  `didBecomeActive` and after every policy change did not help either: the rebuild lands after those
  hooks, so the race cannot be won by inserting more often. The item is now declared as a SwiftUI
  command, which makes it part of what gets rebuilt.
- **A composer failure could not say which permission was missing.** Filling a Mail reply goes
  through System Events, which sits behind two grants — Accessibility, and Automation to System
  Events, a separate grant from Automation to Mail. `prop()` swallows the exception either way, so
  both arrive as the same "no composer window" error, indistinguishable from Mail never having
  opened one. The old message named Accessibility outright; it was a guess with the other
  possibilities hidden, and it sent at least one investigation to re-grant a permission that was
  already in place. Diagnostics now reports the two separately, `-1743` (refused) is distinguished
  from `-1744` (never asked), and the reply and forward tools pre-flight the check rather than
  opening a window they cannot reach. A failed reply no longer leaves an empty composer on screen
  for someone to close by hand — every attempt used to add another — and one that opens and cannot
  be filled is closed again, unless something landed in it that could not be read back, which is
  left alone because discarding that would destroy the text with no undo.
- **A green Accessibility row in Settings while every reply failed.** Diagnostics asked
  `AXIsProcessTrusted`, which answers for an identity, and an identity turned out to be ambiguous:
  `tccutil reset Accessibility io.mgcrea.cupertino` reported clearing **four** separate entries on
  one machine — an installed copy, a development build and earlier reinstalls each leaving their
  own row, all shown as a single "Cupertino" in the pane. The app's check matched one and the
  checks made on its behalf matched another, so granting it again only ever added a fifth.
  Attribution was never at fault; `launchctl procinfo` puts the responsible pid of each server at
  the app, as designed. Diagnostics now reports `composerUiRead` — whether Mail's windows could
  actually be named — beside the flag, and that is the line to believe when the two disagree. The
  cure is to clear the identifier and grant once, from the bundle that is running.
- **The website's surface tool lists and captions had drifted from the shipped counts.**

### Internal

- A Stickies probe and a hand-written RTF-to-text reader under `scripts/`, exploring a surface that
  does not ship yet: RTFD attachments render as U+FFFC rather than being dropped, and the colour
  palette is read from the app's own asset catalogue instead of being guessed at.
- `pnpm version:sync` and `pnpm version:check`, so the eleven copies of the version can be
  propagated and gated without going through `make`.
- The calendar availability fixture no longer hangs past 10s in CI.

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

[unreleased]: https://github.com/mgcrea/cupertino/compare/app-v1.19.1...HEAD
[1.19.1]: https://github.com/mgcrea/cupertino/compare/app-v1.19.0...app-v1.19.1
[1.19.0]: https://github.com/mgcrea/cupertino/compare/app-v1.18.0...app-v1.19.0
[1.18.0]: https://github.com/mgcrea/cupertino/compare/app-v1.17.0...app-v1.18.0
[1.17.0]: https://github.com/mgcrea/cupertino/compare/app-v1.16.0...app-v1.17.0
[1.16.0]: https://github.com/mgcrea/cupertino/compare/app-v1.15.0...app-v1.16.0
[1.15.0]: https://github.com/mgcrea/cupertino/compare/app-v1.14.0...app-v1.15.0
[1.14.0]: https://github.com/mgcrea/cupertino/compare/app-v1.13.0...app-v1.14.0
[1.13.0]: https://github.com/mgcrea/cupertino/compare/app-v1.12.0...app-v1.13.0
[1.12.0]: https://github.com/mgcrea/cupertino/compare/app-v1.11.0...app-v1.12.0
[1.11.0]: https://github.com/mgcrea/cupertino/compare/app-v1.10.0...app-v1.11.0
[1.10.0]: https://github.com/mgcrea/cupertino/compare/app-v1.9.0...app-v1.10.0
[1.9.0]: https://github.com/mgcrea/cupertino/compare/app-v1.8.0...app-v1.9.0
[1.8.0]: https://github.com/mgcrea/cupertino/compare/app-v1.7.0...app-v1.8.0
[1.7.0]: https://github.com/mgcrea/cupertino/compare/app-v1.6.0...app-v1.7.0
[1.6.0]: https://github.com/mgcrea/cupertino/compare/app-v1.5.0...app-v1.6.0
[1.5.0]: https://github.com/mgcrea/cupertino/compare/app-v1.4.0...app-v1.5.0
[1.4.0]: https://github.com/mgcrea/cupertino/compare/app-v1.3.1...app-v1.4.0
[1.3.1]: https://github.com/mgcrea/cupertino/compare/app-v1.3.0...app-v1.3.1
[1.3.0]: https://github.com/mgcrea/cupertino/compare/app-v1.2.2...app-v1.3.0
[1.2.2]: https://github.com/mgcrea/cupertino/compare/app-v1.2.1...app-v1.2.2
[1.2.1]: https://github.com/mgcrea/cupertino/compare/app-v1.2.0...app-v1.2.1
[1.2.0]: https://github.com/mgcrea/cupertino/compare/app-v1.1.0...app-v1.2.0
[1.1.0]: https://github.com/mgcrea/cupertino/compare/app-v1.0.0...app-v1.1.0
[1.0.0]: https://github.com/mgcrea/cupertino/releases/tag/app-v1.0.0

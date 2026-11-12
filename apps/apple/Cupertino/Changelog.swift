import SwiftUI

/// What changed, in the build you are running.
///
/// Generated from the repository's `CHANGELOG.md` by `make changelog`, the same
/// way `SurfaceCatalog` is generated from `surfaces.json` and for the same
/// reason: a copy nobody regenerates is a copy that rots, and here it would rot
/// into the worst possible shape — release notes that confidently describe a
/// different build.
///
/// **Why generated rather than bundled.** The obvious alternative is to ship
/// `CHANGELOG.md` as a resource and parse it at launch. Baking the text in at
/// generation time means the parse happens once, in Node, where
/// `make changelog-check` can assert the result, rather than on every launch
/// where nothing can — and it keeps a markdown parser out of an app that
/// deliberately carries no dependency it does not need.
///
/// Every string below is **raw markdown**. The generator does not decide what
/// bold looks like; `markdown(_:_:)` renders it.
///
/// The list is capped — see `SHOWN` in `scripts/generate-changelog.mjs` —
/// because this is the pane you open after updating, not an archive. The full
/// history is a link away, and `CHANGELOG.md` remains the source of truth.
nonisolated enum Changelog {
  /// One released version.
  struct Release: Identifiable, Hashable {
    /// `"1.17.0"`. Compared against the marketing version and the seen key.
    let version: String
    /// `"2026-09-07"`. Kept as the ISO string the CHANGELOG wrote rather than a
    /// `Date` literal: a `Date(timeIntervalSince1970:)` in a generated file is
    /// unreadable in a diff, and formatting at generation time would bake the
    /// generating machine's locale into every build.
    let date: String
    let sections: [Section]

    var id: String { version }
  }

  /// One `### Added` / `### Fixed` block.
  ///
  /// `name` is whatever the CHANGELOG wrote. This file does not stick to the
  /// Keep a Changelog set — there is a `### Removed` and a `### Security` in
  /// recent releases — so nothing here is an enum.
  struct Section: Identifiable, Hashable {
    let name: String
    /// The prose that can sit between the heading and the first bullet.
    /// Dropping it silently shortens the notes, which is exactly the kind of
    /// loss nothing would report.
    let lead: [String]
    let entries: [Entry]

    var id: String { name }
  }

  /// One bullet.
  struct Entry: Identifiable, Hashable {
    /// Emitted rather than derived, so `ForEach` has a stable identity without
    /// hashing prose or inventing a `UUID` that changes every render.
    ///
    /// Unique across the whole **release**, not within its section. SwiftUI
    /// flattens the section/entry `ForEach` pair inside a `Form`, so
    /// per-section numbering collides as soon as a release has two sections —
    /// and the pane then draws the first section's bullet a second time in
    /// place of the second section's. It looks like a duplicated entry, not
    /// like an identity bug, which is why it is worth a paragraph.
    let ordinal: Int
    /// The leading `**…**`, asterisks removed — or nil. Not every bullet in
    /// this file opens with one, so this is an optional by observation rather
    /// than by caution.
    let headline: String?
    /// The rest, one string per paragraph.
    let body: [String]

    var id: Int { ordinal }
  }

  /// Where the full history lives, since only the most recent releases are here.
  static let historyURL = URL(
    string: "https://github.com/mgcrea/cupertino/blob/main/CHANGELOG.md")!

  // MARK: - Which build this is

  /// The marketing version alone: no build number, no `-dev`, no demo override.
  ///
  /// Neither `AppInfo.version` nor `AppInfo.shortVersion` will do. The first is
  /// `"1.17.0 (119)"` and the second appends `developmentSuffix` and returns
  /// `DemoSeed.version` under a capture — both correct for showing a human, and
  /// both wrong for comparing against a version string written in a defaults
  /// key, where `"1.17.0-dev"` would never equal anything.
  static var marketingVersion: String {
    Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
  }

  /// Whether this build was compiled with `[Unreleased]` still meaning
  /// something. See `unreleased`.
  static var showsUnreleased: Bool {
    #if DEBUG
      return true
    #else
      return false
    #endif
  }

  /// `a` is a later release than `b`, comparing dotted numbers.
  ///
  /// Written here rather than reached for elsewhere because the app has no
  /// version comparator: `AppInfo.major` takes the first component and stops.
  /// Numeric per component, so `1.10.0` is correctly newer than `1.9.0` — the
  /// comparison a lexicographic one gets backwards, and the one this app is
  /// about to need every release.
  ///
  /// Anything non-numeric compares as 0, which makes an unparseable version
  /// "not newer" rather than a crash. Nothing here is worth a trap.
  static func isVersion(_ a: String, newerThan b: String) -> Bool {
    let left = a.split(separator: ".").map { Int($0) ?? 0 }
    let right = b.split(separator: ".").map { Int($0) ?? 0 }
    for index in 0..<max(left.count, right.count) {
      let l = index < left.count ? left[index] : 0
      let r = index < right.count ? right[index] : 0
      if l != r { return l > r }
    }
    return false
  }

  // MARK: - Seen

  /// The last version whose notes were actually read.
  ///
  /// A marketing version string, not a bool: the question the indicator answers
  /// is "did anything ship since you last looked", which needs the comparison.
  static let seenKey = "changelogSeenVersion"

  /// Seed the seen version on a launch that has never set it.
  ///
  /// Without this, a fresh install lights every indicator in the app on first
  /// launch — the key is absent, so everything looks unread, and Cupertino
  /// greets somebody who has never run it with "five new releases". An upgrade
  /// from a build that predates this pane is indistinguishable from that fresh
  /// install (neither wrote the key), so both are treated as caught up. The cost
  /// is that the indicator does nothing until the *next* release; the
  /// alternative costs every new user a false badge.
  static func markSeenIfUnset() {
    guard UserDefaults.standard.string(forKey: seenKey) == nil else { return }
    markSeen()
  }

  /// Record that the notes for this build have been read.
  static func markSeen() {
    UserDefaults.standard.set(marketingVersion, forKey: seenKey)
  }

  /// Releases newer than the last one whose notes were read.
  ///
  /// Empty rather than everything when the key is unset — see
  /// `markSeenIfUnset()`.
  static var unseen: [Release] {
    guard let seen = UserDefaults.standard.string(forKey: seenKey), !seen.isEmpty else { return [] }
    return releases.filter { isVersion($0.version, newerThan: seen) }
  }

  /// Whether to draw an indicator anywhere.
  ///
  /// False under a screenshot capture, unconditionally. The indicator depends on
  /// a defaults value the capture run does not set, so without this guard a dot
  /// appears in the sidebar footer of the golden plates depending on what the
  /// developer's machine happened to have read — drift with no code change
  /// behind it, which is the hardest kind to explain.
  static var hasUnseen: Bool {
    if DemoSeed.isEnabled { return false }
    return !unseen.isEmpty
  }

  // MARK: - Rendering

  /// One markdown string as `Text` can draw it.
  ///
  /// `Text` honours `**bold**`, `_italic_` and links from an `AttributedString`
  /// on its own. It does nothing at all for `` `code` `` — the markdown parser
  /// records that as a semantic `inlinePresentationIntent` and applies no font —
  /// so the loop below is the whole of the missing half. This CHANGELOG is dense
  /// with tool and symbol names, so that is most of what it renders.
  ///
  /// The style is a parameter because setting `.font` on a run **overrides** the
  /// view's own `.font()` for that run: a body-sized helper used inside a
  /// caption makes one word jump a size. And the emphasis has to be reapplied,
  /// because headlines here contain code spans inside the bold — assigning a
  /// plain monospaced font would silently un-bold them.
  ///
  /// Note that `Text("**bold**")` renders markdown only for string *literals*,
  /// through the `LocalizedStringKey` overload. Every string here is a variable,
  /// which takes the `StringProtocol` overload and draws the asterisks. So this
  /// is not an embellishment; without it the pane shows raw markdown.
  static func markdown(_ source: String, _ style: Font.TextStyle = .body) -> AttributedString {
    guard
      var text = try? AttributedString(
        markdown: source,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
    else {
      // Literal asterisks are ugly and honest. Nothing here is worth a crash.
      return AttributedString(source)
    }
    for run in text.runs {
      guard let intent = run.inlinePresentationIntent, intent.contains(.code) else { continue }
      var font = Font.system(style, design: .monospaced)
      if intent.contains(.stronglyEmphasized) { font = font.bold() }
      if intent.contains(.emphasized) { font = font.italic() }
      text[run.range].font = font
    }
    return text
  }

  // MARK: - Generated

  // <generated:changelog> generated from CHANGELOG.md by `make changelog` — do not edit by hand

  /// The most recent 5 releases, newest first.
  ///
  /// Split into one `let` per release rather than a single nested literal.
  /// Swift's expression type-checker is superlinear in the depth of an array
  /// literal, and this one is releases of sections of entries of strings — the
  /// exact shape that turns into a multi-second type-check with no diagnostic.
  // swift-format-ignore
  static let releases: [Release] = [v1_39_0, v1_38_0, v1_37_1, v1_37_0, v1_36_2]

  // swift-format-ignore
  private static let v1_39_0: Release = Release(
    version: "1.39.0",
    date: "2026-11-12",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Typing into a field no longer takes the front.",
            body: [
              "`apple_desktop_type` with a `handle` focuses that field through Accessibility, sends the text to its application alone, and reads the field back. The application stays behind whatever the person is using, and their keyboard stays theirs. The answer says `lane: \"background\"` and whether the whole text `verified`. A field that did not change, or one that cannot be read back, such as a password field, is typed into the way it was before, with its application brought forward. Because a background type cannot reach the person's keyboard, it opens the driving session without the countdown. The orange card still shows, and the first verb that does take the front still gets the countdown. Measured against AppKit and SwiftUI fields and TextEdit; shortcuts still need the front.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Drive a Debug build of one of our apps without it coming forward.",
            body: [
              "`apple_desktop_launch` with `channel: true` opens a driving channel in an app that links swift-support-kit's `SupportKitDriving`. Click, drag, hover, key and type with its `bundleId` then go into its own windows (`lane: \"channel\"`), including shortcuts and windows covered by other apps. Nothing reaches the person's keyboard or cursor. The channel exists only in Debug builds, and other applications are driven as before. `path` starts one exact `.app`: the Debug build of an App Store app that shares its bundle id with the installed copy. Nothing is started while another copy with that bundle id is running.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Rename, move, favourite, delete and restore a voice memo, in Cupertino.",
            body: [
              "Five tools, `rename_recording`, `move_recording`, `set_favorite`, `delete_recording` (to Recently Deleted) and `restore_recording`, exist only when Cupertino hosts the Voice Memos server and its writes are on; from npm they are absent. Cupertino.app saves each one through Core Data with Voice Memos' own model, as a change made in the app is. A rename written straight into the database showed on the Mac and never reached the iPhone. Each tool changes only what Voice Memos itself changed for the same edit, watched one step at a time. Every tool's sync was measured on macOS 27.2 on a Mac and an iPhone: there each write reaches iCloud like a change made in the app, even with Voice Memos closed, as its background service uploads it. On another Voice Memos model version the result says sync is not yet measured.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 3,
            headline: "Maps' writes save through Maps' own model, in Cupertino.",
            body: [
              "When Cupertino hosts the Maps server, `add_favorite`, `remove_favorite`, `save_place`, `remove_saved_place` and `add_place_to_guide` are saved by Cupertino.app through Core Data with Maps' own model, so each is recorded like a change made in the app. Each follows what Maps itself saved for the same step, watched one step at a time on macOS 27.2. None of them brings Maps' window forward or presses anything any more, and `add_place_to_guide` answers `filed: true` only when reading the Guide back finds the place there. A place not yet in the store is still resolved by Maps from its name, which leaves it in your Recents. Every tool's sync was measured on macOS 27.2 on a Mac and an iPhone: there a write reaches iCloud even with Maps closed, as its background service uploads it. On another Maps model version the result says sync is not yet measured.",
            ]),
          Entry(
            ordinal: 4,
            headline: "Unpinning a Maps favourite keeps the place, as Maps does.",
            body: [
              "In Maps, unpinning moves a place into your library as a saved place rather than deleting it. In Cupertino, `remove_favorite` now does the same and says so, and `remove_saved_place` is what removes the place entirely.",
            ]),
          Entry(
            ordinal: 5,
            headline: "`remove_saved_place` takes a ref.",
            body: [
              "In Cupertino it takes a ref from `list_unfiled_places` or `list_collection_places`, with `confirm: true`, instead of a place name and coordinate: Maps' coordinate and yours differ by up to a building's width, so a coordinate can match the wrong place. `add_place_to_guide` takes a ref to a saved place, or a name to save a new place and file it in one save.",
            ]),
        ]),
      Section(
        name: "Removed",
        lead: [],
        entries: [
          Entry(
            ordinal: 6,
            headline: "The npm Maps package no longer writes to Maps.",
            body: [
              "Run from npm, `@mgcrea/mcp-apple-maps` now only reads, whatever `APPLE_MAPS_ALLOW_WRITES` says: `add_favorite` and `remove_favorite`, which wrote SQL straight into Maps' store, are gone. A favourite written that way was watched never to reach iCloud, and Maps itself was seen converting favourites that look like it into saved places.",
            ]),
          Entry(
            ordinal: 7,
            headline: "Maps no longer presses buttons on its place card, in Cupertino.",
            body: [
              "The Accessibility route for `save_place`, `remove_saved_place` and `add_place_to_guide` is gone. The same five Maps tools remain in Cupertino, saved through Maps' own model by the store lane, the way a change made in the app is.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 8,
            headline: "Safari's cookies come from the profile of the tab that asked.",
            body: [
              "`apple_safari_cookies` read Safari's default cookie store, which belongs to one profile, so a tab in any other profile got that profile's session, and signing in again there changed nothing the tool saved. It now reads only the store holding the tab that answered, names it as `store`, and refuses, naming the profile as the cause, when no single store holds the tab. A `probe` option lists every store's copy of one cookie, each value shown only as a short hash, to tell which profile a session lives in. The Safari extension needs this update for the fix; from an older one, `store` is `null` and the tool says the cookies may be another profile's.",
            ]),
          Entry(
            ordinal: 9,
            headline: "Mail searches and counts with an account allowlist cover only the allowed accounts.",
            body: [
              "With `APPLE_MAIL_ACCOUNTS` set and no account or mailbox named, `apple_mail_query` counted and named senders from excluded accounts, and `search_messages` pages came back short or empty. Unscoped queries are now limited to the admitted accounts in SQL.",
            ]),
          Entry(
            ordinal: 10,
            headline: "Paging through a message's raw source never breaks an accented character.",
            body: [
              "A page boundary inside a multibyte character turned both halves into replacement characters, and when Mail supplied the source itself, offsets were counted in UTF-16 units rather than bytes. Both routes now page in UTF-8 bytes and return `nextOffset` to resume from.",
            ]),
          Entry(
            ordinal: 11,
            headline: "Calendar lists and searches no longer report a busy week as free.",
            body: [
              "When hidden declined or cancelled events filled the internal query limit, later events were dropped and `hasMore` was false. The result now sets `hasMore` with `nextFrom` (list) or `nextTo` (search), and leaves the resume point out when it would not move, so following it never loops.",
            ]),
          Entry(
            ordinal: 12,
            headline: "Searching Messages and Calendar finds accented words whatever their case.",
            body: [
              "SQLite folds ASCII only, so \"ÉTÉ\" missed \"été\" in message text and \"été\" missed \"Été indien\" in event titles. Searches with non-ASCII text now fold case fully.",
            ]),
          Entry(
            ordinal: 13,
            headline: "Mail drafts say when Cupertino declined to lend its Accessibility access.",
            body: [
              "A refusal from the app, such as Mail switched off or no licence, was reported as a missing Accessibility grant, sending people to a setting that was already on. Compose, draft edits, rebuilds, `list_open_drafts` and diagnostics now pass on the app's own reason.",
            ]),
          Entry(
            ordinal: 14,
            headline: "Flag, move and delete over several mailboxes or calendars report what was already done when one fails.",
            body: [
              "A later mailbox's or calendar's error discarded the earlier results and returned a bare error, though those items had already changed. Each item now gets its own row with an error code, timed-out ones are counted as `unknown`, and Calendar refreshes its cached store either way.",
            ]),
          Entry(
            ordinal: 15,
            headline: "`update_draft` outside Cupertino no longer reports a replacement that never saved.",
            body: [
              "When sync renumbered the original draft, it could pass for the replacement, giving `replaced: true` with the original's id. The replacement must now open with the new text and carry a new Message-ID.",
            ]),
          Entry(
            ordinal: 16,
            headline: "Chat can still reply to and forward mail after the trial ends.",
            body: [
              "Mail's replies, forwards and open drafts, and the other actions that borrow Desktop's Accessibility access, went through the licence check the Chat pane itself is exempt from, so with an expired trial they were refused and reached the model as a missing permission. A borrow now counts as admitted, because the server asking for it already was.",
            ]),
          Entry(
            ordinal: 17,
            headline: "Configure on a client that is already set up writes nothing and keeps your original backup.",
            body: [
              "For JSON clients, a second Configure rewrote the file and replaced `.cupertino-backup`, the copy of your config from before Cupertino touched it, with the configured version. It now writes only when something changed, and says \"Already up to date\" when nothing did.",
            ]),
          Entry(
            ordinal: 18,
            headline: "Switching off Allow writes or a gate reaches editors that are already connected.",
            body: [
              "A Node server reads its settings once, at start, so an open editor kept tools like `send_message` and `find_codes` until it was restarted. Cupertino now stops any running server started with a setting that has since been switched off, and the editor reconnects to one started without it.",
            ]),
          Entry(
            ordinal: 19,
            headline: "The Log keeps up when it is busy.",
            body: [
              "Follow stopped scrolling once the log was full, at 1,000 rows or a few hundred when calls carry payloads, and Show less could not close a row a search had opened. Follow now tracks each new row, and the button wins until the search changes.",
            ]),
          Entry(
            ordinal: 20,
            headline: "Turning on Launch at login stays on.",
            body: [
              "When macOS still needed your approval, the switch read back as off and the app then removed the registration you had just asked for. It now shows what macOS reports, and Settings says when approval is pending, with a button to open Login Items.",
            ]),
          Entry(
            ordinal: 21,
            headline: "Answering the update question in Settings removes the card in the main window.",
            body: [
              "The card kept its own copy of the answer, so it went on showing, and clicking it reversed what you had just chosen. The card and Settings now read one answer.",
            ]),
          Entry(
            ordinal: 22,
            headline: "The audit log's \"including message contents\" switch follows the settings that put contents on disk.",
            body: [
              "It was greyed out by the app-wide content setting, while each surface's own setting is what decides, so it could be off while contents were written. It now names the surfaces whose contents would be written.",
            ]),
          Entry(
            ordinal: 23,
            headline: "Opening the Activity settings no longer freezes the app while the log is verified.",
            body: [
              "Verification ran on the main thread each time the pane opened, which took seconds on a full log. It now runs in the background, and the button says \"Verifying…\" meanwhile.",
            ]),
          Entry(
            ordinal: 24,
            headline: "The licence server stops reading an oversized request as soon as it passes the limit.",
            body: [
              "The Stripe webhook and the licence re-send form read the whole body before measuring it, so a chunked upload was held in full and two-byte text got through at twice the limit. Both now count bytes as the body arrives and stop at the cap.",
            ]),
          Entry(
            ordinal: 25,
            headline: "The licence email and the thank-you page name the major version your key covers.",
            body: [
              "Both said \"every 1.x release\" as fixed text. They now read the version stored with the licence.",
            ]),
          Entry(
            ordinal: 26,
            headline: "Driving an app without the Accessibility grant says the grant is missing, with nothing put on screen.",
            body: [
              "A click, hover, type or key that brings an app forward opened a driving session, activated the app, waited two seconds and blamed the app for not coming to the front. The grant is now checked first.",
            ]),
          Entry(
            ordinal: 27,
            headline: "Desktop and Simulator trees stay within their 40,000-byte cap.",
            body: [
              "Elements were measured on their own rather than as nested in the answer, and `wait_for` added fields after the cap, so answers ran to 52,000 bytes or more. The whole answer is now measured as sent.",
            ]),
          Entry(
            ordinal: 28,
            headline: "Expanding a handle whose window has closed says the element is gone.",
            body: [
              "It used to return an empty tree that looked complete. A stale element is now named by its handle.",
            ]),
          Entry(
            ordinal: 29,
            headline: "`set_value` confirms clearing a field, a trailing space, a slider and a checkbox.",
            body: [
              "The read-back trimmed text and read strings only, so these writes were reported as dropped although they had landed. The raw value is now compared, and the answer includes `actual`.",
            ]),
          Entry(
            ordinal: 30,
            headline: "Simulator handles from `ui_tree` no longer expire after about a dozen calls.",
            body: [
              "Every call minted a handle for each node it walked to find the device screen, up to 1,500 at a time, which pushed the caller's handles out. Only candidate screen groups get one now.",
            ]),
          Entry(
            ordinal: 31,
            headline: "A desktop `run` with a malformed step is refused before any step runs.",
            body: [
              "A one-title `press_menu` path, a `set_value` given a number, a `find_elements` with no criteria or an unknown key name used to run the earlier steps first. Each step is now checked by the same check the tool makes, and `apple_desktop_key` refuses an unknown key before bringing an app forward.",
            ]),
          Entry(
            ordinal: 32,
            headline: "`apple_simulator_type` types the exact character, or reports it untyped.",
            body: [
              "Shift was assumed to give a key's uppercase, so on AZERTY É went out as \"2\" while counted as typed, and on a US layout `!`, `@` and `?` could not be typed. Each character now uses the key that produces it.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_38_0: Release = Release(
    version: "1.38.0",
    date: "2026-11-10",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Voice Memos, a new surface: `@mgcrea/mcp-apple-voice-memos`.",
            body: [
              "Lists your recordings with their folders, favourites and Recently Deleted, and reads **the transcript Apple made of each one**, which macOS embeds in the audio file. Every segment carries its start and end, so a quote can be found again by listening. Search ignores case and accents, so \"cafe\" finds \"Café\". Recordings from before 2025 have no transcript, because Apple did not backfill, and the server says so rather than making one up. With writes on, `save_recording` copies a recording's audio to `~/Downloads`, where Cadence can pick it up. Nothing writes to Voice Memos itself: the app ships no scripting dictionary, and its App Intents can only be run from Shortcuts. Full Disk Access is required. Checked against a real library of 87 recordings: all 28 from 2025 on read, and an exported `.m4a` and `.qta` both transcribed in Cadence.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Claude Code's pane says when its allowlist hides a surface.",
            body: [
              "Claude Code silently drops a server its `allowedMcpServers` or `deniedMcpServers` refuses, so a surface Cupertino had wired correctly could be missing from every session. The pane now reads `~/.claude/settings.json` and managed settings, applies Claude Code's own matching rules, badges each refused entry and says what to do: Update in Bastion for Bastion's list, the entries to paste for a hand-written one, the Mac's admin for managed settings.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 2,
            headline: "Shell asks once per session by default.",
            body: [
              "\"Before running\" now starts at Ask once per session, and turning Shell off puts it back there. If you never changed it, this update moves you to it. The setting alone approves nothing: the first run on each connection still shows the whole script, with Don't run as the default button, and only \"Run, and stop asking this session\" approves the rest of that connection, for 30 minutes at most. Under Ask every time that button sat behind a picker few people open. Ask every time is still there, and a \"Don't ask\" Cupertino did not seal itself still reads as Ask every time.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 3,
            headline: "A Safari tab no longer stops answering after one lost message.",
            body: [
              "Safari can drop a page's message to the extension's background when the worker is stopped or still starting, and the page then waited for an answer that never came: that tab stopped polling, so every click, fill and `page_elements` on it timed out, while other sites kept answering, until the page was reloaded. Each message now gets ten seconds and a lost one counts as a failed poll, so the tab polls again at its usual interval. A reply that turns up after its wait is dropped with its commands rather than run late, and a result that cannot be filed no longer abandons the rest of its batch. Pages need one reload after this update to pick up the new script.",
            ]),
          Entry(
            ordinal: 4,
            headline: "A Mail attachment whose accented name is split across header lines keeps its real name.",
            body: [
              "Some servers, Open-Xchange among them, cut an encoded filename such as `=?UTF-8?Q?...?=` across several `filename*0`, `filename*1` parameters. Those pieces were joined but never decoded, so `list_attachments` and `get_message` showed the raw encoded text and `save_attachment` could not find the attachment under either name. They are now decoded once joined. `save_attachment` also matches names whatever their Unicode normalization, still accepts the raw spelling earlier versions listed, and says which names the message has when none matches.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_37_1: Release = Release(
    version: "1.37.1",
    date: "2026-11-07",
    sections: [
      Section(
        name: "Security",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Shell warns about a line break the window shows and zsh does not.",
            body: [
              "The window started a new line at a lone carriage return and at U+2028 and U+2029, which zsh reads as ordinary characters, so `ls ~/Documents\\r# ; curl … | sh` showed as `ls` over a comment while zsh ran the `curl`. Each of those now gets the hidden-characters warning, and the line count counts every line the window draws. A Windows line ending (CR LF) is still not flagged: both end the line there.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Shell's \"Turn On Shell\" and \"Don't Ask\" buttons refuse a click through a window laid over them.",
            body: [
              "The run window already did this. The two sheets that lower the bar had no such watch, so a program with Accessibility could open \"Don't Ask\", cover its button with a click-through window and borrow your next click. Each sheet's button now turns off while another window covers it, and says so.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Declining a Shell request also calls off that client's other waiting requests.",
            body: [
              "An agent can open connections as it likes, so four requests stood in line, and \"Don't run\" on the first brought the other three straight up. They are now withdrawn with it, and answer as the cooldown. Another client's window keeps waiting.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 3,
            headline: "A message listed in a Gmail INBOX is moved and deleted in INBOX.",
            body: [
              "On the index lane, `list_messages` named each message by the mailbox its file lives in, which for a Gmail INBOX is All Mail, so `move_messages` and `delete_messages` acted on the All Mail copy. Refs now name the mailbox that was listed. A ref naming INBOX also finds the message's file under All Mail, so `list_attachments` and `save_attachment` work on it instead of failing.",
            ]),
          Entry(
            ordinal: 4,
            headline: "`update_draft` no longer edits the wrong open message.",
            body: [
              "A closed draft that is not a reply was matched to an open window by the shorter of their openings, so an open message reading \"Hi Dave,\" could have its text replaced in place of the draft \"Hi Dave, the VMs are up…\" with the same subject. Such a draft now needs a window holding exactly its text. Replies keep the old rule.",
            ]),
          Entry(
            ordinal: 5,
            headline: "An edited Mail draft keeps characters like `é` and `’` that it stored as HTML entities.",
            body: [
              "A draft that came in from Outlook could hold `&eacute;` or `&rsquo;`, and an edit to it sent the recipient \"Caf&eacute;\". The rest of the text is now kept byte for byte, as intended.",
            ]),
          Entry(
            ordinal: 6,
            headline: "A draft edit with attachments that would land in a reply's quote is refused before anything is pasted.",
            body: [
              "It used to be refused only after the new body was already in a window Mail autosaves.",
            ]),
          Entry(
            ordinal: 7,
            headline: "Rebuilding a reply draft refuses a subject that did not take",
            body: [
              ", leaving the original draft as it was, instead of reporting the draft replaced under Mail's own \"Re:\".",
            ]),
          Entry(
            ordinal: 8,
            headline: "Without Cupertino.app, Mail sends nothing when it holds fewer files than asked.",
            body: [
              "The message stays open as a draft and the result says how many files are there. Replies and forwards on this path now report their `attachments` like the other two paths. A refused reply draft no longer says its window is closed, since nothing on this path looked.",
            ]),
          Entry(
            ordinal: 9,
            headline: "A mailbox created since Cupertino last read Mail's list is found the first time.",
            body: [
              "`list_messages`, `count_messages` and `search_messages` refused it with \"No mailbox\" after a pause, and found it on the next call. They now read the list again before refusing a name.",
            ]),
          Entry(
            ordinal: 10,
            headline: "Mail and Messages watches no longer skip mail or replay old mail.",
            body: [
              "A watch read could move past a message in a mailbox created since the last refresh, so it was never returned. And when Mail's index or Messages' database was rebuilt as a new file, every older message above the watch's start came back as new. A watch now restarts at the new file's latest message.",
            ]),
          Entry(
            ordinal: 11,
            headline: "Safari commands keep working after Back and Forward.",
            body: [
              "A page restored from the back/forward cache stopped taking commands, and every one timed out as if the extension were not installed there.",
            ]),
          Entry(
            ordinal: 12,
            headline: "`apple_safari_wait_for` finds text across a line break on pages whose script predates `find`.",
            body: [
              "A heading spread over two lines was never matched, and with `gone: true` it came back `met: true` while the words were still on the page.",
            ]),
          Entry(
            ordinal: 13,
            headline: "Safari's network list shows a streaming fetch's status as soon as it starts.",
            body: [
              "Server-sent events and other streamed responses read status `null` until the stream ended, or for good if it never did. A `data:` URL over 256 characters is now listed as its header and length rather than whole, so one 4 MiB image no longer makes a 4-million-character answer; `urlContains` still matches all of it.",
            ]),
          Entry(
            ordinal: 14,
            headline: "`get_reminder` in Reminders says \"not found\" for a deleted reminder on a Mac set to another language.",
            body: [
              "It recognised the error only by its English text, and failed with a raw script error.",
            ]),
          Entry(
            ordinal: 15,
            headline: "The Simulator surface names DeviceHub when nothing is showing the simulator.",
            body: [
              "On Xcode 27, with DeviceHub closed, every call answered \"com.apple.iphonesimulator is not running\", which sent an agent looking for a Simulator.app that Xcode 27 does not ship. It now names the app this Mac has, says how to open it (`open -b com.apple.dt.Devices`, then select the device in its sidebar), and warns that quitting DeviceHub shuts every booted simulator down.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 16,
            headline: "`create_reminder` and `move_reminders` find their list about 2 s sooner.",
            body: [
              "Without the Reminders store open, they counted every list's completed reminders to pick one by name, and threw the counts away.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_37_0: Release = Release(
    version: "1.37.0",
    date: "2026-11-06",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Mail's `save_attachment` has Mail download an attachment it has not fetched yet.",
            body: [
              "On a Gmail account that caches messages without their attachments, most older attachments were never on disk, and saving one failed with \"not stored locally\". Cupertino now asks Mail to save it, which makes Mail fetch it from the server (the result says `from: \"mail\"`); Mail keeps the copy, so the attachment reads as retrievable afterwards. Mail has to be running and online. It writes into a staging folder that is removed after the copy, never into the destination itself.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_36_2: Release = Release(
    version: "1.36.2",
    date: "2026-11-03",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "A Mail draft with no subject is pasted, not assigned, when Cupertino hosts the server.",
            body: [
              "It went through Apple Events, which wraps the body in a quotation the recipient sees, and taking that off needed Automation for System Events. It is now filled and saved through Cupertino's own Accessibility driver, like every other draft. Sending a message with no subject at once still takes the old path, because Mail asks about the missing subject before sending it.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Safari brought to the front by `apple_safari_open_url` is announced like any other driving.",
            body: [
              "With `activate: true` Safari came forward through an Apple Event, with no notice and no say for the person at the keyboard. It now goes through Cupertino's driver, and the result says whether it happened (`activated`). Safari stays in front afterwards rather than being handed back when the session idles out.",
            ]),
        ]),
    ])

  /// Work that is written down but not shipped.
  ///
  /// `nil` in any tagged build: CI asserts the CHANGELOG's head section is the
  /// tag's version, so there is no `[Unreleased]` left to emit by then. The
  /// pane shows it in debug builds only, where it is true of what is running.
  static let unreleased: Release? = nil
  // </generated:changelog>
}

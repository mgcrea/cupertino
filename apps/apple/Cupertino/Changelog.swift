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
enum Changelog {
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
  static let releases: [Release] = [v1_17_0, v1_16_0, v1_15_0, v1_14_0, v1_13_0]

  // swift-format-ignore
  private static let v1_17_0: Release = Release(
    version: "1.17.0",
    date: "2026-09-07",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "A `simulator` surface.",
            body: [
              "Simulator.app bridges a simulated device's accessibility tree into the Mac's, so an iOS app's own controls are readable and pressable with no WebDriverAgent and no runner process — and until now reaching them cost switching Desktop to \"Reach any application\", which opens every window on the Mac to touch a developer's own app. The new surface is served in-process, pinned to `com.apple.iphonesimulator` with no switch that widens it, and answers in **iOS points**: the device screen is found as the `AXGroup` whose size is the device's point size times the window scale, the scale is measured against CoreSimulator's own `profile.plist` rather than assumed to be 1, and every `rect` and `point` can be handed to `ios_simulator_tap` unchanged. Four read tools and, behind writes, `press`, `tap`, `swipe`, `type`, `key` and `press_button`. Deliberately absent: boot, install, launch, screenshots, push and staging, which need no grant and belong to `@mgcrea/mcp-ios-simulator`. Measured in [docs/simulator.md](docs/simulator.md): a click lands only once the Simulator is frontmost, a drag arrives as a touch pan, and the Simulator forwards key codes rather than characters, so typing goes one key at a time on the Mac's layout.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "A depth-capped walk silently dropped every sibling after the first branch that hit the cap.",
            body: [
              "The depth bound set the same \"stopped\" flag the node and time bounds do, and the walk returns on that flag before visiting the next node — so a depth-1 listing of a window with eleven children answered one and named `depth(1)` as the reason, which is true and useless. Found by the first simulator probe; the cap is reported and no longer stops anything.",
            ]),
          Entry(
            ordinal: 2,
            headline: "A message addressed to a group could be delivered privately to one person.",
            body: [
              "The send lane passed a group chat's first participant as its handle, and the JXA ladder guesses a one-to-one chat id from a handle whenever the chat lookup above it throws. Reconciliation then polled the group and found nothing, so it reported `pending` — \"do not send again\" — for a message that had been sent, to the wrong recipient. A group ref now carries no handle at all.",
            ]),
          Entry(
            ordinal: 3,
            headline: "Every Maps favourite carried a wrong Apple place id, and synced it.",
            body: [
              "The donor's `ZMUID` is a 64-bit integer read deliberately as text because a real one is past `MAX_SAFE_INTEGER`; the write put it back through a JavaScript number, which SQLite binds as a double. The id landed rounded — measured 233 away — in a CloudKit-mirrored store, so it reached every device on the account.",
            ]),
          Entry(
            ordinal: 4,
            headline: "A pruned audit log reported itself as tampered with.",
            body: [
              "Retention drops whole segments, and the verifier started every run from genesis, so the oldest surviving record was always a broken link and the Activity pane went red saying a record had been removed. It now seeds from the surviving segment's own link and reports \"verifies from segment N\". A mislabelled first segment and a gap in the middle are still failures. Retention's 30-day bound also never ran on a Mac that logs a few hundred calls a day, because pruning only happened on a 4 MB rotation.",
            ]),
          Entry(
            ordinal: 5,
            headline: "A mailbox filter that matched nothing searched everything instead.",
            body: [
              "An empty set of index rowids read the same as \"no filter asked for\", so a scoped Mail search could return other accounts' messages and a per-mailbox count could report the whole archive. It refuses now, naming the mailboxes the index actually holds.",
            ]),
          Entry(
            ordinal: 6,
            headline: "Notes ignored the account allowlist and the folder argument whenever it could read the store.",
            body: [
              "Both failed open, and only on machines with Full Disk Access — which is exactly where they matter. Both now take the slower Apple Events lane rather than answering with what was not asked for.",
            ]),
          Entry(
            ordinal: 7,
            headline: "Date arguments were parsed six different ways, and three of them were wrong.",
            body: [
              "An unreadable date became `NaN`, which SQLite binds as `NULL`, so Mail answered a date written in words with zero results and no error. A bare day meant UTC midnight in some places and local midnight in others. An upper bound naming a day excluded that whole day. `2026-02-30T09:00` silently became 2 March. There is one grammar now, in core, and it refuses what it cannot read.",
            ]),
          Entry(
            ordinal: 8,
            headline: "Mail's composer waited on the wrong signal, and asked the wrong object who had focus.",
            body: [
              "Two fixes from before this release: the readable state is not ready when the window appears, so the focus is polled; and focus is a property of the application, not of the element being addressed.",
            ]),
          Entry(
            ordinal: 9,
            headline: "`find_codes` could miss a code that was right there.",
            body: [
              "Its limit capped the messages scanned before the user's own replies were filtered out, so an ordinary few minutes of conversation pushed the code off the page. Direction is now a database predicate, and the limit applies to the codes returned.",
            ]),
          Entry(
            ordinal: 10,
            headline: "Messages search returned nothing recent once older results filled the page",
            body: [
              ", because the text column pass ran to the limit before the archived-blob pass got a look — and every message since March 2026 lives only in a blob. The two passes are merged by date now.",
            ]),
          Entry(
            ordinal: 11,
            headline: "`update_event` ignored `end` and `durationMinutes` unless `start` came with them",
            body: [
              ", reporting success and changing nothing.",
            ]),
          Entry(
            ordinal: 12,
            headline: "Contacts' diagnostics said the surface registers no mutating tool",
            body: [
              ", while two have been registered behind its write flag.",
            ]),
          Entry(
            ordinal: 13,
            headline: "A search could invalidate the element handles it had just issued",
            body: [
              ", because the handle store emptied itself at capacity while a search was still filling it.",
            ]),
          Entry(
            ordinal: 14,
            headline: "An attachment whose name is not ASCII could be neither listed nor saved.",
            body: [
              "A filename is the one MIME parameter that routinely is not ASCII, and it has two encodings; neither was handled. One returned nothing, so the attachment was reported as having no filename at all; the other came back verbatim, so saving it wrote a file literally named `=?utf-8?Q?...?=`.",
            ]),
          Entry(
            ordinal: 15,
            headline: "Safari reported when a page was first visited using only the visits inside the window asked for",
            body: [
              ", while the visit count beside it stayed the page's lifetime total. A search of last week said a page had been first visited last Tuesday when it had been open since 2019.",
            ]),
          Entry(
            ordinal: 16,
            headline: "A full page of calendar events was indistinguishable from a quiet week.",
            body: [
              "The existing truncation flag is about how far the store's expansion reaches, so a dense day answered with the default fifty read as the whole day. There is a `hasMore` beside it now.",
            ]),
          Entry(
            ordinal: 17,
            headline: "Counting messages by a phone number only worked if you spelled it the way the store does",
            body: [
              ", while sending to that same number resolved it properly — in the same server, against a description promising both spellings work.",
            ]),
          Entry(
            ordinal: 18,
            headline: "Mail grouped by UTC days while filtering by local ones",
            body: [
              ", so a message that arrived at 23:30 counted against the next day.",
            ]),
          Entry(
            ordinal: 19,
            headline: "A wedged server was never cleaned up.",
            body: [
              "Closing its input is a request to exit, and one that ignored it held a thread, three pipes and a process for as long as the app ran.",
            ]),
          Entry(
            ordinal: 20,
            headline: "A malformed request got no answer at all",
            body: [
              "from the three surfaces the app serves itself, so a client that sent broken JSON waited forever instead of being told.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 21,
            headline: "The driving notice is an on-screen panel, not a menu bar badge.",
            body: [
              "See the correction under 1.16.0: the badge could never render. The panel does not take focus and does not steal a keystroke from the sequence it is reporting on.",
            ]),
          Entry(
            ordinal: 22,
            headline: "Simulator.app is a brokered application.",
            body: [
              "The `simulator` surface's entry in the manifest puts it into the set Desktop reaches without \"Reach any application\" and Screen can capture, by design; the Desktop guide's paragraph about it is no longer gated on the reach and sends a caller to the `simulator` surface for iOS-point coordinates. Every \"the eight applications Cupertino brokers\" string now says nine.",
            ]),
          Entry(
            ordinal: 23,
            headline: "The Desktop guide's writes-on line names all eight driving verbs.",
            body: [
              "It listed six; `focus` and `activate` were registered and unmentioned.",
            ]),
          Entry(
            ordinal: 24,
            headline: "Walk bounds have a ceiling",
            body: [
              ", so a budget of an hour cannot hold a session thread for one. `find_elements` also declares the `window` argument it has always honoured.",
            ]),
          Entry(
            ordinal: 25,
            headline: "The handshake has a deadline on the app's side too.",
            body: [
              "A process that connected and sent nothing used to hold a thread and a descriptor until it exited.",
            ]),
          Entry(
            ordinal: 26,
            headline: "Notes and Reminders listings say when they were cut short.",
            body: [
              "`apple_notes_list_notes`, `apple_notes_search_notes`, `apple_reminders_list_reminders` and `apple_reminders_search_reminders` now answer with an object — `notes` or `reminders`, plus `source` and `hasMore` — rather than a bare array. **This changes the output shape of four shipped tools.** A caller that indexed the result directly has to read the named field instead.",
              "The reason is that all four truncated silently, and two of the three bounds involved are nothing the caller asked for. The Apple Events lane stops at its own cap (200 notes, 500 reminders) regardless of `limit`, because a bulk read costs about 700ms per property whatever the library size — so asking for 500 and receiving 200 was indistinguishable from asking for 500 and there being 200. The Reminders index lane over-fetches from SQL and applies the date, flag and priority filters afterwards in JS; when those reject nearly everything, the window runs out before the page fills and the answer comes back short. `hasMore` reports that more matched than the page carries; a `note` field appears only when a lane bound rather than `limit` is what ended the list, so it names something the reader can act on. Both diagnostics tools now report the cap.",
            ]),
        ]),
      Section(
        name: "Security",
        lead: [],
        entries: [
          Entry(
            ordinal: 27,
            headline: "`click`, `type` and `key` now light the driving notice.",
            body: [
              "They are the most invasive verbs here — landing at a screen point, or in whatever is frontmost — and they were the only ones that did it without saying so.",
            ]),
          Entry(
            ordinal: 28,
            headline: "The application support directory is 0700",
            body: [
              ", and an existing one is tightened rather than left as it was found. The socket is created under a private umask rather than narrowed a moment later.",
            ]),
          Entry(
            ordinal: 29,
            headline: "Saving an attachment no longer checks and then writes",
            body: [
              ", which was two steps with a window between them, and it refuses a bad destination before doing the work rather than after.",
            ]),
          Entry(
            ordinal: 30,
            headline: "A failed audit write is reported instead of swallowed",
            body: [
              ", so a full disk stops looking like tampering after the fact.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_16_0: Release = Release(
    version: "1.16.0",
    date: "2026-09-06",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Mail's composer runs on Cupertino's own Accessibility driver now, behind one grant instead of two.",
            body: [
              "Reply and forward reached the composer through System Events, which costs a second TCC grant — Automation to System Events — on top of Accessibility, and 47.4 ms per attribute read. Driven natively the same reads cost 0.202 ms. Both grants always had to be given; only one of them has to exist.",
              "The split between the two halves is forced rather than chosen: a JXA object reference cannot outlive the `osascript` process that made it, so opening and addressing the draft stays an Apple Events call and returns the subject, which is what the native half finds the window by. Everything after — the paste, the read-back, the send — is Accessibility. That makes the send command-shift-D rather than the button named \"Send\", which is correctness rather than convenience: a French Mail says \"Envoyer\" and the shortcut is not localised.",
              "**System Events stays as the fallback**, because the npm packages are published artifacts that have to keep working with no Cupertino on the machine.",
              "One behaviour is deliberately given up and reported rather than hidden. The System Events path discards a composer when a paste provably did not land, so a retry is safe. This one cannot: closing an unsaved composer raises a save sheet whose buttons are localised, and pressing a button by a name that is only right in English is worse than pressing none. A failed compose now leaves the window on screen and says so — strictly safer, since nothing anybody wrote is destroyed, and strictly less tidy.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Maps can reach the objects its SQL lane cannot.",
            body: [
              "`apple_maps_save_place`, `apple_maps_remove_saved_place` and `apple_maps_add_place_to_guide` drive the place card through the same driver. They do not replace the store lane and could not — pressing Add lands an unfiled saved place and never touches a favourites row — but they reach the Places library and guide membership, the second of which was listed as unbuilt. Reading the guides beats the store's own answer: eleven guides came back live where `apple_maps_list_collections` reports ten.",
              "**Filing into a guide works and cannot be verified, so the tool refuses to claim it.** Pressing a row does select it, and nothing in the tree says so — the label carries a stale count that reads identically before and after. So it returns `filed: \"unverified\"` and says it must not be reported as done.",
              "Registered only when Cupertino is hosting the server, since the Accessibility grant belongs to the app.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Four more Desktop verbs, three of them the kind whose absence makes a write land somewhere else.",
            body: [
              "`focus` — raising a window is not focusing a field, and the keystroke that follows goes wherever the focus actually is, so it reads the focus back and reports whether it took. `activate` — synthetic keystrokes are posted to the session and land in whatever is frontmost, so `type` and `key` against a named app need this first. `get_attribute` — for the one field a caller needs that the walk's fixed set does not carry. And `user_activity`, below.",
            ]),
          Entry(
            ordinal: 3,
            headline: "The Mac says when it is being driven, and notices when somebody else is using it.",
            body: [
              "Driving is the one capability here that competes with the person at the keyboard: a synthetic keystroke goes to whatever is frontmost and a click goes to a screen point, so somebody typing during a sequence does not slow it down, it corrupts it.",
              "`apple_desktop_user_activity` reports seconds since a person last touched the machine. It reports _when_, never what — no key, no position, no content — which is why it needs no grant and registers as a read. Measured against how long a sequence took, that figure separates \"they typed just before we started\" from \"they typed into the middle of it\", and every refusal in the Mail and Maps lanes now appends the finding when there is one. It stays silent when the machine was quiet, deliberately: \"nobody touched it\" invites the reader to stop looking.",
              "It exists because of a misdiagnosis rather than a theory. Three Maps failures were blamed on interference and turned out to be bugs in the lane; one was blamed on the lane and turned out to be interference.",
              "A menu bar indicator lights while an interface is being driven, and the popover says which app. macOS supplies an indicator for the microphone and the screen; it supplies none for Accessibility, which is the wider grant. It expires rather than being switched off, because nothing tells the app an agent has finished and an explicit end would leave it lit forever the first time a client disconnected mid-sequence.",
              "**Correction, added after release: the badge described above never appeared.** A menu bar item's button cannot be recoloured while its window is closed, which is the only state it is ever in. What actually shows the notice is an on-screen panel, added in Unreleased below.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 4,
            headline: "A node server can borrow the app's Accessibility driver over the socket it already has.",
            body: [
              "This is what lets Mail's composer run natively without anyone switching on the Desktop surface — the consent governing Mail's own window is Mail's — while equally not escaping Mail being switched off. The handshake line naming the borrower is a claim and nothing rests on it: `LOCAL_PEERPID`, answered by the kernel and unspoofable by the peer, is what turns \"I am the mail server\" into a check. Without it any same-user process could borrow the app's grant.",
            ]),
          Entry(
            ordinal: 5,
            headline: "Desktop's reach is a value now rather than a switch",
            body: [
              ", so it can be narrowed as well as widened. A borrowed driver is pinned to one bundle id, and no user-facing gate can move it. The tool descriptions get a real third branch rather than folding it into the brokered wording — a description promising the brokered set to a caller that can reach one app is an invitation to try the other seven and collect a refusal each time.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 6,
            headline: "`apple_desktop_key` could have quit Mail with an unsaved composer open, silently, and only for people not typing on a US layout.",
            body: [
              "It shipped with a table holding no letters at all, so command-V could not be expressed. The obvious repair is the US map, and it is destructive: a `CGKeyCode` names a physical position, not a letter. Measured on an AZERTY Mac, `a` resolves to 12 and `w` to 6, which in the US table are `q` and `z` — so \"select all before pasting a reply\" would have sent command-Q. The map is built by asking the current input source what each of the 128 codes produces, and cached on the input source id so switching layout rebuilds it.",
            ]),
          Entry(
            ordinal: 7,
            headline: "`apple_desktop_find_elements` reported `matched` from the whole walk instead of the filtered set",
            body: [
              "— one control found and an answer saying 136 matched, which reads as a truncated result and is precisely the confusion the field was added to prevent. The byte cap was wrong the same way, measured against elements that were never going to be sent.",
            ]),
          Entry(
            ordinal: 8,
            headline: "`apple_maps_diagnostics` reported that the server registers no mutating tool while it registers two",
            body: [
              ", and had been wrong since the write lane shipped. Diagnostics is the one thing this repo says must never lie. It now reports the real lane: URL-scheme seeding, raw SQL, the Recents side effect and the CloudKit blast radius, keyed on whether writes are on.",
            ]),
          Entry(
            ordinal: 9,
            headline: "The \"Load tools on demand\" control was drawn on three surfaces where it did nothing.",
            body: [
              "Desktop, Screen and Sound are served in process, and the facade reaches a server through the spawn path's environment, which an in-process server never reads. Moving the picker changed nothing, which reads as a bug in the facade rather than in the card. It is gated on the node runtime now.",
            ]),
          Entry(
            ordinal: 10,
            headline: "`make desktop-check` counted a check that had vanished.",
            body: [
              "A case added for `matched` was written so that on a machine without Maps it did not fail — it disappeared, and the suite went 51 to 50 while still printing \"passed\". Skips are counted and named now. The count is the only line most people read.",
            ]),
          Entry(
            ordinal: 11,
            headline: "Three findings this repo had published are retracted, having been measured wrong.",
            body: [
              "A background application's menus _do_ open — the original write-up was a single A/B with no repetition and no control; re-run as six alternating trials the menu opened every time in both conditions. What actually governs it is the session boundary: closing the connection dismisses an open menu. Safari's page text was called \"an absence rather than a price\" on a census that was measuring System Events; natively the same Safari has one web area, 26 links and 10,735 characters. And a Maps delete does not alternate between taking effect and raising an alert — both shapes are real and a driver must handle either, not expect them to take turns.",
              "The retractions are kept in full rather than quietly deleted, because how each was got wrong is more useful than the answer.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_15_0: Release = Release(
    version: "1.15.0",
    date: "2026-09-06",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Cupertino can drive any app on the Mac now, not only the seven it brokers.",
            body: [
              "The new Desktop surface reads and operates interfaces through the Accessibility API: list what is running, walk a window's element tree, find a control by name, press it, expand a disclosure. It is a capability rather than a broker — there is no target app, and it reaches whatever is in front of you.",
              "This lane had been closed three times here, on numbers that were measuring something else. Every Accessibility measurement this project took before it went through `osascript` and System Events, one Apple Event per attribute, so the 33.6 ms round trip in the Safari notes and the ~14 s place card in the Maps notes were the price of the transport rather than of the API. Called natively the same Maps card walks in 0.177 s, and 13,960 nodes across seven apps average 1.24 ms a round trip. 86% of pressable elements carry an identifier, title or description, so a control is addressed by name rather than by guessing at coordinates.",
              "**It arrives switched off, with its writes gated,** the way Screen and Sound do. The Accessibility grant is per-process and all-or-nothing: it hands over every window on the machine, far past anything Cupertino is asked to broker, so it is switched on by the person who wants it rather than found already on.",
            ]),
          Entry(
            ordinal: 1,
            headline: "A tool list can be traded for a searchable index now.",
            body: [
              "Listing every tool across the eight servers with writes on costs ~106 KB — roughly 26.5k tokens, paid by every client on every connect, whether or not one tool is ever called. `*_LAZY_TOOLS`, off by default, swaps the list for `search_tools`, `describe_tool` and `call_tool`, plus a separate `call_write_tool` when writes are on, so a host's read/write permission boundary survives the facade rather than collapsing into one anonymous name. `diagnostics` stays eagerly listed, since it is what every surface guide points at first on a refusal.",
              "In the app it is a per-surface **Load tools on demand** control, defaulted app-wide in General and overridable in each surface's Access card. Activity still names the tool that actually ran — `apple_mail_send_message`, not the dispatcher that carried it.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 2,
            headline: "Every tool listing is 4.6% smaller, on every server and without opting in to anything.",
            body: [
              "The MCP SDK stamps a generated `\"$schema\"` key onto every `inputSchema` and `outputSchema` it emits, and nothing in the protocol ever reads it back. It is dropped from the outgoing listing now.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 3,
            headline: "The Maps notes no longer describe a favourite that never got written.",
            body: [
              "Four claims there had been read off read-only dumps of the interface; pressing the control for real falsifies all four. It opens a naming sheet instead of writing a favourite, what lands is an unfiled saved place rather than a favourites row, the control is not a toggle, and the state bit lives on the sibling button beside it. Only the addressing claim survived.",
            ]),
          Entry(
            ordinal: 4,
            headline: "The website describes what actually ships now.",
            body: [
              "Desktop was missing from the surface list entirely; the whole list sat under \"each surface is its own npm package\", true of only eight of the eleven; and the menu-bar mock captioned every row \"automation allowed\", including Maps and the three capabilities, which send no Apple Event at all. The site reads `KIND`, `USES_APPLE_EVENTS` and `SUPPORTS_WRITES` generated from `surfaces.json` now, so a card or a caption cannot drift from the manifest again.",
            ]),
          Entry(
            ordinal: 5,
            headline: "The pricing note no longer promises a ladder that was retired.",
            body: [
              "The surface list claimed that adding a surface raises the price, and `docs/licensing.md` carried the promise and its retraction in one document — a table still saying \"rising with the surface count\" above a section describing the ladder as retired. The price stayed flat across the whole 1.x line through three new surfaces, and listing one commits to support at the price already paid.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_14_0: Release = Release(
    version: "1.14.0",
    date: "2026-09-04",
    sections: [
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Screen and Sound arrive switched off.",
            body: [
              "Every surface that brokers an Apple app is on when Cupertino is installed; those two now are not. Their grants are the ones that do not stop at the surface being brokered — `kTCCServiceScreenCapture` is per-process and sees every window on the display, and the microphone hears the room, neither scoped by macOS to the thing Cupertino is asked for. A capability that reaches that far past what it brokers should be switched on by the person who wants it rather than found already on.",
              "The default is per surface now, `defaultEnabled` in `surfaces.json` and generated into `Surface.all`, rather than the constant `true` that `SurfaceSettings.isEnabled` and three `@AppStorage` initialisers each spelled out on their own. A surface added later declares what it should be in the same manifest entry that declares everything else about it, and the app and the relay cannot drift into disagreeing about which surfaces exist.",
              "**On a Mac where they are on today, they go off.** Neither ever wrote a `surfaceEnabled` key — 1.8.0 and 1.11.0 shipped them on by absence — so an untouched switch now reads the new default. The entries already in a client's configuration stay there, flagged in that client's pane as naming a switched-off surface, until the next Configure takes them out. Switching either surface back on in the surface list restores it and rewrites the entry.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "Visual Studio Code is actually wired now.",
            body: [
              "1.13.0's notes announced it and the build did not carry it: the `vscode` entry never reached `ClientWiring.swift` before that release commit, so the client that had just been taken off the paste-a-command list was on no list at all. It is there now, merged into `~/Library/Application Support/Code/User/mcp.json` — strict JSON under `servers`, written by VS Code itself, and not the JSONC `settings.json` the two files were conflated as.",
            ]),
          Entry(
            ordinal: 2,
            headline: "The website's buttons no longer flash blue before the page finishes loading.",
            body: [
              "The design tokens sat in the last 13% of a 33 KB stylesheet, and Safari paints from a partially parsed sheet at around 250 ms, so on a cold load every colour var resolved invalid and the buttons rendered in the browser's link blue. Tokens are their own file now, imported first.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_13_0: Release = Release(
    version: "1.13.0",
    date: "2026-09-04",
    sections: [
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Visual Studio Code is configured with one click, not a pasted command.",
            body: [
              "It was held back on the grounds that its config is JSONC and re-serialising it would delete somebody's comments. That was a mix-up between two files: `settings.json` is the JSONC one, and `User/mcp.json` — where VS Code actually keeps MCP servers, under a `servers` key rather than `mcpServers` — is strict JSON, written by VS Code itself.",
              "The residual worry does not survive being looked at either. Every write begins with a read and `JSONSerialization` throws on a comment, so a file somebody has commented reads as unreadable and the write refuses. It fails closed: it cannot strip a comment it cannot parse.",
            ]),
          Entry(
            ordinal: 1,
            headline: "ChatGPT & Codex is configured with one click too, and `~/.codex/config.toml` is spliced rather than re-serialised.",
            body: [
              "That file is the one config here that is genuinely not safe to round-trip — twenty-nine `[projects.\"…\"]` tables, a `[features]` block and a multi-line string full of markdown on the machine this was written against. `ClientWiringTOML`, ported from Bastion, replaces the lines that hold MCP servers and quotes every other byte verbatim, so a wire produces a diff with one hunk in it and an unwire gives the file back exactly.",
              "It also gets what a pasted command could never give it: a real status. The row now reports `configured`, `incomplete` or `points elsewhere` like every other client, and it reports the one thing no JSON client can — `enabled = false`, which Codex honours and which the ChatGPT app is reported to set on servers it did not expect. An entry in that state still points where it should, so it audits as configured while Codex runs none of it; the row says so.",
            ]),
          Entry(
            ordinal: 2,
            headline: "The row is called \"ChatGPT & Codex\" rather than \"Codex CLI\"",
            body: [
              ", because the ChatGPT app, the Codex CLI and the Codex IDE extension all read that one file — the ChatGPT app bundles the Codex binary and names it in `CODEX_CLI_PATH`. The old name sent somebody who had installed only ChatGPT looking for a row that was already there.",
              "The reason recorded for ChatGPT having no row of its own was also wrong, and is corrected: it did not \"take remote HTTP connectors only and cannot spawn a local stdio server at all\". Connectors are remote-only; the Codex lane inside the same app runs local stdio servers and ships three of its own in that file. It has no row because it is not a separate client.",
            ]),
          Entry(
            ordinal: 3,
            headline: "`apple_mail_query` is on every mail server now, not only the read-only ones.",
            body: [
              "It was held back on budget grounds — a tool costs listing tokens on every connect, and this one had to prove it saves more than it costs — and the measurement in [mail-query.md](docs/mail-query.md) settled that a while ago: 64x on a grouped question, against a ~716-token listing.",
              "What the budget argument missed is that `allowWrites` is a per-surface switch, so the only way to reach a lane that reaches nothing but the index was to give up send, reply, move and delete for Mail across every client at once. Nobody makes that trade, which made the tool invisible to almost everyone — including the website, which has been listing it as a plain read tool.",
            ]),
          Entry(
            ordinal: 4,
            headline: "Client rows show the editor's real icon instead of an SF Symbol.",
            body: [
              "Cursor, VS Code and every other row in the sidebar, the client detail header and Settings' automation table now draw the installed app's own icon, looked up by bundle id or by path. `SurfaceIcon.swift` becomes `AppIcon.swift` and the lookup is shared, so surface icons and client icons stop being two unrelated pieces of code that happened to render the same size.",
              "Two knock-on fixes. Cursor's fallback symbol moves from the chevron-brackets glyph to `cursorarrow`, because the brackets now belong to VS Code and having both wear them was the reason the fallbacks read as interchangeable; and ChatGPT & Codex gains a bundle id (`com.openai.codex`) so its row can resolve to a real icon rather than being the one client that could never have one.",
              "Lookups are disabled under a screenshot capture. The goldens would otherwise depend on which editors happen to be installed on the Mac doing the capturing, which is a gate that fails for a reason that has nothing to do with the change under test.",
            ]),
        ]),
      Section(
        name: "Removed",
        lead: [],
        entries: [
          Entry(
            ordinal: 5,
            headline: "Nothing has to be pasted into a terminal any more.",
            body: [
              "With both remaining clients written, the copy-a-command lane had no users: the `Recipe` templates, the shell quoting, the two copy buttons, the \"VS Code has no command that removes a server\" paragraph and the `unknown` status that existed only because a pasted client could never report one are all gone. Zed and Goose are still the reason to remember it existed, and neither is JSON or TOML, so the honest way to add them is a third `Wiring` case rather than a snippet maintained blind.",
            ]),
        ]),
    ])

  /// Work that is written down but not shipped.
  ///
  /// `nil` in any tagged build: CI asserts the CHANGELOG's head section is the
  /// tag's version, so there is no `[Unreleased]` left to emit by then. The
  /// pane shows it in debug builds only, where it is true of what is running.
  // swift-format-ignore
  private static let unreleasedRelease: Release = Release(
    version: "Unreleased",
    date: "",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "What changed, readable after you have already updated.",
            body: [
              "Release notes existed in exactly one place a user could reach: the sheet Sparkle puts up while it asks permission to install. That sheet is gone the moment you press Install, which left the one person most likely to want them — somebody who has just replaced an app holding Full Disk Access — with nowhere to look but `CHANGELOG.md` on GitHub. Settings has a **What's New** pane now, beside Updates, because the two are halves of one question: what did this build change, and is there a newer one. General keeps the version and the build number, which answer _which_ build this is — the question you ask with a bug report open, not the one you ask after updating.",
              "It is generated, not bundled. `make changelog` compiles the last five releases of `CHANGELOG.md` into `Changelog.swift` the same way `make surfaces` compiles `surfaces.json` into `SurfaceCatalog.swift`, and `changelog-check` fails CI if the two drift — so the notes in the app are the notes in the repository, or the build goes red. `### Internal` sections are dropped at generation time rather than hidden at render time, so repo-facing prose never reaches the binary. `[Unreleased]` is emitted separately and shown only in a Debug build, which matters here because CI asserts only that a `## [<version>]` section exists, not that it is the top one.",
              "The parse behind it is shared with `changelog-notes.mjs`, which renders the appcast, so the two cannot disagree about what a bullet is — and the appcast's own guards, on a missing section and an empty one, stay where they were. `scripts/lib/changelog.test.mjs` is written against the shapes this file actually contains rather than tidy examples: a bullet with no bold headline, a headline with a code span inside it, prose between a `###` heading and its first bullet, and a freely named section like `### Note for 1.0.0 users`. One assertion is deliberately about code spans rather than the word \"undefined\", because 1.3.0's prose is _about_ a field that read back as `undefined` and the blunt check fails on a correct render.",
              "Entries whose bold lead is a whole sentence get it pulled onto its own line; entries that bold only the subject and run on — \"…**filled the page**, because the text column pass ran to the limit\" — are left as one flowing paragraph, because splitting those puts a line break before a comma.",
              "Anything that shipped since the version you last read is marked, and says so from the menu bar panel and the sidebar footer as well as in Settings — once, until you look. A fresh install is treated as caught up rather than greeted with five unread releases.",
            ]),
        ]),
    ])

  // swift-format-ignore
  static let unreleased: Release? = unreleasedRelease
  // </generated:changelog>
}

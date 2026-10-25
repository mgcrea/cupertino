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
  static let releases: [Release] = [v1_31_0, v1_30_0, v1_29_1, v1_29_0, v1_28_1]

  // swift-format-ignore
  private static let v1_31_0: Release = Release(
    version: "1.31.0",
    date: "2026-10-25",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Desktop can select a list row without clicking it.",
            body: [
              "`apple_desktop_select` chooses a sidebar entry or a table or outline row, given the row or the label inside it that a search by name finds. It is what a click on the row does, without moving the pointer or bringing the app forward. Rows like these usually have no press action, so they were missing from the default tree and a click was the only way in; the tree now lists them, marked `selectable`, and `press` on one says to use `select`. Found driving Xcode's Device Hub, whose device list works this way. It is a `run` step.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Simulator can fold and unfold iPhone Duo.",
            body: [
              "`apple_simulator_set_pose` sets a foldable simulator closed, partially open or open through Device Hub's pose buttons, the only way there is, selecting the device first if no window shows it, and confirms which screen it then draws. An open Duo is readable and pressable like any other device; the window listings name the screen as `display`.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 2,
            headline: "A simulator tap can no longer land outside the simulator.",
            body: [
              "`apple_simulator_tap` and `swipe` checked the point against the device screen, then clicked wherever the screen's reported frame put it on the Mac. Device Hub reports iPhone Duo's screen away from where it draws it, so on a Duo that was another app's window. Both now refuse when the screen is not on its window, and when the Mac point is not on the simulator's window, as desktop clicks already did. On the Duo, press works.",
            ]),
          Entry(
            ordinal: 3,
            headline: "An unfolded iPhone Duo is found.",
            body: [
              "Only the device's main screen was matched, which on the Duo is the outer one, so an open Duo was \"not found\". Every built-in screen is matched now, and Device Hub keeps one for each panel once the Duo has been opened, so the one actually drawn is asked of `devicectl`.",
            ]),
          Entry(
            ordinal: 4,
            headline: "Finding the device screen in Device Hub stops before the app's own tree",
            body: [
              ", which made the search run out of time on an iPhone Duo.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_30_0: Release = Release(
    version: "1.30.0",
    date: "2026-10-22",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "A new mail no longer reaches its recipient as one long quote.",
            body: [
              "`apple_mail_send_message` set the body through AppleScript, and Mail wraps a body set that way in a quotation. Mail hides it, but Outlook and every other client show it, and the plain-text part had `> ` before every line. The step meant to remove it needed a permission Cupertino doesn't hold, so it failed every time, and the failure was dropped as cosmetic. A new message is now composed the way a reply is: the body and any files are pasted into the window and read back, and nothing is assigned, so there is no quote to remove. `apple_mail_update_draft` recreates a draft the same way. Without Cupertino, a body that stays quoted is reported as `quoted: true` and is never sent like that.",
            ]),
        ]),
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "Mail attaches files to a draft that is already open.",
            body: [
              "`apple_mail_update_draft` takes `attachments`, and its `body` is now optional, so \"attach the PDF to that reply\" no longer means driving Mail's File menu by hand. The files are pasted into the draft's own composer window after your text and above any quoted original, the way a file copied in Finder pastes, and nothing is saved until each one shows up in the window with your text unchanged. Threading and the quote stay as they were. With no window open, files only go on when the body is rewritten too, on a draft that is not a reply.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_29_1: Release = Release(
    version: "1.29.1",
    date: "2026-10-21",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "A saved body is whole, or nothing is saved.",
            body: [
              "If the page dropped a large body from its buffer while `apple_safari_network_get` was still pulling it, the part already pulled was saved as the file and reported as a success: a PDF missing its tail, which still opens. The pull now checks it got every character and refuses otherwise.",
            ]),
          Entry(
            ordinal: 1,
            headline: "A request body reads whole when the response was cut short.",
            body: [
              "With `part: \"request\"`, `jsonPath`, `decode` and `saveAs` refused whenever the response had gone past `maxBodyBytes`, and sent you to record again for nothing. Request bodies are never cut, so they are now judged on their own.",
            ]),
          Entry(
            ordinal: 2,
            headline: "A page that polls with one request keeps every answer.",
            body: [
              "A page that reopens the same request from its `onreadystatechange` handler had every answered poll but the last recorded as \"Aborted\", with no status or body.",
            ]),
          Entry(
            ordinal: 3,
            headline: "A save never writes through a symlink.",
            body: [
              "Saving with `overwrite` (Mail, Notes and Messages attachments, Safari's `saveAs`) followed a symlink of the same name in the download folder, so the bytes could land outside it. It now refuses.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_29_0: Release = Release(
    version: "1.29.0",
    date: "2026-10-21",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Safari can show what a page fetched.",
            body: [
              "With the new \"Read network traffic\" setting on, three tools appear: `apple_safari_network_record` starts and stops recording on an open tab, `apple_safari_network_list` lists the requests it made, with method, address, status and timing, and `apple_safari_network_get` reads one request's headers and response. It answers the questions a page's text cannot, such as why a button did nothing or which call came back with an error. The setting is off by default, recording is per tab and ends on its own after 15 minutes unless you ask for longer, and it works only on websites you have allowed the Cupertino extension on.",
            ]),
          Entry(
            ordinal: 1,
            headline: "A file inside a response can be saved straight to disk.",
            body: [
              "Some sites hand over a document, a signed PDF for instance, as base64 inside a JSON response rather than as a download. `apple_safari_network_get` can pick that field out, decode it and save it to your Downloads folder in one call, without the file passing through the conversation. Saving a file, and reloading a tab to record it from the start, also need the write setting.",
            ]),
          Entry(
            ordinal: 2,
            headline: "What it cannot see, and what it does not hide.",
            body: [
              "Only the page's own `fetch` and `XMLHttpRequest` calls and its console errors are recorded: nothing from embedded frames, web or service workers, or WebSockets. Headers that carry credentials are masked, but response bodies and addresses are returned as the page received them, so a body or a link holding a token comes back with the token in it.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_28_1: Release = Release(
    version: "1.28.1",
    date: "2026-10-17",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "A reply no longer blames Accessibility when Mail just has no window open.",
            body: [
              "With Mail closed down to the menu bar, `apple_desktop_list_windows` refused instead of listing none, and Mail's reply and forward read that refusal as a missing grant: nothing was written, and you were sent to toggle a permission that was already on. Listing an app with no windows now answers an empty list, so the reply goes ahead.",
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
            headline: "The npm servers also speak the 2026-07-28 MCP protocol.",
            body: [
              "Mail, Notes, Reminders, Calendar, Contacts, Messages, Safari and Maps answer `server/discover` and serve a client that opens with the new per-request handshake, alongside the 2025 `initialize` one. Clients on the older protocol see no change.",
            ]),
        ]),
    ])

  // swift-format-ignore
  static let unreleased: Release? = unreleasedRelease
  // </generated:changelog>
}

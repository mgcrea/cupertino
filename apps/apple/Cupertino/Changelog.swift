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
  static let releases: [Release] = [v1_29_1, v1_29_0, v1_28_1, v1_28_0, v1_27_0]

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

  // swift-format-ignore
  private static let v1_28_0: Release = Release(
    version: "1.28.0",
    date: "2026-10-13",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Mail can attach files.",
            body: [
              "`apple_mail_send_message`, `reply_to_message` and `forward_message` take `attachments`, absolute paths to local files, which Mail places after the text the way a file dragged into a composer is placed. On a draft, the default, you see the files before anything is sent. Attaching and sending in the same call is refused unless `APPLE_MAIL_ALLOW_FILE_SEND` is set, because nobody reviews it and a path can name any file the server can read. A file Mail refuses stops the call before anything is sent, and the composer it opened is closed again.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "Contacts recognises one person held in two accounts.",
            body: [
              "Someone in both iCloud and Google came back from `apple_contacts_resolve_handles` as ambiguous, with no name, because the link id that joins their two cards was read as a number and the column holds text.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Contacts names the right ref when a person has gone.",
            body: [
              "Updating a contact deleted in the meantime said `No contact for ref \"No contact with id …\"`, quoting Contacts' own message where the ref you passed belonged.",
            ]),
          Entry(
            ordinal: 3,
            headline: "Desktop, Screen, Sound and Simulator no longer grow over a long session.",
            body: [
              "The app serves them itself, and each request left Foundation's temporary objects behind until the client disconnected. They are now released after every request.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_27_0: Release = Release(
    version: "1.27.0",
    date: "2026-10-13",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Desktop can right-click and drag.",
            body: [
              "`apple_desktop_show_menu` opens an element's context menu without moving the pointer or bringing the app forward, and the tree marks which elements offer one. For a view with nothing to ask, such as a drawing canvas, `apple_desktop_click` now takes `button: \"right\"`. While a menu is open, `ui_tree` and `find_elements` list its items first, wherever the app hung it, so an item is pressed like any other control. `apple_desktop_drag` presses, moves and releases between two handles or points, for moving something on a canvas, a slider or a splitter; the press and the drop are both refused unless they land on a window of an app within reach. Both are `run` steps.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "Clients you have configured stay current.",
            body: [
              "Switching a surface on adds it to every client already wired to Cupertino, and switching one off takes it out, without a visit to each client's pane. A surface that arrives in an update and starts switched on is added at the next launch, and an entry still pointing at a copy of Cupertino that is no longer there is pointed at this one. A client that has never been configured is left alone, and so is one wired to another copy of Cupertino that is still installed. Entries that are already right are not rewritten. A folder's `.mcp.json` is never touched. It is off in a copy that is not in an Applications folder, and `defaults write io.mgcrea.cupertino autoWireClients -bool NO` turns it off altogether.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 2,
            headline: "A Desktop click right after bringing an app forward is no longer refused.",
            body: [
              "`click` and `hover` at a point, given the app's `bundleId`, could answer that the point was \"not on a window of\" an app whose window covered it. The app had come to the front, but its window had not yet been stacked on top. The check now waits up to half a second for the window to arrive.",
            ]),
          Entry(
            ordinal: 3,
            headline: "Updating a Mail draft no longer deletes it when the save fails.",
            body: [
              "`apple_mail_update_draft` took any other draft already carrying the subject, such as one of Mail's autosaved copies, as proof that the replacement was saved, and deleted the original with nothing saved in its place.",
            ]),
          Entry(
            ordinal: 4,
            headline: "An element reporting an impossible frame no longer quits Cupertino.",
            body: [
              "A window or control whose frame came back as NaN, as some Simulator windows' do, made `ui_tree`, `find_elements` or `list_windows` terminate the app and every surface's connection with it. It now reads as an element with no frame.",
            ]),
          Entry(
            ordinal: 5,
            headline: "Mail's account allowlist holds for mailboxes.",
            body: [
              "With `APPLE_MAIL_ACCOUNTS` naming no account that exists, `apple_mail_list_mailboxes` listed every account's mailboxes instead of none.",
            ]),
          Entry(
            ordinal: 6,
            headline: "`apple_desktop_key` refuses modifiers it cannot read.",
            body: [
              "A `modifiers` given as a string, or a list with something other than names in it, was dropped and the bare key sent, so \"a\" was typed where select-all was meant and the call still reported success.",
            ]),
          Entry(
            ordinal: 7,
            headline: "The activity log no longer reports a removed record after a full disk.",
            body: [
              "A write that failed could leave an empty log file behind, and the next launch started a new chain from it, so verification said a record was missing from a log nothing had been removed from.",
            ]),
          Entry(
            ordinal: 8,
            headline: "Safari says when it may need reopening.",
            body: [
              "A page action that times out while no site has been captured for over half an hour now names a stopped extension as the likely cause, rather than only a missing site permission.",
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
  static let unreleased: Release? = unreleasedRelease
  // </generated:changelog>
}

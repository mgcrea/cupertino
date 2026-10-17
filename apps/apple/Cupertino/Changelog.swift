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
  static let releases: [Release] = [v1_28_1, v1_28_0, v1_27_0, v1_26_0, v1_25_0]

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

  // swift-format-ignore
  private static let v1_26_0: Release = Release(
    version: "1.26.0",
    date: "2026-10-06",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "`apple_mail_list_open_drafts` reads the drafts you have open in Mail.",
            body: [
              "Every compose window, with its subject, From, the recipients as Mail shows them, your own text kept apart from the message it quotes, and the opening of that quote. \"Review my draft\" now works without naming a message, including a draft Mail has not yet saved anywhere a search could find. Each one carries the refs Mail autosaved it under, for the recipients' addresses and for `apple_mail_update_draft`. It only reads: nothing is focused or brought to the front.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Desktop reads and presses menu bar items by title.",
            body: [
              "`apple_desktop_menu` reads one menu by its title path, `[]` being the bar itself, with each item's enabled state, checkmark, shortcut and submenu. `apple_desktop_press_menu` presses an item by path. Both work with the app in the background, so choosing View ▸ Show Sidebar no longer means clicking at screen points and taking the focus from you.",
            ]),
          Entry(
            ordinal: 2,
            headline: "The driving card has a cross that stops the session",
            body: [
              ", as Stop driving in the menu bar does. A stop is a no, not only an end: the next action is refused for 30 seconds, saying you stopped it, as a cancelled countdown already was. An agent cannot press the cross itself.",
            ]),
          Entry(
            ordinal: 3,
            headline: "A driving session keeps the display awake.",
            body: [
              "Accessibility presses are not input, so the idle timer ran on, and a Mac that locks on display sleep left the agent driving the lock screen.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 4,
            headline: "Searching mail by subject finds replies.",
            body: [
              "`apple_mail_search_messages` matched `subject` and `query` against the subject without its \"Re: \" or \"Fwd: \", so searching for a reply by the subject Mail displays found nothing.",
            ]),
          Entry(
            ordinal: 5,
            headline: "Quitting Cupertino stops every server it started.",
            body: [
              "Servers were left to notice their input closing, and one that was wedged outlived the app, still holding its permissions. Quitting and the relaunch after an update now ask each one to stop, and force any still running three seconds later. The relaunch also stops accepting connections first, so a client connecting mid-update no longer starts a server from the outgoing version.",
            ]),
          Entry(
            ordinal: 6,
            headline: "Check for Updates no longer stays on \"Checking…\"",
            body: [
              "when a check ends with nothing to show.",
            ]),
          Entry(
            ordinal: 7,
            headline: "Wiring a client whose config file is a symlink works.",
            body: [
              "The write lands on the file the link points to, the link stays a link, and the backup is a real copy. A config caught empty while another program rewrites it is read once more before it is treated as empty.",
            ]),
          Entry(
            ordinal: 8,
            headline: "A licence key a mail client wrapped across lines is accepted.",
            body: [
              "The line breaks made a genuine key read as malformed.",
            ]),
          Entry(
            ordinal: 9,
            headline: "Screen capture's description follows the \"Capture any application\" setting.",
            body: [
              "With it on, the tool still said it could never capture an arbitrary app, so an agent fell back to `screencapture` and brought the app forward for every look, taking the focus from you each time.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_25_0: Release = Release(
    version: "1.25.0",
    date: "2026-10-03",
    sections: [
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Removing a place from Maps takes an explicit `confirm`.",
            body: [
              "`apple_maps_remove_favorite` and `apple_maps_remove_saved_place` both delete on every device signed in to the account, through iCloud, and now refuse a call without `confirm: true` — before Maps is opened, in the second case. Every other destructive tool on every surface already asked.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Safari element ids name the page load they came from.",
            body: [
              "An id now reads `3f9a2c1d-e12` rather than `e12`, and a click or fill goes only to the tab that handed it out. With two tabs on the same URL, `click e12` from one tab's list could be claimed by the other and press its `e12` instead, with nothing in the answer saying which tab had acted. An id whose page has since reloaded or closed is refused rather than guessed at; list the elements again. Tabs open across the update need a reload first.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Every surface's diagnostics report the same things in the same places.",
            body: [
              "`server` is which build is running, with its version and commit, and `settings` is how it is configured — the write gate, prompts, on-demand tools and the result cap. Notes, Reminders and Calendar used to file their lane report under `server` and so could not report their own version; their lanes now sit beside it, as everyone else's do. Contacts' diagnostics stopped saying its dictionary offers a delete.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 3,
            headline: "Desktop driving no longer types into whatever happens to be in front.",
            body: [
              "A `type`, `key`, `click` or `hover` that named no application went to the frontmost one, even when the surface's reach did not include it — so with Terminal in front, text meant for another app went into a shell. The frontmost application is now checked against the surface's reach before anything is posted, and checked again after the on-screen countdown, since that is when the person at the keyboard may switch apps. A click or hover is also refused unless the point is actually on one of that application's windows, and no surface can drive Cupertino itself, whatever its reach.",
            ]),
          Entry(
            ordinal: 4,
            headline: "A recording ends when the client that started it goes.",
            body: [
              "A microphone recording outlived its client and its editor, with the indicator up and nobody left holding a `stop_recording`; switching Sound or recording off did not end one already running either. Both now finalise it. Recordings are written readable by you alone, as screen captures are.",
            ]),
          Entry(
            ordinal: 5,
            headline: "Screen capture honours a surface being switched off.",
            body: [
              "A surface switched off in Settings could still have its window photographed, by name or, with \"Capture any application\", by bundle id. Both are refused now, before anything is captured.",
            ]),
          Entry(
            ordinal: 6,
            headline: "The Activity window and the audit log see Desktop, Simulator, Screen and Sound.",
            body: [
              "Calls to the surfaces Cupertino serves itself were missing from both, and their sessions read zero calls however hard they were driven. A trial running out also closes those sessions now, as it already closed every other surface's.",
            ]),
          Entry(
            ordinal: 7,
            headline: "The audit log survives a disk that will not take a write.",
            body: [
              "A failed append used to advance the chain in memory anyway, so the next record that landed linked to one that never had, and verification reported a full disk as tampering. The log now continues from what is actually on disk and files a notice saying how many records were not written. A Keychain prompt dismissed while signing an export also no longer replaces the signing key recipients have pinned.",
            ]),
          Entry(
            ordinal: 8,
            headline: "Installing an update with a Screen or Sound session open no longer kills the app mid-install.",
            body: [
              "The updater stopped every session's process, and those two report Cupertino's own.",
            ]),
          Entry(
            ordinal: 9,
            headline: "A second copy of Cupertino quitting no longer takes the running one's socket with it",
            body: [
              ", and the watch that notices the socket being replaced now actually runs.",
            ]),
          Entry(
            ordinal: 10,
            headline: "`apple_mail_save_attachment` writes the attachment, not three bytes of whitespace.",
            body: [
              "When Mail keeps an attachment beside the message rather than inside it, the blank part left in its place was taken for the file. And `apple_mail_get_message` stopped saying an attachment could not be fetched when `save_attachment` could fetch it; the note now names only the files Mail has not downloaded.",
            ]),
          Entry(
            ordinal: 11,
            headline: "Moving a reminder keeps its due time.",
            body: [
              "A reminder due at 16:40 arrived in the other list as due that day, all day.",
            ]),
          Entry(
            ordinal: 12,
            headline: "A server's own log output stays inside Cupertino.",
            body: [
              "Whatever a server wrote to stderr was also copied to the app's standard error, outside the redaction calls get, and into a file that outlives the process. It now stays in the in-app log only.",
            ]),
          Entry(
            ordinal: 13,
            headline: nil,
            body: [
              "`APPLE_*_DEBUG=0` turned debug logging on, like any other non-empty value; it now means off. Searching Messages no longer holds every recent message in memory at once to decode it; it reads one at a time and stops once it has a page.",
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

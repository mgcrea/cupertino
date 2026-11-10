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
  static let releases: [Release] = [v1_37_2, v1_37_1, v1_37_0, v1_36_2, v1_36_1]

  // swift-format-ignore
  private static let v1_37_2: Release = Release(
    version: "1.37.2",
    date: "2026-11-10",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
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
            ordinal: 1,
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
            ordinal: 2,
            headline: "A Safari tab no longer stops answering after one lost message.",
            body: [
              "Safari can drop a page's message to the extension's background when the worker is stopped or still starting, and the page then waited for an answer that never came: that tab stopped polling, so every click, fill and `page_elements` on it timed out, while other sites kept answering, until the page was reloaded. Each message now gets ten seconds and a lost one counts as a failed poll, so the tab polls again at its usual interval. A reply that turns up after its wait is dropped with its commands rather than run late, and a result that cannot be filed no longer abandons the rest of its batch. Pages need one reload after this update to pick up the new script.",
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

  // swift-format-ignore
  private static let v1_36_1: Release = Release(
    version: "1.36.1",
    date: "2026-11-02",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Mail drafts work with Mail in full screen or on another desktop.",
            body: [
              "Accessibility lists only the windows on the desktop shown, so with Mail full screen every draft failed after 8 seconds with \"no such window was readable\", and `apple_mail_list_open_drafts` said no draft was open while one was. The app now finds Mail's windows on other desktops and reads them where they are, listed with `onAnotherDesktop: true`. Editing one brings Mail forward on that desktop first, and a composer that cannot be brought forward is refused before anything is touched. A compose that reads no Mail window at all no longer says \"this is not a permission\".",
            ]),
          Entry(
            ordinal: 1,
            headline: "A Mail draft stays in front for you to read.",
            body: [
              "Once a draft was written or edited, Cupertino brought back the app you had been in, straight after the save and again 45 seconds later, so the draft disappeared under it while you were reading. Mail now stays in front with the draft open. To get the old behaviour, turn on **Return to the previous app after a draft** in Mail's settings in Cupertino, or `APPLE_MAIL_HAND_BACK_AFTER_DRAFT` outside the app. A send, a refusal or a failure still brings back your app as before.",
            ]),
          Entry(
            ordinal: 2,
            headline: "A Desktop press or write that times out says it may have landed.",
            body: [
              "An app answers a press only when the action returns, and an action that opens a modal alert returns when the alert closes, so a press that worked still answered \"did not answer in time … retry\", and the retry pressed a second time. A press or write with no answer within 2 s now says it may already have happened and asks for a read of the window before repeating it. A read that times out still says busy.",
            ]),
          Entry(
            ordinal: 3,
            headline: "The Activity log shows a watch update that no one was listening for.",
            body: [
              "When matching mail or a message arrived and the host had not subscribed to the watch, the update went nowhere and the Activity log showed nothing, so a push never sent and a push nobody took looked the same. Mail and Messages now log `push dropped (no listener): cupertino://mail/watch/…` with the reason: no open `subscriptions/listen` names the watch (2026-07-28 protocol), or it was not subscribed with `resources/subscribe` (2025). In Claude Code every watch update is such a line, since it never subscribes to a watch; its agents read the watch instead.",
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

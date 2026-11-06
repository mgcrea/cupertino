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
  static let releases: [Release] = [v1_37_0, v1_36_2, v1_36_1, v1_36_0, v1_35_0]

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

  // swift-format-ignore
  private static let v1_36_0: Release = Release(
    version: "1.36.0",
    date: "2026-10-30",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Desktop can start an application that is not running.",
            body: [
              "`apple_desktop_launch` opens it behind whatever is in front and waits until it answers, up to 10 s, so its controls can be read and pressed while the person keeps their keyboard. It takes a bundle identifier and nothing else, is write-gated and scoped like the other driving tools, and shows the \"Cupertino opened\" notice. An application already running is left alone, one that takes the front anyway is sent back behind, and one never opened on this Mac is refused rather than stopping at a Gatekeeper dialog. With \"Reach any application\" on, any installed application can be started. A verb refused because an application is not running now says so and names the tool.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Desktop can wait for a change instead of polling for it.",
            body: [
              "`apple_desktop_wait_for` blocks until an element matching `id`, `role`, `name` or `value` appears, or with `state: \"absent\"` until it is gone, for up to a minute, and answers with the matches and their handles. It re-reads the tree every quarter second and sooner when the app posts a change. A timeout is an error saying what the last read saw, so a `run` stops there, and Esc in Claude Code ends it. It replaces chains of `wait` steps and `find_elements` calls.",
            ]),
          Entry(
            ordinal: 2,
            headline: "A `run` step can name its element instead of passing a handle.",
            body: [
              "A step that takes a `handle` can take `match` and `bundleId` instead, and the element is found when the step runs, waiting up to two seconds by default for it to appear. A step can now press an item in a context menu the step before it opened, which a handle read before the run could never reach. A match that finds several elements fails the step unless `index` picks one.",
            ]),
          Entry(
            ordinal: 3,
            headline: "`find_elements` matches on `value`.",
            body: [
              "A static text keeps its text in its value rather than its name, so it could only be found by reading the whole tree.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 4,
            headline: "`set_value` reaches SwiftUI text fields.",
            body: [
              "Written while the field was not focused, the text showed in the field and read back as written, but the app's own state never received it, so a prompt typed into Drakar and sent went out empty. `set_value` now focuses a text field before writing, without bringing the app forward, and says `focused` in its answer.",
            ]),
          Entry(
            ordinal: 5,
            headline: "Desktop says an app quit rather than calling it busy.",
            body: [
              "A handle into an app that had crashed answered \"did not answer in time. The app may be busy; retry\". It now says the app quit, with its pid and the crash report when there is one.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_35_0: Release = Release(
    version: "1.35.0",
    date: "2026-10-30",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Safari reads a site's cookies, for the sites you list.",
            body: [
              "`apple_safari_cookies` lists the cookies Safari would send to an open page, HttpOnly ones included, with each one's name, domain, path, flags and expiry, and never its value. To hand a session to a local tool, it writes the cookies you name to a private file (mode 0600) as one Cookie header value. Turn it on in Safari's settings in Cupertino with **Read cookies**, and list the sites it may read in the **Sites** field under it, like `yahoo.com`: an empty list refuses every site. Saving the file also needs writes. Outside the app, the same is `APPLE_SAFARI_ALLOW_COOKIES` and `APPLE_SAFARI_COOKIE_HOSTS`.",
            ]),
          Entry(
            ordinal: 1,
            headline: "The Safari extension asks for the cookies permission",
            body: [
              ", which the tool above reads through. It adds no all-sites access: cookies are read only on sites you have already allowed the extension on.",
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

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
  static let releases: [Release] = [v1_36_1, v1_36_0, v1_35_0, v1_34_0, v1_33_0]

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

  // swift-format-ignore
  private static let v1_34_0: Release = Release(
    version: "1.34.0",
    date: "2026-10-29",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Safari can close the tabs an agent opened.",
            body: [
              "`apple_safari_close_tabs` takes the `ref` that `apple_safari_open_url` now returns for a new tab, or `all: true` for every tab an agent opened, from this session or another, in the last seven days. It closes a tab only while it still shows the URL it was opened on and no other tab shows that URL too. Anything else is reported and left open. A tab that redirected or was navigated away is let go rather than followed. Safari is not launched to close tabs, and the tool is registered only with writes on.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "Shell's window shows the whole script, not two and a half lines of it.",
            body: [
              "The script box was measured before its text was laid out, so it opened at its least height whatever the script's length, and the rest had to be scrolled to. It now grows with the script up to its cap, and so does the box for a script's input.",
            ]),
          Entry(
            ordinal: 2,
            headline: "A Safari element id lasts as long as its element, not as long as the last list.",
            body: [
              "Every `apple_safari_page_elements` call voided the ids of the one before, so listing a field, then listing again to find its Submit button, left the field's id dead, with an error blaming a navigation that never happened. The same element now keeps its id across lists; an id dies when its element leaves the page or the page navigates, and the error says which.",
            ]),
          Entry(
            ordinal: 3,
            headline: "Safari reads a page as it is laid out.",
            body: [
              "`apple_safari_read_page`, `apple_safari_wait_for` and stored captures read the text from a detached copy of the page, which has no layout: blocks ran together (\"HomeHomeSearch Performance…\") and CSS-hidden labels came along. They now read the page itself, and `wait_for` matches a phrase the layout split across lines.",
            ]),
          Entry(
            ordinal: 4,
            headline: "Safari element labels are one line, without icon glyphs.",
            body: [
              "A click's `label` names the element as it was clicked (\"Submit\"), with `labelAfter` when it changed (\"Submitting\"). The `idNote` and `staleNote` repeated in every result are gone; the tool descriptions say it once.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_33_0: Release = Release(
    version: "1.33.0",
    date: "2026-10-28",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Experimental: Mail and Messages serve the draft MCP Events extension.",
            body: [
              "`events/list`, `events/poll` and `events/stream` offer `mail.received` and `messages.received` events, by poll with a cursor or pushed over stdio, following [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415). Off by default behind `APPLE_MAIL_ALLOW_EVENTS` and `APPLE_MESSAGES_ALLOW_EVENTS`, and served on the 2026-07-28 protocol only. The arguments are the watch filter, a sender is required, and an event carries envelope metadata only. Watches are unchanged. The extension is a draft and no client consumes it yet, Claude Code included.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Safari can submit a form and wait for a page.",
            body: [
              "`apple_safari_submit` submits the form an element belongs to, as pressing Enter would, after the form's own validation, and names the fields that fail it. `apple_safari_wait_for` waits until some text appears on a page, or leaves it. `apple_safari_page_elements` takes `query`, `kind` and `inViewOnly`, applied before its cap. `read_page`, `page_elements`, `find_codes` and `wait_for` read the frontmost tab when no `url` is given.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Shell: an agent can run a script with Cupertino's access, after you approve it.",
            body: [
              "`apple_shell_run` runs one script, in zsh, bash, python3, node, AppleScript or JXA, as Cupertino's own child, so it holds every grant Cupertino holds, Full Disk Access among them when Cupertino has it. Before each run a window shows you the whole script and the agent's reason. Don't run is the default, Return and Escape mean it, and only a click by hand on Run once runs it, so VoiceOver can't approve a run. You can let a connection stop asking for 30 minutes, or turn asking off, and a run with no window still shows a card you can stop it from. Shell arrives off, and turning it on, or turning asking off, takes a confirming click that another program can't fake by writing Cupertino's preferences. Every request, refusals included, leaves a line in a run record that keeps a hash of the script and never its text or output. Timeouts, Esc in the client and quitting Cupertino stop the script and everything still in its process group. Scripts start without your shell startup files, with the system's PATH plus Homebrew's, so an interpreter from nvm or pyenv needs the script to set it up, where the window shows it. See [docs/shell.md](docs/shell.md).",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 3,
            headline: "Safari matches more open tabs to history.",
            body: [
              "A tab whose history row only exists with a query added (`/plus5` beside `/plus5?variant=…`) now matches, as `historyMatch: \"query-added\"`.",
            ]),
          Entry(
            ordinal: 4,
            headline: "Safari pulls large network bodies faster",
            body: [
              "by queueing the next chunks instead of waiting a second between each, and `read_page` no longer parses every stored capture to find one.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 5,
            headline: "Safari diagnostics no longer call a dead extension working.",
            body: [
              "`working` was true whenever the extension had ever run, including beside a newest capture 7.5 hours old. The extension now stamps a heartbeat per site while a page is open, and diagnostics report a `state` (`never-ran`, `never-captured`, `stale`, `capturing`, `answering`), which sites are answering, and what the server cannot tell apart. `read_page` and `page_elements` now say which case a timeout is: the extension running nowhere, running but not on this site, or running on this site with no page on that exact URL. A site set to Deny, or an extension switched off, in the half minute before the command is named as having just stopped, not as still running.",
            ]),
          Entry(
            ordinal: 6,
            headline: "A Debug build of the app no longer updates itself into a second copy of the release.",
            body: [
              "The copy registered the Safari extension a second time, and Safari ran no Cupertino extension until the extra copies were removed.",
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

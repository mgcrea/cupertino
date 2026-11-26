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
  static let releases: [Release] = [v1_44_1, v1_44_0, v1_43_0, v1_42_0, v1_41_0]

  // swift-format-ignore
  private static let v1_44_1: Release = Release(
    version: "1.44.1",
    date: "2026-11-26",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "The five surfaces the app serves itself work over HTTP.",
            body: [
              "Desktop, Screen, Shell, Simulator and Sound agree on an earlier MCP revision than the other surfaces, and a client sends that revision back with every request. 1.44.0's HTTP endpoint refused it, so Claude Code, Codex, Cursor and VS Code, once switched to HTTP, showed those five as failed to connect. Clients on the bridge were never affected. After updating, reconnect them (`/mcp` in Claude Code) or restart the client.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_44_0: Release = Release(
    version: "1.44.0",
    date: "2026-11-26",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Clients can reach Cupertino over HTTP, with no bridge process.",
            body: [
              "The app now serves every surface at `http://127.0.0.1:8830/s/<surface>` (8831 for a Debug build), on this Mac only. Claude Code, Cursor, VS Code and Codex are wired that way when you configure them fresh, each with a token of its own kept in Cupertino's Keychain and written into its config, which is then readable by you alone (mode 0600, backup included). A client already wired keeps the bridge and says \"Wired the old way\" with a Switch to HTTP button; nothing is rewritten without you pressing it. An HTTP client cannot start Cupertino the way the bridge does, so wiring one turns on Launch at login. Claude Desktop, LM Studio and Windsurf stay on the bridge, and so does a repository's `.mcp.json`, which is meant to be committed and never carries a token.",
            ]),
          Entry(
            ordinal: 1,
            headline: "The port and each client's token are in Settings.",
            body: [
              "Settings › General › HTTP endpoint sets the port, from 1024 to 65535. A port another app holds is refused and the old one kept. After a change, HTTP clients are rewritten to the new port at Cupertino's next launch or the next time a surface is switched, or at once by Update in each one's pane. An HTTP client's pane has Reset token, which issues a new token and rewrites its entries with it: \"A new token is written; the old one no longer works.\" Remove Cupertino's entries still signs a client out for good.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Activity says how each session came in.",
            body: [
              "The Activity window and each surface's pane show `socket` or `http` beside the session's pid.",
            ]),
          Entry(
            ordinal: 3,
            headline: "Claude Code's allowlist is read for HTTP entries too.",
            body: [
              "An HTTP entry is judged by its URL against `serverUrl` patterns, as Claude Code judges a remote server, and the card offers the exact URL to add.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 4,
            headline: "A server starts only when a session first needs it.",
            body: [
              "Every session used to start one node process per surface (Mail, Notes, Reminders and six more) the moment its client connected, whether or not it ever called one, at about 18 MB each. Cupertino now answers the handshake and the tool, prompt and resource lists itself, from what an identical server already replied, and starts the server at the session's first real call, which takes about 70 to 95 ms longer. A session that only connects and lists costs no process at all. Right after Cupertino launches nothing is recorded yet, so the first sessions still start their servers. `defaults write io.mgcrea.cupertino deferServerSpawn -bool false` turns it off for new connections.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_43_0: Release = Release(
    version: "1.43.0",
    date: "2026-11-20",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Click Cupertino's icon in Safari to see the tab in front.",
            body: [
              "A popover says whether the page can reach Cupertino right now: ready, still connecting, stalled since a given time, or not running there and why. Reload tab is one click away, which is what brings a stalled tab back. It shows a network recording an agent left on the tab, with Stop and Clear, and the last ten things agents did on the page (clicked \"Rechercher\", filled \"Nom\", read cookies), by verb and label, never what was typed. It asks the page directly, so it still works when Safari has stopped the extension's background worker. It adds no permission.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "A Safari timeout no longer blames a setting when Safari stopped the extension's worker.",
            body: [
              "Safari can stop the extension's background worker while tabs are open, and pages then cannot reach it until one reloads. `page_elements`, `click` and the other page tools used to say the extension was \"most likely just switched off\" or \"not running in Safari\", which sent agents to Settings for a switch nobody had touched. They now name the stopped worker and say to reload the tab first. When a page was captured well after its site's last poll, which shows the extension is on and only the polls are getting lost, they say so and leave Settings out.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_42_0: Release = Release(
    version: "1.42.0",
    date: "2026-11-17",
    sections: [
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Driving behind your apps says you can keep working.",
            body: [
              "A Desktop session that only reaches an app behind the one you are using, through a Debug build's driving channel or an Accessibility press, menu press, row select, value write or focus, now shows a blue card: \"Cupertino is using Filiation. Behind your apps. You can keep working.\" It used to ask you not to use the keyboard or mouse, though nothing it did could reach either. The first call that posts input to the session, brings an app forward, or types by posting keys, and the driven app coming in front, turn it into the orange hands-off card until the session ends. It never turns back. Those background calls are no longer held for a countdown or a question while you type, and the Simulator's `press` behind your apps works the same way. `apple_desktop_diagnostics` says which card is up, and the server's instructions tell agents how to keep a session blue.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_41_0: Release = Release(
    version: "1.41.0",
    date: "2026-11-16",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Capture one copy of an app by its pid.",
            body: [
              "`apple_screen_capture_surface` takes `pid`, and `apple_screen_list_targets` lists each app once, with every running copy's pid and window count. While several copies run, a capture that names none is refused and lists their pids, rather than taking the larger window of whichever copy drew it.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Double and triple clicks.",
            body: [
              "`apple_desktop_click` takes `count`, 1 to 3, with the left button: through a driving channel, and on the session lane as the click state an app reads as a double click. A `run` step's count is checked like the tool's.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 2,
            headline: "Typing into an open or save panel.",
            body: [
              "A field in a window its app does not draw, as a sandboxed app's open panel is, is typed into by Accessibility where typing would put it and read back (`lane: \"accessibility\"`), and return and escape are its confirm and cancel actions. Keys and driving channel commands, which reach only the app's own windows, were refused there or could land in another field.",
            ]),
          Entry(
            ordinal: 3,
            headline: "A key that quits the app says so.",
            body: [
              "A ⌘Q through a driving channel answers `quit: true` once the process has ended, instead of reporting that the app did not answer within 2 s.",
            ]),
          Entry(
            ordinal: 4,
            headline: "A launch that opens no driving channel names the cause.",
            body: [
              "An unconfirmed copy, or a sandboxed app's container that Cupertino may not read without Full Disk Access, is said to be that, rather than a build without SupportKitDriving. A copy the launch would quit again is checked once more, just before it is asked to quit.",
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

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
  static let releases: [Release] = [v1_23_0, v1_22_1, v1_22_0, v1_21_1, v1_21_0]

  // swift-format-ignore
  private static let v1_23_0: Release = Release(
    version: "1.23.0",
    date: "2026-09-18",
    sections: [
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "`apple_mail_update_draft` now edits a reply draft instead of refusing it.",
            body: [
              "Revising a draft is the most common thing asked of this server — \"draft a reply, now change this line\" — and it was the one thing the tool would not do. Rewriting a draft meant RECREATING it, which cannot carry `In-Reply-To` across, so a reply draft was refused outright and the only way through was deleting it in Mail by hand.",
              "Recreating was never the only option; it was the only one reachable from Apple Events. The draft's own composer window is still on screen — nothing in this server closes one — and a body replaced in that window saves back to the same draft, so threading, attachments and the quoted original all survive because nothing is remade. `update_draft` now does that first and falls back to recreating only when no composer is open. The result says which route it took in `method`, and a ref stays valid across an in-place edit.",
              "Telling the draft's own text from the message it quotes is the whole difficulty, and `AXBlockQuoteLevel` answers it exactly: the sender's paragraphs read 0, and the attribution line and everything below it read 1 — for a forward as well as a reply, which was measured rather than assumed. The selection is then proved before anything is replaced: it is copied back and must equal the composer's own text exactly, because `AXSelectedText` reads null on Mail's composer and the pasteboard is the only place a selection is legible. Selecting and copying change nothing, so a selection that cannot be made to match costs a refusal rather than somebody's draft. Measured on macOS 27.0 (build 26A428) and verified end to end against a live Mail on a forward draft — the kind recreation refuses — which came back with one draft, its `References` header intact and the forwarded message still under the new text. `docs/mail-compose.md` carries the sequence and the readings, and `node scripts/verify-mail-ax.mjs --compose` re-runs the whole thing.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 1,
            headline: "Opening or resizing a window could abort the app.",
            body: [
              "Diagnosed from a crash report: naming a window for AppKit's frame autosave makes it write the frame out from inside `-[NSWindow _setFrameCommon:]` — so a resize SwiftUI itself performs during the window's own layout pass persists a frame, persisting posts `NSUserDefaultsDidChange`, an `@AppStorage` observer reads that as a settings change and dirties the hosting view, and the `setNeedsUpdateConstraints` that follows lands inside the layout pass that is still running. AppKit throws rather than re-enter, nobody catches it, and the process takes SIGABRT. It needs no bad frame and no bad window: one `@AppStorage` anywhere in the app is fuel enough. The frame is still remembered, but it is read with `setFrameUsingName` and written a turn later by a saver that only believes a person's own resize or move — never a size SwiftUI tried on its own. The key and its format are unchanged, so a frame saved by an earlier build still restores.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Every accent, em dash and curly quote in a composed mail was corrupted.",
            body: [
              "`pbcopy` and `pbpaste` encode in the LOCALE's character set, and this server is spawned by the app with an environment naming none — so they fell back to MacRoman, and every byte outside ASCII was wrong in both directions. A body pasted into a composer arrived with `—` turned into `‚Äî`. Not a display artefact: that is what went into the draft, and what would have gone into the mail. The read is worse in kind, because the clipboard is BORROWED — read, overwritten, put back — so replying to a mail handed back a corrupted copy of whatever the person had copied. Both verbs now name `LC_CTYPE=UTF-8`, which sets the encoding and nothing else. Found by a live rewrite whose read-back would not match, and verified end to end: `é à ç œ « »` and `—` now reach the stored draft intact.",
            ]),
          Entry(
            ordinal: 3,
            headline: "A mailbox holding fewer messages than the limit could not be listed at all.",
            body: [
              "`apple_mail_list_messages` came back with a null subject, null sender and an unusable `#null` ref on every row — so nothing else could act on any of them. `slice(from, to)` on an Apple Events specifier is INCLUSIVE of `to`, not exclusive like JavaScript's, so asking for `n` messages asked for `n + 1`; when `n` was the whole mailbox that ran one past the end, raised `Invalid index.`, and left every batched property read empty. Drafts is where it was found, because a Drafts mailbox almost always holds fewer messages than the limit — an agent that had just written a reply could not find the draft again to revise it. The same off-by-one was in `SENT_SINCE`, where it matters most: that is the read deciding whether a reply was SENT, and on a Sent mailbox smaller than the limit it answered \"it does NOT appear to have been sent\" for a mail that had gone, inviting a second send. Measured against a live Mail: `slice(0, 303)` on a 303-message mailbox raises, `slice(0, 302)` returns all 303.",
              "The stubs had hidden it by being kinder than Mail — they modelled `Array.prototype.slice`, which is exclusive and forgiving of an index past the end. They now raise where Mail raises, and 7 of the 9 existing `sent-since` tests fail without the fix.",
            ]),
          Entry(
            ordinal: 4,
            headline: "`apple_mail_reply_to_message` and `apple_mail_forward_message` reported a correct draft as a failure.",
            body: [
              "The composer was read back once, immediately after the paste — but `apple_desktop_key` returns when the keystroke is POSTED, and WebKit has still to take it, edit the document and republish an accessibility tree. On a long message the read lost that race and the reply came back `bodyVerified: false` with \"SOMETHING DID land in it that could not be read back\", for a body that was in fact perfect. Worse, that message tells its reader not to retry. Measured against a reply quoting a 322-element newsletter. The read-back is now polled, the same way the focus poll above it already was.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_22_1: Release = Release(
    version: "1.22.1",
    date: "2026-09-16",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Full Disk Access read as denied on every Mac running macOS 27, whether it was granted or not.",
            body: [
              "Cupertino tells whether the grant is in place by asking whether one file that only Full Disk Access can open is readable, and on macOS 27 that file no longer exists. A missing file answered \"no\" either way, so the row said denied while every server's own diagnostics, reading their own stores, said granted — and it sent people off to grant a permission they already had.",
              "A file that is not there proves nothing about permission. When it is gone, Cupertino now asks the same question of the first Mail, Messages, Safari, Notes or Calendar store on the Mac, each of which has been measured as unreadable without the grant.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_22_0: Release = Release(
    version: "1.22.0",
    date: "2026-09-16",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "`apple_desktop_set_window_frame`, so the `rect` the surface reports can also be written.",
            body: [
              "`apple_desktop_list_windows` has always returned a window's position and size and nothing could set them, which left one ordinary thing — narrowing a window until its toolbar overflows — with no route through this surface at all. The alternative was `osascript` and System Events, and that is the one route this surface must not take: Accessibility attaches to the process RESPONSIBLE for `osascript`, so it would have meant granting a terminal the right to drive every application on the Mac. The write belongs in the app that already holds the grant. It needs no new permission and sits behind the writes and reach switches that were already there.",
              "Every component is optional, so `width` alone narrows a window without deciding where it goes, and the numbers are the same screen points, top-left origin, that every other answer here uses.",
              "**It reports what the window did, not what was asked.** AppKit enforces a window's own minimum size silently: a window with a 900-point floor asked for 600 lands at 900 with no error anywhere along the way. The answer carries `requested`, `actual` and `confirmed` so a caller can see the clamp instead of going on to measure a window it never got.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Agents now warn you before they take the keyboard and mouse.",
            body: [
              "Until now the orange card appeared in the same instant as the first click or keystroke, so somebody halfway through a sentence had no chance to stop. When you have used the Mac in the last 20 seconds, the first driving call of a Desktop or Simulator sequence now puts a card up first: \"Cupertino will drive Safari in 3 s\", with a Cancel button. Leave it and the agent goes ahead; cancel and nothing is posted, the agent is told you said no, and it cannot put the card back in front of you for 30 seconds. A Mac nobody has touched for 20 seconds is driven straight away, as before.",
              "The Access card for Desktop and Simulator has a \"Before driving\" setting: count down, ask first (Allow or Don't, where no answer within 25 seconds is a no), or nothing, which is the old behaviour. The countdown length and how long an idle session lasts are set there too.",
            ]),
          Entry(
            ordinal: 2,
            headline: "Driving is now a session that ends, and ending it gives you your app back.",
            body: [
              "The card used to vanish four seconds after each action, even while the agent was still thinking about the next one, and the driven app stayed in front afterwards, so there was no telling a pause from the end. The card now stays up for as long as the agent holds the screen. The session ends when the agent calls the new `apple_desktop_release` or `apple_simulator_release`, when you press Stop driving in the menu bar, when no call arrives for 45 seconds, or a few seconds after the client disconnects. When it ends, the app you were using comes back to the front, unless you had already switched to something yourself. A green card says the keyboard and mouse are yours again.",
            ]),
          Entry(
            ordinal: 3,
            headline: "`apple_desktop_run` takes a whole interaction in one call.",
            body: [
              "Steps are the desktop verbs (press, type, key, click, hover, focus and the rest), a few reads, and `wait`. Every step is checked before the first one runs, so a mistake in step five cannot leave a form half filled. The run stops at the first step that fails and says which one, and `releaseAfter` hands the Mac back when every step completed.",
            ]),
          Entry(
            ordinal: 4,
            headline: "Settings has an About pane and a Help pane.",
            body: [
              "Which build this is — the version, the system, the model — used to be answered in the first section of General, the page about launching at login. It is a pane of its own now, with the app icon, the bundle id and the signing identity beside it, and the version line in the menu bar is a button that opens it rather than text that does nothing. Help is new as well: the same three links the Help menu carries, reachable when no window is open, which is when somebody is most likely to want them.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 5,
            headline: "`apple_desktop_hover` no longer refuses while somebody is using the Mac.",
            body: [
              "It used to fail whenever there had been input in the last two seconds, and that refusal put no card on screen, which is why hovering looked like it never announced itself. It now waits for the same warning every other driving call gets.",
            ]),
          Entry(
            ordinal: 6,
            headline: "The Settings sidebar is grouped into what Cupertino does, then what it did.",
            body: [
              "General, Activity and Permissions are the panes you configure; What's New, Updates, About and Help are the ones you open when you want to know what this build is or something has gone wrong; License is last. No stored selection moves, so the first-run licence prompt still lands where it did.",
            ]),
          Entry(
            ordinal: 7,
            headline: "The menu bar panel matches the fleet's other apps.",
            body: [
              "The version sits at the trailing edge of the footer, as a button to the new About pane rather than as a suffix to the app's name, and the row finally carries ⌘O and ⌘Q. Tooltips lose their trailing clauses: \"Logs (⌘L) — what every client has called, live\" is now \"Logs (⌘L)\", built from the action's own name and shortcut so the two cannot disagree.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 8,
            headline: "Every desktop call against Finder found no windows.",
            body: [
              "Finder answers `kAXWindows` with an empty list while a perfectly ordinary window is open on screen, and the same window is reachable only through `kAXChildren`. The window list is now the union of both, deduped, so Finder is drivable like anything else.",
            ]),
          Entry(
            ordinal: 9,
            headline: "A call could wait forever.",
            body: [
              "Killing a server does not guarantee the end of its output: a grandchild that inherited the pipe holds it open after the child is gone, and the read behind it waited indefinitely no matter what the watchdog did. Those reads now give up once the deadline has passed and the child has exited, whoever still holds the pipe, and the watchdog escalates to SIGKILL for a server that outlives its grace period. Sound's `say` and the bridge's `open`, which had no timeout at all, are bounded the same way.",
            ]),
          Entry(
            ordinal: 10,
            headline: "The Simulator row said Simulator was not installed, on a Mac running one.",
            body: [
              "Xcode 27 ships no `Simulator.app` — the simulator's window belongs to DeviceHub now — while LaunchServices goes on pointing at the path Xcode 26 used. The row fell back to the not-installed glyph with devices booted and the surface working. It now falls back to the app that owns that window today, and a Mac with no Xcode at all still says nothing is installed, which is still true.",
            ]),
          Entry(
            ordinal: 11,
            headline: "The app offered a licence while the store was closed.",
            body: [
              "The website already gated its buy copy on whether the payment link resolves; the app's two buy buttons did not, so a build made while the store is shut still invited people to a page that could not sell them anything.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_21_1: Release = Release(
    version: "1.21.1",
    date: "2026-09-11",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "A reply that went in fine came back as \"SOMETHING DID land in it that could not be read back\", and the same mix-up could have sent the wrong draft.",
            body: [
              "`apple_mail_reply_to_message` finds the composer it opened by its title, and a composer from an earlier attempt was still open under the same subject. Nothing in the native path closes one, so that is routine. Mail keeps composers as tabs, and the leftover was readable before the new one, so the title matched it first. ⌘V went to the composer Mail had in front, the read-back went to the leftover, and a correct reply was reported as a failure that a retry would paste twice. With `sendNow`, the send shortcut would have named the leftover as well.",
              "The call now checks the window list it takes before opening anything. If a composer with the reply's subject was already there, nothing is pasted, pressed or sent, and the note says to close the extra window and deal with the older one first. Handles are minted per call, so there is nothing to tell the two composers apart by, and guessing here means guessing which message to send.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Driven sequences blamed \"someone using this Mac\" for Cupertino's own keystrokes.",
            body: [
              "The idle reading behind `apple_desktop_user_activity` counts synthetic events, deliberately, so a sequence that posted a key always found input a moment ago. A native Mail reply reported \"Someone used this Mac 0.2s ago\" for its own ⌘V and sent the reader looking for a person who was not there. The tool now also returns `secondsSinceOwnInput`, the time since Cupertino last posted input, and Mail and Maps only name interference when the input came after that. A host too old to report it keeps the old comparison.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_21_0: Release = Release(
    version: "1.21.0",
    date: "2026-09-10",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "`apple_desktop_click`, `apple_desktop_type` and `apple_desktop_key` can name the application they are meant for.",
            body: [
              "An agent that opened an application and clicked into it, while the person at the keyboard had switched to their editor, clicked into the editor — and the driving notice said so, \"Cupertino is driving com.microsoft.VSCode\", because it was true. These three verbs post into the session and took no target, so the event went to whatever was in front.",
              "`click` now takes `bundleId`, and `type` and `key` take `bundleId` or the `handle` of the field that was focused. The application is brought to the front and waited for; if it does not come, nothing is posted and the call says so, and the notice names the application meant. Leaving it out keeps the old behaviour. `hover` already worked this way and now shares the same refusal.",
              "Mail and Maps pass one. Mail's paste and its send and save shortcuts name the composer they are meant for, so Mail is brought forward or nothing is pressed, rather than ⌘V landing in whatever window someone switched to. Maps names itself when it closes its menu with Escape: its card opens behind whatever is in front, so a bare Escape went to that other application instead.",
              "One scope hole closed along the way: bringing an application forward skipped the reach check when that application was already in front, so `hover` could drive an application outside \"Reach any application\" as long as it happened to be frontmost.",
            ]),
          Entry(
            ordinal: 1,
            headline: "Mail, Safari, Notes and the other Node surfaces now say when they change the screen.",
            body: [
              "The notice naming what Cupertino is driving was lit only by the in-process surfaces, because that is where synthetic input is posted. Everything else reaches its app by Apple Event, System Events or the Safari extension, so a Safari tab switching under someone, or Notes starting up because a note was written, came with no word from Cupertino at all.",
              "The app now decides from each call's tool name, before the server has acted on it, and the notice comes in tiers. Mail's compose tools raise Mail and press keys, so they get the orange card that asks for hands off the keyboard and mouse. Safari's page verbs and adding a Maps favourite change what is on screen without touching either, and get a quieter blue card that says you can keep working. A write to Notes, Reminders, Calendar, Contacts or Messages gets one only when it had to start the app, since that is all a person sees. A call that outlasts the notice's usual linger holds it until the reply arrives.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 2,
            headline: "A reply that was sent came back as a reply that failed, and the note argued against the wrong retry.",
            body: [
              "`apple_mail_reply_to_message` composed a reply correctly and it went out — and then reported `ok: false`, `bodyVerified: false`, \"the body did not go in\", and \"SOMETHING DID land in it that could not be read back, a retry would paste the reply in twice\". Every part of that was false. What actually happened is that the person at the keyboard pressed Send while the call was still running.",
              "A composer that closes takes its Accessibility handle with it, so every read after that is a refusal — and `bodySize()` answered `-1` for a refusal while the caller compared it as an element count. `-1` against a real count reads as \"the body changed\", which is the signature of a paste that landed and cannot be matched. The same sentinel had a second edge in the System Events fallback: `-1` against `-1` reads as \"nothing landed\", which is the one branch that DISCARDS the composer, so an unreadable body could be thrown away rather than left on screen.",
              "Blind and different are now different answers. Before blaming the body, both compose paths ask whether the composer window is still there at all — nothing in them ever closes one, so a missing composer was taken by whoever is using the Mac. The native path then asks Mail whether the message reached Sent and says so with the timestamp, because sending and discarding leave the same empty screen and guessing wrong in either direction is expensive: a sent reply called a failure invites a retry that sends it twice. The Sent lookup deliberately does not use the envelope index, which is rebuilt on a schedule and was 47 minutes stale when this was found.",
              "Two smaller holes closed along the way. A composer that vanished before the paste's second attempt escaped as a bare channel error with no note at all; it now returns a described failure. And the send shortcut was posted without re-raising the composer, so a person who changed the foreground between the verifying read and the send took ⌘⇧D into their own window — it is raised again first, and if it cannot be raised nothing is pressed.",
            ]),
          Entry(
            ordinal: 3,
            headline: "Listing Safari's tabs opened Safari.",
            body: [
              "`apple_safari_list_tabs` asked Safari for its windows by Apple Event, and an Apple Event launches an application that is not running, so a question about open tabs could put a browser on someone's screen. It now asks whether Safari is running first, which launches nothing. When it is not, the tool says so in words, with `running: false`, rather than returning an empty list that reads as a Safari with every window closed or as a missing permission.",
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

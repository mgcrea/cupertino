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
  static let releases: [Release] = [v1_26_0, v1_25_0, v1_24_1, v1_24_0, v1_23_0]

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

  // swift-format-ignore
  private static let v1_24_1: Release = Release(
    version: "1.24.1",
    date: "2026-09-29",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "`apple_safari_read_page` reads the tab as it is now, not as it looked while loading.",
            body: [
              "A single-page app that renders its frame and then fetches its content was stored as the empty frame: Shopify's app-listing form came back as \"Skip to content\" for as long as the tab was open, while `page_elements` could see every field on it. The read now asks the open tab first and says `source: \"live\"`; a tab that cannot answer within a couple of seconds — in the background, or closed — still gets the stored capture, marked `source: \"capture\"` with a `liveRead` line saying why. The stored capture itself also stopped giving up at the first quiet moment, so it now catches a page that renders after a fetch. The new wait is `APPLE_SAFARI_LIVE_READ_TIMEOUT_MS`. Tabs open across the update need a reload before they answer live.",
            ]),
          Entry(
            ordinal: 1,
            headline: "`apple_safari_page_elements` can read a form.",
            body: [
              "Checkboxes and radios now say whether they are ticked, radios are reported as radios rather than checkboxes, a select reports the option it shows, and a greyed-out control is listed with `disabled: true` instead of being left out. A field value cut at the 200-character default now says so, with its full length, and `maxValueChars` raises the cap. A select asking for a card's expiry is withheld like any other card field.",
            ]),
          Entry(
            ordinal: 2,
            headline: "`apple_safari_fill` works on React forms.",
            body: [
              "It used to put the text in the box without React noticing, so the form kept its old value and a Save sent that instead; Shopify's app-listing form was the case that showed it. It now writes the value the way a keystroke does. It can also choose an option in a select, by the text the option shows, and it refuses a checkbox or radio with a pointer to `apple_safari_click` rather than doing something a caller cannot predict.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_24_0: Release = Release(
    version: "1.24.0",
    date: "2026-09-26",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "The Simulator surface works on Xcode 27, through DeviceHub.",
            body: [
              "Xcode 27 ships no Simulator.app; the simulator's window belongs to DeviceHub, which bridges the device's accessibility tree the same way. The surface now drives whichever of the two is showing the simulator, finds the device screen DeviceHub nests beside its sidebar and inspector, and still reaches those two applications and nothing else. Every tool was measured working against an iPhone 18 Pro on iOS 27.0, including rotation, which DeviceHub's menus no longer list but whose shortcuts it keeps.",
              "Two Xcode 27 changes had to be worked around, and both fail without a sign. AppKit reports DeviceHub's process id as -1, so every Accessibility call went to no process and answered like an app with no accessibility at all; the driver now finds the process by its executable. And device types no longer carry their screen size in `profile.plist`, so the point size is read from `capabilities.plist`, where Xcode 27 moved it. An earlier entry claimed the surface was working on Xcode 27; only its icon was. A physical device shown in DeviceHub remains out of reach: its screen is a video with no tree behind it.",
            ]),
          Entry(
            ordinal: 1,
            headline: "The on-screen notice can be placed, resized and given a sound.",
            body: [
              "Three settings in Settings → General: which of six places along the top or bottom edge of the display the card sits in, how large it is drawn, and whether it plays a sound arriving and leaving. The top-right corner it shipped in is not free for everyone — it is where menu bar apps drop their panels, where Xcode parks its inspector, and on a laptop with a notch it is the narrowest part of the visible frame.",
              "Six places rather than eight, because the vertical middle is where the person is looking and is the one place a notice must not cover. The position control draws them inside the outline of a display rather than listing them in a menu, since the answer is a geometry rather than a phrase, and a Preview button puts a sample card where the real one would go — the setting is otherwise unanswerable from the window it is set in, because the card only appears while an agent is working.",
              "The size is a scale applied to every length in the card, the panel and padding as well as both type sizes, rather than a transform on the rendered layer — which looks identical in a screenshot and wrong on the screen, because it would blow up a bitmap of the text. Medium is scale 1 exactly, so a Mac that never opens the setting sees no change.",
              "The sound is a choice of the Mac's own alert sounds, one for the card arriving and one for it going, with a volume slider. They ship with every Mac, so there is nothing to bundle, and the menu is read from `/System/Library/Sounds` rather than written out — it is whatever this macOS has. There is no separate switch: \"None\" is a row in each menu, because a switch beside two menus has a fourth state that says nothing the menus do not already say. Picking a sound plays it, since a sound is chosen by ear, and the volume plays a sample when the slider is let go rather than on every step. It starts silent, at a third of full if chosen, where an alert sound reads as a cue under what you are doing rather than as an alert.",
              "All of it is appearance and none of it can stop the card appearing, change what it says, or move it off the display holding the application being driven. This is the only warning the person at the keyboard gets, and `docs/desktop.md` records what happened without one. Sounds are silent under a screenshot run whatever is chosen, and fire when the card arrives and when it goes rather than on each step — an agent working through a sequence shows one card, so it is twice a session and not twice a keystroke.",
              "The placement arithmetic lives in `NoticeStyle` with no dependency beyond `CGRect` and `make unit` pins it, because it is silent when wrong: AppKit's y grows upward, and a sign error puts the card under the Dock, where it looks exactly like a card that never appeared. So is the volume, which is the other value that can be wrong invisibly — `NSArgumentDomain` hands back strings, so a volume of 0 read as a `Double` is nil and falls through to a default that is a third of full, which is the opposite of what was asked for.",
            ]),
        ]),
    ])

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

  /// Work that is written down but not shipped.
  ///
  /// `nil` in any tagged build: CI asserts the CHANGELOG's head section is the
  /// tag's version, so there is no `[Unreleased]` left to emit by then. The
  /// pane shows it in debug builds only, where it is true of what is running.
  static let unreleased: Release? = nil
  // </generated:changelog>
}

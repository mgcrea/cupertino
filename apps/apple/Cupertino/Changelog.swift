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
  static let releases: [Release] = [v1_21_0, v1_20_1, v1_20_0, v1_19_1, v1_19_0]

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

  // swift-format-ignore
  private static let v1_20_1: Release = Release(
    version: "1.20.1",
    date: "2026-09-09",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "Cupertino crashed while driving the keyboard, taking every connected client down with it.",
            body: [
              "Four crash reports carry one signature: an `EXC_BREAKPOINT` inside HIToolbox on a `cupertino.session` thread, under `AccessibilityDriver.layoutKeyCodes()`. Measured on 1.18.0 twice, on 1.19.1, and on 1.20.0 — it has been shipping since key codes first started resolving against the real keyboard layout rather than a fixed table.",
              "The lookup asked Text Input Services which layout was current on whatever thread the RPC arrived on, and HIToolbox enumerates the input source list under a `dispatch_assert_queue`. An off-main call trips a runtime trap and the process dies, so a single `apple_desktop_key` took down every surface's connection at once, not only the one that asked.",
              "It was intermittent, which is how it shipped in three releases: the assertion fires only in the branch that rebuilds the current source ref, never in the one serving a cached one, so probes calling TIS off the main thread came back fine. The reliable trigger is the Mail composer, where `paste()` and `selectAll()` send single-character shortcuts — exactly the key names that miss the position-keyed table and fall through to the layout. Named keys never touch TIS, so most driving looked healthy.",
              "The TIS half now runs main-thread-only behind a `dispatchPrecondition`, warmed at launch before the host opens its socket and refreshed when the selected input source changes. The per-call lookup is a cache read that asserts no queue, and a caller on the wrong thread now fails in its own frame instead of inside HIToolbox on a machine that is only sometimes unlucky.",
            ]),
          Entry(
            ordinal: 1,
            headline: "A mail body stopped at its first run, so anything below an inline image was missing.",
            body: [
              "A message whose text is interrupted — a screenshot pasted mid-mail, a file between two paragraphs — was read down to its first `text/plain` part and no further. `apple_mail_get_message` returned the opening and dropped the rest, and a `body:` search in `apple_mail_search_messages` could not match a word that sat below the image. Nothing reported a truncation; the message simply read as though it ended early.",
              "The body is now assembled in document order across the whole tree, with an `[image: shot.png]` marker standing where a file separated two runs, and `multipart/alternative` still resolving to a single rendering so a plain-and-html message is not emitted twice. A body that came through the tag stripper for any of its runs now says so, rather than reporting the type of whichever run happened to be first.",
              "Two parsing faults surfaced with it. A boundary was matched anywhere in the body instead of at the start of a line, so `--B` also matched inside `--B2` and flattened a nested multipart into its parent's sibling list — harmless while only one part was ever read, a doubled body the moment the parts are joined. And `htmlToText` left a `<style>` block's CSS behind as prose whenever the closing tag fell outside the scan's read window, which is routine at the window's size and made a body search for a font name match a newsletter that never said it.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_20_0: Release = Release(
    version: "1.20.0",
    date: "2026-09-08",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "A Chat pane, so the tools can be tried without wiring an editor first.",
            body: [
              "Until now the only way to see Cupertino do anything was to install an MCP client, configure it, and ask it a question — three steps before the first sign of life, and the app could only ever describe its servers. The new pane under Activity picks a surface, loads as many of its tools as fit, and lets you ask in plain words.",
              "The answers come from Apple's on-device model, which is the only choice that keeps `scripts/audit-network.sh` true: the pane adds no network reach, no API key and nothing to send. It also works before a licence is entered, because what a licence buys is letting _other_ apps in — a self-check is not a relay.",
              "The calls are real ones. The pane dials the app's own socket with the same handshake `cupertino-bridge` sends, so a tool call from here goes to the same supervised child, under the same write gate and the same surface switch, and shows up in the Log and Connections panes like anybody else's. Tool calls are drawn above the model's prose, with the arguments it invented, because the calls are the evidence and the prose is a small model's account of them.",
              "The on-device model holds 4,096 tokens and Mail alone lists 4,858 tokens of tool schema, so the pane cannot offer a surface's tools — only as many as fit. It costs each tool, sorts the ones callable with no arguments first (a set of only `get_*(id)` tools gives the model nothing to open with), fills a 1,800-token budget greedily, and says in the header what it spent and in the picker what it left out. `make chat-check` asserts that arithmetic with no app and no model, and `make chat-check-real` puts every shipped tool schema through the same rule — all 131 of them convert.",
              "A question may make six tool calls, and a reply is capped at 400 tokens. Neither is tidiness: a model looping on a failing tool would otherwise spend six minutes of call deadlines before anybody could type again, and a model that starts enumerating fills the window, overflows, and gets silently trimmed — so the only symptom is a conversation that has forgotten its own opening. Stopping a reply ends the turn immediately and drops the stopped question from what the model remembers, which the row says out loud.",
              "With writes enabled for a surface, the pane honours it: the model can change your data, behind an acknowledgement that names the surface and gates the Send button.",
            ]),
          Entry(
            ordinal: 1,
            headline: "A client that already fetches tool schemas on its own is never fronted.",
            body: [
              "\"Load tools on demand\" reads as a decision about a surface, but a surface feeds every wired client at once, and they do not agree about what they need. Claude Code and Claude Desktop both load an MCP server's schemas only when they are about to use them, so fronting either paid the facade's whole cost to buy back only the tool names — and worse, their own tool search then indexed the facade's four generic entries instead of the surface's twenty real ones.",
              "Cupertino now writes `--client=<id>` beside `--server=<id>` when it configures a client, so the host knows which config a connection came from and can leave those two alone. Which clients defer is an allowlist backed by evidence, with a per-client override (`defaults write … defersSchemas.<client> on|off`) for when it is wrong in either direction. An unrecognised client, or a config written before this existed, does not defer — the behaviour every client had before. Existing wirings are not invalidated: the staleness check compares the command and never the arguments, so nothing needs re-configuring, though a client that has not been re-configured carries no id until it is.",
            ]),
          Entry(
            ordinal: 2,
            headline: "A listing too small to be worth searching is served whole, whatever the switch says.",
            body: [
              "A facade costs its own declarations and buys back only what the real listing would have cost, so below a certain size the trade is a loss that looks exactly like a working facade. A surface is now fronted only when its listing has at least twice as many tools as the facade replacing it **and** costs at least twice as many bytes. Measured with writes on, Contacts (7 tools) and Messages (8) fail the first test at 1.4x and 1.6x while passing the second at 2.6x and 3.8x — which is why both terms are needed: a handful of fat schemas outweighs a facade made of prose, so a floor counting bytes alone would front them and buy nothing but a coarser permission prompt.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_19_1: Release = Release(
    version: "1.19.1",
    date: "2026-09-08",
    sections: [
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "`apple_safari_read_page` returned a single-page app's pre-boot shell, forever.",
            body: [
              "The extension captured a page once, at `document_idle`, and again only after a route change — before a single-page app has rendered anything. The only capture of x.com was therefore its loading shell: an empty `<title>` and the static \"Something went wrong … privacy related extensions\" block X ships in every response, easy to misread as a real error rather than an uninitialized page. The store is keyed by URL, so that snapshot was the **permanent** answer for the page; no amount of waiting before `read_page` improved it, because nothing ever captured a second time.",
              "The content script now re-captures once the page settles: a `MutationObserver` fires after the DOM holds still for 500ms, with a 5-second deadline for pages that never go fully quiet — a live timeline (video, ads, ticking timestamps) would otherwise never trigger a debounce on its own. A route change reuses the same watcher instead of a fixed delay, and a settled capture identical to the one already sent is skipped rather than resent.",
            ]),
        ]),
    ])

  // swift-format-ignore
  private static let v1_19_0: Release = Release(
    version: "1.19.0",
    date: "2026-09-08",
    sections: [
      Section(
        name: "Added",
        lead: [],
        entries: [
          Entry(
            ordinal: 0,
            headline: "`apple_desktop_hover`, because a click is not a pointer.",
            body: [
              "The desktop surface could press, click, type and read a tree, and still could not make a tooltip appear. `click` posts a press and a release and nothing in between, so a tracking area sees a button go down inside it having never seen the pointer arrive — which means every control that only exists under the cursor was unreachable: a tooltip, a hover readout, SwiftUI's `onContinuousHover`. Driving a chart's hover band is what found it, and the workaround was a throwaway `CGEvent` script outside the repo.",
              "Addressed by `handle` in preference to a coordinate, and for a sharper reason than the other verbs have. A point from `ui_tree` was true when the walk ran; a window that has moved since — and one being driven moves often — leaves it aimed at bare desktop, where a hover **misses in silence**. There is no control to fail to press and nothing to report, just a readout that never appears. So the handle form re-reads the element's frame at call time. It also brings the target application forward first and refuses to post if it did not come, because a hover is delivered only to the frontmost application; the same reasoning the simulator surface already applies to a tap.",
              "It is the first verb here that is refused on account of the person at the keyboard. A hover takes the physical pointer for as long as it sweeps, which is worse than a click rather than better, so it declines while somebody is using the Mac. The check could not be `secondsSinceUserInput()` alone: that reads `.combinedSessionState`, which counts Cupertino's own events, so a plain idle test would have refused every hover after the first — biting hardest when the agent is working alone, the case it exists to allow. The driving indicator already knows whether the last input was ours, and the idle floor sits under its linger so a sequence composes. The reading is returned with the answer, for the before/after comparison `apple_desktop_user_activity` describes.",
              "Annotated non-destructive and idempotent, unlike `click`: moving the pointer twice to the same place leaves the same state and presses nothing.",
            ]),
          Entry(
            ordinal: 1,
            headline: "The simulator surface introduces itself on connect.",
            body: [
              "A client loads the `initialize` result's `instructions` without being asked to; the guide resource is pull-only and goes unread unless something names its uri, which is the wrong shape for the handful of facts that change a caller's very first move. `InProcessRPC.dispatch` takes an optional instructions string and omits the key entirely when it is nil, so a surface that declares none answers byte for byte as it did before. Simulator declares a short one — only what changes that first move — and points at the guide for the rest.",
            ]),
        ]),
      Section(
        name: "Changed",
        lead: [],
        entries: [
          Entry(
            ordinal: 2,
            headline: "The role-filter guidance was drawn from Catalyst apps alone.",
            body: [
              "The advice about filtering `apple_desktop_find_elements` by role came from a sample where controls report as `AXGenericElement`, `AXStaticText` and `AXImage` far more often than `AXButton`. That is true of Catalyst and was overstated as the norm. Re-measured across 21 regular apps: Catalyst still misses about 80% of them (Maps, Messages, Calendar, System Settings), while AppKit and plain SwiftUI apps miss only about a fifth, and widening the filter to the whole button family clears most of that. The rule does not change — the stragglers are exactly the clickable heading or row a caller cannot predict, and asking for pressable costs nothing — but the tool description and `docs/desktop.md` no longer claim the miss rate is typical.",
            ]),
        ]),
      Section(
        name: "Fixed",
        lead: [],
        entries: [
          Entry(
            ordinal: 3,
            headline: "`apple_desktop_activate` was refusing every target, and it was never a permission.",
            body: [
              "Cupertino is an `LSUIElement` broker nobody ever clicks, which since macOS 14 is on its own enough for `NSRunningApplication.activate()` to refuse — whatever the target, and with no grant that changes it. Measured on macOS 26.6.2: refused for `com.apple.mail` and `com.apple.finder` alike when called from Cupertino, while the same `activate()` on Mail from a freshly launched command-line process returned true and moved the foreground. `.activateIgnoringOtherApps` is not the way out either, having been deprecated and a no-op since macOS 14.",
              "When LaunchServices says no and the app holds Accessibility, the driver now sets `AXFrontmost` on the target's application element instead — measured raising Mail from behind another app with `err=0`. Either path is then checked against the window server's own `frontmostBundleId` rather than the return value of the call that did it, because activation is asynchronous and a caller that posts a keystroke before it lands types into whatever was already in front. That check is what `apple_desktop_hover` leans on when it declines to post into an application that did not come forward.",
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
  static let unreleased: Release? = unreleasedRelease
  // </generated:changelog>
}

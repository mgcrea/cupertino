import AppKit
import SwiftUI

/// Screenshot mode: the app photographed instead of the app used.
///
/// Everything here is inert unless `-ScreenshotMode YES` is on the command
/// line, which `appshot capture` passes and nothing else does. Launch
/// arguments land in `NSArgumentDomain`, so they are readable through
/// `UserDefaults` with no plumbing and they apply to that launch only — a
/// developer's normal runs are untouched, and none of this can ship enabled.
///
/// It exists because a screenshot of this app is otherwise a screenshot of
/// *this machine*: the log is empty until a client connects, the licence line
/// says whatever this Mac is licensed for, the store row prints the developer's
/// real home directory, and the automation glyphs report their real TCC state.
/// Three of those four are wrong in the marketing image; the third is a privacy
/// leak.
///
/// The rule for anything added here: a fact the screen shows must be *fixed*,
/// never merely *plausible*. Two runs a week apart have to produce comparable
/// images or the golden gate in `make screenshots-check` is decorative.
/// Deliberately **not** `@MainActor` as a whole. Two of its callers are
/// nonisolated — `MainView`'s `pane` property initialiser and
/// `StatusModel.refresh()` — and isolating the type would push `await` into
/// both for values that are a `UserDefaults` read and a constant. The members
/// that touch AppKit carry the annotation individually.
enum DemoSeed {
  // MARK: - Launch arguments

  /// The names `appshot` passes by default. Changing one means changing the
  /// Makefile's `--extra-args` in the same commit.
  private enum Key {
    static let mode = "ScreenshotMode"
    static let stage = "ScreenshotStage"
    static let appearance = "ScreenshotAppearance"
    static let readyFile = "ScreenshotReadyFile"
  }

  nonisolated static var isEnabled: Bool { UserDefaults.standard.bool(forKey: Key.mode) }

  /// Which screen this launch is for.
  ///
  /// The staged driver reaches a screen by relaunching rather than by
  /// navigating, so there is one process per screen and this is read once. That
  /// is the trade: ten launches instead of two, in exchange for a pipeline that
  /// never touches the accessibility tree and therefore cannot be broken by
  /// renaming a label.
  enum Stage: String, CaseIterable {
    case surface
    case prompt
    case activity
    case connections
    case settings

    /// Which window the shutter is aimed at.
    ///
    /// `settings` is the only stage that is not the main window, and it is the
    /// one most likely to fail *silently*: appshot photographs the largest
    /// ordinary window, so leaving the main window on screen captures that
    /// instead — at exactly the right size, showing a real screen, with nothing
    /// in the run saying a word. `openStagedWindow()` below is what stops it —
    /// the main window is simply never opened on this stage — and `ReadySource`
    /// is what stops the shutter firing before the Settings window is up.
    var subject: Subject {
      switch self {
      case .settings: .settings(.permissions)
      case .surface, .prompt, .activity, .connections: .main
      }
    }

    enum Subject {
      case main
      case settings(SettingsPane)
    }

    /// Which view's `.task` is allowed to report readiness for this stage.
    var readySource: ReadySource {
      switch self {
      case .settings: .settings
      case .surface, .prompt, .activity, .connections: .main
      }
    }

    /// Where the main window's sidebar selection starts.
    ///
    /// `prompt` and `activity` are the same pane on purpose. They differ in what
    /// the log is seeded with, not in what is on screen: `activity` is the
    /// general-purpose fixture that exercises every level, and `prompt` is one
    /// question's trace and nothing else. Two stages rather than one because a
    /// caption quoting a prompt is only honest if the log under it shows the
    /// calls that prompt actually made.
    var pane: MainView.Pane {
      switch self {
      case .surface: .surface("mail")
      case .prompt, .activity: .log
      case .connections: .connections
      // Never seen: `openStagedWindow()` never builds `MainView` on this
      // stage at all, so this value exists only because the switch must be
      // exhaustive.
      case .settings: .log
      }
    }

    /// The log fixture this stage photographs.
    ///
    /// Exhaustive rather than `default:`, so adding a stage is a compile error
    /// here instead of a silent inheritance of the sampler — which is the same
    /// failure the `fatalError` on an unparseable stage exists to prevent, one
    /// level down: a good-looking capture of content nobody chose.
    var logLines: [(String, LogStore.Level, String)] {
      switch self {
      case .prompt: DemoSeed.heroTurnLogLines
      case .surface, .activity, .connections, .settings: DemoSeed.logLines
      }
    }
  }

  /// Deliberately non-optional with no fallback to a default screen.
  ///
  /// Which view reported that its screen is ready.
  ///
  /// `MainView` and `SettingsView` both call `signalReady(from:)` from their
  /// own `.task`, and only the one matching the current stage's `readySource`
  /// is honoured. `openStagedWindow()` means only one of the two is built on
  /// any given stage, so today the check never fires — it is here because the
  /// failure it prevents is silent and the cost is a switch. The moment
  /// anything opens both windows, whichever view renders first would report a
  /// screen the shutter is not aimed at, and the capture would be of a window
  /// that had not finished drawing.
  enum ReadySource {
    case main
    case settings
  }

  /// A stage argument that does not parse must be loud. The silent version of
  /// this bug produces a valid, correctly sized, good-looking capture of the
  /// *wrong* screen, filed under the right name — which is the one screenshot
  /// failure that is genuinely hard to see by eye, and the reason
  /// `appshot accept` refuses a set containing two identical images.
  nonisolated static var stage: Stage {
    let raw = UserDefaults.standard.string(forKey: Key.stage) ?? ""
    guard let stage = Stage(rawValue: raw) else {
      fatalError("-\(Key.stage) was '\(raw)' — expected one of \(Stage.allNames)")
    }
    return stage
  }

  // MARK: - Entry point

  /// Called from `applicationDidFinishLaunching`, before anything real starts.
  ///
  /// Order matters: the appearance and the ambient formatting are pinned before
  /// any view is built, the stores are seeded before the window that reads them
  /// opens, and the window observers are installed before the window exists.
  @MainActor static func apply() {
    pinAppearance()
    pinFormatting()
    seedStores()
    observeWindows()
  }

  /// The one window this launch opens, chosen by the stage.
  ///
  /// Opening the *right* window is the whole of the secondary-window problem,
  /// and it is worth saying why it is solved here rather than by hiding the
  /// wrong one later. appshot photographs the largest ordinary window, so the
  /// obvious approach — open both, then `orderOut` the main one before the
  /// shutter — has to run at activation time, and that is exactly when appshot
  /// is resolving its window list in two steps (`CGWindowListCopyWindowInfo`
  /// for ids and z-order, then `SCShareableContent` for the images). Reordering
  /// windows between those two steps makes the ids stop matching and kills the
  /// run on a random shot.
  ///
  /// It also deadlocks against `--ready-file`, which is how this was found:
  /// appshot waits for the readiness signal *before* it activates, so a
  /// presentation driven off `didBecomeActive` never runs, and the run fails
  /// with "the app never signalled ready within 8.0s" on the settings shot.
  ///
  /// Never opening the second window is strictly simpler than hiding it, and
  /// there is nothing left to race.
  @MainActor static func openStagedWindow() {
    switch stage.subject {
    case .main: MainWindowController.show()
    case .settings(let pane): SettingsWindowController.show(pane)
    }
  }

  // MARK: - Ambient state

  /// The appearance is forced per launch rather than left to System Settings,
  /// which is what makes `--appearances light,dark` mean anything: appshot
  /// launches twice and the *app* decides, not the Mac.
  @MainActor private static func pinAppearance() {
    switch UserDefaults.standard.string(forKey: Key.appearance) {
    case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
    case "light": NSApp.appearance = NSAppearance(named: .aqua)
    default: break
    }
  }

  /// The activity and connections panes render `HH:mm:ss` through a
  /// `DateFormatter`, which reads the process's default time zone. Fixed
  /// instants are therefore only half of determinism — the same `Date` prints
  /// 09:41 in Paris and 08:41 in London, so a golden accepted here fails on a
  /// machine one time zone over, in a way that looks like a UI change.
  ///
  /// Pinning the default zone rather than each formatter keeps this in one
  /// place, and demo mode formats nothing else.
  nonisolated private static func pinFormatting() {
    if let utc = TimeZone(identifier: "UTC") { NSTimeZone.default = utc }
  }

  // MARK: - Fixtures

  /// The wall clock the fixtures are pinned to.
  ///
  /// 09:41 is Apple's own convention for a product shot, and it is already what
  /// `apps/website/src/components/Activity.astro` draws — so the real capture
  /// and the hand-drawn mock beside it agree rather than reading as two
  /// different products.
  nonisolated private static func at(_ minute: Int, _ second: Int) -> Date {
    var components = DateComponents()
    components.year = 2026
    components.month = 1
    components.day = 15
    components.hour = 9
    components.minute = minute
    components.second = second
    components.timeZone = TimeZone(identifier: "UTC")
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    // The components are a literal above, so this cannot fail; a crash here
    // beats seeding `Date()` and quietly reintroducing the clock.
    return calendar.date(from: components)!
  }

  /// The activity log, in the app's own vocabulary.
  ///
  /// **No arguments appear here, and none may be added.** The footer under this
  /// list says "Tool names only — never arguments, message contents or
  /// results", `RequestObserver` is written to hold that true, and a fixture
  /// showing a subject line would put a promise in the marketing image that the
  /// product deliberately does not make.
  ///
  /// Long enough to fill the pane, because a log with a dozen lines and six
  /// hundred points of empty below it photographs as a product nobody uses. All
  /// three levels appear, since they are tinted differently and a fixture that
  /// only exercises `.info` shows none of that.
  nonisolated private static let logLines: [(String, LogStore.Level, String)] = [
    ("cupertino", .info, "listening at ~/Library/Application Support/io.mgcrea.cupertino/host.sock"),
    ("mail", .info, "initialize"),
    ("mail", .info, "tools/list"),
    ("mail", .info, "allowWrites=true"),
    ("mail", .call, "apple_mail_list_accounts"),
    ("mail", .call, "apple_mail_list_mailboxes"),
    ("mail", .call, "apple_mail_search_messages"),
    ("mail", .call, "apple_mail_get_thread"),
    ("notes", .info, "initialize"),
    ("notes", .info, "tools/list"),
    ("notes", .call, "apple_notes_list_folders"),
    ("notes", .call, "apple_notes_search_notes"),
    ("notes", .call, "apple_notes_get_note"),
    ("reminders", .info, "initialize"),
    ("reminders", .info, "allowWrites=false"),
    ("reminders", .call, "apple_reminders_list_lists"),
    ("reminders", .call, "apple_reminders_list_reminders"),
    ("reminders", .error, "refused: writes are disabled for reminders"),
    ("calendar", .info, "initialize"),
    ("calendar", .call, "apple_calendar_list_calendars"),
    ("calendar", .call, "apple_calendar_list_events"),
    ("calendar", .call, "apple_calendar_search_events"),
    ("mail", .call, "apple_mail_get_message"),
    ("mail", .call, "apple_mail_list_attachments"),
    ("notes", .call, "apple_notes_search_notes"),
    ("calendar", .call, "apple_calendar_get_event"),
    ("reminders", .call, "apple_reminders_search_reminders"),
    ("mail", .call, "apple_mail_get_thread"),
  ]

  /// One turn's trace, for the `prompt` stage.
  ///
  /// The plate this seeds is captioned with a prompt, so the log under it has to
  /// be what *that* prompt produced and nothing else. `logLines` above is
  /// deliberately a sampler: it exercises every level, including a refused write
  /// to Reminders. Captioned with a prompt it would show surfaces the reader was
  /// never told were involved and a refusal for a request that asks nothing of
  /// them, which reads as the app doing things behind your back — the exact
  /// opposite of the claim.
  ///
  /// **The authority is `HERO_TURN` in apps/website/src/data/examples.ts**, and
  /// this is a hand-kept mirror of it, because Swift cannot read that file. Keep
  /// the prompt in `screenshots.config.json`, the calls here and `HERO_TURN`
  /// itself in step; the site enforces its own half at build time (every call a
  /// READ tool that `data/surfaces.ts` actually registers) and nothing yet
  /// enforces this one.
  ///
  /// Contacts leads, and that is the point of the turn: the prompt names a
  /// person, and every other surface is addressed by handle. Contacts logs no
  /// `allowWrites` line, unlike the two below it — `Surfaces.swift` registers no
  /// write tool for it by construction, so there is no toggle to report.
  ///
  /// The same prohibition as above applies and matters more here, because the
  /// caption is a sentence about the reader's own mail: **no arguments, and no
  /// search terms.** Four calls is what the turn takes, so four is what this
  /// shows — it fills perhaps half the pane, and padding it with calls the
  /// prompt did not make is the one fix that is not available.
  nonisolated private static let heroTurnLogLines: [(String, LogStore.Level, String)] = [
    ("cupertino", .info, "listening at ~/Library/Application Support/io.mgcrea.cupertino/host.sock"),
    ("contacts", .info, "initialize"),
    ("contacts", .info, "tools/list"),
    ("mail", .info, "initialize"),
    ("mail", .info, "tools/list"),
    ("mail", .info, "allowWrites=false"),
    ("calendar", .info, "initialize"),
    ("calendar", .info, "tools/list"),
    ("calendar", .info, "allowWrites=false"),
    ("contacts", .call, "apple_contacts_search_contacts"),
    ("mail", .call, "apple_mail_search_messages"),
    ("mail", .call, "apple_mail_get_thread"),
    ("calendar", .call, "apple_calendar_list_events"),
  ]

  /// Live sessions, as the handshake actually reports them.
  ///
  /// The client names are raw `clientInfo.name` values — `claude-code`,
  /// `cursor-vscode`, `claude-ai` — because that is what `Sessions.named`
  /// stores and the pane renders. Prettifying them for the screenshot would
  /// advertise a lookup table the app deliberately does not have.
  ///
  /// Eighteen rows, with names repeating. That is not padding: a session is one
  /// *connection* and every client opens one per server it is wired to, so the
  /// list is clients x surfaces x shells. `Sessions.grouped` puts the number at
  /// "four terminals plus two GUI clients is already ~18 rows", and collapsing
  /// them is the popover's job — this pane is the ungrouped truth, so the
  /// screenshot has to show what that actually looks like.
  nonisolated private static let sessions: [(String, String, Int32, Int)] = [
    ("mail", "claude-ai", 41_207, 9),
    ("notes", "claude-ai", 41_208, 3),
    ("reminders", "claude-ai", 41_209, 2),
    ("calendar", "claude-ai", 41_210, 1),
    ("mail", "claude-code", 41_884, 6),
    ("notes", "claude-code", 41_885, 1),
    ("reminders", "claude-code", 41_886, 0),
    ("calendar", "claude-code", 41_887, 2),
    ("mail", "claude-code", 42_003, 4),
    ("notes", "claude-code", 42_004, 0),
    ("reminders", "claude-code", 42_005, 0),
    ("calendar", "claude-code", 42_006, 5),
    ("mail", "claude-code", 42_141, 1),
    ("calendar", "claude-code", 42_142, 0),
    ("mail", "cursor-vscode", 42_016, 4),
    ("notes", "cursor-vscode", 42_017, 2),
    ("reminders", "cursor-vscode", 42_018, 0),
    ("calendar", "cursor-vscode", 42_019, 3),
  ]

  @MainActor private static func seedStores() {
    LicenseStore.demoLicensed = true

    for (index, line) in stage.logLines.enumerated() {
      LogStore.shared.appendDemo(
        at: at(40, 48 + index), surface: line.0, level: line.1, line.2)
    }
    // Sessions open before the calls they carry, so they are stamped earlier
    // than the log. Three seconds apart: a client opens one connection per
    // server it is wired to within a moment of the others, not on a timer.
    for (index, session) in sessions.enumerated() {
      Sessions.shared.openDemo(
        surface: session.0, client: session.1, pid: session.2, calls: session.3,
        startedAt: at(39, 4 + index * 3))
    }
  }

  /// What `StatusModel` reports instead of asking TCC and the file system.
  ///
  /// Every surface granted, because the screenshot is of the working state.
  /// This is also the isolation boundary: without it the automation glyphs and
  /// the Full Disk Access dot describe the capturing Mac, so the same commit
  /// produces a green image on one machine and an orange one on another.
  /// The version the marketing images show.
  ///
  /// Pinned for the reason at the top of this file: the real one is whatever the
  /// capturing Mac's nearest `app-v*` tag says, which moves the moment a release
  /// is cut. A capture would bake that into a marketing image, so every tag would
  /// churn the golden gate into noise — and the images would claim a version
  /// before the store listing showing them had caught up.
  /// Bump this deliberately, when new marketing images are wanted.
  nonisolated static let version = "1.2.0"

  nonisolated static let diskAccess: DiskAccessStatus = .granted
  nonisolated static let automation: AutomationStatus = .granted

  /// The store row in `SurfaceDetail`, which otherwise prints an absolute path
  /// under the developer's real home directory into a public image.
  nonisolated static func storePath(for surface: Surface) -> String? {
    guard let relative = surface.storePath else { return nil }
    return "/Users/you/" + relative.replacingOccurrences(of: "V*", with: "V10")
  }

  // MARK: - The window

  /// Windows are pinned on *appearance*, not once at startup.
  ///
  /// Pinning at launch only reaches windows that exist then, and this app opens
  /// its main window from `AppDelegate` a beat later. `didBecomeKey` fires once
  /// per window; `didUpdate` fires continuously and ordering a window from
  /// inside it re-enters until the app dies by recursion.
  @MainActor private static func observeWindows() {
    NotificationCenter.default.addObserver(
      forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main
    ) { note in
      guard let window = note.object as? NSWindow else { return }
      MainActor.assumeIsolated { pin(window) }
    }
  }

  /// The exact content size every capture is taken at.
  ///
  /// Sized to the fixtures rather than to a round number: at 700pt tall the log
  /// stopped three quarters of the way down and the rest of the window was
  /// empty, which photographs as a product nobody uses. 540 is what the seeded
  /// content actually fills. It is wider than the 1.6:1 canvas it gets composed
  /// onto, which is fine — the compositor fits by width and the gradient takes
  /// the remaining height — and a wide window suits the marketing site's
  /// full-bleed sections better than a squarer one.
  ///
  /// It has to be forced at all because `HostedWindow` sets a frame autosave
  /// name, and AppKit restores the saved frame from `UserDefaults`. So without
  /// this the capture is whatever size the developer last dragged the window
  /// to. `-ApplePersistenceIgnoreState` does not cover it: that suppresses
  /// state restoration, and an autosaved frame is a separate mechanism.
  nonisolated private static let contentSize = NSSize(width: 1120, height: 540)

  /// The Settings window's size, and it is the size that window is *created*
  /// at — not one applied to it afterwards.
  ///
  /// Two dead ends are worth recording, because both look right.
  ///
  /// Resizing the window after `show()` does not survive. `HostedWindow.show()`
  /// already documents why: SwiftUI sizes a `NavigationSplitView` window from
  /// its content on a layout pass landing *after* `show()` has returned, that
  /// comes out at 1120pt, and nothing set beforehand survives it. `pin()` runs
  /// on `didBecomeKey`, inside that window, so it loses — and it loses
  /// asymmetrically, which is what made it hard to see: the first capture came
  /// out 1120x540, SwiftUI's width with the *main* window's height, and looked
  /// like a plausible screenshot of a Settings pane with a lake of empty
  /// sidebar in it.
  ///
  /// Giving the *content* an exact `.frame(width:height:)` in demo mode — the
  /// usual advice when an AppKit resize loses to a SwiftUI content clamp — is
  /// worse: on a `NavigationSplitView` it conflicts with the split view's own
  /// constraints and AppKit throws from `_NSSplitViewItemViewWrapper
  /// updateConstraints`, so the app dies during the first display cycle and the
  /// run fails with "the window never appeared".
  ///
  /// What works is the size the window is born with, because `HostedWindow`
  /// already pins that against the late pass for its own reasons.
  ///
  /// Taller than the main window on purpose, and sized to the content rather
  /// than to a round number — the same rule `contentSize` above is chosen by.
  /// Permissions is the longest pane: Full Disk Access, then Automation and
  /// then Writes, one row per surface each, and the write gate is the whole
  /// reason this screen is captioned the way it is. 880 fitted all of it and
  /// left an empty third below, which photographs as a product nobody uses;
  /// 740 ends just under the footer sentence. Shortening it further starts
  /// cropping the write toggles, under a caption promising one per surface.
  nonisolated static let settingsContentSize = NSSize(width: 1000, height: 740)

  @MainActor private static func pin(_ window: NSWindow) {
    // Sheets and panels are windows too, and forcing a main-window size onto a
    // sheet blows out its layout.
    guard window.styleMask.contains(.titled), window.canBecomeMain else { return }

    // Matched on the autosave name rather than the title, which is a string
    // that could be localized, and rather than "the first window", which is
    // whatever order AppKit happened to open them in. A window this does not
    // recognise is left at whatever size it chose — better an odd size in one
    // capture than a wrong size forced on every future window.
    let size: NSSize
    switch window.frameAutosaveName {
    case MainWindowController.autosaveName: size = contentSize
    case SettingsWindowController.autosaveName: size = settingsContentSize
    default: return
    }

    window.setContentSize(size)
    window.center()

    // Focus is visible twice, and the second one is the flake. Beyond which
    // *window* is key there is which *view* holds first responder, and
    // `List(selection:)` draws its selected row in the accent colour while it
    // is first responder and in muted grey when it is not. Nothing in this app
    // assigns that focus deliberately, so it is whatever AppKit resolved by the
    // time the shutter fired — a gate that fails perhaps one run in three with
    // no code change.
    //
    // One runloop hop later, or SwiftUI's own assignment lands after this and
    // wins.
    DispatchQueue.main.async { window.makeFirstResponder(nil) }
  }

  // MARK: - Readiness

  /// Tell appshot the screen is actually ready, instead of letting it guess.
  ///
  /// `--settle` is a floor followed by a frame poll, and a poll detects
  /// *motion* — it is blind to anything wrong-but-still, which is precisely
  /// what a pane that has not filled in yet looks like. This is the app saying
  /// so from the one place that knows.
  ///
  /// Called from `MainView` once its body has run with the model populated. If
  /// the signal never arrives appshot fails the run rather than reverting to
  /// the guess, which is the entire point of using it.
  nonisolated static func signalReady(from source: ReadySource) {
    guard isEnabled, stage.readySource == source,
      let path = UserDefaults.standard.string(forKey: Key.readyFile)
    else { return }
    FileManager.default.createFile(atPath: path, contents: nil)
  }
}

extension DemoSeed.Stage {
  /// Derived from `allCases`, not restated. The hand-written list this replaced
  /// had to be edited in lockstep with the enum, and the only thing that reads
  /// it is the `fatalError` that fires when a stage does not parse — so the one
  /// message telling you which stages exist was the one most likely to be stale.
  static var allNames: String {
    allCases.map(\.rawValue).joined(separator: ", ")
  }
}

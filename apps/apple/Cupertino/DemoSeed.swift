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
  enum Stage: String {
    case surface
    case activity
    case connections

    /// Where the main window's sidebar selection starts.
    var pane: MainView.Pane {
      switch self {
      case .surface: .surface("mail")
      case .activity: .log
      case .connections: .connections
      }
    }
  }

  /// Deliberately non-optional with no fallback to a default screen.
  ///
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

    for (index, line) in logLines.enumerated() {
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
  /// pbxproj default happens to be on the machine that captured — `1.0`, not
  /// `1.0.0`, because nothing bumps MARKETING_VERSION locally and only CI sets
  /// it from the tag. A capture would bake that into a marketing image, and a
  /// version that changes every release would churn the golden gate into noise.
  /// Bump this deliberately, when new marketing images are wanted.
  nonisolated static let version = "1.0.0"

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

  @MainActor private static func pin(_ window: NSWindow) {
    // Sheets and panels are windows too, and forcing a main-window size onto a
    // sheet blows out its layout.
    guard window.styleMask.contains(.titled), window.canBecomeMain else { return }

    window.setContentSize(contentSize)
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
  nonisolated static func signalReady() {
    guard isEnabled,
      let path = UserDefaults.standard.string(forKey: Key.readyFile)
    else { return }
    FileManager.default.createFile(atPath: path, contents: nil)
  }
}

extension DemoSeed.Stage {
  static var allNames: String {
    [Self.surface, .activity, .connections].map(\.rawValue).joined(separator: ", ")
  }
}

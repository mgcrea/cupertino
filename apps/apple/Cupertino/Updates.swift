import AppKit
import Observation
import Sparkle

/// The update check — the one thing in this app that opens a socket to the
/// internet, and the single documented exception to the claim in
/// docs/licensing.md.
///
/// Everything here is built around one property: **a Cupertino nobody has said
/// yes to has never resolved a name.** That is stronger than "the checkbox is
/// off", and it is why `SPUStandardUpdaterController` is not a stored property
/// built at launch but a `nil` that stays `nil`. Sparkle starts a scheduler the
/// moment it is constructed, so constructing it and then declining to check
/// would leave the claim resting on a flag rather than on the absence of the
/// machinery.
///
/// `scripts/audit-network.sh` asserts the shipped Info.plist agrees — checks
/// off, feed ours, public key present — so "off by default" is something CI
/// refuses to ship without rather than a sentence in a settings pane.
@MainActor
@Observable
final class UpdateController: NSObject {
  static let shared = UpdateController()

  /// Set once the user has answered the consent card, either way.
  static let choiceMade = "updateChoiceMade"

  private var controller: SPUStandardUpdaterController?

  private(set) var isChecking = false
  private(set) var lastCheck: Date?

  /// Whether automatic checks are on.
  ///
  /// The answer lives in Sparkle's own `UserDefaults` key, read through the
  /// updater when it exists and directly when it does not. A second
  /// `@AppStorage` mirror would be one more thing to drift, and the plist
  /// default (`SUEnableAutomaticChecks`, false) already answers for a fresh
  /// install.
  var automatic: Bool {
    controller?.updater.automaticallyChecksForUpdates
      ?? UserDefaults.standard.bool(forKey: "SUEnableAutomaticChecks")
  }

  /// Called from `applicationDidFinishLaunching`. Builds nothing unless the
  /// user has already opted in.
  ///
  /// The two guards mirror `promptForLicenceIfNeeded`, for the same reasons
  /// recorded there: a screenshot is of the product rather than of this
  /// machine's update state, and `--background` means the bridge started us
  /// while somebody is mid-sentence at an assistant.
  func startIfConsented() {
    guard !DemoSeed.isEnabled,
      !CommandLine.arguments.contains(BridgeProtocol.backgroundFlag),
      UserDefaults.standard.bool(forKey: "SUEnableAutomaticChecks")
    else { return }
    start()
  }

  /// An explicit Check Now. This is consent in itself — pressing it is asking —
  /// so it starts the updater even when automatic checks are off, and leaves
  /// them off.
  func checkNow() {
    start()
    isChecking = true
    lastCheck = Date()
    controller?.updater.checkForUpdates()
  }

  func setAutomatic(_ on: Bool) {
    if on { start() }
    controller?.updater.automaticallyChecksForUpdates = on
    // Written through even when no updater exists, so that a "no" answered at
    // the consent card is durable without constructing one to record it.
    UserDefaults.standard.set(on, forKey: "SUEnableAutomaticChecks")
  }

  private func start() {
    guard controller == nil else { return }
    controller = SPUStandardUpdaterController(
      startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
  }
}

extension UpdateController: SPUUpdaterDelegate {
  /// Sparkle asks on its own on second launch when `SUEnableAutomaticChecks` is
  /// absent. It is present and false, so this never fires — but the plist is a
  /// build input and this is code, and only one of the two survives somebody
  /// deleting a key they did not recognise.
  nonisolated func updaterShouldPromptForPermissionToCheck(forUpdates updater: SPUUpdater) -> Bool
  { false }

  /// Never postpone the relaunch.
  ///
  /// This once held the install until the last MCP session closed, on the
  /// reasoning that a client mid-tool-call gets an EOF and its host reports a
  /// dead server. Both halves of that were wrong. Sparkle calls this the moment
  /// somebody clicks Install and Relaunch, so the only thing it ever deferred
  /// was an explicit request — and `SUAutomaticallyUpdate` is false, so there is
  /// no other path that can reach it. A session is one *connection*, held open
  /// for the lifetime of the client, so `live` is empty only in the seconds
  /// nobody has an assistant running: one Claude Code window is eight of them.
  /// The held block therefore never fired, the panel dismissed with nothing
  /// shown, and the button read as broken.
  ///
  /// The EOF is still real; it is just handled a few milliseconds later and
  /// unconditionally, in `updaterWillRelaunchApplication` below, which SIGTERMs
  /// every server so the clients see an ordinary shutdown.
  nonisolated func updater(
    _ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
    untilInvokingBlock installHandler: @escaping () -> Void
  ) -> Bool { false }

  /// Servers spawned by the outgoing bundle keep running from its inode after
  /// Sparkle replaces it, so an MCP host would quietly go on talking to the
  /// previous version's code over a socket the new app never bound.
  ///
  /// SIGTERM for the same reasons `endTrialSessions` gives: the child exits on
  /// its own, the pumps see EOF, and the session leaves the Activity window by
  /// the ordinary path.
  nonisolated func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
    MainActor.assumeIsolated {
      for session in Sessions.shared.live {
        hostLog("update", .info, "updating — stopping server (pid \(session.pid))")
        kill(session.pid, SIGTERM)
      }
      ServerHost.shared.stop()
    }
  }
}

extension UpdateController: SPUStandardUserDriverDelegate {
  /// A scheduled check that finds something posts a notification instead of
  /// stealing focus. Cupertino spends nearly all of its life as an accessory
  /// nobody is looking at, and an alert in front of the window someone *is*
  /// looking at is the wrong way to mention a point release.
  nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

  /// `DockPresence` follows the windows, but it is driven by exactly one
  /// trigger — `NSWindow.willCloseNotification` — because every window this app
  /// owns is opened through `HostedWindow.show()`, which calls `update()`
  /// itself. Sparkle's alert is the first window that arrives from neither
  /// path, and without this it appears with no Dock icon, no app menu and no
  /// ⌘-Tab entry: the exact "reads as broken rather than as restrained" failure
  /// DockPresence was written against.
  ///
  /// The hop mirrors `updateAfterClose`'s: the notification arrives before the
  /// window is on screen, so counting immediately would not yet see it.
  nonisolated func standardUserDriverWillHandleShowingUpdate(
    _ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem,
    state: SPUUserUpdateState
  ) {
    Task { @MainActor in
      isChecking = false
      try? await Task.sleep(for: .milliseconds(50))
      DockPresence.update()
    }
  }

  nonisolated func standardUserDriverWillFinishUpdateSession() {
    Task { @MainActor in
      isChecking = false
      DockPresence.update()
    }
  }
}

import SwiftUI

/// Starting the host belongs to the app lifecycle, not to the menu: the
/// servers must be reachable whether or not anyone has opened the menu bar
/// item. `MenuBarExtra` content is built lazily, so this cannot live there.
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    // Screenshot mode never starts the host. Binding the socket would collide
    // with the developer's real Cupertino, spawn four Node servers per launch,
    // and write real log lines into the seeded fixture — and every screen this
    // photographs is one the app can draw without a single connection.
    if DemoSeed.isEnabled {
      DemoSeed.apply()
      DockPresence.observe()
      // Not `MainWindowController.show()`: the `settings` stage photographs a
      // different window, and the main one must not merely be hidden but never
      // opened. See `DemoSeed.openStagedWindow`.
      DemoSeed.openStagedWindow()
      return
    }

    // Before the first line is logged. Listening is not writing: with the
    // Activity pane untouched `AuditLog` opens no file.
    AuditLog.install()

    let location = InstallLocation.current
    hostLog(
      "cupertino", .info,
      "running from \(location.url.path)"
        + (location.isStable ? "" : " — not a stable location for MCP client configuration"))
    do {
      try ServerHost.shared.start()
    } catch {
      hostLog("cupertino", .error, error.localizedDescription)
    }
    DockPresence.observe()
    LoginItem.healIfNeeded()
    promptForLicenceIfNeeded()
    UpdateController.shared.startIfConsented()
  }

  /// A click on the Dock icon, or opening the app while it is already running —
  /// which, since Cupertino is started by the first tool call and usually also
  /// by the login item, is what a Finder double-click almost always becomes.
  ///
  /// This is the only path that opens the main window automatically. Doing it
  /// from `applicationDidFinishLaunching` instead needed the app to work out
  /// whether a person or a tool call had started it, and it cannot: an
  /// `.accessory` app never becomes active, so `NSApp.isActive` is false either
  /// way, and "is the login item enabled" suppresses exactly the daily users
  /// most likely to want the window. A cold double-click with the app not
  /// running therefore shows only the menu bar icon; opening it once more gets
  /// the window, and that case is rare precisely because the app is nearly
  /// always already up.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    guard !hasVisibleWindows else { return true }
    if !Entitlement.current.allowsServers
      && !UserDefaults.standard.bool(forKey: Self.licencePromptShown)
    {
      UserDefaults.standard.set(true, forKey: Self.licencePromptShown)
      SettingsOpener.show(.licence)
    } else {
      MainWindowController.show()
    }
    return true
  }

  /// Show the main window when a person opened the app, and never when a tool
  /// call did.
  ///
  /// The obvious test — is the app active — does not work: an `.accessory` app
  /// never becomes active, so `NSApp.isActive` is false for a double-click and
  /// for `open -g` alike. The bridge therefore says so outright.
  ///
  /// Launch at login is the other quiet start. Someone who asked for the app to
  /// be there at login did not ask for a window at login, and the menu bar item
  /// and the Dock icon are each one click away.
  private func openMainWindowIfLaunchedByHand() {
    guard !CommandLine.arguments.contains(BridgeProtocol.backgroundFlag) else { return }
    guard !LoginItem.isEnabled else { return }
    MainWindowController.show()
  }

  static let licencePromptShown = "licencePromptShown"

  /// Open the licence pane once, and only when there is nothing to run with.
  ///
  /// Suppressed when the bridge started us. `cupertino-bridge` passes
  /// `--background` because it launches Cupertino with `open -g` while someone
  /// is mid-sentence at an assistant, and a window arriving then is the exact
  /// interruption that flag exists to prevent. They still learn why: the server
  /// refusal reaches the MCP host, the Activity log has it, and the popover
  /// carries the banner. The pane opens the first time a person opens the app.
  private func promptForLicenceIfNeeded() {
    guard !CommandLine.arguments.contains(BridgeProtocol.backgroundFlag) else { return }
    // `Entitlement`, not `LicenseStore`: someone who started a trial two minutes
    // ago has something to run with, and opening the licence pane at them is
    // answering a question they have already answered.
    guard !Entitlement.current.allowsServers,
      !UserDefaults.standard.bool(forKey: Self.licencePromptShown)
    else { return }
    UserDefaults.standard.set(true, forKey: Self.licencePromptShown)
    SettingsOpener.show(.licence)
  }

  func applicationWillTerminate(_ notification: Notification) {
    ServerHost.shared.stop()
  }
}

@main
struct CupertinoApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = StatusModel.shared

  var body: some Scene {
    // The menu bar is the only surface Cupertino shows uninvited. It is started
    // by a tool call far more often than by a person, and docs/distribution.md's
    // framing — "the signed app that grants them their permissions once instead
    // of once each" — is a broker, not something to look at.
    //
    // It owns two windows all the same, opened only when asked: the main window
    // (status and the log) and Settings. `DockPresence` gives the app a Dock
    // icon for exactly as long as one of them is open, because a titled window
    // with no Dock icon and no app menu is one you cannot get back to.
    // The mark, not an SF Symbol. MenuBarIcon is a template image: pure black
    // plus alpha, so AppKit tints it for light, dark and the highlighted state
    // rather than us drawing three of them.
    MenuBarExtra {
      StatusMenu(model: model)
    } label: {
      MenuBarLabel()
    }
    .menuBarExtraStyle(.window)
    // Settings and its ⌘, declared to SwiftUI rather than inserted into
    // `NSApp.mainMenu` by hand.
    //
    // `MainMenu.installSettingsItem()` did the latter and the item did not
    // survive. MEASURED: the insertion succeeded at launch — no "no app menu
    // found" in the log — and the live app menu was still About / Services /
    // Hide / Quit, with a dead ⌘,. SwiftUI installs its own main menu after the
    // delegate returns and builds another whenever the activation policy flips,
    // and each one discards whatever was in the menu it replaced. Re-asserting
    // the item on `didBecomeActive` and after every policy change did not fix it
    // either: SwiftUI's rebuild lands after those hooks, so the race is not one
    // that can be won by inserting more often.
    //
    // Declared this way the item is part of what SwiftUI rebuilds, so there is
    // nothing left to race.
    .commands {
      // `.appSettings`, not `after: .appInfo`. Both put an item in the app menu,
      // but only this one is the slot AppKit reserves for Settings, so the
      // separators around it are Apple's rather than ours to guess at. Measured
      // with `after: .appInfo`: About / Settings… / separator / Services, which
      // is one separator short of every stock app menu on the system.
      CommandGroup(replacing: .appSettings) {
        Button("Settings…") { SettingsWindowController.show() }
          .keyboardShortcut(",", modifiers: .command)
      }
    }
  }
}

/// The menu bar glyph, and the only thing in the app that changes on its own
/// without anyone opening a window.
///
/// A separate `View` rather than an `Image` inline in the Scene: `MenuBarExtra`'s
/// `(_:image:)` initialiser takes an asset *name*, resolved once when the Scene
/// is built, so a state change cannot reach it. A label closure gives a real
/// view whose body re-runs when `Sessions.live` changes.
///
/// `.isEmpty` and not a count. This says *whether* anything is connected, which
/// is the question the menu bar can answer in one glyph at 18pt; how many is
/// what the popover is for.
struct MenuBarLabel: View {
  private var sessions = Sessions.shared

  var body: some View {
    Image(sessions.live.isEmpty ? "MenuBarIcon" : "MenuBarIconActive")
      // The asset carries template-rendering-intent, but SwiftUI resolves an
      // Image by name without consulting it, so a plain Image ships black-on-
      // black in a dark menu bar. AppKit does the tinting; this only says it may.
      .renderingMode(.template)
      .accessibilityLabel(
        sessions.live.isEmpty ? "Cupertino" : "Cupertino — a client is connected")
  }
}

@Observable
final class StatusModel {
  /// Shared for the same reason `Sessions` and `LogStore` are: the Settings
  /// window is built by an AppKit controller that has no view hierarchy to
  /// inherit it from, and two StatusModels would disagree about permissions.
  static let shared = StatusModel()

  private(set) var diskAccess: DiskAccessStatus = .denied
  private(set) var automation: [String: AutomationStatus] = [:]
  /// The two grants a Mail composer needs, which nothing else in this window
  /// covers. Both are about the app itself rather than a surface, so neither
  /// fits the per-surface `automation` table.
  private(set) var accessibility: AccessibilityStatus = .denied
  private(set) var systemEvents: AutomationStatus = .notDetermined
  /// Whether Safari is running our extension — the one permission-like fact the
  /// SERVER cannot measure for itself.
  ///
  /// It can see captures on disk, but a disabled extension leaves its last ones
  /// there and simply stops adding more, so the store looks healthy and answers
  /// with an ever-older page. Only Safari knows the switch is off, and only the
  /// containing app may ask it.
  private(set) var safariExtension: SafariExtensionStatus = .unknown
  private(set) var location: InstallLocation = .current
  private(set) var clients: [ClientWiring.Client: ClientWiring.Status] = [:]
  private(set) var lastError: String?
  /// The socket never came up. Nothing works in this state, and until now it
  /// was only ever written to stderr.
  private(set) var hostError: String?

  init() { refresh() }

  func refresh() {
    // Every line below reads the capturing Mac: TCC for the automation glyphs,
    // `access(2)` for the Full Disk Access dot, and the file system for which
    // MCP clients are installed. All three are correct facts about the wrong
    // subject — a screenshot is of the product, not of this laptop — so demo
    // mode answers them from a table instead. See `DemoSeed`.
    guard !DemoSeed.isEnabled else {
      location = .current
      hostError = nil
      diskAccess = DemoSeed.diskAccess
      accessibility = DemoSeed.accessibility
      systemEvents = DemoSeed.automation
      safariExtension = DemoSeed.safariExtension
      automation = Dictionary(
        uniqueKeysWithValues: Surface.all.map { ($0.id, DemoSeed.automation) })
      clients = Dictionary(
        uniqueKeysWithValues: ClientWiring.clients.map { ($0, ClientWiring.Status.configured) })
      return
    }
    location = .current
    hostError = ServerHost.shared.startupError
    diskAccess = Permissions.diskAccess()
    // A lookup, not an IPC — safe here, unlike the Automation probes below.
    accessibility = Permissions.accessibility()
    clients = Dictionary(
      uniqueKeysWithValues: ClientWiring.clients.map { ($0, ClientWiring.status(of: $0)) })
    refreshAutomation()
    refreshSafariExtension()
  }

  /// Off the main thread, for the same reason the automation glyphs are: this
  /// asks Safari, and a row must never wait on another process to paint.
  ///
  /// Not private: `SurfaceDetail` calls it on every visit to the Safari pane.
  /// `refresh()` only runs from three `.onAppear`s, so the state survived
  /// someone flipping the switch in Safari and coming straight back — the one
  /// row on that pane whose value is expected to change while you are looking
  /// at another window.
  func refreshSafariExtension() {
    Task {
      let state = await Permissions.safariExtension()
      await MainActor.run { self.safariExtension = state }
    }
  }

  /// The automation glyphs, gathered off the main thread — and never on it.
  ///
  /// `Permissions.automation(for:)` passes `askUserIfNeeded: false`, and that
  /// was read as making it safe to call while painting a row. It does make it
  /// safe from *prompting*. It does not make it safe from *blocking*:
  /// `AEDeterminePermissionToAutomateTarget` is a synchronous IPC, and it can
  /// park on a semaphore for as long as whatever is on the other end takes.
  ///
  /// MEASURED, 1.2.1 build 192, macOS 26.6: the call was reached through
  /// `NSHostingView.layout()` — SwiftUI running `refresh()` inside a layout
  /// pass — and never returned. Two samples 60 seconds apart showed the same
  /// stack, 2396 of 2396 samples, with 11 seconds of CPU across 11 hours. The
  /// run loop never came back, so the menu bar stopped answering clicks and no
  /// bridge could complete a handshake. The app looked dead because, for every
  /// purpose that reaches the main thread, it was.
  ///
  /// The rule this encodes: a TCC answer is a status glyph, and a status glyph
  /// is never worth the run loop. A stalled reply now leaves the previous value
  /// on screen instead of freezing the app.
  ///
  /// Only the surfaces that actually send an Apple Event. Asking TCC about a
  /// surface that never scripts anything would report it as "not yet asked"
  /// forever, and put an Allow… button on a permission nothing would use.
  private func refreshAutomation() {
    // Strings rather than `Surface` values, so what crosses to the detached
    // task is unambiguously Sendable no matter what Surface grows later.
    // Enabled only. Asking TCC about a surface that will never start spends a
    // blocking IPC on a question with no consumer.
    // compactMap, not map: `bundleID` is optional now that a surface need not
    // be an app. Nothing is dropped here in practice — surfaces.json refuses a
    // manifest with `usesAppleEvents` true and no bundle id — so the filter
    // above already guarantees one.
    let targets = SurfaceSettings.enabledSurfaces.filter(\.usesAppleEvents)
      .compactMap { surface in surface.bundleID.map { (surface.id, $0) } }
    // System Events goes through the same door and must ride the same detached
    // task. It is not a Surface, so it cannot come from the list above — but it
    // is the identical blocking IPC, and running it on the main thread would
    // reproduce the freeze this whole method exists to avoid.
    let systemEventsID = Permissions.systemEventsBundleID
    Task.detached {
      let statuses = targets.map { ($0.0, Permissions.automation(for: $0.1)) }
      let resolved = Dictionary(uniqueKeysWithValues: statuses)
      let events = Permissions.automation(for: systemEventsID)
      await MainActor.run {
        self.automation = resolved
        self.systemEvents = events
      }
    }
  }

  func configure(_ client: ClientWiring.Client) {
    do {
      try ClientWiring.configure(client)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
      hostLog("cupertino", .error, error.localizedDescription)
    }
    refresh()
  }

  /// Off the main thread: the prompt blocks until answered, and so does the
  /// launch below it.
  ///
  /// `.appNotRunning` takes the launching path because TCC cannot answer the
  /// question at all while the target is closed — measured, and spelled out on
  /// `Permissions.launchAndRequestAutomation`. Asking again without opening the
  /// app writes back the state it started in, which is the shape of a button
  /// that does nothing.
  func requestAutomation(_ surface: Surface) {
    // Both conditions hold together by construction: the manifest cannot
    // declare Apple Events without a target to send them to.
    guard surface.usesAppleEvents, let bundleID = surface.bundleID else { return }
    let needsLaunch = automation[surface.id] == .appNotRunning
    Task.detached {
      let result =
        needsLaunch
        ? Permissions.launchAndRequestAutomation(for: bundleID)
        : Permissions.requestAutomation(for: bundleID)
      await MainActor.run { self.automation[surface.id] = result }
    }
  }

  /// Ask for Automation to System Events.
  ///
  /// Detached for the reason in `refreshAutomation`, and doubly so here:
  /// `requestAutomation` blocks until the user answers the consent dialog,
  /// which can be minutes.
  func requestSystemEvents() {
    Task.detached {
      let result = Permissions.requestAutomation(for: Permissions.systemEventsBundleID)
      await MainActor.run { self.systemEvents = result }
    }
  }

  /// Ask for Accessibility, then re-read it.
  ///
  /// The prompt only offers to open System Settings — the switch is flipped by
  /// hand — so the answer arrives whenever the window is next brought forward,
  /// not when this returns. `refresh()` on activation is what actually updates
  /// the row; this just makes sure the app is listed to flip.
  func requestAccessibility() {
    Permissions.requestAccessibility()
    accessibility = Permissions.accessibility()
  }
}

struct StatusMenu: View {
  let model: StatusModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      // Baseline-aligned so the version reads as a suffix to the name rather
      // than as a second heading. The popover is capped at 320pt and its button
      // row is already full, so this goes beside the title — the one piece of
      // horizontal space left that costs nothing.
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("Cupertino").font(.headline)
        Text(AppInfo.shortVersion).font(.caption).foregroundStyle(.secondary)
        Spacer()
      }

      // First, and in the popover rather than behind a tab. This is the one
      // state where nothing works at all, and whoever is reading it has just
      // been told by their assistant that a server failed to start.
      EntitlementNotice()

      // Not about the grant — that follows the signature and survives a move.
      // It is the bridge path written into other apps' configs that breaks.
      if let warning = model.location.warning {
        VStack(alignment: .leading, spacing: 6) {
          Label(warning, systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
            .font(.caption)
            .fixedSize(horizontal: false, vertical: true)
          Button("Reveal in Finder") { model.location.revealInFinder() }
            .controlSize(.small)
        }
        Divider()
      }

      // Status at a glance, carrying only the actions that will not wait. The
      // explanations, the writes toggles and the client wiring moved to
      // Settings when a fourth surface made this taller than the thing it is
      // supposed to be a summary of.
      HStack {
        Label {
          Text("Full Disk Access")
        } icon: {
          Image(
            systemName: model.diskAccess == .granted ? "checkmark.circle.fill" : "xmark.circle.fill"
          )
          .foregroundStyle(model.diskAccess == .granted ? .green : .secondary)
        }
        Spacer()
        if model.diskAccess != .granted {
          Button("Grant…") { Permissions.openDiskAccessSettings() }
            .buttonStyle(.glass)
            .controlSize(.small)
        }
      }

      // Enabled only, and this is the feature's most visible payoff. The comment
      // above records that the explanations moved to Settings "when a fourth
      // surface made this taller than the thing it is supposed to be a summary
      // of"; there are eight now. It also removes up to eight live "Allow…"
      // buttons that would fire a real TCC consent dialog for a server that
      // cannot start.
      if SurfaceSettings.enabledSurfaces.isEmpty {
        // A bare gap between the disk-access row and the divider otherwise. The
        // vocabulary is the one this file already uses for a resting state.
        Text("No surfaces are on.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      ForEach(SurfaceSettings.enabledSurfaces) { surface in
        HStack {
          Label {
            Text(surface.displayName)
          } icon: {
            Image(systemName: StatusStyle.automationIcon(surface, model.automation[surface.id]))
              .foregroundStyle(StatusStyle.automationTint(surface, model.automation[surface.id]))
          }
          Spacer()
          switch surface.usesAppleEvents ? model.automation[surface.id] : nil {
          case .notDetermined:
            // Ask here, where the dialog is expected, rather than letting the
            // first tool call block on it 30 seconds into a conversation.
            Button(StatusStyle.actionLabel(.notDetermined) ?? "") {
              model.requestAutomation(surface)
            }
            .buttonStyle(.glass)
            .controlSize(.small)
          case .denied:
            // A denial cannot be re-prompted; it has to be changed in Settings.
            Button(StatusStyle.actionLabel(.denied) ?? "") {
              Permissions.openAutomationSettings()
            }
            .controlSize(.small)
          case .appNotRunning:
            // Same reasoning as the Permissions pane: consent cannot be asked
            // for a closed app, so the only useful control opens it first.
            Button(StatusStyle.actionLabel(.appNotRunning) ?? "") {
              model.requestAutomation(surface)
            }
            .buttonStyle(.glass)
            .controlSize(.small)
          default:
            Text(StatusStyle.automationCaption(surface, model.automation[surface.id]))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }

      Divider()

      ConnectionsSection(model: model)

      if let error = model.lastError {
        Text(error).font(.caption).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }

      Divider()

      // Four again, but only one of them is spelled. A fourth TEXT button
      // truncated "Open Cupertino" to "Open Cuperti…" at 320pt, which is what
      // cost Refresh its place — `onAppear` already refreshes every time the
      // menu opens and `requestAutomation` writes its own result back, so it
      // reached no state the other two did not. Two glyphs cost a fraction of
      // that width, so the row grew back without the panel having to.
      //
      // The gap goes after "Open Cupertino", not before "Quit". What opens
      // something sits left, what you GO TO sits right — Settings and the log
      // are both windows you go to, not things this panel does.
      HStack {
        Button("Open Cupertino") { MainWindowController.show() }
          .buttonStyle(.glass)

        Spacer()

        // Logs is the exception to the paragraph above, and worth naming rather
        // than quietly re-adding a row that was removed.
        //
        // Refresh was dropped because nothing it reached was state the panel did
        // not already have. The log is the opposite: every line above is a count
        // of calls, and "what were those calls" is the one question this summary
        // raises and cannot answer. It is also what people arrive with urgently
        // — an agent just touched their mail and they want to see what.
        //
        // Both are icons, and both sit right, which is the rule stated above:
        // what opens something sits left, what you GO TO sits right. Spelling
        // them is what the comment above measured truncating "Open Cupertino"
        // at 320pt; a gear and a list are the two glyphs nobody needs taught, so
        // the tooltips and the shortcuts carry the names instead of twenty more
        // points of panel.
        Button {
          MainWindowController.show(.log)
        } label: {
          Image(systemName: "list.bullet.rectangle")
        }
        .keyboardShortcut("l", modifiers: .command)
        .help("Logs (⌘L) — what every client has called, live")

        // ⌘, as well, matching the app menu item. The main menu already answers
        // that chord app-wide, popover or no popover; declaring it here is what
        // puts the shortcut where somebody looking for it would look.
        Button {
          SettingsOpener.show()
        } label: {
          Image(systemName: "gearshape")
        }
        .keyboardShortcut(",", modifiers: .command)
        .help("Settings (⌘,)")

        Button("Quit") { NSApplication.shared.terminate(nil) }
      }
      .controlSize(.small)
    }
    .padding(14)
    .frame(width: 320)
    // Permission state changes in System Settings, not here, so a menu drawn
    // once at launch is a menu that lies. `Permissions.automation` is the
    // non-prompting variant precisely so this is safe.
    .onAppear { model.refresh() }
  }
}

/// The unlicensed state, said plainly and where it will be seen.
///
/// The reason string is the same sentence `ServerHost` hands the bridge, which
/// hands it to the MCP host, which files it in a log nobody opens. Saying it
/// here as well is the difference between "it broke" and "I know why".
/// Whichever of the three things is worth saying here, and nothing when the
/// answer is "licensed" — a paying customer does not need a status line about
/// it every time they open the popover.
///
/// On a timeline because a trial ends on a clock rather than on an event. A
/// popover left open across the end of the window would otherwise keep offering
/// a countdown that had already run out, which is the same lie as showing a
/// stale "running" glyph for a server that died.
struct EntitlementNotice: View {
  @State private var revision = 0

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { _ in
      VStack(alignment: .leading, spacing: 12) {
        switch Entitlement.current {
        case .licensed:
          EmptyView()
        case .trial:
          TrialBanner()
          Divider()
        case .refused(let reason):
          LicenceBanner(reason: reason) { revision += 1 }
          Divider()
        }
      }
    }
    .id(revision)
  }
}

struct LicenceBanner: View {
  let reason: String
  /// Called after a trial is armed, so the popover redraws now rather than at
  /// the next tick. Pressing a button and watching nothing happen for fifteen
  /// seconds reads as a broken button.
  var onStartTrial: () -> Void = {}

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Unlicensed — servers will not start", systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
      Text(reason)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Text("Permissions, settings and the write controls are unaffected.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        // The trial leads, and only until it has been used. Somebody reading
        // this has just been told a server failed to start; the useful offer is
        // the one that makes it work in the next ten seconds, not the one that
        // opens a checkout.
        if !Trial.hasRun {
          Button("Start a \(Int(Trial.duration / 60))-minute trial") {
            Trial.start()
            onStartTrial()
          }
          .buttonStyle(.glassProminent)
          Button("Enter a key…") { SettingsOpener.show(.licence) }
            .buttonStyle(.glass)
        } else {
          Button("Enter a licence key…") { SettingsOpener.show(.licence) }
            .buttonStyle(.glassProminent)
        }
      }
      .controlSize(.small)
    }
  }
}

/// The trial, while it is running.
///
/// Deliberately not styled as a warning. Nothing is wrong — everything is
/// working, on purpose, and the orange triangle belongs to the state where it
/// is not.
struct TrialBanner: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Trial · \(Trial.remainingText)", systemImage: "clock")
        .foregroundStyle(.blue)
        .font(.caption)
      Text("Every surface is running. When the window closes the servers stop, and your assistant will report the connection dropped.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Button("Buy a licence…") { NSWorkspace.shared.open(LicenseLinks.buy) }
        .buttonStyle(.glassProminent)
        .controlSize(.small)
    }
  }
}

/// Writes are withheld by not registering the tools at all
/// (`packages/*/src/tools/index.ts`) — and, since prompts shipped, the workflow
/// prompts that end in a mutation too (`packages/*/src/prompts.ts`). So this
/// decides what the assistant can even *see*, not merely whether it is allowed
/// to use it.
///
/// `@AppStorage` rather than a copy cached on the model. The cached version read
/// the defaults once at init and the toggle wrote back from that snapshot, so a
/// value changed from anywhere else was silently overwritten the next time the
/// menu was drawn. That is exactly how `allowWrites.mail` went back to 0 after
/// being set to 1.
struct WritesToggle: View {
  /// Where the toggle is being drawn, which is the only thing that differs
  /// between the two callers. The key stays in one place: two views reading the
  /// same `@AppStorage` key agree by construction, which is exactly what the
  /// cached copy above did not.
  enum Style {
    /// Tucked under the surface it belongs to, in the main window's detail
    /// card. The surface is already named above it, so the toggle names itself.
    case inline
    /// A Settings row, where the surface has to name itself and the switch
    /// belongs at the trailing edge like every other control in that form.
    case row
  }

  private let surface: Surface
  private let style: Style
  @AppStorage private var allowWrites: Bool

  init(surface: Surface, style: Style = .inline) {
    self.surface = surface
    self.style = style
    _allowWrites = AppStorage(wrappedValue: false, "allowWrites.\(surface.id)")
  }

  var body: some View {
    switch style {
    case .inline:
      Toggle("Allow writes", isOn: $allowWrites)
        .toggleStyle(.checkbox)
        .font(.caption)
        .padding(.leading, 20)
    case .row:
      Toggle(isOn: $allowWrites) {
        SurfaceLabel(surface: surface)
      }
    }
  }
}


/// One extra opt-in switch, for a tool the write gate is the wrong flag for.
///
/// Same one-key-two-views shape as `WritesToggle` above, and the same reason:
/// the key lives in `surfaces.json`, so the toggle, the environment variable
/// the server reads and the capability cache key cannot disagree.
///
/// Renders nothing for a surface with no gates, which is every surface but
/// Messages today. The description comes from the manifest rather than from
/// here because a switch that turns on a read of authentication codes needs to
/// say so at the point of decision, not in a doc comment.
struct GateToggle: View {
  private let surface: Surface
  private let gate: Surface.Gate
  @AppStorage private var isOn: Bool

  init(surface: Surface, gate: Surface.Gate) {
    self.surface = surface
    self.gate = gate
    _isOn = AppStorage(wrappedValue: false, SurfaceSettings.gateKey(surface, gate))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Toggle(gate.label, isOn: $isOn)
        .toggleStyle(.checkbox)
        .font(.caption)
      Text(gate.description)
        .font(.caption2)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 20)
    }
    .padding(.leading, 20)
  }
}

/// Whether Cupertino serves this surface at all.
///
/// Two homes, one key, exactly as `WritesToggle` above: the Settings row is the
/// batch job — first-run pruning is eight decisions at once, which is a list
/// rather than eight navigations — and the detail-pane switch is the in-context
/// one, taken where the evidence for it is already on screen. `SurfaceDetail`'s
/// own doc comment is the argument for the second: those facts were once
/// "scattered between the popover, the Permissions tab and the log filter", and
/// a per-surface preference reachable only from a second window rebuilds exactly
/// that.
///
/// `@AppStorage` and never a cached copy, for the reason `WritesToggle` records
/// — but the stakes are higher here. A stale copy of `allowWrites` reverted a
/// checkbox; a stale copy of this one silently re-enables a surface AND writes
/// its key back into somebody's client config on the next Update.
///
/// `wrappedValue: true` agrees with `SurfaceSettings.isEnabled`'s absence-means-
/// enabled by construction. Do not change one without the other; the app and the
/// relay would then disagree about which surfaces exist.
struct SurfaceSwitch: View {
  enum Style {
    /// Under the surface it belongs to, in the main window's detail pane.
    case inline
    /// A Settings row, where the surface has to name itself.
    case row
  }

  private let surface: Surface
  private let style: Style
  private let model: StatusModel
  @AppStorage private var enabled: Bool

  init(surface: Surface, style: Style = .inline, model: StatusModel) {
    self.surface = surface
    self.style = style
    self.model = model
    _enabled = AppStorage(wrappedValue: true, SurfaceSettings.enabledKey(surface))
  }

  var body: some View {
    control
      .onChange(of: enabled) { _, isOn in
        // Off means off now, not at the next editor restart. An MCP host opens
        // one stdio connection when it launches and keeps it for the life of
        // that editor, so refusing new connections alone would leave the tools
        // somebody has just switched off sitting in a session that outlives the
        // decision.
        if !isOn { ServerHost.shared.stopSessions(for: surface) }
        // `model.clients` is only recomputed in `refresh()`, which fires on the
        // Settings window's `onAppear`. Without this, flipping a switch here and
        // walking to the Clients pane — same window, no reappearance — shows a
        // verdict computed before the change, for the rest of the session.
        model.refresh()
      }
  }

  @ViewBuilder private var control: some View {
    switch style {
    case .inline:
      Toggle("Enabled", isOn: $enabled)
        .toggleStyle(.switch)
        .controlSize(.small)
        .labelsHidden()
    case .row:
      Toggle(isOn: $enabled) {
        SurfaceLabel(
          surface: surface,
          caption: enabled ? nil : "off — not served, and not written to clients")
      }
      .help(
        "Turn this off to stop serving \(surface.displayName). Clients you have already "
          + "configured keep the entry until you update them.")
    }
  }
}


/// What is talking to Cupertino right now.
///
/// The popover could previously say a great deal about permissions and nothing
/// at all about whether any of it was being used.
///
/// One row per client rather than per connection, and never more than `visible`
/// of them. This section lives in a popover with no `ScrollView`, so its height
/// has to be bounded by construction instead of by how many places someone has
/// wired Cupertino into — `Sessions.grouped` has the arithmetic.
struct ConnectionsSection: View {
  let model: StatusModel

  /// Grouping already bounds the list to the number of *kinds* of client
  /// installed. The cap is the backstop that makes that bound provable.
  private static let visible = 4

  var body: some View {
    let groups = Sessions.shared.grouped

    VStack(alignment: .leading, spacing: 6) {
      Text("Connections").font(.subheadline).bold()

      if let error = model.hostError {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(.red)
          .font(.caption)
          .fixedSize(horizontal: false, vertical: true)
      } else if groups.isEmpty {
        // Not a fault state. The bridge starts a server when a client connects
        // and the process exits with it, so idle is the normal resting shape.
        Text("No client connected.")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        ForEach(groups.prefix(Self.visible)) { group in
          row(group)
        }
        if groups.count > Self.visible {
          // The overflow is not lost, it is one click away — and the window it
          // opens lists every individual session, not just the hidden groups.
          Button("\(groups.count - Self.visible) more…") { openActivity() }
            .buttonStyle(.link)
            .font(.caption)
        }
      }
    }
  }

  private func row(_ group: Sessions.ClientGroup) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "circle.fill")
        .font(.system(size: 6))
        .foregroundStyle(.green)
      // Free-form, straight off the peer's handshake. This app does not choose
      // the string, so it does not let it set the popover's width either.
      Text(group.displayName)
        .lineLimit(1)
        .truncationMode(.middle)
      if group.sessions > 1 {
        Text("×\(group.sessions)")
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
      Text(group.surfaces.joined(separator: ", "))
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Spacer(minLength: 6)
      // Last to give way: the count is the part that says anything is happening.
      Text("\(group.calls) call\(group.calls == 1 ? "" : "s")")
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .layoutPriority(1)
    }
    .font(.caption)
  }

  /// Onto Connections specifically, not merely "open the window".
  ///
  /// This link says "N more…" under a list of connections, so the window it
  /// opens has to be showing them. It used to call `show()`, which brought the
  /// window forward on whatever pane it was last left on — and since the main
  /// window opens on the log by default, the common case was a link promising
  /// the connection list and delivering the log.
  private func openActivity() {
    MainWindowController.show(.connections)
  }
}
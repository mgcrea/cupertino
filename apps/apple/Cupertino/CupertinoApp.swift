import SwiftUI

/// Starting the host belongs to the app lifecycle, not to the menu: the
/// servers must be reachable whether or not anyone has opened the menu bar
/// item. `MenuBarExtra` content is built lazily, so this cannot live there.
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
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
    promptForLicenceIfNeeded()
  }

  /// Open the licence pane once, and only when there is nothing to run with.
  ///
  /// A menu bar app that opens a window at launch is normally a nuisance. This
  /// one earns it exactly once: an unlicensed build has just refused, or is
  /// about to refuse, the tool call that started it, and the popover is behind
  /// an icon the user may never have looked at. Recorded in defaults so it is
  /// the first launch and not every launch.
  private func promptForLicenceIfNeeded() {
    let shown = "licencePromptShown"
    guard !LicenseStore.isLicensed, !UserDefaults.standard.bool(forKey: shown) else { return }
    UserDefaults.standard.set(true, forKey: shown)
    Task { @MainActor in
      // `showSettingsWindow:` has nothing to open until the scene graph exists,
      // and it does not yet during didFinishLaunching.
      try? await Task.sleep(for: .milliseconds(500))
      SettingsOpener.show(.licence)
    }
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
    // LSUIElement is YES, so there is no Dock icon and no main window: the
    // menu bar is the whole surface. docs/distribution.md's framing — "the
    // signed app that grants them their permissions once instead of once
    // each" — is a status-and-consent app, not a window.
    // The mark, not an SF Symbol. MenuBarIcon is a template image: pure black
    // plus alpha, so AppKit tints it for light, dark and the highlighted state
    // rather than us drawing three of them.
    MenuBarExtra("Cupertino", image: "MenuBarIcon") {
      StatusMenu(model: model)
    }
    .menuBarExtraStyle(.window)

    // The one exception to "the menu bar is the whole surface". A log is read by
    // scrolling, and the popover dismisses itself the moment focus moves.
    Window("Activity", id: ActivityWindow.id) {
      ActivityView()
    }
    .defaultSize(width: 760, height: 460)
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
  private(set) var location: InstallLocation = .current
  private(set) var clients: [ClientWiring.Client: ClientWiring.Status] = [:]
  private(set) var lastError: String?
  /// The socket never came up. Nothing works in this state, and until now it
  /// was only ever written to stderr.
  private(set) var hostError: String?

  init() { refresh() }

  func refresh() {
    location = .current
    hostError = ServerHost.shared.startupError
    diskAccess = Permissions.diskAccess()
    automation = Dictionary(
      uniqueKeysWithValues: Surface.all.map { ($0.id, Permissions.automation(for: $0.bundleID)) })
    clients = Dictionary(
      uniqueKeysWithValues: ClientWiring.clients.map { ($0, ClientWiring.status(of: $0)) })
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

  /// Off the main thread: the prompt blocks until answered.
  func requestAutomation(_ surface: Surface) {
    Task.detached {
      let result = Permissions.requestAutomation(for: surface.bundleID)
      await MainActor.run { self.automation[surface.id] = result }
    }
  }
}

struct StatusMenu: View {
  let model: StatusModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Cupertino").font(.headline)

      // First, and in the popover rather than behind a tab. This is the one
      // state where nothing works at all, and whoever is reading it has just
      // been told by their assistant that a server failed to start.
      if case .refused(let reason) = LicenseStore.check {
        LicenceBanner(reason: reason)
        Divider()
      }

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
            .controlSize(.small)
        }
      }

      ForEach(Surface.all) { surface in
        HStack {
          Label {
            Text(surface.displayName)
          } icon: {
            Image(systemName: StatusStyle.icon(model.automation[surface.id]))
              .foregroundStyle(StatusStyle.tint(model.automation[surface.id]))
          }
          Spacer()
          switch model.automation[surface.id] {
          case .notDetermined:
            // Ask here, where the dialog is expected, rather than letting the
            // first tool call block on it 30 seconds into a conversation.
            Button("Allow…") { model.requestAutomation(surface) }
              .controlSize(.small)
          case .denied:
            // A denial cannot be re-prompted; it has to be changed in Settings.
            Button("Settings…") { Permissions.openAutomationSettings() }
              .controlSize(.small)
          default:
            Text(StatusStyle.caption(model.automation[surface.id]))
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

      HStack {
        Button("Settings…") { SettingsOpener.show(.general) }
        Button("Activity…") {
          openWindow(id: ActivityWindow.id)
          // An accessory app does not come forward on its own, so the window
          // would otherwise open behind whatever the user was looking at.
          NSApp.activate(ignoringOtherApps: true)
        }
        Spacer()
        Button("Refresh") { model.refresh() }
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
struct LicenceBanner: View {
  let reason: String

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
      Button("Enter a licence key…") { SettingsOpener.show(.licence) }
        .controlSize(.small)
    }
  }
}

/// Writes are withheld by not registering the tools at all
/// (`packages/*/src/tools/index.ts`), so this decides which tools the assistant
/// can even *see* — not merely whether it is allowed to use them.
///
/// `@AppStorage` rather than a copy cached on the model. The cached version read
/// the defaults once at init and the toggle wrote back from that snapshot, so a
/// value changed from anywhere else was silently overwritten the next time the
/// menu was drawn. That is exactly how `allowWrites.mail` went back to 0 after
/// being set to 1.
struct WritesToggle: View {
  @AppStorage private var allowWrites: Bool

  init(surface: Surface) {
    _allowWrites = AppStorage(wrappedValue: false, "allowWrites.\(surface.id)")
  }

  var body: some View {
    Toggle("Allow writes", isOn: $allowWrites)
      .toggleStyle(.checkbox)
      .font(.caption)
      .padding(.leading, 20)
  }
}


/// One-click wiring into the MCP clients on this Mac.
struct ClientsSection: View {
  let model: StatusModel
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("MCP clients").font(.subheadline).bold()

      ForEach(ClientWiring.clients) { client in
        if let status = model.clients[client], status != .notInstalled {
          HStack {
            Label {
              Text(client.displayName)
            } icon: {
              Image(systemName: status == .configured ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(status == .configured ? .green : .secondary)
            }
            Spacer()
            switch status {
            case .configured:
              Button("Reveal") { ClientWiring.reveal(client) }.controlSize(.small)
            case .stale:
              // Points at a previous build — the common case after moving the app.
              Button("Update") { model.configure(client) }.controlSize(.small)
            case .incomplete(let missing):
              // Wired before a surface existed. Configure writes all of
              // Surface.all, so the same button finishes the job.
              HStack(spacing: 6) {
                Text("missing \(missing.joined(separator: ", "))")
                  .font(.caption).foregroundStyle(.secondary)
                Button("Update") { model.configure(client) }.controlSize(.small)
              }
            case .unreadable(let why):
              Text(why).font(.caption).foregroundStyle(.red)
            default:
              Button("Configure") { model.configure(client) }.controlSize(.small)
            }
          }
        }
      }

      // Not edited automatically on purpose: ~/.claude.json is large, holds API
      // credentials, and running sessions write to it concurrently, so a
      // read-modify-write from here could drop someone else's change.
      HStack {
        Label("Claude Code", systemImage: "terminal")
        Spacer()
        Button(copied ? "Copied" : "Copy command") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(ClientWiring.claudeCodeCommands, forType: .string)
          copied = true
          // Confirmation, not a permanent state: the button has to invite a
          // second copy after the app has moved and the paths changed.
          Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
          }
        }
        .controlSize(.small)
      }
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
  @Environment(\.openWindow) private var openWindow

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

  private func openActivity() {
    openWindow(id: ActivityWindow.id)
    // An accessory app does not come forward on its own.
    NSApp.activate(ignoringOtherApps: true)
  }
}
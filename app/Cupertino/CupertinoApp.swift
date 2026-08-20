import SwiftUI

/// Starting the host belongs to the app lifecycle, not to the menu: the
/// servers must be reachable whether or not anyone has opened the menu bar
/// item. `MenuBarExtra` content is built lazily, so this cannot live there.
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      try ServerHost.shared.start()
    } catch {
      hostLog("cupertino", .error, error.localizedDescription)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    ServerHost.shared.stop()
  }
}

@main
struct CupertinoApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = StatusModel()

  var body: some Scene {
    // LSUIElement is YES, so there is no Dock icon and no main window: the
    // menu bar is the whole surface. docs/distribution.md's framing — "the
    // signed app that grants them their permissions once instead of once
    // each" — is a status-and-consent app, not a window.
    MenuBarExtra("Cupertino", systemImage: "tray.full") {
      StatusMenu(model: model)
    }
    .menuBarExtraStyle(.window)
  }
}

@Observable
final class StatusModel {
  private(set) var diskAccess: DiskAccessStatus = .denied
  private(set) var automation: [String: AutomationStatus] = [:]

  init() { refresh() }

  func refresh() {
    diskAccess = Permissions.diskAccess()
    automation = Dictionary(
      uniqueKeysWithValues: Surface.all.map { ($0.id, Permissions.automation(for: $0.bundleID)) })
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

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Cupertino").font(.headline)

      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Label {
            Text("Full Disk Access")
          } icon: {
            Image(systemName: model.diskAccess == .granted ? "checkmark.circle.fill" : "xmark.circle.fill")
              .foregroundStyle(model.diskAccess == .granted ? .green : .secondary)
          }
          Spacer()
          if model.diskAccess != .granted {
            Button("Grant…") { Permissions.openDiskAccessSettings() }
              .controlSize(.small)
          }
        }
        // One row, not one per surface: the grant is indivisible, and showing
        // it per surface would imply a containment that does not exist.
        Text(diskAccessHint)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Divider()

      ForEach(Surface.all) { surface in
        VStack(alignment: .leading, spacing: 2) {
          HStack {
            Label {
              Text(surface.displayName)
            } icon: {
              Image(systemName: icon(for: model.automation[surface.id]))
                .foregroundStyle(tint(for: model.automation[surface.id]))
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
              Text(caption(for: model.automation[surface.id]))
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
          WritesToggle(surface: surface)
        }
      }

      Divider()

      HStack {
        Button("Refresh") { model.refresh() }
        Spacer()
        Button("Quit") { NSApplication.shared.terminate(nil) }
      }
      .controlSize(.small)
    }
    .padding(14)
    .frame(width: 320)
  }

  private var diskAccessHint: String {
    switch model.diskAccess {
    case .granted:
      // Deliberately blunt. The honest description of what was granted.
      return "Search and message bodies are available. This grant covers the whole disk, not just Mail."
    case .denied:
      return "Without it, search falls back to Apple Events — usable for Notes, far too slow for Mail."
    case .storeMissing:
      return "No Mail or Notes store found on this Mac."
    }
  }

  private func icon(for status: AutomationStatus?) -> String {
    switch status {
    case .granted: "checkmark.circle.fill"
    case .appNotRunning: "moon.zzz"
    case .notDetermined, .none: "questionmark.circle"
    default: "xmark.circle.fill"
    }
  }

  private func tint(for status: AutomationStatus?) -> Color {
    switch status {
    case .granted: .green
    case .denied: .red
    default: .secondary
    }
  }

  private func caption(for status: AutomationStatus?) -> String {
    switch status {
    case .granted: "automation allowed"
    case .denied: "automation denied"
    case .notDetermined, .none: "not yet asked"
    case .appNotRunning: "not running"
    case .failed(let code): "error \(code)"
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

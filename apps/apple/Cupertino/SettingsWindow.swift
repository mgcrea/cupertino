import AppKit
import SwiftUI

/// The tabs, and the key the selection persists under.
///
/// Persisted rather than held in `@State` because opening Settings *at* a tab is
/// how the first-run licence prompt works: write the selection, then open the
/// window. A binding threaded down from the `Settings` scene would need the App
/// struct to own state that only one pane cares about.
enum SettingsPane: String, CaseIterable, Identifiable {
  case general
  case permissions
  case clients
  case licence

  var id: String { rawValue }

  static let defaultsKey = "settingsPane"

  var title: String {
    switch self {
    case .general: "General"
    case .permissions: "Permissions"
    case .clients: "Clients"
    case .licence: "Licence"
    }
  }

  var symbol: String {
    switch self {
    case .general: "gearshape"
    case .permissions: "lock.shield"
    case .clients: "puzzlepiece.extension"
    case .licence: "key"
    }
  }
}

/// The Settings window.
///
/// See `HostedWindow` for why this is an `NSWindow` rather than a SwiftUI
/// `Settings` scene: the scene opens through an app menu that `LSUIElement`
/// removes, so its button did nothing at all.
@MainActor
enum SettingsWindowController {
  private static let hosted = HostedWindow(
    title: "Cupertino Settings", autosaveName: "settings",
    content: { SettingsView(model: StatusModel.shared) })

  static func show(_ pane: SettingsPane) {
    UserDefaults.standard.set(pane.rawValue, forKey: SettingsPane.defaultsKey)
    hosted.show()
  }
}

/// The entry point for callers that are not already on the main actor.
enum SettingsOpener {
  static func show(_ pane: SettingsPane) {
    Task { @MainActor in SettingsWindowController.show(pane) }
  }
}

/// Everything that is configuration rather than status.
///
/// The split is deliberate and it is what the menu bar popover was losing. A
/// menu answers "what is happening right now" at a glance; it had grown four
/// surfaces of permission controls, a client wiring section and five rows of
/// About, none of which is a glance. Those live here, where there is room to
/// explain them, and the popover went back to being a status view with the
/// actions that are genuinely urgent.
struct SettingsView: View {
  let model: StatusModel
  @AppStorage(SettingsPane.defaultsKey) private var selection = SettingsPane.general.rawValue

  var body: some View {
    TabView(selection: $selection) {
      ForEach(SettingsPane.allCases) { pane in
        content(for: pane)
          .tabItem { Label(pane.title, systemImage: pane.symbol) }
          .tag(pane.rawValue)
      }
    }
    .frame(width: 580)
    .onAppear { model.refresh() }
  }

  @ViewBuilder
  private func content(for pane: SettingsPane) -> some View {
    switch pane {
    case .general: GeneralPane(model: model)
    case .permissions: PermissionsPane(model: model)
    case .clients: ClientsPane(model: model)
    case .licence: LicensePane()
    }
  }
}

struct GeneralPane: View {
  let model: StatusModel
  @State private var launchAtLogin = LoginItem.isEnabled
  @State private var loginError: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Cupertino \(AppInfo.version)").font(.headline)
        Text(AppInfo.identity).font(.caption).foregroundStyle(.secondary)
      }

      Divider()

      VStack(alignment: .leading, spacing: 6) {
        Toggle("Launch at login", isOn: $launchAtLogin)
          .toggleStyle(.checkbox)
          .disabled(!model.location.isStable)
          .onChange(of: launchAtLogin) { _, value in
            loginError = LoginItem.set(value)
            // Trust the service, not the checkbox: a refused registration has
            // to put the box back rather than claim something untrue.
            launchAtLogin = LoginItem.isEnabled
          }

        if let loginError {
          Text(loginError).font(.caption).foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          Text(
            "Cupertino starts on demand when a client connects. This only removes the wait on the first call."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }
      }

      Divider()

      VStack(alignment: .leading, spacing: 6) {
        Text("Location").font(.subheadline).bold()
        if let warning = model.location.warning {
          Label(warning, systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
            .font(.caption)
            .fixedSize(horizontal: false, vertical: true)
          Button("Reveal in Finder") { model.location.revealInFinder() }
            .controlSize(.small)
        } else {
          Text(
            "Installed where the clients expect it. Moving Cupertino breaks the bridge path written into their configs, not the permission grant."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }
      }

      Spacer(minLength: 0)
    }
    .padding(20)
    .frame(minHeight: 340, alignment: .topLeading)
  }
}

struct PermissionsPane: View {
  let model: StatusModel

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Label {
            Text("Full Disk Access").bold()
          } icon: {
            Image(
              systemName: model.diskAccess == .granted
                ? "checkmark.circle.fill" : "xmark.circle.fill"
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
        // One row, not one per surface: the grant is indivisible, and showing it
        // per surface would imply a containment that does not exist.
        Text(StatusStyle.diskAccessHint(model.diskAccess))
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Divider()

      VStack(alignment: .leading, spacing: 10) {
        Text("Automation and writes").font(.subheadline).bold()
        Text(
          "Automation lets Cupertino drive each app through Apple Events. Writes decide which tools an assistant can see at all — the write tools are not registered when it is off, so this is not merely a permission to refuse later."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

        ForEach(Surface.all) { surface in
          HStack(alignment: .firstTextBaseline) {
            Label {
              Text(surface.displayName)
            } icon: {
              Image(systemName: StatusStyle.icon(model.automation[surface.id]))
                .foregroundStyle(StatusStyle.tint(model.automation[surface.id]))
            }
            .frame(width: 130, alignment: .leading)

            Text(StatusStyle.caption(model.automation[surface.id]))
              .font(.caption)
              .foregroundStyle(.secondary)
              .frame(width: 130, alignment: .leading)

            WritesToggle(surface: surface)

            Spacer()

            switch model.automation[surface.id] {
            case .notDetermined:
              Button("Allow…") { model.requestAutomation(surface) }
                .buttonStyle(.glass).controlSize(.small)
            case .denied:
              // A denial cannot be re-prompted; it has to change in Settings.
              Button("Settings…") { Permissions.openAutomationSettings() }.controlSize(.small)
            default:
              EmptyView()
            }
          }
        }
      }

      Spacer(minLength: 0)
    }
    .padding(20)
    .frame(minHeight: 340, alignment: .topLeading)
  }
}

struct ClientsPane: View {
  let model: StatusModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(
        "Cupertino writes its own bridge path into each client's config. Re-run these after moving the app, or after a new surface ships."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)

      ClientsSection(model: model)

      if let error = model.lastError {
        Text(error).font(.caption).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 0)
    }
    .padding(20)
    .frame(minHeight: 340, alignment: .topLeading)
  }
}

/// The glyphs and sentences shared by the popover and the Permissions pane.
///
/// Hoisted out of `StatusMenu` when the two grew a second caller: a status icon
/// that disagrees between the menu and Settings is a small bug that reads as a
/// big one.
enum StatusStyle {
  static func icon(_ status: AutomationStatus?) -> String {
    switch status {
    case .granted: "checkmark.circle.fill"
    case .appNotRunning: "moon.zzz"
    case .notDetermined, .none: "questionmark.circle"
    default: "xmark.circle.fill"
    }
  }

  static func tint(_ status: AutomationStatus?) -> Color {
    switch status {
    case .granted: .green
    case .denied: .red
    default: .secondary
    }
  }

  static func caption(_ status: AutomationStatus?) -> String {
    switch status {
    case .granted: "automation allowed"
    case .denied: "automation denied"
    case .notDetermined, .none: "not yet asked"
    case .appNotRunning: "not running"
    case .failed(let code): "error \(code)"
    }
  }

  static func diskAccessHint(_ status: DiskAccessStatus) -> String {
    switch status {
    case .granted:
      // Deliberately blunt. The honest description of what was granted.
      "Search and message bodies are available. This grant covers the whole disk, not just Mail."
    case .denied:
      "Without it, search falls back to Apple Events — usable for Notes, far too slow for Mail."
    case .storeMissing:
      "No Mail or Notes store found on this Mac."
    }
  }
}

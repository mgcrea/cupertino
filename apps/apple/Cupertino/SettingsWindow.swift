import AppKit
import SwiftUI

/// The panes, and the key the selection persists under.
///
/// Persisted rather than held in `@State` because opening Settings *at* a pane
/// is how the first-run licence prompt works: write the selection, then open the
/// window. It is also what makes a deep link land on a window that is already
/// open — `@AppStorage` observes the write, so `SettingsOpener.show(.licence)`
/// moves the sidebar selection whether the window was built a moment ago or has
/// been sitting behind Xcode for an hour.
enum SettingsPane: String, CaseIterable, Identifiable {
  case general
  case permissions
  case clients
  case licence

  var id: String { rawValue }

  static let defaultsKey = "settingsPane"

  /// How the app behaves…
  static let configuration: [SettingsPane] = [.general, .permissions, .clients]

  /// …and what was bought, which is a different question and the only reason
  /// the sidebar is in two groups rather than one list of four. Somebody opens
  /// Licence because of a refusal or a receipt, never because they are tuning
  /// something.
  static let entitlement: [SettingsPane] = [.licence]

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
/// removes, so its button did nothing at all. `MainMenu` puts the ⌘, back by
/// hand.
@MainActor
enum SettingsWindowController {
  /// See `MainWindowController.autosaveName`.
  static let autosaveName = "settings-panes"

  private static let hosted = HostedWindow(
    // Renamed from "settings" deliberately. The old autosaved frame was sized
    // for a 580pt tab view; this window has a sidebar and a minimum a good deal
    // wider, and reopening into a frame smaller than the content can occupy is
    // how a window comes back with its detail column crushed to nothing.
    // A new name is a one-time reset of position and size, and nothing else.
    title: "Cupertino Settings", autosaveName: autosaveName,
    // Screenshot mode opens it at the capture size instead. It has to be *this*
    // number rather than a resize later on: `HostedWindow` pins the frame the
    // window was created with against SwiftUI's own layout pass, and anything
    // set after `show()` loses to that pass. See `DemoSeed.settingsContentSize`.
    contentSize: DemoSeed.isEnabled ? DemoSeed.settingsContentSize : NSSize(width: 760, height: 560),
    content: { SettingsView(model: StatusModel.shared) })

  static func show(_ pane: SettingsPane) {
    UserDefaults.standard.set(pane.rawValue, forKey: SettingsPane.defaultsKey)
    hosted.show()
  }

  /// Settings, without naming a pane — ⌘, and the app menu item, where nobody
  /// has said which one they want. The persisted selection stands, so this
  /// reopens on whatever was last being read instead of resetting to General.
  /// Every `show(_:)` caller is a deep link and keeps overriding it.
  static func show() {
    hosted.show()
  }
}

/// The entry point for callers that are not already on the main actor.
enum SettingsOpener {
  static func show(_ pane: SettingsPane) {
    Task { @MainActor in SettingsWindowController.show(pane) }
  }

  static func show() {
    Task { @MainActor in SettingsWindowController.show() }
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
///
/// A sidebar rather than the tab strip this used to be. Tabs price every pane
/// at one icon and one word across the top, which was survivable at four and is
/// the reason nothing could be added to it; a source list costs a column and
/// then stays free. It also puts Settings in the same shape as the main window,
/// and it is what every Mac app people already have open does — System Settings
/// and Xcode included.
struct SettingsView: View {
  let model: StatusModel
  @AppStorage(SettingsPane.defaultsKey) private var selection = SettingsPane.general.rawValue

  /// `List(selection:)` drives an `Optional` for a single selection, and the
  /// stored value is a `String` because that is what `@AppStorage` can hold.
  /// Bridging here rather than mirroring into `@State` keeps one source of
  /// truth: a `@State` copy seeded once at init is exactly how a deep link into
  /// an already-open window stops working.
  private var pane: Binding<SettingsPane?> {
    Binding(
      get: { SettingsPane(rawValue: selection) ?? .general },
      set: { selection = ($0 ?? .general).rawValue })
  }

  private var current: SettingsPane { SettingsPane(rawValue: selection) ?? .general }

  var body: some View {
    NavigationSplitView {
      List(selection: pane) {
        Section {
          ForEach(SettingsPane.configuration) { row($0) }
        }
        Section {
          ForEach(SettingsPane.entitlement) { row($0) }
        }
      }
      .navigationSplitViewColumnWidth(min: 172, ideal: 192, max: 240)
    } detail: {
      detail
    }
    // Wider than the 580 the tabs needed, because the sidebar is new width that
    // the content does not get to use. The minimum is what keeps the widest row
    // in Permissions — an app icon, a name, a status and a control — on one line.
    .frame(minWidth: 720, idealWidth: 760, minHeight: 480, idealHeight: 540)
    .onAppear { model.refresh() }
    // The `settings` stage photographs this window, so this is the one that
    // gets to say the screen is ready. MainView's own signal is inert on that
    // stage — see `DemoSeed.ReadySource`.
    .task { DemoSeed.signalReady(from: .settings) }
  }

  private func row(_ pane: SettingsPane) -> some View {
    Label(pane.title, systemImage: pane.symbol).tag(pane)
  }

  /// The pane's name is drawn in the content rather than left to the title bar,
  /// which keeps the window called "Cupertino Settings" in ⌘-Tab and in the
  /// Window menu while the heading still says which page this is.
  private var detail: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(current.title)
        .font(.title2)
        .fontWeight(.semibold)
        .padding(.horizontal, 20)
        .padding(.top, 16)

      content(for: current)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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

/// Every pane is a grouped `Form`, which is what draws the inset cards, the
/// hairlines between rows and the trailing-edge controls. Doing it by hand — a
/// `VStack` of `HStack`s, as this file used to — is how four panes end up with
/// four slightly different row heights and three different label widths.
struct GeneralPane: View {
  let model: StatusModel
  @State private var launchAtLogin = LoginItem.isEnabled
  @State private var loginError: String?
  @State private var copied = false

  var body: some View {
    Form {
      Section {
        LabeledContent {
          // Selectable *and* a button. Selecting a caption with a trackpad to
          // paste it into an issue is fiddly enough that people retype it, and
          // a retyped build number is the one that turns out to be wrong.
          Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(AppInfo.buildLine, forType: .string)
            copied = true
          } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
          }
          .buttonStyle(.borderless)
          .help("Copy build details for a bug report")
          .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
          }
        } label: {
          Text("Cupertino \(AppInfo.version)")
          Text(AppInfo.identityLine)
        }
        .textSelection(.enabled)
      }

      UpdatesSection()

      Section {
        Toggle(isOn: $launchAtLogin) {
          Text("Launch at login")
          Text(
            "Cupertino starts on demand when a client connects. This only removes the wait on the first call."
          )
        }
        .disabled(!model.location.isStable)
        .onChange(of: launchAtLogin) { _, value in
          loginError = LoginItem.set(value)
          // Trust the service, not the checkbox: a refused registration has to
          // put the box back rather than claim something untrue.
          launchAtLogin = LoginItem.isEnabled
        }
      } header: {
        Text("Startup")
      } footer: {
        if let loginError {
          Text(loginError).foregroundStyle(.red)
        }
      }

      Section {
        LabeledContent {
          if model.location.warning != nil {
            Button("Reveal in Finder") { model.location.revealInFinder() }
          }
        } label: {
          Text("Location")
          // Not about the grant — that follows the signature and survives a
          // move. It is the bridge path written into other apps' configs that
          // breaks.
          if let warning = model.location.warning {
            Text(warning).foregroundStyle(.orange)
          } else {
            Text(
              "Installed where the clients expect it. Moving Cupertino breaks the bridge path written into their configs, not the permission grant."
            )
          }
        }
      }
    }
    .formStyle(.grouped)
  }
}

struct PermissionsPane: View {
  let model: StatusModel

  var body: some View {
    Form {
      Section {
        LabeledContent {
          if model.diskAccess == .granted {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
          } else {
            Button("Grant…") { Permissions.openDiskAccessSettings() }
          }
        } label: {
          Text("Full Disk Access")
          // One row, not one per surface: the grant is indivisible, and showing
          // it per surface would imply a containment that does not exist.
          Text(StatusStyle.diskAccessHint(model.diskAccess))
        }
      }

      // Automation and writes were one row per surface carrying both, which
      // needed a paragraph above the table to explain that the two are
      // unrelated. Two sections say it without the paragraph: they are
      // different questions about the same apps, and each row now has one
      // control at its trailing edge like every other row in this window.
      Section {
        ForEach(Surface.all) { surface in
          LabeledContent {
            if surface.usesAppleEvents {
              switch model.automation[surface.id] {
              case .notDetermined:
                Button(StatusStyle.actionLabel(.notDetermined) ?? "") {
                  model.requestAutomation(surface)
                }
              case .denied:
                // A denial cannot be re-prompted; it has to change in Settings.
                Button(StatusStyle.actionLabel(.denied) ?? "") {
                  Permissions.openAutomationSettings()
                }
              case .appNotRunning:
                // Used to land in `default:` and paint a bare moon with nothing
                // to click — a dead end on the one surface that sits in this
                // state permanently, since Contacts is the Apple app nobody
                // leaves open. The button opens it and then asks.
                Button(StatusStyle.actionLabel(.appNotRunning) ?? "") {
                  model.requestAutomation(surface)
                }
              default:
                Image(systemName: StatusStyle.icon(model.automation[surface.id]))
                  .foregroundStyle(StatusStyle.tint(model.automation[surface.id]))
              }
            } else {
              Image(systemName: StatusStyle.automationIcon(surface, nil))
                .foregroundStyle(StatusStyle.automationTint(surface, nil))
            }
          } label: {
            SurfaceLabel(
              surface: surface,
              caption: StatusStyle.automationCaption(surface, model.automation[surface.id]))
          }
        }
      } header: {
        Text("Automation")
      } footer: {
        Text("Automation lets Cupertino drive each app through Apple Events.")
      }

      // Its own section because these two are not per-surface and not
      // interchangeable with the rows above. They gate ONE thing — filling a
      // Mail reply or forward — and they gate it together: the composer is
      // reached through System Events, so both must be granted, and until this
      // section existed neither was visible anywhere in the app.
      //
      // Grouped rather than split across Automation and a lone Accessibility
      // row, because the failure they produce is identical. `prop()` swallows
      // the exception either way, so a missing grant of either kind arrives as
      // the same "no composer window" error — which is exactly how one of them
      // got diagnosed as the other.
      Section {
        LabeledContent {
          if model.accessibility == .granted {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
          } else {
            // Two buttons, because the prompt cannot grant it: the first makes
            // the app appear in the list, the second is where the switch is.
            HStack {
              Button("Ask…") { model.requestAccessibility() }
              Button("Open…") { Permissions.openAccessibilitySettings() }
            }
          }
        } label: {
          Text("Accessibility")
          Text(StatusStyle.accessibilityHint(model.accessibility))
        }

        LabeledContent {
          switch model.systemEvents {
          case .granted:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
          case .denied:
            Button("Open…") { Permissions.openAutomationSettings() }
          default:
            Button("Allow…") { model.requestSystemEvents() }
          }
        } label: {
          Text("System Events")
          Text(StatusStyle.caption(model.systemEvents))
        }
      } header: {
        Text("Mail composer")
      } footer: {
        Text(
          "Replying and forwarding fill Mail's compose window directly, which needs both of "
            + "these. Every other tool works without them, so a missing grant here shows up only "
            + "as a reply that will not send.")
      }

      Section {
        // Only the surfaces that HAVE a write tool. A toggle for a server that
        // registers none would gate nothing while implying otherwise, which is
        // the opposite of what this section is for.
        ForEach(Surface.all.filter(\.supportsWrites)) { surface in
          WritesToggle(surface: surface, style: .row)
        }
      } header: {
        Text("Writes")
      } footer: {
        Text(
          "Writes decide what an assistant can see at all — the write tools, and the prompts that end in one, are not registered when this is off, so it is not merely a permission to refuse later."
        )
      }
    }
    .formStyle(.grouped)
  }
}

/// A form row's leading half for one surface: the app's own icon, its name, and
/// whatever this pane has to say about it underneath.
///
/// Spelled out rather than left to `LabeledContent`'s two-`Text` convention,
/// which produces the title-and-description pair only when the label is Text and
/// nothing else — and these rows lead with an icon.
struct SurfaceLabel: View {
  let surface: Surface
  var caption: String?

  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 1) {
        Text(surface.displayName)
        if let caption {
          Text(caption)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    } icon: {
      SurfaceIconView(surface: surface)
    }
  }
}

struct ClientsPane: View {
  let model: StatusModel

  /// A client we cannot find is not a client to nag anybody about. This is also
  /// the entire implementation of "does not support ChatGPT desktop": it is not
  /// in `ClientWiring.clients`, so there is no row and no explanation to
  /// maintain.
  private var visible: [ClientWiring.Client] {
    ClientWiring.clients.filter { model.clients[$0].map { $0 != .notInstalled } ?? false }
  }

  var body: some View {
    Form {
      Section {
        if visible.isEmpty {
          Text("No MCP clients found on this Mac.").foregroundStyle(.secondary)
        }
        ForEach(visible) { client in
          ClientRow(
            client: client,
            status: model.clients[client] ?? .notInstalled,
            configure: { model.configure(client) })
        }
      } header: {
        Text("MCP clients")
      } footer: {
        VStack(alignment: .leading, spacing: 6) {
          Text(
            "Cupertino writes its own bridge path into each client's config. Re-run these after moving the app, or after a new surface ships."
          )
          // The `code` command is installed separately from VS Code itself, and
          // the row is gated on the app rather than on the CLI: a false negative
          // would hide the row entirely, which is worse than a paste that says
          // "command not found" and names the thing to fix.
          Text(
            "Clients with a command keep their config in a format this app will not rewrite. Paste the command into a terminal — for Visual Studio Code that needs its \"code\" shell command installed."
          )
          if let error = model.lastError {
            Text(error).foregroundStyle(.red)
          }
        }
        .fixedSize(horizontal: false, vertical: true)
      }

      ProjectFoldersSection(model: model)
    }
    .formStyle(.grouped)
  }
}

/// Wiring one folder rather than the whole machine.
///
/// A section rather than a pane of its own: it is the same question the rows
/// above answer — where do these servers get written — and separating them
/// would invite someone to configure both and wonder why a project has the
/// servers twice.
///
/// ## Why the scope is a control here and not a setting
///
/// It was nearly a preference in Settings, and that is the wrong shape. The
/// choice is genuinely per-folder — this repo wants the entry committed, the
/// client's repo very much does not — so a single global answer would be wrong
/// half the time. More to the point, `project` scope writes a file into
/// somebody's git working tree, and a preference set once and applied silently
/// months later is the worst possible way to make that decision.
///
/// So it is a radio, sitting next to the button, resolved before the open panel
/// appears. The last choice is remembered, which is the part a setting would
/// have bought — without moving the decision away from the moment it matters.
private struct ProjectFoldersSection: View {
  let model: StatusModel

  @AppStorage("wiring.projectScope") private var scopeRaw = ClientWiring.ProjectScope.local
    .rawValue
  @State private var folders: [URL] = ClientWiring.rememberedFolders
  @State private var copied: URL?
  @State private var error: String?

  private var scope: ClientWiring.ProjectScope {
    ClientWiring.ProjectScope(rawValue: scopeRaw) ?? .local
  }

  var body: some View {
    Section {
      Picker(
        "Write to",
        selection: Binding(get: { scope }, set: { scopeRaw = $0.rawValue })
      ) {
        ForEach(ClientWiring.ProjectScope.allCases) { option in
          Text(option.displayName).tag(option)
        }
      }
      .pickerStyle(.radioGroup)

      Text(scope.detail)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      LabeledContent("Add a folder") {
        Button("Choose…") { choose() }
      }

      ForEach(folders, id: \.path) { folder in
        FolderRow(
          folder: folder,
          scope: scope,
          copied: copied == folder,
          wire: { wire(folder) },
          forget: {
            ClientWiring.forget(folder)
            folders = ClientWiring.rememberedFolders
          })
      }
    } header: {
      Text("Project folders")
    } footer: {
      VStack(alignment: .leading, spacing: 6) {
        Text(
          "Wire a folder when you want these servers in one project rather than everywhere. A Claude Code session started in that folder gets them; every other session stays as it was."
        )
        if let error {
          Text(error).foregroundStyle(.red)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func choose() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Wire"
    panel.message = "Choose the project folder to wire Cupertino into."
    guard panel.runModal() == .OK, let folder = panel.url else { return }
    ClientWiring.remember(folder)
    folders = ClientWiring.rememberedFolders
    wire(folder)
  }

  /// One button, two behaviours, because the two scopes genuinely differ in
  /// what this app is willing to do — see `ClientWiring.ProjectScope`.
  private func wire(_ folder: URL) {
    error = nil
    switch scope {
    case .project:
      do { try ClientWiring.configureProject(folder) } catch {
        self.error = error.localizedDescription
      }
      folders = ClientWiring.rememberedFolders
    case .local:
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(ClientWiring.localCommands(for: folder), forType: .string)
      copied = folder
      Task {
        try? await Task.sleep(for: .seconds(2))
        copied = nil
      }
    }
  }
}

private struct FolderRow: View {
  let folder: URL
  let scope: ClientWiring.ProjectScope
  let copied: Bool
  let wire: () -> Void
  let forget: () -> Void

  private var status: ClientWiring.Status { ClientWiring.projectStatus(folder, scope: scope) }

  var body: some View {
    LabeledContent {
      HStack(spacing: 8) {
        switch scope {
        case .local:
          Button(copied ? "Copied" : "Copy command", action: wire)
        case .project:
          if status == .configured {
            Button("Reveal") { ClientWiring.reveal(folder: folder) }
          } else {
            Button(status == .notConfigured ? "Write" : "Update", action: wire)
          }
        }
        Button("Remove", action: forget)
          .buttonStyle(.borderless)
          .foregroundStyle(.secondary)
      }
    } label: {
      Label {
        VStack(alignment: .leading, spacing: 1) {
          Text(folder.lastPathComponent)
          // The full path, because two repos called `app` is the normal case
          // and the last component alone would make them indistinguishable.
          Text(folder.path)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
        }
      } icon: {
        Image(systemName: status == .configured ? "checkmark.circle.fill" : "folder")
          .foregroundStyle(status == .configured ? .green : .secondary)
      }
    }
  }
}

/// One client, and the one action it can take.
///
/// A view of its own rather than a branch inside the pane, because `copied` has
/// to be per-row: with a single `copiedID` on the section, copying one client's
/// command while another's two-second reset is still in flight clears the wrong
/// label. `ForEach` identity scopes `@State` correctly for free.
private struct ClientRow: View {
  let client: ClientWiring.Client
  let status: ClientWiring.Status
  let configure: () -> Void
  @State private var copied = false

  var body: some View {
    LabeledContent {
      action
    } label: {
      Label {
        VStack(alignment: .leading, spacing: 1) {
          Text(client.displayName)
          if let caption {
            Text(caption)
              .font(.caption)
              .foregroundStyle(status.isFault ? .red : .secondary)
          }
        }
      } icon: {
        Image(systemName: status == .configured ? "checkmark.circle.fill" : "circle.dashed")
          .foregroundStyle(status == .configured ? .green : .secondary)
      }
    }
  }

  private var caption: String? {
    switch status {
    case .incomplete(let missing): "missing \(missing.joined(separator: ", "))"
    case .unreadable(let why): why
    default: nil
    }
  }

  @ViewBuilder private var action: some View {
    if case .unreadable = status {
      EmptyView()
    } else {
      switch client.wiring {
      // Not edited automatically on purpose: these files are JSONC, TOML, or —
      // in Claude Code's case — strict JSON that holds API credentials and that
      // running sessions write to concurrently. See `ClientWiring.Wiring`.
      case .command:
        Button(copied ? "Copied" : "Copy command") {
          guard let commands = ClientWiring.commands(for: client) else { return }
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(commands, forType: .string)
          copied = true
          // Confirmation, not a permanent state: the button has to invite a
          // second copy after the app has moved and the paths changed.
          Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
          }
        }

      case .json:
        switch status {
        case .configured:
          Button("Reveal") { ClientWiring.reveal(client) }
        case .stale:
          // Points at a previous build — the common case after moving the app.
          Button("Update") { configure() }
        case .incomplete:
          // Wired before a surface existed. Configure writes all of
          // Surface.all, so the same button finishes the job.
          Button("Update") { configure() }
        default:
          Button("Configure") { configure() }
        }
      }
    }
  }
}

extension ClientWiring.Status {
  /// Whether the caption under a client's name is a problem or just a note.
  var isFault: Bool {
    if case .unreadable = self { return true }
    return false
  }
}

/// The glyphs and sentences shared by the popover and the Permissions pane.
///
/// Hoisted out of `StatusMenu` when the two grew a second caller: a status icon
/// that disagrees between the menu and Settings is a small bug that reads as a
/// big one.
enum StatusStyle {
  /// A surface with no Apple Events lane has no automation state to report, and
  /// every other caption here would be a lie about it: "not yet asked" implies
  /// something will ask, and a cross implies something is broken. Nothing is
  /// going to ask, because the server never scripts the app — which is a fact
  /// worth showing rather than hiding, since it means one permission fewer.
  static func automationIcon(_ surface: Surface, _ status: AutomationStatus?) -> String {
    surface.usesAppleEvents ? icon(status) : "minus.circle"
  }

  static func automationTint(_ surface: Surface, _ status: AutomationStatus?) -> Color {
    surface.usesAppleEvents ? tint(status) : .secondary
  }

  static func automationCaption(_ surface: Surface, _ status: AutomationStatus?) -> String {
    surface.usesAppleEvents ? caption(status) : "not needed — this surface reads only"
  }

  /// What the button on an automation row should say, or nil when the row has
  /// nothing left to offer.
  ///
  /// Shared for the same reason the glyphs are: three call sites paint this row
  /// — the popover, the Permissions pane and the surface detail — and a button
  /// that says something different in each is a small bug that reads as a big
  /// one.
  ///
  /// `.appNotRunning` gets "Open…" rather than "Allow…" because opening the app
  /// is literally what the click does. TCC returns `procNotFound` for a closed
  /// target whether or not it is asked to prompt (measured — see
  /// `Permissions.launchAndRequestAutomation`), so consent cannot be requested
  /// until the app is running, and a button promising to allow something would
  /// be describing a step that has to happen first.
  static func actionLabel(_ status: AutomationStatus?) -> String? {
    switch status {
    case .granted: nil
    // A denial cannot be re-prompted; it has to change in Settings.
    case .denied: "Settings…"
    case .appNotRunning: "Open…"
    default: "Allow…"
    }
  }

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
    // Not a verdict — TCC cannot answer while the app is closed, so this is a
    // step that has not happened yet rather than a permission that was refused.
    case .appNotRunning: "not running — open it to check"
    case .failed(let code): "error \(code)"
    }
  }

  static func accessibilityHint(_ status: AccessibilityStatus) -> String {
    switch status {
    // Deliberately about this app and not about the servers. The two are not
    // the same question for Accessibility — a granted app has been measured
    // alongside servers that still could not read a composer — and the old
    // wording promised the second while only ever checking the first.
    case .granted: "Granted to Cupertino. If replies still fail, quit and reopen it."
    // Not "denied": `AXIsProcessTrusted` cannot tell a refusal from a question
    // never asked, so the wording has to cover both without claiming either.
    case .denied: "Not granted. Replies and forwards will fail until it is."
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

/// The update controls, directly under the version number because that is where
/// somebody wondering whether they are current has already looked.
///
/// Cupertino is the only thing in this app that can reach the internet, so the
/// caption says what the check sends in plain terms rather than leaving it to
/// the privacy policy. See docs/licensing.md.
struct UpdatesSection: View {
  @State private var automatic = UpdateController.shared.automatic
  private var updates = UpdateController.shared

  var body: some View {
    Section {
      Toggle(isOn: $automatic) {
        Text("Check for updates automatically")
      }
      .onChange(of: automatic) { _, on in
        updates.setAutomatic(on)
        // Answering here is answering the consent card too. Leaving it armed
        // would ask again about a decision already made in this pane.
        UserDefaults.standard.set(true, forKey: UpdateController.choiceMade)
      }

      // The row's whole label is the answer to "am I current", because the
      // section header already said the word Updates and a row titled the same
      // thing under it says nothing twice.
      LabeledContent {
        Button("Check Now…") { updates.checkNow() }
          .disabled(updates.isChecking)
      } label: {
        Text(lastCheck)
      }
    } header: {
      Text("Updates")
    } footer: {
      Text(
        """
        This is the only network connection Cupertino makes, and it makes none \
        at all until you turn this on or press Check Now. It reads one file, \
        cupertino.mgcrea.io/appcast.xml, and sends no identifier with it: not \
        your licence key, not a machine id.
        """
      )
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// A sentence either way. The row previously showed nothing at all before the
  /// first check, which reads as a missing value rather than as the answer.
  private var lastCheck: String {
    guard let last = updates.lastCheck else { return "Not checked yet" }
    return "Last checked \(last.formatted(.relative(presentation: .named)))"
  }
}

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
  case audit
  case permissions
  case clients
  case updates
  case licence

  var id: String { rawValue }

  static let defaultsKey = "settingsPane"

  /// How the app behaves…
  ///
  /// Updates sits last. It was a Section in General, under the version number,
  /// on the theory that somebody wondering whether they are current has already
  /// looked there — which holds only for the people who scroll. The one manual
  /// check the app has was the second card on a page whose other rows are about
  /// launching at login and where the bundle lives, and a row in the sidebar is
  /// findable without knowing that. Bastion splits it the same way.
  static let configuration: [SettingsPane] = [.general, .audit, .permissions, .clients, .updates]

  /// …and what was bought, which is a different question and the only reason
  /// the sidebar is in two groups rather than one list of four. Somebody opens
  /// Licence because of a refusal or a receipt, never because they are tuning
  /// something.
  static let entitlement: [SettingsPane] = [.licence]

  var title: String {
    switch self {
    case .general: "General"
    case .audit: "Activity"
    case .permissions: "Permissions"
    case .clients: "Clients"
    case .updates: "Updates"
    case .licence: "Licence"
    }
  }

  var symbol: String {
    switch self {
    case .general: "gearshape"
    case .audit: "list.bullet.rectangle"
    case .permissions: "lock.shield"
    case .clients: "puzzlepiece.extension"
    case .updates: "arrow.down.circle"
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
    contentSize: DemoSeed.isEnabled ? DemoSeed.settingsContentSize : NSSize(width: 720, height: 520),
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
    // 720 wide against the main window's 1120 leaves ~200pt of it showing on
    // each side, which is its sidebar — so Settings opens in front of the main
    // window rather than over the whole of it.
    .frame(minWidth: 680, idealWidth: 720, minHeight: 440, idealHeight: 520)
    .onAppear { model.refresh() }
    // Readiness is signalled by `PermissionsPane`, not here.
    //
    // It used to be this `.task`, which was correct until the `writes` stage
    // needed the pane SCROLLED before the shutter fired. Two tasks racing would
    // let this one win and report a screen still sitting at the top, filed as
    // the write gate — a real screen, correctly sized, showing the wrong part.
    // Signalling from the pane that does the scrolling makes the order an
    // ordering rather than a race.
    //
    // The cost is that a future stage opening a different pane would hang
    // instead of capturing. That is the right failure: appshot says "the app
    // never signalled ready" and names the stage.
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
    case .audit: AuditPane()
    case .permissions: PermissionsPane(model: model)
    case .clients: ClientsPane(model: model)
    case .updates: UpdatesPane()
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

/// The grants that have no surface.
///
/// Automation and the write toggles used to be here too, as one row per app
/// each. They moved to `SurfaceDetail` — the main window already has one pane
/// per surface, and that pane's own doc comment records these facts having once
/// been "scattered between the popover, the Permissions tab and the log filter"
/// with nothing answering "is Mail working" in one place. Keeping a second copy
/// in Settings was that scattering, still going.
///
/// What is left is the line the split is on: **a grant that cannot be expressed
/// per app.** Full Disk Access says so in its own row comment below — it is
/// indivisible. Accessibility and System Events have exactly one consumer, the
/// Mail composer, but are equally app-wide: granting them "for Mail" is not a
/// thing macOS offers, and a per-app row would imply it was.
struct PermissionsPane: View {
  let model: StatusModel

  var body: some View { form }

  private var form: some View {
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

      // Not an app-wide grant like the three above, and not a per-surface one
      // either: it is a switch inside Safari. It earns a row because it is the
      // only permission here the SERVER cannot see for itself — a disabled
      // extension leaves its last captures on disk and simply stops adding
      // more, so the store keeps answering with an ever-older page.
      Section {
        LabeledContent {
          HStack(spacing: 8) {
            if model.safariExtension == .enabled {
              Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
            // One label per state, or none, from `StatusStyle` — so this row
            // and the Safari pane's cannot drift, and neither can offer a
            // button for a state it cannot act on.
            if let label = StatusStyle.safariExtensionAction(model.safariExtension) {
              Button(label) { Permissions.openSafariExtensionSettings() }
            }
          }
        } label: {
          Text("Safari extension")
          Text(StatusStyle.safariExtensionHint(model.safariExtension, location: model.location))
        }
      } header: {
        Text("Page content")
      } footer: {
        Text(
          "Reading what a page says needs this extension, and Safari grants it one website at a "
            + "time — enabling it is not enough on its own. Everything else Safari can answer "
            + "works without it.")
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
    // Readiness is signalled from here rather than from `SettingsView`, and the
    // pane it comes from has to be the pane the stage opens: the shutter waits
    // on this file, so a signal from the window would let a capture fire before
    // the rows below have drawn. `settings` is the only Settings stage left, and
    // it opens this pane.
    form.task { DemoSeed.signalReady(from: .settings) }
  }

  private var form: some View {
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
            "Cupertino writes its own bridge path into each client's config. Re-run these after moving the app, after a new surface ships, or after you turn one off."
          )
          // The `code` command is installed separately from VS Code itself, and
          // the row is gated on the app rather than on the CLI: a false negative
          // would hide the row entirely, which is worse than a paste that says
          // "command not found" and names the thing to fix.
          Text(
            "Clients with a command keep their config in a format this app will not rewrite. Paste the command into a terminal — for Visual Studio Code that needs its \"code\" shell command installed."
          )
          // Only VS Code reaches this, and only once something is switched off.
          // It is the one client with an add verb and no removal verb, so there
          // is no command to offer — naming the file to edit beats a button that
          // would paste something that does not exist.
          if visible.contains(where: ClientWiring.needsManualRemoval) {
            Text(
              "Visual Studio Code has no command that removes a server, so a surface you turn off has to be taken out by hand — run \"MCP: List Servers\" in VS Code, or edit its mcp.json. That file is JSONC, which is why this app will not rewrite it."
            )
          }
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
  @State private var folders: [URL] = ProjectFoldersSection.remembered
  @State private var error: String?

  /// Demo mode answers from a table, like every other fact these captures show.
  static var remembered: [URL] {
    DemoSeed.isEnabled ? DemoSeed.wiredFolders : ClientWiring.rememberedFolders
  }

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
          wire: { wire(folder) },
          forget: {
            ClientWiring.forget(folder)
            folders = ProjectFoldersSection.remembered
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
    folders = ProjectFoldersSection.remembered
    wire(folder)
  }

  /// One button, one behaviour. The scope picks which file is merged into —
  /// see `ClientWiring.ProjectScope`.
  private func wire(_ folder: URL) {
    error = nil
    do { try ClientWiring.configure(folder: folder, scope: scope) } catch {
      self.error = error.localizedDescription
    }
    // Redrawn either way: a failed write leaves the row's status telling the
    // truth about the file, which is what the red line above is beside.
    folders = ProjectFoldersSection.remembered
  }
}

private struct FolderRow: View {
  let folder: URL
  let scope: ClientWiring.ProjectScope
  let wire: () -> Void
  let forget: () -> Void

  private var status: ClientWiring.Status { ClientWiring.projectStatus(folder, scope: scope) }

  var body: some View {
    LabeledContent {
      HStack(spacing: 8) {
        if status == .configured {
          Button("Reveal") { ClientWiring.reveal(folder: folder, scope: scope) }
        } else {
          Button(status == .notConfigured ? "Write" : "Update", action: wire)
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
  @State private var removed = false

  /// Shared by the two copy buttons so their two-second resets cannot drift.
  private func copy(_ text: String, into flag: Binding<Bool>) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    flag.wrappedValue = true
    // Confirmation, not a permanent state: the button has to invite a second
    // copy after the app has moved and the paths changed.
    Task {
      try? await Task.sleep(for: .seconds(2))
      flag.wrappedValue = false
    }
  }

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
    case .extra(let leftover): "still wired for \(leftover.joined(separator: ", "))"
    case .unreadable(let why): why
    default: nil
    }
  }

  @ViewBuilder private var action: some View {
    if case .unreadable = status {
      EmptyView()
    } else {
      switch client.wiring {
      // Not edited automatically on purpose: these files are JSONC or TOML, and
      // re-serialising either would delete comments somebody wrote by hand. See
      // `ClientWiring.Wiring`.
      case .command:
        HStack {
          // Its own button, never appended to the adds: a remove for a name
          // that was never there exits non-zero, and deletion is the half worth
          // reading first. See `ClientWiring.removalCommands`.
          if let removals = ClientWiring.removalCommands(for: client) {
            Button(removed ? "Copied" : "Copy removal") { copy(removals, into: $removed) }
          }
          Button(copied ? "Copied" : "Copy command") {
            guard let commands = ClientWiring.commands(for: client) else { return }
            copy(commands, into: $copied)
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
          // Wired before a surface existed. Configure writes every surface that
          // is switched on, so the same button finishes the job.
          Button("Update") { configure() }
        case .extra:
          // Still holds a server for a surface that has since been switched off.
          // The same write that adds the missing ones prunes these.
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
    guard !surface.usesAppleEvents else { return caption(status) }
    // Reading "reads only" off usesAppleEvents held for every surface until Maps,
    // which writes SQL into its Core Data store and still sends no Apple Event.
    // The grant is equally not needed either way — only the reason differs, and
    // the read-only half of it is now false for exactly one surface.
    return surface.supportsWrites
      ? "not needed — this surface never scripts the app"
      : "not needed — this surface reads only"
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

  /// What the Safari extension row says under its name.
  ///
  /// `notInstalled` gets its own sentence rather than being folded into
  /// "off": on a Debug build the appex is stripped, so that is the correct
  /// answer, and telling someone to enable a thing that is not there is how a
  /// permission row wastes ten minutes.
  ///
  /// It takes the install location because that sentence was only ever true of
  /// a Debug build, and it was shown to everyone. In a RELEASE build the same
  /// state has a different cause and a different fix: Safari will not list an
  /// extension whose container is translocated or living outside
  /// `/Applications`, which `InstallLocation` already knows and no other row
  /// was asking it about.
  static func safariExtensionHint(
    _ status: SafariExtensionStatus, location: InstallLocation
  ) -> String {
    switch status {
    case .enabled:
      "enabled — allow it per website from Safari's toolbar"
    case .disabled:
      "switched off in Safari"
    case .notInstalled:
      #if DEBUG
        "not in this build — a locally built app ships no extension"
      #else
        location.isInApplications
          ? "Safari has no record of it yet. Open Safari, then check Settings ▸ Extensions."
          : "Safari cannot see it from where this app is running — move Cupertino to Applications and open it from there."
      #endif
    case .unknown:
      "could not be read"
    }
  }

  /// The button beside that row, or none.
  ///
  /// Same shape as `actionLabel` above, and for the same reason it was written:
  /// this row used to offer "Open Safari…" for every state that was not
  /// enabled, which made a provably dead button. On a Debug build the appex is
  /// stripped, so `notInstalled` is the normal answer and Safari has nothing to
  /// show; `unknown` means the question failed, which sending someone to Safari
  /// does not answer either.
  ///
  /// `enabled` DOES get one, which is the case that looks least like it needs
  /// it. The switch being on is only half the setup — Safari asks per website —
  /// and the pane that grants that is the pane this opens.
  static func safariExtensionAction(_ status: SafariExtensionStatus) -> String? {
    switch status {
    case .enabled, .disabled: "Open Safari…"
    case .notInstalled, .unknown: nil
    }
  }

  static func accessibilityHint(_ status: AccessibilityStatus) -> String {
    switch status {
    // Deliberately narrower than it was. This checks the app; the composer is
    // what the user cares about, and a green row has been measured beside a
    // composer the servers could not reach — several stale entries under one
    // bundle identifier, each check matching a different one. Promising the
    // composer here is what made that failure so hard to place.
    case .granted: "Granted to Cupertino. Replies also need it to reach the servers — check diagnostics."
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

/// The update controls.
///
/// A pane rather than the Section in General it used to be — see
/// `SettingsPane.configuration` for why. What the version number gave it by
/// being directly above, it now carries itself: the first row says which build
/// this is, from the same `AppInfo.version` General reads, so the pane answers
/// "am I current" without sending anybody back a page.
///
/// Cupertino is the only thing in this app that can reach the internet, so the
/// caption says what the check sends in plain terms rather than leaving it to
/// the privacy policy. See docs/licensing.md.
struct UpdatesPane: View {
  @State private var automatic = UpdateController.shared.automatic
  private var updates = UpdateController.shared

  var body: some View {
    Form {
      Section {
        LabeledContent("Version", value: AppInfo.version)

        // The row's whole label is the answer to "am I current", because a row
        // titled the same thing as the button beside it says nothing twice.
        LabeledContent {
          Button("Check Now…") { updates.checkNow() }
            .disabled(updates.isChecking)
        } label: {
          Text(lastCheck)
        }
      }

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
    .formStyle(.grouped)
  }

  /// A sentence either way. The row previously showed nothing at all before the
  /// first check, which reads as a missing value rather than as the answer.
  private var lastCheck: String {
    guard let last = updates.lastCheck else { return "Not checked yet" }
    return "Last checked \(last.formatted(.relative(presentation: .named)))"
  }
}

/// Everything about what Cupertino records.
///
/// A pane of its own because these settings had outgrown a `Section` in
/// General: what the live log keeps, whether any of it survives a quit, and —
/// once it does — how long it is kept, whether it carries the text of your
/// mail, and how it leaves the machine.
///
/// The per-surface override stays on the surface, beside its write gate. This
/// pane is the default; a surface is the exception to it.
private struct AuditPane: View {
  @AppStorage(SurfaceSettings.appCaptureKey) private var capture = CallCapture.defaultMode.rawValue
  @AppStorage(SurfaceSettings.appContentKey) private var content = false
  @AppStorage(AuditLog.enabledKey) private var keepFile = false
  @AppStorage(AuditLog.payloadsKey) private var filePayloads = false
  @AppStorage(AuditLog.contentKey) private var fileContent = false
  @AppStorage(AuditLog.maxDaysKey) private var maxDays = AuditLog.defaultMaxDays
  @AppStorage(AuditLog.maxMegabytesKey) private var maxMegabytes = AuditLog.defaultMaxMegabytes

  @State private var summary: AuditLog.Summary?
  @State private var note: String?
  @State private var fingerprint = AuditSigning.currentFingerprint()
  @State private var copied = false

  var body: some View {
    Form {
      Section {
        Picker("Record", selection: $capture) {
          ForEach(CallCapture.Mode.allCases, id: \.self) { mode in
            Text(mode.label).tag(mode.rawValue)
          }
        }
        Text(
          "What every surface records unless it says otherwise. The Activity window keeps this in "
            + "memory.")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)

        Toggle(isOn: $content) {
          Text("Include message contents")
          Text(
            "Off. A mail body, a message and a note's text arrive as arguments here, so they are "
              + "blanked by default and what is left is the structure — which tool, which "
              + "mailbox, which recipient.")
        }
      } header: {
        Text("What is recorded")
      }

      Section {
        Toggle("Keep an audit log on disk", isOn: $keepFile)
        Text(
          keepFile
            ? "Records survive a quit, in \(AuditLog.directory.path), readable only by you."
            : "Off. The Activity window is a ring in memory and nothing outlives the app.")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)

        Toggle("Include arguments and results in the file", isOn: $filePayloads)
          .disabled(!keepFile)

        // The third act, and the only toggle in this app with a warning on it.
        // Getting somebody's mail onto disk should take three deliberate
        // switches, not one — and the last of them should say what it does.
        Toggle(isOn: $fileContent) {
          Text("…including message contents")
          Text(
            fileContent
              ? "⚠ Mail bodies, message text and note contents are written to a file on disk, "
                + "unencrypted. FileVault is what protects it at rest."
              : "Off. Even with contents shown in the window above, the file keeps only the "
                + "structure. Turning this on is a separate decision from showing them on screen.")
        }
        .disabled(!keepFile || !filePayloads || !content)

        LabeledContent("Keep for") {
          Stepper("\(maxDays) days", value: $maxDays, in: 1...365)
        }
        LabeledContent("At most") {
          Stepper("\(maxMegabytes) MB", value: $maxMegabytes, in: 5...5000, step: 5)
        }
        Text(
          "Whichever runs out first. The log is written in segments and a whole segment is "
            + "dropped at a time — a chain cannot lose a record from the middle and still verify.")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      } header: {
        Text("On disk")
      }

      Section {
        HStack {
          Button("Verify") { verify() }
          Button("Export…") { export() }
          Button("Delete the log") { erase() }
            .disabled((summary?.records ?? 0) == 0)
          Spacer()
        }
        if let summary {
          Text(
            summary.report.isIntact
              ? "\(summary.records) records across \(summary.segments) "
                + "segment\(summary.segments == 1 ? "" : "s"), \(bytes(summary.bytes)). "
                + "The chain verifies."
              : "\(summary.records) records, and the chain does NOT verify: "
                + describe(summary.report.failures))
            .font(.caption)
            .foregroundStyle(summary.report.isIntact ? Color.secondary : .red)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let note {
          Text(note).font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Text(
          "Each record carries a hash of the one before it, so an edited field, a deleted record "
            + "or a truncated file can be detected. That is the whole claim: it catches tampering "
            + "by something that does not know it is a chain. It is not proof against anyone who "
            + "can write the file, because they can recompute it.")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      } header: {
        Text("The chain")
      }

      Section {
        if let fingerprint {
          LabeledContent {
            Button {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString((try? AuditSigning.publicKey()) ?? "", forType: .string)
              copied = true
            } label: {
              Image(systemName: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help("Copy the full public key")
            .task(id: copied) {
              guard copied else { return }
              try? await Task.sleep(for: .seconds(2))
              copied = false
            }
          } label: {
            Text(fingerprint).font(.system(.body, design: .monospaced))
            Text("This Mac's export key")
          }
        } else {
          Text("No key yet — one is made the first time you sign an export.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Text(
          "Signing an export proves it came from this Mac and has not been altered since. It "
            + "does not prove the log was not curated before it was signed — you control this "
            + "machine. And it only means anything to someone who already has the key above, "
            + "sent to them some other way: a key that travels only inside the export proves "
            + "nothing, because a forger would include their own.")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Text(
          "A new Mac makes a new key. Exports already signed keep verifying against the old one.")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      } header: {
        Text("Signing")
      }
    }
    .formStyle(.grouped)
    .onAppear { summary = AuditLog.verifyAll() }
  }

  private func verify() {
    summary = AuditLog.verifyAll()
    note = nil
  }

  private func export() {
    guard let outcome = AuditExport.run() else { return }
    note = outcome.note
    if let written = outcome.summary { summary = written }
    fingerprint = AuditSigning.currentFingerprint()
  }

  private func erase() {
    AuditLog.shared.clear()
    summary = AuditLog.verifyAll()
    note = "The log on disk is gone."
  }

  private func bytes(_ count: Int) -> String {
    count < 1024 * 1024
      ? "\(count / 1024) KB" : String(format: "%.1f MB", Double(count) / 1024 / 1024)
  }

  /// Say what broke, not just that something did — a verifier that reports
  /// "invalid" and stops is a verifier nobody can act on.
  private func describe(_ failures: [AuditChain.Failure]) -> String {
    guard let first = failures.first else { return "no detail" }
    let rest = failures.count > 1 ? " (and \(failures.count - 1) more)" : ""
    switch first {
    case .unreadable(let line): return "line \(line) is not a record\(rest)"
    case .unknownVersion(let line, let version):
      return "line \(line) is format \(version), which this build cannot check\(rest)"
    case .brokenHash(let seq): return "record \(seq) was edited\(rest)"
    case .brokenLink(let seq): return "a record before \(seq) was removed\(rest)"
    case .outOfOrder(let seq): return "record \(seq) is out of sequence\(rest)"
    }
  }

}

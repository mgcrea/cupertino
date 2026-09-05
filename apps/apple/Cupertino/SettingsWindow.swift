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
  static let configuration: [SettingsPane] = [.general, .audit, .permissions, .updates]

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
    case .updates: "Updates"
    case .licence: "Licence"
    }
  }

  var symbol: String {
    switch self {
    case .general: "gearshape"
    case .audit: "list.bullet.rectangle"
    case .permissions: "lock.shield"
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
    contentSize: DemoSeed.isEnabled
      ? DemoSeed.settingsContentSize : NSSize(width: 720, height: 520),
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
  @AppStorage(SurfaceSettings.appLazyToolsKey) private var lazyTools = false

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
        Toggle(isOn: $lazyTools) {
          Text("Load tools on demand")
          Text(
            "Serve a search tool and a dispatcher instead of listing every tool up front. "
              + "Cuts what a client reads on connect by about four fifths, at the cost of a "
              + "coarser permission prompt: your client asks once per surface for reads and "
              + "once for writes, rather than naming each tool. Leave it off for Claude Code "
              + "and Claude Desktop, which already load tool schemas only when they are needed."
          )
        }
      } header: {
        Text("Context")
      } footer: {
        Text("Applies the next time a client connects. Each surface can override this.")
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
    // Scripted only to write, and writes are off — so nothing will send an
    // event and nothing will ask for the grant. Reporting "not yet asked" here
    // was true and useless: it nagged for a permission that turning one switch
    // on is the only way to ever spend.
    if surface.appleEventsScope == .writes, !SurfaceSettings.allowWrites(surface) {
      return "not needed — writes are off"
    }
    guard !surface.usesAppleEvents else { return caption(status) }
    // A capability has no app behind it, so "reads only" would explain the
    // wrong thing: the grant is not declined here, there is simply nothing to
    // automate.
    if surface.kind == .capability { return "not needed — there is no app to script" }
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

  /// The aggregate glyph and tint — what the popover, the sidebar row and the
  /// sidebar footer all paint now.
  ///
  /// Here rather than on `SurfaceHealth` itself for the reason this whole enum
  /// exists: one place decides what green means, so the three renderers cannot
  /// drift. `SurfaceHealth` is the verdict; these are how it looks.
  static func healthIcon(_ health: SurfaceHealth) -> String {
    switch health {
    case .ready: "checkmark.circle.fill"
    // A triangle rather than a cross. A cross reads as broken, and this state
    // is "one step left" — the button beside it is the step.
    case .needsSetup: "exclamationmark.triangle.fill"
    case .fault: "xmark.octagon.fill"
    }
  }

  static func healthTint(_ health: SurfaceHealth) -> Color {
    switch health {
    case .ready: .green
    case .needsSetup: .orange
    case .fault: .red
    }
  }

  /// The dot beside a client, in the sidebar and at the top of its pane.
  ///
  /// Here rather than on `ClientWiring` for the reason every other glyph in this
  /// enum is here: one place decides what green, orange and red mean in this
  /// app, and a client that reads amber in the sidebar and red in its own header
  /// is a small bug that reads as a big one.
  ///
  /// `.extra` is amber and not green, which is the one debatable call: nothing is
  /// broken, and the entry only costs an assistant definitions it will never
  /// use. It is amber because it is the state a button can finish, and grey
  /// would file it with "nothing to do here".
  static func clientTint(_ status: ClientWiring.Status) -> Color {
    switch status {
    case .configured: .green
    case .incomplete, .extra: .orange
    case .stale, .unreadable: .red
    // Grey covers two different absences on purpose. Neither is a fault, and
    // neither is something this app can fix without being asked.
    case .notInstalled, .notConfigured: .secondary
    }
  }

  /// The AUTOMATION glyph, which is now one input to the aggregate above rather
  /// than the whole verdict. Still drawn on its own by the Access card, whose
  /// job is the per-grant breakdown.
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
    case .granted:
      "Granted to Cupertino. Replies also need it to reach the servers — check diagnostics."
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
            + "memory."
        )
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

        Toggle(isOn: $content) {
          Text("Include contents")
          // The result half was missing here too. Examples kept, because they
          // ground an abstract sentence — but they are examples of the argument
          // half only, and a surface with no prose in its arguments (Screen)
          // still has its return value withheld.
          Text(
            "Off. What a tool returns is logged as «redacted», and prose in its arguments — a "
              + "mail body, a message, a note's text — is blanked. What is left is the "
              + "structure: which tool, which mailbox, which recipient.")
        }
      } header: {
        Text("What is recorded")
      }

      Section {
        Toggle("Keep an audit log on disk", isOn: $keepFile)
        Text(
          keepFile
            ? "Records survive a quit, in \(AuditLog.directory.path), readable only by you."
            : "Off. The Activity window is a ring in memory and nothing outlives the app."
        )
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
            + "dropped at a time — a chain cannot lose a record from the middle and still verify."
        )
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
                + describe(summary.report.failures)
          )
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
            + "can write the file, because they can recompute it."
        )
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
              NSPasteboard.general.setString(
                (try? AuditSigning.publicKey()) ?? "", forType: .string)
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
            + "nothing, because a forger would include their own."
        )
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        Text(
          "A new Mac makes a new key. Exports already signed keep verifying against the old one."
        )
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

import AppKit
import SwiftUI

/// One surface, in full: what it can reach, what it may write, what it is doing.
///
/// These facts existed before this pane did — scattered between the popover, the
/// Permissions tab and the log filter — and none of them answered "is Mail
/// working" in one place. Making a surface a destination rather than a filter is
/// also what gives Messages and Safari somewhere to land.
///
/// **Store readability is per surface. Full Disk Access is not.** `Permissions`
/// says so at the top of `DiskAccessStatus`: one grant covers the whole app, and
/// reporting it per surface "would imply a containment that does not exist". So
/// this pane reports whether *this* store can be read, which is a real per-surface
/// fact, and leaves the grant itself to the sidebar footer. Do not merge them.
struct SurfaceDetail: View {
  let surface: Surface
  let model: StatusModel

  @State private var store: StoreStatus = .checking
  /// The TCC service this surface's store sits behind. Resolved in `.task`, not
  /// read inline: a view body runs often and this is a fact about the machine,
  /// not about the render.
  ///
  /// Its own state rather than `model.grants`, because that table covers the
  /// ENABLED surfaces only and this pane reports an off surface too.
  @State private var grant: StoreGrant?
  /// Safari only. `nil` until the first probe returns, so the card can say
  /// "Looking…" rather than "nothing captured" at a directory it has not read.
  @State private var captures: SafariCaptures?
  @State private var showSetup = false
  /// Its own copy of the key `SurfaceSwitch` writes, so this pane re-lays out
  /// the moment the switch moves. Same reason `CapabilitiesCard` keeps one for
  /// the write flag.
  @AppStorage private var enabled: Bool

  init(surface: Surface, model: StatusModel) {
    self.surface = surface
    self.model = model
    _enabled = AppStorage(wrappedValue: surface.defaultEnabled, SurfaceSettings.enabledKey(surface))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        heading
        if enabled {
          accessSection
          // No Store card for a capability. It has no store, and the empty-state
          // copy under it says "everything goes through Apple Events", which is
          // false twice over here: this surface has no file lane AND sends no
          // Apple Event. A card that can only lie is better absent.
          if surface.kind == .app { storeSection }
          pageContentSection
          CapabilitiesCard(surface: surface)
          activity
        } else {
          offSection
          // Kept, and live. A fact about this Mac rather than about the server —
          // it costs a `stat` and an `access(2)`, and it is the only card that
          // answers "would this work if I turned it back on", which may well be
          // the question that follows.
          if surface.kind == .app { storeSection }
          pageContentSection
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task(id: surface.id) {
      await resolveStore()
      await resolveExtension()
      grant =
        DemoSeed.isEnabled
        ? DemoSeed.storeGrant
        : Permissions.storeGrant(for: surface, diskAccess: model.diskAccess)
    }
  }

  /// The icon is the system's, fetched at runtime — see `SurfaceIcon`. It also
  /// answers a question the bundle id underneath it cannot: whether the app it
  /// names is actually installed.
  private var heading: some View {
    HStack(spacing: 12) {
      SurfaceIconView(surface: surface, size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(surface.displayName).font(.title2)
        // A surface with no bundle id is not an app. Saying so is better than
        // an empty line where every other surface shows an identifier — the
        // subtitle's job is to name what is being brokered.
        if let bundleID = surface.bundleID {
          Text(bundleID)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
        } else {
          Text("A system capability, not an app")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer()
      // In the heading rather than inside Access, because it gates every card
      // below it — including Access itself. A control that can remove the card
      // it sits in belongs above that card.
      SurfaceSwitch(surface: surface, style: .inline, model: model)
    }
  }

  /// What is true of a surface that is switched off, and nothing that is not.
  ///
  /// Access and Capabilities are deliberately absent rather than disabled.
  /// Access would offer an automation button that fires a real TCC consent
  /// dialog for a server that can never start — the exact dead end two buttons
  /// were already removed for (see `accessSection`) — and `CapabilitiesCard`
  /// spawns the real server with an 8s deadline, which would be the app visibly
  /// starting the thing it has just been told not to. The absence IS the
  /// demonstration, the same way a shorter tool list demonstrates writes-off.
  private var offSection: some View {
    Card("Off") {
      Text(
        "Cupertino is not serving \(surface.displayName). A client asking for it is refused at "
          + "the bridge, so no server starts and nothing from this surface reaches your assistant."
      )
      .font(.callout)
      .fixedSize(horizontal: false, vertical: true)

      if let first = leftoverClients.first {
        Divider()
        HStack {
          Text(
            "\(leftoverClients.count) client\(leftoverClients.count == 1 ? "" : "s") still list "
              + "this server."
          )
          .font(.callout)
          Spacer()
          // Straight to the pane that can fix it, rather than to a list of every
          // client. When more than one is behind, the first is as good a place to
          // start as any and the sidebar shows the rest with their dots already
          // amber.
          Button(
            leftoverClients.count == 1 ? "Update \(first.displayName)…" : "Update clients…"
          ) {
            MainWindowController.show(.client(first.id))
          }
          .buttonStyle(.glass)
          .controlSize(.small)
        }
      }
    }
  }

  /// Configured clients whose config still holds this surface's key.
  ///
  /// Read off the statuses `StatusModel` already computes, which is the same
  /// verdict each client's own pane reaches from the same file — so this row and
  /// the dot it sends you to cannot disagree about whether there is anything
  /// left to do. The clients themselves rather than a count, because the button
  /// beside this now names one.
  private var leftoverClients: [ClientWiring.Client] {
    ClientWiring.clients.filter { client in
      if case .extra(let leftover) = model.clients[client] {
        return leftover.contains(surface.displayName)
      }
      return false
    }
  }

  /// What the grant gating this store is called, in the words System Settings
  /// uses — this row sends someone to a named pane and has to match it.
  private var grantName: String {
    switch surface.storePermission {
    case .fullDiskAccess: "Full Disk Access"
    case .contacts: "Contacts"
    case .screenRecording: "Screen Recording"
    case .microphone: "Microphone"
    case .accessibility: "Accessibility"
    }
  }

  /// What breaks without it, per surface. Screen refuses outright; Contacts
  /// still has an Apple Events lane for writes, so "every tool" would be false.
  /// "Ask…" when a prompt is what the button raises, "Allow…" when it opens a
  /// pane.
  ///
  /// This used to be the literal "Allow…" for every state, which made the
  /// microphone row promise the wrong thing in both directions: it said
  /// "Allow…" over a button that raised the system prompt, and it went on
  /// saying it once the answer was `denied` and the pane was the only route —
  /// while the same row in the menu-bar popover said "Ask…". Two renderings of
  /// one verdict, drifting. `SurfaceStatus.action` is the other half.
  private var grantActionLabel: String {
    surface.storePermission == .microphone && Permissions.microphone() == .notDetermined
      ? "Ask…" : "Allow…"
  }

  private var grantFailureHint: String {
    switch surface.storePermission {
    case .fullDiskAccess: "not granted"
    case .contacts: "not granted — reads will find nothing"
    case .screenRecording: "not granted — every capture will refuse"
    // Only recording refuses. Devices and volume need no grant at all, which is
    // the whole shape of this surface and would be misreported by "every tool".
    case .microphone: "not granted — recording will refuse, devices and volume still work"
    case .accessibility: "not granted — every read and every press will refuse"
    }
  }

  private var accessSection: some View {
    Card("Access") {
      HStack {
        Image(systemName: StatusStyle.automationIcon(surface, model.automation[surface.id]))
          .foregroundStyle(StatusStyle.automationTint(surface, model.automation[surface.id]))
        Text("Automation")
        Spacer()
        Text(StatusStyle.automationCaption(surface, model.automation[surface.id]))
          .foregroundStyle(.secondary)
        // One label and one destination per state, from `StatusStyle`, so this
        // row cannot drift from the popover and the Permissions pane.
        //
        // This used to hardcode "Allow…" for every state that was not granted,
        // which made two provably dead buttons: `.denied` cannot be
        // re-prompted at all, and `.appNotRunning` re-ran a call that returns
        // `procNotFound` until the app is opened.
        if surface.usesAppleEvents,
          let label = StatusStyle.actionLabel(model.automation[surface.id])
        {
          Button(label) {
            if model.automation[surface.id] == .denied {
              Permissions.openAutomationSettings()
            } else {
              model.requestAutomation(surface)
            }
          }
          .buttonStyle(.glass)
          .controlSize(.small)
        }
      }
      .font(.callout)

      // The grant this surface actually runs on. Without it the row above can
      // say "not needed" and nothing else on the pane mentions a permission at
      // all, so the surface reads as ready when every tool will refuse.
      //
      // Driven by `storePermission` rather than special-cased to Screen
      // Recording, which is how Contacts had gone since it shipped without a
      // row for the one grant it runs on — it declared its own TCC service and
      // nothing in the app ever probed it. The `microphone` case docs/sound.md
      // anticipates gets a row here for free.
      //
      // Full Disk Access is the deliberate exception: it is app-wide, and
      // `SurfaceDetail`'s own doc comment says not to report it per surface —
      // the Store card below reports what IS per surface, whether this store
      // opens.
      if surface.storePermission != .fullDiskAccess {
        Divider()
        HStack {
          let granted = grant == .granted
          Image(systemName: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
            .foregroundStyle(granted ? Color.green : Color.orange)
          Text(grantName)
          Spacer()
          Text(grant == nil ? "checking…" : (granted ? "granted" : grantFailureHint))
            .foregroundStyle(.secondary)
          // The pane, never the request call. `CGRequestScreenCaptureAccess`
          // prompts once and returns silently ever after — a button that works
          // one time is the dead end the Automation row was already fixed for.
          if grant == .missing {
            Button(grantActionLabel) {
              switch surface.storePermission {
              case .contacts: Permissions.openContactsSettings()
              case .screenRecording: Permissions.openScreenRecordingSettings()
              case .fullDiskAccess: Permissions.openDiskAccessSettings()
              // requestAccessibility() first, so the app is LISTED in the pane.
              // Permissions.swift:615: an app that has never asked is simply
              // absent from that list, and the `+` and file picker is the part
              // people get stuck on.
              case .accessibility:
                Permissions.requestAccessibility()
                Permissions.openAccessibilitySettings()
              // The microphone is the one grant whose prompt is still live
              // while nobody has been asked, so the comment above does not
              // apply to it — see SurfaceStatus.action.
              case .microphone:
                if Permissions.microphone() == .notDetermined {
                  Task {
                    await model.requestMicrophone(surface)
                    grant = Permissions.storeGrant(for: surface, diskAccess: model.diskAccess)
                  }
                } else {
                  Permissions.openMicrophoneSettings()
                }
              }
            }
            .buttonStyle(.glass)
            .controlSize(.small)
          }
        }
        .font(.callout)
        if grant == .missing, surface.storePermission == .screenRecording {
          Text("Takes effect when Cupertino relaunches, not when the switch is flipped.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      if surface.supportsWrites {
        Divider()

        // Safety, not licensing. docs/licensing.md rules out gating writes behind
        // the licence, and this toggle behaves identically either way.
        WritesToggle(surface: surface, model: model)
          .padding(.leading, 0)
      }

      // Separate from the write gate above, and deliberately below it so the
      // two read as two decisions rather than one. A gate is not a write, and
      // neither implies the other.
      if !surface.gates.isEmpty {
        Divider()
        ForEach(surface.gates) { gate in
          GateToggle(surface: surface, gate: gate)
        }
      }

      Divider()
      LazyToolsControl(surface: surface)
    }
  }

  private var storeSection: some View {
    Card("Store") {
      switch store {
      case .checking:
        Text("Looking…").font(.callout).foregroundStyle(.secondary)
      case .missing:
        Text(
          surface.storePath == nil
            ? "This surface has no file lane; everything goes through Apple Events."
            : "Nothing to read on this Mac yet."
        )
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      case .found(let path, let readable):
        HStack(alignment: .firstTextBaseline) {
          Image(systemName: readable ? "checkmark.circle.fill" : "lock.circle.fill")
            .foregroundStyle(readable ? Color.green : Color.orange)
          Text(readable ? "Readable" : "Present, but not readable")
            .font(.callout)
          Spacer()
          Button("Reveal") {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
          }
          .buttonStyle(.glass)
          .controlSize(.small)
        }
        Text(path)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
        if !readable {
          // The exists-vs-readable split is the whole shape of a TCC failure:
          // `stat` succeeds on a protected file and only `open`/`access` are
          // denied, so "present" here is not reassurance.
          Text("Full Disk Access is what turns this into a readable file.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  /// Safari's THIRD lane, which nothing else in this window reports.
  ///
  /// The other two cards above are the other two: `accessSection` is the Apple
  /// Events lane and `storeSection` is the file lane. `surfaces.json` calls
  /// Safari "the only surface whose two lanes are NOT fallbacks for each
  /// other", and the extension is a third that overlaps neither — it is the
  /// only route to what a page SAYS, and `apple_safari_read_page` is the only
  /// tool behind it.
  ///
  /// It is here rather than only in Settings because it is the one
  /// permission-like fact **the server cannot measure for itself**. A disabled
  /// extension leaves its last captures on disk and stops adding more, so
  /// `apple_safari_diagnostics` goes on reporting a healthy store that answers
  /// with an ever-older page. Only Safari knows the switch is off, and only the
  /// containing app may ask it — `packages/safari/src/client/pages.ts` says as
  /// much at the point where it gives up on knowing.
  @ViewBuilder private var pageContentSection: some View {
    if surface.id == Permissions.safariSurfaceID {
      Card("Page content") {
        let status = model.safariExtension
        HStack(alignment: .firstTextBaseline) {
          Image(systemName: Self.extensionIcon(status))
            .foregroundStyle(Self.extensionTint(status))
          VStack(alignment: .leading, spacing: 2) {
            Text(Self.extensionLabel(status))
            Text(StatusStyle.safariExtensionHint(status, location: model.location))
              .font(.caption)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer()
          // Suppressed while the surface is off, for the reason `offSection`
          // gives: no server can start, so enabling the extension changes
          // nothing that can be observed. The STATE stays visible because it is
          // a fact about this Mac, which is the same argument that keeps
          // `storeSection` on an off surface.
          if enabled, let label = StatusStyle.safariExtensionAction(status) {
            Button(label) { Permissions.openSafariExtensionSettings() }
              .buttonStyle(.glass)
              .controlSize(.small)
          }
        }
        .font(.callout)

        if status == .enabled {
          Divider()
          capturesLine
        }

        if enabled, status == .enabled || status == .disabled {
          Divider()
          setupDisclosure
        }
      }
    }
  }

  /// What the switch being on has actually produced.
  ///
  /// The line that makes this card worth more than the Settings row it
  /// duplicates. Safari grants the extension one website at a time, so
  /// "enabled" and "allowed nowhere" render identically up there — and the
  /// second is the state people are actually in after following the
  /// instructions halfway.
  private var capturesLine: some View {
    Group {
      switch captures {
      case nil:
        Text("Looking…").foregroundStyle(.secondary)
      case .some(let seen) where seen.count == 0:
        Text("Nothing captured yet. Safari asks per website, and none has been allowed.")
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      case .some(let seen):
        VStack(alignment: .leading, spacing: 2) {
          Text(
            "\(seen.count) page\(seen.count == 1 ? "" : "s") captured"
              + (seen.newestAge.map { " · newest \(Self.age($0))" } ?? ""))
          if seen.isQuiet {
            // Says the captures are old and deliberately not why — switched
            // off, or allowed on no site visited since, cannot be told apart
            // from a directory listing. Same restraint
            // `apple_safari_diagnostics` applies to the same measurement.
            Text("Nothing recent. They are kept for 30 minutes, so this lane has gone quiet.")
              .font(.caption)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
    .font(.callout)
    .monospacedDigit()
  }

  /// The half of the setup that is not a switch.
  ///
  /// Two steps, because the second is the one that gets missed: Settings
  /// already says in prose that "enabling it is not enough on its own", and
  /// prose in another window is not where somebody stuck is looking. Collapsed
  /// once the extension is on, open while it is off.
  private var setupDisclosure: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Setting it up").font(.callout)
        Spacer()
        Button(showSetup ? "Hide" : "Show") { withAnimation(.snappy) { showSetup.toggle() } }
          .buttonStyle(.glass)
          .controlSize(.small)
      }
      if showSetup {
        VStack(alignment: .leading, spacing: 4) {
          Text("1. Safari ▸ Settings ▸ Extensions, and tick Cupertino.")
          Text(
            "2. On a site you want it to read, click Cupertino in Safari's toolbar and choose "
              + "Always Allow on This Website.")
          Text(
            "Step 2 is per website and there is no way to grant it for all of them — which is "
              + "the point. The alternative macOS offers, \"Allow JavaScript from Apple Events\", "
              + "is one switch that opens every tab to every app that can send an Apple Event."
          )
          .foregroundStyle(.secondary)
        }
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
      }
    }
    .onAppear { showSetup = model.safariExtension == .disabled }
  }

  private static func extensionIcon(_ status: SafariExtensionStatus) -> String {
    switch status {
    case .enabled: "checkmark.circle.fill"
    case .disabled: "lock.circle.fill"
    // The same glyph `SurfaceIconView` falls back to for an app that is not on
    // this Mac, because it is the same shape of fact.
    case .notInstalled: "app.dashed"
    case .unknown: "questionmark.circle"
    }
  }

  private static func extensionTint(_ status: SafariExtensionStatus) -> Color {
    switch status {
    case .enabled: .green
    case .disabled: .orange
    case .notInstalled, .unknown: .secondary
    }
  }

  private static func extensionLabel(_ status: SafariExtensionStatus) -> String {
    switch status {
    case .enabled: "Extension enabled"
    case .disabled: "Extension off"
    case .notInstalled: "Extension not installed"
    case .unknown: "Extension state unknown"
    }
  }

  /// Coarse on purpose. This is a freshness cue, and a capture that landed 97
  /// seconds ago is "a minute ago" for every decision anyone makes from it.
  private static func age(_ seconds: TimeInterval) -> String {
    let minutes = Int(seconds / 60)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes) min ago" }
    let hours = minutes / 60
    return hours < 24 ? "\(hours)h ago" : "\(hours / 24)d ago"
  }

  private var activity: some View {
    Card("Activity") {
      let live = Sessions.shared.live.filter { $0.surface == surface.id }
      let calls = live.reduce(0) { $0 + $1.calls }
      HStack {
        Text(live.isEmpty ? "No client connected." : "\(live.count) connected")
        Spacer()
        if !live.isEmpty {
          Text("\(calls) call\(calls == 1 ? "" : "s")")
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
      }
      .font(.callout)

      ForEach(live) { session in
        HStack {
          Text(session.client ?? "connecting…")
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer()
          Text("pid \(session.pid)").foregroundStyle(.secondary).monospacedDigit()
        }
        .font(.system(.caption, design: .monospaced))
      }

      Divider()
      CaptureControls(surface: surface)
    }
  }

  /// Re-ask Safari, and count what the extension has written.
  ///
  /// On every visit to the pane rather than once per window, because this is
  /// the one status here that someone is expected to change in another app and
  /// come straight back to check. `model.refresh()` fires from three
  /// `.onAppear`s and none of them is this pane.
  ///
  /// Both halves are off the main actor. The first is an IPC to Safari and the
  /// second reads a directory — the rule `StatusModel.refreshAutomation`
  /// documents with a measured run-loop freeze applies to both.
  private func resolveExtension() async {
    guard surface.id == Permissions.safariSurfaceID else { return }
    guard !DemoSeed.isEnabled else {
      captures = DemoSeed.safariCaptures
      return
    }
    model.refreshSafariExtension()
    captures = await Task.detached(priority: .userInitiated) { Permissions.safariCaptures() }.value
  }

  /// Off the main actor: resolving Mail's store walks up to nineteen candidate
  /// paths, and this runs again every time the selection changes.
  private func resolveStore() async {
    // Isolation, not cosmetics. The real path is absolute and rooted at the
    // capturing Mac's home directory, so the honest version of this row puts
    // `/Users/<whoever built this>/…` into the marketing site and the README.
    if DemoSeed.isEnabled {
      store = DemoSeed.storePath(for: surface).map { .found(path: $0, readable: true) } ?? .missing
      return
    }
    let surface = surface
    let resolved: StoreStatus = await Task.detached(priority: .userInitiated) {
      guard let path = Permissions.resolveStore(surface) else { return StoreStatus.missing }
      return .found(path: path, readable: access(path, R_OK) == 0)
    }.value
    store = resolved
  }
}

/// What this surface's server exposes, read from the server rather than listed
/// here — see `SurfaceCatalog` for why nothing is written down.
///
/// It reads its own `@AppStorage` copy of the write flag, the same key
/// `WritesToggle` writes, and re-probes when it changes. That is the feature,
/// not an implementation detail: the app has always claimed writes-off means
/// the mutating tools are never registered rather than refused later, and until
/// now that claim was a sentence in Settings with no way to check it. Flip the
/// toggle above and watch the list change.
struct CapabilitiesCard: View {
  private let surface: Surface
  @AppStorage private var allowWrites: Bool
  @State private var state: LoadState = .loading
  @State private var expanded = false
  /// The gates currently on, re-read whenever any default changes.
  ///
  /// Not `@AppStorage`: there can be any number of gates and their keys are
  /// only known at runtime, so there is no fixed property to bind. Watching
  /// `didChangeNotification` covers all of them at once and costs nothing —
  /// `GateToggle` writes the key, this recomputes, and `.task(id:)` re-probes.
  @State private var gates: [String] = []

  init(surface: Surface) {
    self.surface = surface
    _allowWrites = AppStorage(wrappedValue: false, "allowWrites.\(surface.id)")
  }

  /// Not `State`: a nested type of that name shadows SwiftUI's `@State`, and
  /// the failure is "enum 'State' cannot be used as an attribute" pointing at
  /// the property wrappers rather than at the enum. Same trap `SurfaceSettings`
  /// documents for `Settings`.
  private enum LoadState {
    case loading
    case loaded(SurfaceCatalog.Capabilities)
    case failed(String)
  }

  var body: some View {
    Card("Capabilities") {
      switch state {
      case .loading:
        Text("Asking the server…").font(.callout).foregroundStyle(.secondary)
      case .failed(let why):
        Text(why)
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      case .loaded(let caps):
        summary(caps)
        if expanded { detail(caps) }
      }
    }
    // Keyed on every flag as well as the surface, so flipping any of them
    // re-probes instead of showing a list the server no longer serves.
    .task(id: "\(surface.id)/\(allowWrites)/\(gates.sorted().joined(separator: "+"))") {
      await load()
    }
    .onAppear { gates = SurfaceSettings.enabledGates(surface) }
    .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
      let now = SurfaceSettings.enabledGates(surface)
      if now != gates { gates = now }
    }
  }

  private func summary(_ caps: SurfaceCatalog.Capabilities) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(
          "\(caps.tools.count) tool\(caps.tools.count == 1 ? "" : "s")"
            + " · \(caps.prompts.count) prompt\(caps.prompts.count == 1 ? "" : "s")"
            + " · \(caps.resources.count) resource\(caps.resources.count == 1 ? "" : "s")"
        )
        .font(.callout)
        .monospacedDigit()
        Spacer()
        Button(expanded ? "Hide" : "Show") { withAnimation(.snappy) { expanded.toggle() } }
          .buttonStyle(.glass)
          .controlSize(.small)
      }
      Text(
        !surface.supportsWrites
          // A surface with no mutating tool has no write gate, so explaining
          // what the gate is doing describes a control that is not on the pane.
          ? "This surface registers no mutating tool, so there is no write gate."
          : allowWrites
            ? "Writes are on, so the mutating tools and the prompts that end in one are registered."
            : "Writes are off, so the mutating tools and the prompts that end in one are not registered at all — not refused later."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder private func detail(_ caps: SurfaceCatalog.Capabilities) -> some View {
    group("Tools", caps.tools)
    group("Prompts", caps.prompts)
    group("Resources", caps.resources)
  }

  @ViewBuilder private func group(_ title: String, _ items: [SurfaceCatalog.Item]) -> some View {
    if !items.isEmpty {
      Divider().padding(.vertical, 2)
      Text(title.uppercased())
        .font(.caption2)
        .foregroundStyle(.secondary)
        .tracking(0.6)
      ForEach(items) { item in
        VStack(alignment: .leading, spacing: 1) {
          Text(item.name)
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
          if let detail = item.detail {
            Text(detail)
              .font(.caption2)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
  }

  private func load() async {
    // Straight from the cache when it is there, without passing through
    // `.loading` — otherwise every return to a pane someone has already visited
    // flashes "Asking the server…" at a list that never left memory.
    if let hit = SurfaceCatalog.cached(surface, allowWrites: allowWrites, gates: gates) {
      state = .loaded(hit)
      return
    }
    state = .loading
    do {
      let caps = try await SurfaceCatalog.read(surface, allowWrites: allowWrites, gates: gates)
      state = .loaded(caps)
    } catch {
      state = .failed(error.localizedDescription)
    }
  }
}

/// A titled group. The panes are lists of facts, and every one of them wants the
/// same box, so it is written once.
struct Card<Content: View>: View {
  let title: String
  @ViewBuilder var content: () -> Content

  init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
    self.title = title
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased())
        .font(.caption2)
        .foregroundStyle(.secondary)
        .tracking(0.6)
      VStack(alignment: .leading, spacing: 8) { content() }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 10))
    }
  }
}

/// What this surface records, for this surface alone.
///
/// Per surface rather than global for the same reason the write gate is: the
/// surfaces differ in how much of their traffic is private. Recording the
/// arguments of `list_events` is nearly free; recording the arguments of
/// `send_message` is recording the message. One switch for all eight would have
/// to be set for the most sensitive of them, which in practice means set to
/// nothing.
///
/// A change applies to the NEXT connection, not the current one. `RequestObserver`
/// resolves both settings once when a connection opens — a `UserDefaults` read
/// per line on a pump thread is a cost with no payoff — and the write gate has
/// the same behaviour for the same reason.
/// How this surface presents its tools, overriding the app-wide default.
///
/// In the Access card rather than beside the capture controls, because it is a
/// decision about what a client is shown rather than about what gets logged —
/// and directly under the write gate, because the two interact: with writes on,
/// a lazy surface exposes a second dispatcher, and a host's permission rule
/// then names "this surface's writes" instead of `send_message`.
///
/// A change applies to the NEXT connection, the same rule the write gate and
/// the capture mode already follow.
private struct LazyToolsControl: View {
  private let surface: Surface
  /// Empty means "follow the app-wide default" — see `SurfaceSettings.lazyTools`.
  @AppStorage private var choice: String

  init(surface: Surface) {
    self.surface = surface
    _choice = AppStorage(wrappedValue: "", SurfaceSettings.lazyToolsKey(surface))
  }

  var body: some View {
    Picker("Load tools on demand", selection: $choice) {
      Text("Default (\(SurfaceSettings.appLazyTools ? "on" : "off"))").tag("")
      Text("On").tag("on")
      Text("Off").tag("off")
    }
    .font(.callout)

    Text(
      SurfaceSettings.lazyTools(surface)
        ? "\(surface.displayName) serves a search tool and a dispatcher. Clients read far less on "
          + "connect, and ask permission once for reads and once for writes rather than per tool."
        : "\(surface.displayName) lists every tool up front, so your client can ask about each one "
          + "by name."
    )
    .font(.caption)
    .foregroundStyle(.secondary)
    .fixedSize(horizontal: false, vertical: true)
  }
}

private struct CaptureControls: View {
  private let surface: Surface
  /// Empty means "follow the app-wide default", which is what absence means in
  /// `SurfaceSettings.captureMode`. A `Picker` needs a concrete tag, so the
  /// absence is spelled rather than optional here.
  @AppStorage private var mode: String
  @AppStorage private var content: Bool

  init(surface: Surface) {
    self.surface = surface
    _mode = AppStorage(wrappedValue: "", SurfaceSettings.captureKey(surface))
    _content = AppStorage(
      wrappedValue: SurfaceSettings.capturesContent(surface), SurfaceSettings.contentKey(surface))
  }

  var body: some View {
    Picker("Record", selection: $mode) {
      Text("Default (\(SurfaceSettings.appCaptureMode.label))").tag("")
      ForEach(CallCapture.Mode.allCases, id: \.self) { mode in
        Text(mode.label).tag(mode.rawValue)
      }
    }
    .font(.callout)

    Toggle(isOn: $content) {
      // Not "message contents": this control governs nine surfaces and the
      // app-wide log, and only two of them have messages.
      Text("Include contents")
      // Both halves, because `CallCapture` redacts them differently and the
      // sentence used to describe only the smaller one. Arguments lose the keys
      // in `contentKeys`; a RESULT is withheld entirely, on the grounds that
      // every word of it was answered by the server. A reader told only about
      // blanked arguments would expect to find return values in the log.
      //
      // It names «redacted» because that is the literal string they will see.
      Text(
        resolved >= .arguments
          ? "Off: what \(surface.displayName)'s tools return is logged as «redacted», and prose "
            + "in their arguments — a body, a subject, a query — is blanked. Names and structure "
            + "are kept."
          : "Nothing is recorded beyond names, so there is no content to include.")
    }
    .font(.callout)
    .disabled(resolved < .arguments)
  }

  private var resolved: CallCapture.Mode {
    CallCapture.Mode(rawValue: mode) ?? SurfaceSettings.appCaptureMode
  }
}

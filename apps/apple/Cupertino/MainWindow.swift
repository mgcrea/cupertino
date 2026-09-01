import AppKit
import SwiftUI

/// Cupertino's main window.
///
/// This started as the log pane and became the main window, which is the right
/// shape for what it already was. A menu bar popover is 320pt wide and closes
/// the moment focus moves — fine for a glance, wrong for watching a log, and
/// wrong for the question a new user actually has, which is "is any of this
/// working". So the status the popover summarises is repeated here as a header
/// that stays put while the log scrolls underneath it.
///
/// It is still not opened on launch. Cupertino is started by a tool call far
/// more often than by a person, and a window appearing while someone is typing
/// at an assistant is exactly the interruption `open -g` exists to avoid —
/// `AppDelegate` opens this only when a human launched the app in the
/// foreground, or clicked the Dock icon.
@MainActor
enum MainWindowController {
  /// Also the window's `frameAutosaveName`, which is how `DemoSeed` tells this
  /// window apart from the Settings one — it has to size them differently, and
  /// the `settings` stage has to order *this* one out. Matching on the title
  /// would be matching on a localizable string.
  static let autosaveName = "main"

  private static let hosted = HostedWindow(
    title: "Cupertino", autosaveName: autosaveName,
    // Only under screenshot mode. The shipping window has no forced size on
    // purpose — it opens at SwiftUI's fitting size and then remembers whatever
    // the user drags it to.
    contentSize: DemoSeed.isEnabled ? DemoSeed.contentSize : nil,
    content: { MainView(model: StatusModel.shared) })

  static func show() { hosted.show() }

  /// Open onto a particular pane, including on a window that is already up.
  ///
  /// The default is written *before* the window is shown, exactly as
  /// `SettingsWindowController.show(_:)` does it: `MainView` reads its
  /// selection through `@AppStorage`, which observes the write. This is what
  /// the popover's "N more…" link needs — it promises the Connections list, and
  /// with the window already open on the log it used to bring that window
  /// forward still showing the log.
  static func show(_ pane: MainView.Pane) {
    UserDefaults.standard.set(pane.rawValue, forKey: MainView.Pane.defaultsKey)
    hosted.show()
  }
}

/// The entry point for callers that are not already on the main actor.
enum MainWindowOpener {
  static func show() {
    Task { @MainActor in MainWindowController.show() }
  }
}

struct MainView: View {
  let model: StatusModel
  /// Where the sidebar selection lives.
  ///
  /// `@AppStorage`, not `@State`, and the reason is the one already written on
  /// `SettingsView.pane`: a `@State` copy seeded once at init is exactly how a
  /// deep link into an *already-open* window stops working. Settings was
  /// bridged this way from the start; this window was not, and the cost was the
  /// popover's "N more…" link opening the window on whatever pane it was last
  /// left on instead of on Connections.
  @AppStorage(Pane.defaultsKey) private var selection = Pane.log.rawValue
  @State private var surface: String = MainView.allSurfaces
  @State private var callsOnly = false
  @State private var following = true
  @State private var exported: String?
  @State private var query = ""

  static let allSurfaces = "all"

  /// What the sidebar selects.
  ///
  /// Surfaces are destinations rather than a filter on one list, which is the
  /// whole reason this became a split view: "is Mail working" is the question
  /// people actually arrive with, and answering it used to mean reading three
  /// different places.
  enum Pane: Hashable {
    case surface(String)
    case log
    case connections
  }

  /// Optional because that is the shape `List(selection:)` drives for a single
  /// selection. A non-optional binding compiles, and then the sidebar highlight
  /// moves while the detail pane stays where it was — selection updating in
  /// AppKit but never reaching this state.
  ///
  /// Bridged here rather than mirrored into `@State` so there is one source of
  /// truth, which is what lets `MainWindowController.show(_:)` reach a window
  /// that is already open.
  private var pane: Binding<Pane?> {
    Binding(
      get: { current },
      set: { selection = ($0 ?? .log).rawValue })
  }

  /// The staged driver reaches a screen by relaunching onto it rather than by
  /// clicking through to it, so under `appshot capture` the initial selection
  /// *is* the navigation — and it must come from the stage, never from the
  /// stored value. A remembered pane is the developer's, and a capture must not
  /// inherit whichever screen they happened to leave this window on.
  /// `HostedWindow` overrides a remembered *frame* for the same reason.
  private var current: Pane {
    if DemoSeed.isEnabled { return DemoSeed.stage.pane }
    return Pane(rawValue: selection) ?? .log
  }

  private var needle: String { query.trimmingCharacters(in: .whitespaces) }

  /// Why the feed is empty, which is three different facts.
  ///
  /// "Nothing matches this filter" in front of a log that has never had a line
  /// in it sends someone looking for a filter to clear.
  private var emptyReason: String {
    if LogStore.shared.entries.isEmpty { return "Nothing yet." }
    if !needle.isEmpty { return "Nothing matches \u{201C}\(query)\u{201D}." }
    return "Nothing matches this filter."
  }

  private var entries: [LogStore.Entry] {
    LogStore.shared.entries.filter { entry in
      if surface != Self.allSurfaces && entry.surface != surface { return false }
      if callsOnly && entry.level == .info { return false }
      if !needle.isEmpty && !entry.matches(needle) { return false }
      return true
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      UpdateConsentCard()
      NavigationSplitView {
        sidebar
      } detail: {
        detail
      }
    }
    .frame(minWidth: 780, minHeight: 460)
    .onAppear { model.refresh() }
    // A fact, not a duration: the body has run and the model is populated. That
    // is what `--ready-file` wants, and it is why `--settle` can stay at its
    // floor instead of being padded until the screen "looks about right".
    .task { DemoSeed.signalReady(from: .main) }
  }

  /// The sidebar carries its own material on macOS 26, which is why the glass
  /// bar this window used to have is gone: hand-rolled chrome next to system
  /// chrome is the one arrangement that always looks wrong.
  private var sidebar: some View {
    List(selection: pane) {
      // Two groups, because they are two different offers. A surface brokers
      // one Apple APP and costs that app's permission; a capability brokers
      // something the system provides, has no app behind it, and costs a
      // permission of its own — Screen Recording for `screen`. Filed together,
      // "Screen" reads as an app nobody can find in their Applications folder.
      Section("Surfaces") {
        // Every surface, including the ones switched off. Hiding them would make
        // this window lie about which apps Cupertino knows, and would leave the
        // detail pane — where you turn one back on — unreachable from here.
        // Moving them to their own section is worse in a smaller way: the row
        // would jump out from under the cursor that just switched it off.
        ForEach(Surface.apps) { surface in
          SurfaceSidebarRow(surface: surface, model: model)
            .tag(Pane.surface(surface.id))
        }
      }
      // Absent rather than empty when there are none: a titled group with
      // nothing in it advertises a feature that does not exist.
      if !Surface.capabilities.isEmpty {
        Section("Capabilities") {
          ForEach(Surface.capabilities) { surface in
            SurfaceSidebarRow(surface: surface, model: model)
              .tag(Pane.surface(surface.id))
          }
        }
      }
      Section("Activity") {
        Label("Log", systemImage: "list.bullet.rectangle").tag(Pane.log)
        Label("Connections", systemImage: "cable.connector").tag(Pane.connections)
      }
    }
    .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
    .safeAreaInset(edge: .bottom) { sidebarStatus }
  }

/// One sidebar row, owning its own `@AppStorage` so it redraws when the switch
/// moves.
///
/// A view rather than a branch inside the `ForEach`: `SurfaceSettings.isEnabled`
/// is a plain `UserDefaults` read and does not publish, so a row that consulted
/// it directly would keep its old appearance until something else invalidated
/// the list. `WritesToggle` makes the same move for the same reason.
  /// The two facts that are true of the whole app rather than of one surface.
  /// Full Disk Access belongs here and nowhere else — `DiskAccessStatus` is
  /// deliberately app-wide, and a copy of it per surface would imply a
  /// containment that does not exist.
  /// Distinct clients, not connections. See the comment at the use site.
  private var clientCount: Int { Sessions.shared.grouped.count }

  private var sidebarStatus: some View {
    VStack(alignment: .leading, spacing: 6) {
      Divider()
      licenceLine
      Button { SettingsOpener.show(.permissions) } label: {
        HStack(spacing: 6) {
          Circle()
            .fill(
              StatusStyle.healthTint(model.diskAccess == .granted ? .ready : .needsSetup)
            )
            .frame(width: 7, height: 7)
          Text("Full Disk Access").font(.caption)
          Spacer()
        }
      }
      .buttonStyle(.plain)
      // Last, and quiet: the two lines above are states that can need acting on,
      // and this one never does. Opens Settings, where the build number, the
      // commit and the copy button are.
      HStack(spacing: 6) {
        Button { SettingsOpener.show(.general) } label: {
          Text("Version \(AppInfo.shortVersion)")
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)

        Spacer()

        // Clients, never sessions. Every MCP client opens one connection per
        // surface it is configured with, so `live.count` is
        // clients × surfaces × concurrent shells — the demo fixture alone is 18
        // sessions from 3 clients, and "18 clients connected" is simply false.
        // `grouped` is the same collapse the Connections pane shows, so the two
        // numbers cannot disagree.
        //
        // Absent at zero rather than "0 clients": this line sits under two
        // others that are always present, and a permanent zero is a row that
        // only ever says nothing is happening.
        if clientCount > 0 {
          Button { selection = Pane.connections.rawValue } label: {
            Text(clientCount == 1 ? "1 client" : "\(clientCount) clients")
              .font(.caption)
              .foregroundStyle(.tertiary)
          }
          .buttonStyle(.plain)
          .help("Show connections")
        }

        // The one entrance that says so. Every other route out of this window
        // into Settings is a status line that happens to be a button, and each
        // goes to the pane its own line is about — which is the right behaviour
        // and no help at all to somebody who does not already know they are
        // buttons. The app menu carrying ⌘, is not the answer either: it exists
        // only while a window is open, which is a rule nobody should have to
        // learn about a menu bar app.
        Button { SettingsOpener.show() } label: {
          Image(systemName: "gearshape")
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .help("Settings (⌘,)")
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 10)
    // Opaque, and not for looks. `safeAreaInset` reserves the space but does
    // not fill it, so once the sidebar has more rows than fit, the list scrolls
    // *under* a transparent footer and the licence and disk-access lines are
    // drawn through by whatever row is passing behind them. Six rows against a
    // 460pt minimum do not scroll today, which is why this has never been seen
    // here — it is one added surface, or one shorter window, away. `.bar` is
    // the material AppKit uses for exactly this strip, so it occludes without
    // inventing a colour the sidebar does not already have.
    //
    // (That "six rows" was written when there were four surfaces. There are
    // eight, so the list is ten rows and two headers against a 460pt minimum
    // less this strip — the margin is about four rows, not the comfortable one
    // implied above. Switching a surface off does not shrink it: the row stays,
    // dimmed.)
    .background(.bar)
  }

  @ViewBuilder
  private var licenceLine: some View {
    // The countdown is the reason for the timeline: this line sits in a window
    // somebody leaves open while they try the thing out, so it is the one most
    // likely to be on screen when the window closes.
    TimelineView(.periodic(from: .now, by: 15)) { _ in
      switch Entitlement.current {
      case .licensed(let license):
        Button { SettingsOpener.show(.licence) } label: {
          HStack(spacing: 6) {
            Circle().fill(Color.green).frame(width: 7, height: 7)
            Text("Licensed").font(.caption)
            Spacer()
          }
        }
        .buttonStyle(.plain)
        .help(license.email)
      case .trial:
        Button { SettingsOpener.show(.licence) } label: {
          HStack(spacing: 6) {
            Circle().fill(Color.blue).frame(width: 7, height: 7)
            Text("Trial · \(Trial.remainingText)").font(.caption)
            Spacer()
          }
        }
        .buttonStyle(.plain)
        .help("Every surface is running, exactly as a licensed copy would")
      case .refused:
        Button { SettingsOpener.show(.licence) } label: {
          Label("Unlicensed", systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
        }
        .buttonStyle(.plain)
        .help("Servers will not start until a key is entered or a trial is started")
      }
    }
  }

  @ViewBuilder
  private var detail: some View {
    switch current {
    case .surface(let id):
      if let surface = Surface.named(id) {
        SurfaceDetail(surface: surface, model: model)
      } else {
        Text("Unknown surface").foregroundStyle(.secondary)
      }
    case .log:
      VStack(spacing: 0) {
        // Floating rather than welded to the edge: glass reads as a layer above
        // the content, and a strip of it flush against the top with a divider
        // under it just looks like a lighter background.
        filters
          .padding(.horizontal, 12)
          .padding(.top, 12)
          .padding(.bottom, 6)
        log
        Divider()
        footer
      }
    case .connections:
      connections
    }
  }

  private var filters: some View {
    HStack(spacing: 12) {
      Picker("", selection: $surface) {
        Text("All").tag(Self.allSurfaces)
        // "cupertino" is the host's own surface name in hostLog — the socket,
        // the install location, the client wiring.
        Text("Cupertino").tag("cupertino")
        ForEach(Surface.all) { Text($0.displayName).tag($0.id) }
      }
      .labelsHidden()
      .fixedSize()

      Toggle("Calls and errors only", isOn: $callsOnly)
        .toggleStyle(.checkbox)

      // Over the payloads too, not just the tool name — "which call touched
      // that note" is what a log this size gets opened for, and the answer is
      // in the arguments. Composes with the picker and the toggle rather than
      // replacing them: three narrowings of one list.
      HStack(spacing: 4) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(.tertiary)
          .font(.caption)
        TextField("Search", text: $query)
          .textFieldStyle(.plain)
          .frame(minWidth: 90, idealWidth: 150)
        if !query.isEmpty {
          Button { query = "" } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
          }
          .buttonStyle(.plain)
          .help("Clear the search")
        }
      }
      .padding(.horizontal, 6).padding(.vertical, 3)
      .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 6))
      .frame(maxWidth: 220)

      Spacer()

      if !needle.isEmpty {
        Text("\(entries.count) of \(LogStore.shared.entries.count)")
          .font(.caption).foregroundStyle(.secondary).monospacedDigit()
      }
      Button("Copy") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(entries.map(line).joined(separator: "\n"), forType: .string)
      }
      Button("Clear") { LogStore.shared.clear() }
      // The same panel the Activity settings pane opens, via the one copy of
      // it — not a route to that pane, which would be a button labelled
      // "Export…" that produced a settings window.
      Button("Export…") { exported = AuditExport.run()?.note }
        .disabled(!AuditLog.isEnabled)
        .help(AuditLog.isEnabled ? "Save the audit log and its manifest." : AuditExport.unavailable)
    }
    .controlSize(.small)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .glassBackground(cornerRadius: 12)
  }

  private var log: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2) {
          ForEach(entries) { entry in
            row(entry).id(entry.id)
          }
          // An empty anchor, so following the tail does not depend on the last
          // entry still passing the filter.
          Color.clear.frame(height: 1).id(tailAnchor)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .textSelection(.enabled)
      .onChange(of: LogStore.shared.entries.count) {
        guard following else { return }
        withAnimation(.linear(duration: 0.1)) { proxy.scrollTo(tailAnchor, anchor: .bottom) }
      }
      .overlay(alignment: .center) {
        if entries.isEmpty {
          Text(emptyReason)
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  private var tailAnchor: String { "activity-tail" }

  /// Every live session, one row each — the detail the menu popover deliberately
  /// collapses.
  ///
  /// This is where the ungrouped list belongs: a real window that scrolls, not a
  /// popover sized to whatever happens to be connected. `Sessions.grouped` is the
  /// other half of that split.
  private var connections: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 2) {
        ForEach(Sessions.shared.live) { session in
          connectionRow(session)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .textSelection(.enabled)
    .overlay(alignment: .center) {
      if Sessions.shared.live.isEmpty {
        // The same words as the popover: idle is the resting shape, not a fault.
        Text("No client connected.")
          .foregroundStyle(.secondary)
      }
    }
  }

  private func connectionRow(_ session: Sessions.Session) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(Self.clock.string(from: session.startedAt))
        .foregroundStyle(.tertiary)
      // Same width as the log's surface column, so the two panes line up.
      Text(Surface.named(session.surface)?.displayName ?? session.surface)
        .foregroundStyle(.secondary)
        .frame(width: 68, alignment: .leading)
      Text(session.client ?? "connecting…")
        .lineLimit(1)
        .truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)
      Text("pid \(session.pid)")
        .foregroundStyle(.secondary)
        .monospacedDigit()
      Text("\(session.calls) call\(session.calls == 1 ? "" : "s")")
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .frame(width: 72, alignment: .trailing)
    }
    .font(.system(.caption, design: .monospaced))
  }


  private func row(_ entry: LogStore.Entry) -> some View {
    LogRow(entry: entry, tint: tint(entry.level), clock: Self.clock, highlight: needle)
  }

  private func tint(_ level: LogStore.Level) -> Color {
    switch level {
    case .call: .accentColor
    case .error: .red
    case .info: .primary
    }
  }

  private func line(_ entry: LogStore.Entry) -> String {
    var out =
      "\(Self.clock.string(from: entry.at))  \(entry.surface)  \(entry.level.rawValue)  "
      + "\(entry.text)"
    // Copy has to carry what the row shows, or the button quietly lies about
    // what was on screen.
    if let arguments = entry.arguments { out += "\n    args   \(arguments)" }
    if let result = entry.result { out += "\n    result \(result)" }
    return out
  }

  private static let clock: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter
  }()

  private var footer: some View {
    HStack {
      // Load-bearing, not decoration. Keeping this sentence true is a
      // constraint on anything added to the feed — including the payloads,
      // which is why it says where they stop rather than dropping the claim now
      // that there are some. It named tools only until prompts and resources
      // shipped; it gained the second sentence when arguments did.
      Text(
        "Tool, prompt and resource names, and the arguments each was called with. Message "
          + "contents and results are per-surface and off unless you turn them on. "
          + (AuditLog.isEnabled
            ? "An audit log is being kept on disk — see Settings › Activity."
            : "Nothing here is written to disk."))
        .font(.caption)
        .foregroundStyle(.secondary)
        // Bounded, and it has to be. `fixedSize(horizontal: false, vertical:
        // true)` asks for the height this text needs at whatever width it is
        // proposed, and inside this HStack that proposal is near zero — so the
        // caption wrapped into a column 2060pt tall, the split view took that as
        // its ideal height, and a 572pt window laid its entire contents out at
        // y = -587. Nothing painted: sidebar, log and footer all existed in the
        // accessibility tree and none of them was on screen. The `activity` and
        // `prompt` plates photographed an empty window.
        //
        // It was latent under the one-line caption, which wrapped tall enough to
        // be wrong and short enough to fit; the second sentence is what pushed
        // it past the window. `layoutPriority` and a flexible `frame` were both
        // tried and neither reaches it — the fix is not to ask for an unbounded
        // height in the first place.
        //
        // Three rather than two: two is what it takes at the size the plates are
        // captured, but this window goes down to 780pt wide and the sentence is
        // load-bearing — truncating a privacy claim with an ellipsis is the one
        // way this footer must not fail.
        .lineLimit(3)
      Spacer()
      if let exported {
        Text(exported)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .help(exported)
      }
      Toggle("Follow", isOn: $following)
        .toggleStyle(.checkbox)
        .font(.caption)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }
}


private struct SurfaceSidebarRow: View {
  let surface: Surface
  let model: StatusModel
  @AppStorage private var enabled: Bool

  init(surface: Surface, model: StatusModel) {
    self.surface = surface
    self.model = model
    _enabled = AppStorage(wrappedValue: true, SurfaceSettings.enabledKey(surface))
  }

  var body: some View {
    // The app's own icon leads the row, so the sidebar reads as a list of the
    // apps rather than of abstractions — and the automation status moves to the
    // trailing edge instead of being displaced by it. Both facts fit; one was
    // standing in for the other.
    Label {
      HStack(spacing: 6) {
        Text(surface.displayName)
          .foregroundStyle(enabled ? .primary : .tertiary)
        Spacer(minLength: 4)
        // The glyph goes rather than greys. A grant reported against a server
        // that will never start is a true fact about the wrong subject.
        //
        // The aggregate, matching the popover — `SurfaceStatus` rather than
        // `AutomationStatus`, so this row and that one cannot answer different
        // questions about the same surface.
        if enabled, let status = model.status(for: surface) {
          Image(systemName: StatusStyle.healthIcon(status.health))
            .font(.caption)
            .foregroundStyle(StatusStyle.healthTint(status.health))
            .help(status.caption)
        }
      }
    } icon: {
      SurfaceIconView(surface: surface)
        .saturation(enabled ? 1 : 0)
        .opacity(enabled ? 1 : 0.55)
    }
    .help(enabled ? "" : "Off")
    // The batch path. Switching four surfaces off from the detail pane is four
    // navigations; from here it is four right-clicks without leaving the list,
    // which is the one thing a Settings list of all eight would have bought.
    .contextMenu {
      Button(enabled ? "Turn Off" : "Turn On") {
        enabled.toggle()
        if !enabled { ServerHost.shared.stopSessions(for: surface) }
        model.refresh()
      }
    }
  }
}


/// `RawRepresentable` so the selection can live in `@AppStorage`. See
/// `MainView.pane` for why it has to.
extension MainView.Pane: RawRepresentable {
  static let defaultsKey = "mainPane"

  init?(rawValue: String) {
    switch rawValue {
    case "log": self = .log
    case "connections": self = .connections
    default:
      // Only `surface:` carries a payload, and an id that is no longer in
      // `Surface.all` still parses — `MainView.detail` already re-resolves it
      // and draws "Unknown surface", which is a better answer than silently
      // landing somewhere else.
      guard rawValue.hasPrefix("surface:") else { return nil }
      let id = String(rawValue.dropFirst("surface:".count))
      guard !id.isEmpty else { return nil }
      self = .surface(id)
    }
  }

  var rawValue: String {
    switch self {
    case .surface(let id): "surface:\(id)"
    case .log: "log"
    case .connections: "connections"
    }
  }
}

/// Asked once, and as a card rather than a dialog.
///
/// The honest default already holds without an answer — nothing constructs an
/// updater, and nothing resolves a name, until somebody opts in — so stopping
/// the app to demand one would be theatre. That is `promptForLicenceIfNeeded`'s
/// reasoning in reverse: the licence pane opens itself because *nothing works*
/// until the question is answered, and this does not.
///
/// It is also the sentence that keeps the claim in docs/licensing.md honest.
/// Cupertino is sold partly on making no network connections, so the moment it
/// can make one, the person who bought it on that basis is the one who decides.
struct UpdateConsentCard: View {
  @State private var answered = UserDefaults.standard.bool(forKey: UpdateController.choiceMade)

  var body: some View {
    // Never in a capture: a screenshot is of the product, not of whether this
    // laptop has answered a question yet.
    if !answered && !DemoSeed.isEnabled {
      VStack(alignment: .leading, spacing: 8) {
        Label("Should Cupertino check for updates?", systemImage: "arrow.down.circle")
          .font(.subheadline).bold()
        Text(
          """
          Cupertino makes no network connections at all today. Checking for \
          updates is the one exception, and it is off until you say otherwise. \
          It reads one file and sends no identifier with it.
          """
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

        HStack(spacing: 8) {
          Button("Check automatically") { answer(true) }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
          Button("Keep updates off") { answer(false) }
            .controlSize(.small)
          Text("You can change this in Settings.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.quaternary.opacity(0.4))
    }
  }

  private func answer(_ automatic: Bool) {
    UpdateController.shared.setAutomatic(automatic)
    UserDefaults.standard.set(true, forKey: UpdateController.choiceMade)
    answered = true
  }
}


/// One line of the log, with whatever payload it carries.
///
/// A view of its own rather than a function on the pane, because it needs
/// `@State` for the expansion and a `some View` helper cannot hold any. Modelled
/// on the connections list's rows, and on Bastion's `FeedRow`, which solves the
/// same problem one repo over.
private struct LogRow: View {
  let entry: LogStore.Entry
  let tint: Color
  let clock: DateFormatter
  /// The active search, so a row can open itself when the reason it matched is
  /// past the preview. Empty when nothing is being searched for.
  var highlight: String = ""

  @State private var expanded = false

  /// How much of a payload shows before the row is opened.
  private static let preview = 160

  /// Open either because the reader asked, or because the match is out of
  /// sight and a row listed for no visible reason reads as a bug.
  private var isOpen: Bool {
    expanded || entry.matchIsHidden(highlight, preview: Self.preview)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(clock.string(from: entry.at))
          .foregroundStyle(.tertiary)
        Text(entry.surface)
          .foregroundStyle(.secondary)
          .frame(width: 68, alignment: .leading)
        Text(entry.text)
          .foregroundStyle(tint)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
        if entry.failed {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption2)
            .foregroundStyle(.red)
        }
      }
      if let arguments = entry.arguments {
        payload("args", arguments, tint: .secondary)
      }
      if let result = entry.result {
        payload("result", result, tint: entry.failed ? .red : .secondary)
      }
      if longest > Self.preview {
        Button(isOpen ? "Show less" : "Show all \(longest) characters") { expanded.toggle() }
          .buttonStyle(.link)
          .font(.caption2)
          .padding(.leading, 84)
      }
    }
    .font(.system(.caption, design: .monospaced))
  }

  private var longest: Int { max(entry.arguments?.count ?? 0, entry.result?.count ?? 0) }

  private func payload(_ label: String, _ text: String, tint: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(label)
        .foregroundStyle(.tertiary)
        .frame(width: 76, alignment: .trailing)
      Text(isOpen ? text : String(text.prefix(Self.preview)))
        .foregroundStyle(tint)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .font(.system(.caption2, design: .monospaced))
  }
}

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
  private static let hosted = HostedWindow(
    title: "Cupertino", autosaveName: "main",
    content: { MainView(model: StatusModel.shared) })

  static func show() { hosted.show() }
}

/// The entry point for callers that are not already on the main actor.
enum MainWindowOpener {
  static func show() {
    Task { @MainActor in MainWindowController.show() }
  }
}

struct MainView: View {
  let model: StatusModel
  /// Optional because that is the shape `List(selection:)` drives for a single
  /// selection. A non-optional binding compiles, and then the sidebar highlight
  /// moves while the detail pane stays where it was — selection updating in
  /// AppKit but never reaching this state.
  /// The staged driver reaches a screen by relaunching onto it rather than by
  /// clicking through to it, so the initial selection *is* the navigation.
  @State private var pane: Pane? = DemoSeed.isEnabled ? DemoSeed.stage.pane : .log
  @State private var surface: String = MainView.allSurfaces
  @State private var callsOnly = false
  @State private var following = true

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

  private var entries: [LogStore.Entry] {
    LogStore.shared.entries.filter { entry in
      if surface != Self.allSurfaces && entry.surface != surface { return false }
      if callsOnly && entry.level == .info { return false }
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
    .task { DemoSeed.signalReady() }
  }

  /// The sidebar carries its own material on macOS 26, which is why the glass
  /// bar this window used to have is gone: hand-rolled chrome next to system
  /// chrome is the one arrangement that always looks wrong.
  private var sidebar: some View {
    List(selection: $pane) {
      Section("Surfaces") {
        ForEach(Surface.all) { surface in
          // The app's own icon leads the row, so the sidebar reads as a list of
          // the four apps rather than of four abstractions — and the automation
          // status moves to the trailing edge instead of being displaced by it.
          // Both facts fit; one was standing in for the other.
          Label {
            HStack(spacing: 6) {
              Text(surface.displayName)
              Spacer(minLength: 4)
              Image(systemName: StatusStyle.icon(model.automation[surface.id]))
                .font(.caption)
                .foregroundStyle(StatusStyle.tint(model.automation[surface.id]))
                .help(StatusStyle.caption(model.automation[surface.id]))
            }
          } icon: {
            SurfaceIconView(surface: surface)
          }
          .tag(Pane.surface(surface.id))
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

  /// The two facts that are true of the whole app rather than of one surface.
  /// Full Disk Access belongs here and nowhere else — `DiskAccessStatus` is
  /// deliberately app-wide, and a copy of it per surface would imply a
  /// containment that does not exist.
  private var sidebarStatus: some View {
    VStack(alignment: .leading, spacing: 6) {
      Divider()
      licenceLine
      Button { SettingsOpener.show(.permissions) } label: {
        HStack(spacing: 6) {
          Circle()
            .fill(model.diskAccess == .granted ? Color.green : Color.orange)
            .frame(width: 7, height: 7)
          Text("Full Disk Access").font(.caption)
          Spacer()
        }
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
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
    switch pane ?? .log {
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

      Spacer()

      Button("Copy") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(entries.map(line).joined(separator: "\n"), forType: .string)
      }
      Button("Clear") { LogStore.shared.clear() }
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
          Text(LogStore.shared.entries.isEmpty ? "Nothing yet." : "Nothing matches this filter.")
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
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(Self.clock.string(from: entry.at))
        .foregroundStyle(.tertiary)
      Text(entry.surface)
        .foregroundStyle(.secondary)
        .frame(width: 68, alignment: .leading)
      Text(entry.text)
        .foregroundStyle(tint(entry.level))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .font(.system(.caption, design: .monospaced))
  }

  private func tint(_ level: LogStore.Level) -> Color {
    switch level {
    case .call: .accentColor
    case .error: .red
    case .info: .primary
    }
  }

  private func line(_ entry: LogStore.Entry) -> String {
    "\(Self.clock.string(from: entry.at))  \(entry.surface)  \(entry.level.rawValue)  \(entry.text)"
  }

  private static let clock: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter
  }()

  private var footer: some View {
    HStack {
      // Load-bearing, not decoration. RequestObserver records the method and the
      // tool name and stops there; keeping this sentence true is a constraint on
      // anything added to it later.
      Text("Tool names only — never arguments, message contents or results.")
        .font(.caption)
        .foregroundStyle(.secondary)
      Spacer()
      Toggle("Follow", isOn: $following)
        .toggleStyle(.checkbox)
        .font(.caption)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
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

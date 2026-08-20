import AppKit
import SwiftUI

/// Identifies the Activity scene to `openWindow`.
enum ActivityWindow {
  static let id = "activity"
}

/// The log pane, at last rendered.
///
/// A window rather than a section of the menu: the popover is 320pt wide and
/// closes the moment you click anywhere else, which is the opposite of what
/// reading a scrolling log needs. LSUIElement only removes the Dock icon; an
/// accessory app can still own windows.
struct ActivityView: View {
  @State private var surface: String = ActivityView.allSurfaces
  @State private var callsOnly = false
  @State private var following = true

  static let allSurfaces = "all"

  private var entries: [LogStore.Entry] {
    LogStore.shared.entries.filter { entry in
      if surface != Self.allSurfaces && entry.surface != surface { return false }
      if callsOnly && entry.level == .info { return false }
      return true
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      filters
      Divider()
      log
      Divider()
      footer
    }
    .frame(minWidth: 560, minHeight: 320)
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
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
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

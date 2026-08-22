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

  enum StoreStatus {
    case checking
    /// No file lane at all, or nothing on this machine to read.
    case missing
    case found(path: String, readable: Bool)
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        heading
        accessSection
        storeSection
        activity
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task(id: surface.id) { await resolveStore() }
  }

  /// The icon is the system's, fetched at runtime — see `SurfaceIcon`. It also
  /// answers a question the bundle id underneath it cannot: whether the app it
  /// names is actually installed.
  private var heading: some View {
    HStack(spacing: 12) {
      SurfaceIconView(surface: surface, size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(surface.displayName).font(.title2)
        Text(surface.bundleID)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }
    }
  }

  private var accessSection: some View {
    Card("Access") {
      HStack {
        Image(systemName: StatusStyle.icon(model.automation[surface.id]))
          .foregroundStyle(StatusStyle.tint(model.automation[surface.id]))
        Text("Automation")
        Spacer()
        Text(StatusStyle.caption(model.automation[surface.id]))
          .foregroundStyle(.secondary)
        if model.automation[surface.id] != .granted {
          Button("Allow…") { model.requestAutomation(surface) }
            .buttonStyle(.glass)
            .controlSize(.small)
        }
      }
      .font(.callout)

      Divider()

      // Safety, not licensing. docs/licensing.md rules out gating writes behind
      // the licence, and this toggle behaves identically either way.
      WritesToggle(surface: surface)
        .padding(.leading, 0)
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
    }
  }

  /// Off the main actor: resolving Mail's store walks up to nineteen candidate
  /// paths, and this runs again every time the selection changes.
  private func resolveStore() async {
    let surface = surface
    let resolved: StoreStatus = await Task.detached(priority: .userInitiated) {
      guard let path = Permissions.resolveStore(surface) else { return StoreStatus.missing }
      return .found(path: path, readable: access(path, R_OK) == 0)
    }.value
    store = resolved
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

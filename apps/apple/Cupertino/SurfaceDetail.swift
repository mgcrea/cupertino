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
        CapabilitiesCard(surface: surface)
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

      if surface.supportsWrites {
        Divider()

        // Safety, not licensing. docs/licensing.md rules out gating writes behind
        // the licence, and this toggle behaves identically either way.
        WritesToggle(surface: surface)
          .padding(.leading, 0)
      }
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
    // Keyed on the flag as well as the surface, so flipping writes re-probes
    // instead of showing a list the server no longer serves.
    .task(id: "\(surface.id)/\(allowWrites)") { await load() }
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
        allowWrites
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
    if let hit = SurfaceCatalog.cached(surface, allowWrites: allowWrites) {
      state = .loaded(hit)
      return
    }
    state = .loading
    do {
      let caps = try await SurfaceCatalog.read(surface, allowWrites: allowWrites)
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

import Foundation
import Observation

/// The server processes that are running right now, one per accepted connection.
///
/// `ServerHost` deliberately keeps no state of its own — a connection lives on
/// the stack inside `serve`/`run` and dies with it — so this is the only place
/// that can answer "is anything actually connected?". It is observation, not
/// bookkeeping: nothing in the host reads back from here.
@MainActor
@Observable
final class Sessions {
  static let shared = Sessions()

  struct Session: Identifiable {
    let id: UUID
    let surface: String
    let pid: Int32
    let startedAt: Date
    /// From the MCP `initialize` handshake, not from the socket. The peer is
    /// accepted with a nil address and never identified, so the client's own
    /// `clientInfo.name` is the only name available.
    var client: String?
    var calls: Int
  }

  /// Main-actor hops are pinned to one priority on purpose.
  ///
  /// `opened` is enqueued from the connection thread and `named`/`counted` from
  /// that connection's pump thread, always later in wall-clock time — but the
  /// actor's executor only guarantees FIFO **within** a priority. Left to inherit,
  /// an update could land before the session it updates exists and be dropped, so
  /// the client would read "connecting…" forever.
  nonisolated static let priority = TaskPriority.userInitiated

  private(set) var live: [Session] = []

  func opened(id: UUID, surface: String, pid: Int32) {
    live.append(
      Session(id: id, surface: surface, pid: pid, startedAt: Date(), client: nil, calls: 0))
  }

  /// Seed a fully-formed session at a fixed instant, for `DemoSeed` only.
  ///
  /// The live path builds a session across three calls — `opened`, then `named`
  /// and `counted` as the handshake and the traffic arrive — because that is
  /// the order the wire delivers them in. A fixture has no wire, and threading
  /// it through the same three steps would only be ceremony.
  func openDemo(surface: String, client: String, pid: Int32, calls: Int, startedAt: Date) {
    live.append(
      Session(
        id: UUID(), surface: surface, pid: pid, startedAt: startedAt, client: client,
        calls: calls))
  }

  func closed(id: UUID) {
    live.removeAll { $0.id == id }
  }

  func named(id: UUID, _ client: String) {
    guard let index = live.firstIndex(where: { $0.id == id }) else { return }
    live[index].client = client
  }

  func counted(id: UUID) {
    guard let index = live.firstIndex(where: { $0.id == id }) else { return }
    live[index].calls += 1
  }

  // MARK: - One row per client

  /// `live` collapsed to one entry per client, for a surface that cannot scroll.
  ///
  /// A session is one *connection*, and every MCP client opens one per server it
  /// is configured with — so the raw list is `clients × surfaces × concurrent
  /// sessions`, and each new Claude Code shell adds a full set. Four terminals
  /// plus two GUI clients is already ~18 rows in a popover that has no
  /// `ScrollView`, and five identical `claude-code · Mail` lines say one thing
  /// five times.
  ///
  /// Derived rather than stored: `live` stays the single source of truth that
  /// the host writes to, and this is only how it is read.
  struct ClientGroup: Identifiable {
    let id: String
    let displayName: String
    let sessions: Int
    /// Display names, in `Surface.all` order.
    let surfaces: [String]
    let calls: Int
  }

  /// The bucket for sessions that have not finished the `initialize` handshake.
  /// Kept apart from the named groups rather than folded into one: until the
  /// client says who it is, it could turn out to be any of them.
  private static let unnamed = "\u{0}connecting"

  var grouped: [ClientGroup] {
    var order: [String] = []
    var buckets: [String: [Session]] = [:]
    for session in live {
      let key = session.client ?? Self.unnamed
      if buckets[key] == nil { order.append(key) }
      buckets[key, default: []].append(session)
    }

    let groups = order.map { key -> ClientGroup in
      let sessions = buckets[key] ?? []
      let ids = Set(sessions.map(\.surface))
      return ClientGroup(
        id: key,
        // The raw `clientInfo.name` — `claude-code`, `cursor-vscode`,
        // `claude-ai`. Deliberately not prettified: a lookup table would have to
        // guess at names this app does not choose, and a wrong guess labels the
        // row with a client that is not the one connected.
        displayName: key == Self.unnamed ? "connecting…" : key,
        sessions: sessions.count,
        // Filtered from the closed table, not sorted: a stable order for free.
        surfaces: Surface.all.filter { ids.contains($0.id) }.map(\.displayName),
        calls: sessions.reduce(0) { $0 + $1.calls })
    }

    // Deterministic, or the rows swap places every time the menu is drawn.
    return groups.sorted { a, b in
      if (a.id == Self.unnamed) != (b.id == Self.unnamed) { return b.id == Self.unnamed }
      return a.displayName.localizedStandardCompare(b.displayName) == .orderedAscending
    }
  }
}

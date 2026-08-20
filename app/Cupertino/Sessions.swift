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
    live.append(Session(id: id, surface: surface, pid: pid, startedAt: Date(), client: nil, calls: 0))
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
}

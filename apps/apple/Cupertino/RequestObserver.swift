import Foundation

/// Reads the client→server half of one connection for the activity log.
///
/// MCP over stdio is newline-delimited JSON, so requests can be picked off the
/// wire without interpreting them. One instance per connection, driven only
/// from that connection's single pump thread, which is why nothing here locks.
///
/// Best effort, and strictly non-blocking: this must never slow or break the
/// pump. It records **method and tool names only** — never arguments, never
/// results, which is the claim the Activity window makes on screen.
final class RequestObserver {
  private let surface: Surface
  private let session: UUID

  /// The tail of a chunk that ended mid-line.
  ///
  /// Reads come back in 64 KiB chunks with no regard for line boundaries, so
  /// splitting each chunk on its own dropped every request unlucky enough to
  /// straddle two of them — invisibly, because the pump still forwarded the
  /// bytes. Anything with a large argument (a long draft body, a base64
  /// attachment) is exactly the size that hits this.
  private var pending = Data()

  /// A line this long is not MCP framing, so stop buffering rather than grow
  /// without bound on a peer that never sends a newline.
  private let limit = 1 << 20

  init(surface: Surface, session: UUID) {
    self.surface = surface
    self.session = session
  }

  func saw(_ chunk: Data) {
    pending.append(chunk)
    guard let lastNewline = pending.lastIndex(of: UInt8(ascii: "\n")) else {
      if pending.count > limit { pending.removeAll(keepingCapacity: false) }
      return
    }

    let complete = pending[..<lastNewline]
    pending = Data(pending[pending.index(after: lastNewline)...])

    for line in complete.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
      note(Data(line))
    }
  }

  private func note(_ line: Data) {
    guard
      let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
      let method = object["method"] as? String
    else { return }

    let params = object["params"] as? [String: Any]

    if method == "tools/call", let name = params?["name"] as? String {
      let id = session
      Task(priority: Sessions.priority) { @MainActor in Sessions.shared.counted(id: id) }
      hostLog(surface.id, .call, name)
      return
    }

    // The peer is accepted with a nil address and never identified, so the
    // handshake is the only place a client says who it is.
    if method == "initialize", let info = params?["clientInfo"] as? [String: Any],
      let name = info["name"] as? String
    {
      let id = session
      Task(priority: Sessions.priority) { @MainActor in Sessions.shared.named(id: id, name) }
    }

    hostLog(surface.id, .info, method)
  }
}

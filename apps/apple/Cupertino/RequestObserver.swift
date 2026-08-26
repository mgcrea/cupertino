import Foundation

/// Reads the client→server half of one connection for the activity log.
///
/// MCP over stdio is newline-delimited JSON, so requests can be picked off the
/// wire without interpreting them. One instance per connection, driven only
/// from that connection's single pump thread, which is why nothing here locks.
///
/// Best effort, and strictly non-blocking: this must never slow or break the
/// pump. It records **method names, and the name of whatever a request reached
/// for** — a tool name, a prompt name, a resource URI — never arguments, never
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

    /*
     * The three ways a client asks a server to DO something, each identified by
     * the one param that names what was asked for.
     *
     * Reading that param is not a widening of what this records. The claim on
     * screen is "method and tool names only — never arguments, never results",
     * and a prompt name and a resource URI are identities in exactly the way a
     * tool name is: `apple_mail_draft_reply` and `cupertino://mail/inventory`
     * say WHICH capability was reached, never what was passed to it or what
     * came back. The alternative is worse than verbose — before this, expanding
     * a prompt logged a bare `prompts/get` and counted as nothing, so the
     * Activity window under-reported an agent that had just been handed a
     * write workflow.
     */
    let identifier: String? =
      switch method {
      case "tools/call": params?["name"] as? String
      case "prompts/get": (params?["name"] as? String).map { "prompt: \($0)" }
      case "resources/read": (params?["uri"] as? String).map { "read: \($0)" }
      default: nil
      }

    if let identifier {
      let id = session
      Task(priority: Sessions.priority) { @MainActor in Sessions.shared.counted(id: id) }
      hostLog(surface.id, .call, identifier)
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

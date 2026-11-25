import CryptoKit
import Foundation

/// The rules for starting a session's server only when it is needed.
///
/// See docs/superpowers/specs/2026-11-25-deferred-server-spawn-design.md.
nonisolated enum DeferredSpawn {
  /// Requests the host can answer from a recorded reply, without a process.
  /// `ping` is not one of them: it is answered with `{}` and never recorded.
  static let answerable: Set<String> = [
    "initialize", "server/discover", "tools/list", "prompts/list", "resources/list",
    "resources/templates/list",
  ]

  /// The requests whose params say who the client is and what it can do.
  static let handshakes: Set<String> = ["initialize", "server/discover"]

  /// `_meta` keys whose values change from one session to the next without
  /// changing the answer.
  static let volatileMeta: Set<String> = ["progressToken"]

  /// Bytes held without a newline past which the server is started and they
  /// are forwarded raw: no list call is this big, so whatever it is, it is not
  /// one the host can answer.
  static let oversized = 64 << 10
}

/// What a session sent before its first request a server has to answer.
///
/// Fed every client frame; says one line, once, when that request arrives, or
/// at close if it never did. The line is what the deferral is measured with:
/// which methods each client opens with, whether its handshake is the same
/// from one session to the next, and which `_meta` keys ride on the requests
/// the host would answer.
nonisolated struct ConnectTraffic {
  private var methods: [String] = []
  private var meta: Set<String> = []
  private var handshake: Data?
  private var said = false

  mutating func saw(_ frame: McpFrame) -> String? {
    guard !said else { return nil }
    switch frame.kind {
    case .notification:
      methods.append(frame.method ?? "?")
      return nil
    case .request:
      let method = frame.method ?? "?"
      if method == "ping" {
        methods.append(method)
        return nil
      }
      guard DeferredSpawn.answerable.contains(method) else { break }
      methods.append(method)
      let params = frame.params as? [String: Any]
      if let keys = (params?["_meta"] as? [String: Any])?.keys { meta.formUnion(keys) }
      if handshake == nil, DeferredSpawn.handshakes.contains(method) {
        handshake = McpFrame.canonical(frame.params, droppingMeta: DeferredSpawn.volatileMeta)
      }
      return nil
    case .response, .unparsed:
      break
    }
    said = true
    return line(first: Self.label(frame))
  }

  /// The line, if `saw` never said it.
  func atClose() -> String? {
    said ? nil : line(first: "none (closed)")
  }

  private func line(first: String) -> String {
    let fingerprint = handshake.map {
      SHA256.hash(data: $0).prefix(4).map { String(format: "%02x", $0) }.joined()
    }
    return "connect: \(methods.isEmpty ? "none" : methods.joined(separator: ", "))"
      + " | meta: \(meta.isEmpty ? "none" : meta.sorted().joined(separator: ", "))"
      + " | handshake: \(fingerprint ?? "none")"
      + " | first: \(first)"
  }

  private static func label(_ frame: McpFrame) -> String {
    switch frame.kind {
    case .request, .notification: frame.method ?? "?"
    case .response: "a response"
    case .unparsed: "an unparsed line"
    }
  }
}

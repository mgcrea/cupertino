import Foundation
import os

/// Reads one connection for the activity log.
///
/// MCP over stdio is newline-delimited JSON, so frames can be picked off the
/// wire without interpreting them. One instance per connection.
///
/// **Both directions now, and they are different threads.** `saw` is driven by
/// the client→server pump and `answered` by the server→client one, which is why
/// the id table below is behind a lock where nothing here used to need one. The
/// line buffers are not shared — each direction owns its own `LineReader`, and
/// each is touched by exactly one thread.
///
/// Best effort, and strictly non-blocking: this must never slow or break a
/// pump. It records method names, the name of whatever a request reached for —
/// a tool name, a prompt name, a resource URI — and, for a surface that records
/// them, the arguments. Prose is blanked unless the surface asks for it. See
/// `CallCapture`, which owns both rules.
final class RequestObserver {
  private let surface: Surface
  private let session: UUID

  private var requests = FrameSplitter()
  private var responses = FrameSplitter()

  /// JSON-RPC id → the log row that call was recorded in.
  ///
  /// Cupertino passes client ids through untouched — one child per connection,
  /// so there is no numbering to own and nothing that already correlates a
  /// reply with its request. Bastion gets this for free from the id remapping
  /// its supervisor has to do anyway; here it is a table of its own.
  ///
  /// Locked because the two pumps are two dedicated threads: `saw` inserts and
  /// `answered` removes. Bounded, because a server that never answers would
  /// otherwise grow it for the life of the connection — and the cap is the
  /// oldest-out kind rather than a refusal, since losing the correlation for a
  /// stale request is better than losing it for a live one.
  private let waiting = OSAllocatedUnfairLock<[(key: String, row: UUID)]>(initialState: [])
  private static let waitingLimit = 256

  /// Whether this surface records anything beyond names, resolved once per
  /// connection rather than per frame — a `UserDefaults` read on a pump thread
  /// for every line is a cost with no payoff, and a setting changed mid-session
  /// applying at the next connection is the same rule the write gate follows.
  private let mode: CallCapture.Mode
  private let content: Bool

  init(surface: Surface, session: UUID) {
    self.surface = surface
    self.session = session
    self.mode = SurfaceSettings.captureMode(surface)
    self.content = SurfaceSettings.capturesContent(surface)
  }

  /// Client → server.
  func saw(_ chunk: Data) {
    for line in requests.lines(chunk) { note(line) }
  }

  /// Server → client.
  ///
  /// Only ever looked at when the surface records results — parsing every
  /// response to throw it away would be the most expensive thing on the hot
  /// path, and responses are the big frames.
  ///
  /// The cost of that: a tool that FAILED is only marked as such when results
  /// are on, because an `isError` result is a normal-looking response and the
  /// only way to know is to parse it. That is not a regression — nothing read
  /// this direction at all before — but it is the reason the red marker in the
  /// log is quiet on a surface set to arguments only. Making it always-on means
  /// paying the parse on every response, which is a trade worth making
  /// deliberately rather than by accident.
  func answered(_ chunk: Data) {
    guard mode >= .argumentsAndResults else { return }
    for line in responses.lines(chunk) { reply(line) }
  }

  private func reply(_ line: Data) {
    guard
      let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
      CallCapture.isResponse(object),
      let key = CallCapture.idKey(object["id"])
    else { return }

    let row = waiting.withLock { table -> UUID? in
      guard let index = table.firstIndex(where: { $0.key == key }) else { return nil }
      return table.remove(at: index).row
    }
    guard let row else { return }

    hostCallResult(
      row,
      CallCapture.result(object, mode: mode, content: content),
      failed: CallCapture.isFailure(object))
  }

  private func note(_ line: Data) {
    guard
      let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
      let method = object["method"] as? String
    else { return }

    let params = object["params"] as? [String: Any]

    // The three ways a client asks a server to DO something, each identified by
    // the one param that names what was asked for.
    //
    // Reading that param is not a widening of what this records. The claim on
    // screen is "method and tool names, and the arguments each was called with",
    // and a prompt name and a resource URI are identities in exactly the way a
    // tool name is: `apple_mail_draft_reply` and `cupertino://mail/inventory`
    // say WHICH capability was reached, never what was passed to it or what
    // came back. The alternative is worse than verbose — before this, expanding
    // a prompt logged a bare `prompts/get` and counted as nothing, so the
    // Activity window under-reported an agent that had just been handed a
    // write workflow.
    //
    // A surface serving its tools lazily wraps the real call one level down.
    // Both the identity below and the arguments further down have to be read
    // from the inner frame, or the row names the dispatcher and carries the
    // dispatcher's own two fields as if they were what was sent.
    var callParams = params
    if method == "tools/call", let outer = params?["name"] as? String,
      let unwrapped = CallCapture.unwrapFacade(name: outer, params: params)
    {
      // The inner frame already carries the real name under the same key, so
      // everything below reads it exactly as it reads an ordinary call.
      callParams = unwrapped.params
    }

    let identifier: String? =
      switch method {
      case "tools/call": callParams?["name"] as? String
      case "prompts/get": (params?["name"] as? String).map { "prompt: \($0)" }
      case "resources/read": (params?["uri"] as? String).map { "read: \($0)" }
      default: nil
      }

    if let identifier {
      let id = session
      Task(priority: Sessions.priority) { @MainActor in Sessions.shared.counted(id: id) }

      let arguments =
        method == "tools/call"
        ? CallCapture.arguments(params: callParams, mode: mode, content: content)
        : nil
      let row = hostCall(surface.id, identifier, arguments: arguments)

      // Only a request can be answered. A notification carries no id, and
      // remembering one would be a row waiting for a reply that cannot come.
      if mode >= .argumentsAndResults, let key = CallCapture.idKey(object["id"]) {
        waiting.withLock { table in
          table.append((key: key, row: row))
          if table.count > Self.waitingLimit { table.removeFirst(table.count - Self.waitingLimit) }
        }
      }
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

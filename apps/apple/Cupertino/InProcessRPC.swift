import Foundation

/// JSON-RPC framing and envelopes, shared by every surface the app serves itself.
///
/// Extracted when `sound` became the second one. `ScreenServer` had all of this
/// privately, and a second hand-rolled copy of "how do we spell a tool result"
/// is precisely the drift `surfaces.json` exists to end — its own header records
/// the list being hardcoded in ten places before anyone generated it. Two is
/// where that starts.
///
/// Nothing here knows about a surface. What varies per server is the tool list,
/// the tool bodies and the resources; what does not vary is the wire, so only
/// the wire lives here.
enum InProcessRPC {

  /// Matches what the node servers negotiate, so a host sees one protocol
  /// across every Cupertino surface.
  static let protocolVersion = "2024-11-05"

  /// The method switch, which is the wire and therefore belongs here.
  ///
  /// It shipped as three byte-identical copies — Desktop, Screen and Sound —
  /// differing only in the four values this takes as parameters. The header
  /// above says only the wire lives here and that two copies is where drift
  /// starts; the switch is as much the wire as the envelope is, and three
  /// copies is where it ended.
  ///
  /// **A malformed request is now `-32700`, not silence.** All three copies
  /// returned `nil` when the line did not parse, and `nil` means "notification,
  /// send nothing" — so a client that sent broken JSON, or JSON with no
  /// `method`, waited forever on an id that was never going to be answered. A
  /// parse failure has no id to answer with, which is exactly what JSON-RPC's
  /// null id is for.
  ///
  /// - Parameters:
  ///   - name: the `serverInfo.name`, e.g. `cupertino-desktop`.
  ///   - instructions: the `initialize` result's `instructions`, which a client
  ///     loads on connect without being asked — unlike a resource, which is
  ///     pull-only and so goes unread unless something names it. Paid on every
  ///     connect by every surface a client wires up, so it holds only what
  ///     changes a caller's first move and points at the guide for the rest.
  ///     Omitted from the answer entirely when nil.
  ///   - tools: the tool list, already gated.
  ///   - resources: the resource list.
  ///   - read: answers `resources/read` for one uri.
  ///   - call: answers `tools/call` for one name and its arguments.
  static func dispatch(
    _ line: String,
    name: String,
    instructions: String? = nil,
    tools: () -> [[String: Any]],
    resources: () -> [[String: Any]],
    read: (_ uri: String, _ id: Any?) -> String,
    call: (_ name: String, _ args: [String: Any], _ id: Any?) -> String
  ) -> String? {
    guard let data = line.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data),
      let msg = object as? [String: Any]
    else {
      return error(nil, code: -32700, message: "could not parse that as JSON")
    }
    guard let method = msg["method"] as? String else {
      // An id may be present here, so the reply can name it. Only the parse
      // failure above is genuinely anonymous.
      return error(msg["id"], code: -32600, message: "no 'method' in that request")
    }

    let id = msg["id"]
    // No id means a notification. Answering one is a protocol error.
    let isNotification = id == nil

    switch method {
    case "initialize":
      guard !isNotification else { return nil }
      var value: [String: Any] = [
        "protocolVersion": protocolVersion,
        "capabilities": ["tools": [String: Any](), "resources": [String: Any]()],
        "serverInfo": ["name": name, "version": AppInfo.shortVersion],
      ]
      // Absent, not null, for a surface that declares none — so their answer
      // stays byte-for-byte what it was.
      if let instructions { value["instructions"] = instructions }
      return result(id, value)

    case "ping":
      return isNotification ? nil : result(id, [String: Any]())

    case "tools/list":
      return isNotification ? nil : result(id, ["tools": tools()])

    case "resources/list":
      return isNotification ? nil : result(id, ["resources": resources()])

    case "resources/read":
      guard !isNotification else { return nil }
      return read(((msg["params"] as? [String: Any])?["uri"] as? String) ?? "", id)

    case "prompts/list":
      return isNotification ? nil : result(id, ["prompts": [Any]()])

    case "tools/call":
      guard !isNotification else { return nil }
      let params = msg["params"] as? [String: Any] ?? [:]
      return call(
        params["name"] as? String ?? "", params["arguments"] as? [String: Any] ?? [:], id)

    default:
      guard !isNotification else { return nil }
      return error(id, code: -32601, message: "unknown method '\(method)'")
    }
  }

  /// One newline-delimited JSON-RPC message. MCP's stdio framing, which the
  /// socket carries verbatim.
  static func nextLine(_ fd: Int32) -> String? {
    var out = [UInt8]()
    // Bounded: a caller that never sends a newline must not be able to grow
    // this without limit. 1 MiB is far above any real request here.
    let limit = 1 << 20
    while out.count < limit {
      var byte: UInt8 = 0
      let n = read(fd, &byte, 1)
      if n < 0 {
        if errno == EINTR { continue }
        return nil
      }
      if n == 0 { return out.isEmpty ? nil : String(decoding: out, as: UTF8.self) }
      if byte == UInt8(ascii: "\n") { return String(decoding: out, as: UTF8.self) }
      out.append(byte)
    }
    return nil
  }

  static func jsonText(_ object: Any) -> String {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
      let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  static func envelope(_ id: Any?, _ body: [String: Any]) -> String {
    var msg: [String: Any] = ["jsonrpc": "2.0"]
    msg["id"] = id ?? NSNull()
    for (k, v) in body { msg[k] = v }
    guard let data = try? JSONSerialization.data(withJSONObject: msg),
      let text = String(data: data, encoding: .utf8)
    else {
      return #"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"encode failed"}}"#
    }
    return text
  }

  static func result(_ id: Any?, _ value: Any) -> String {
    envelope(id, ["result": value])
  }

  static func error(_ id: Any?, code: Int, message: String) -> String {
    envelope(id, ["error": ["code": code, "message": message]])
  }

  /// A tool RESULT carrying text, which is what every node surface returns.
  static func ok(_ id: Any?, _ value: [String: Any]) -> String {
    result(id, ["content": [["type": "text", "text": jsonText(value)]]])
  }

  /// A tool failure is a result with `isError`, not a JSON-RPC error — the
  /// model has to be able to read why.
  static func failure(_ id: Any?, _ message: String) -> String {
    result(id, ["content": [["type": "text", "text": message]], "isError": true])
  }

  static func failed(_ id: Any?, _ error: Error) -> String {
    failure(id, error.localizedDescription)
  }

  struct Interrupted: Error, CustomStringConvertible {
    var description: String { "The request did not complete." }
  }

  /// Run an async body from the serve thread and wait for it.
  ///
  /// Safe ONLY because a surface served in-process gets a thread of its own per
  /// connection, so blocking it waits on nothing the work needs. The same
  /// pattern on the main thread would deadlock — and both current callers hop
  /// TO the main actor, which is exactly the deadlock this arrangement avoids.
  static func blocking<T>(_ body: @escaping () async throws -> T) throws -> T {
    let box = ResultBox<T>()
    let sem = DispatchSemaphore(value: 0)
    Task {
      do { box.result = .success(try await body()) } catch { box.result = .failure(error) }
      sem.signal()
    }
    sem.wait()
    guard let result = box.result else { throw Interrupted() }
    return try result.get()
  }
}

/// Carries one `Result` across the `Task` boundary in `InProcessRPC.blocking`.
///
/// `@unchecked Sendable` is honest rather than a shrug: exactly one write
/// happens before the semaphore is signalled and exactly one read after it, so
/// the semaphore is the synchronisation and the box never races itself.
final class ResultBox<T>: @unchecked Sendable {
  var result: Result<T, Error>?
}

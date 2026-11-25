import Foundation

/// What a POST to a live session comes to.
nonisolated enum PostOutcome: Equatable {
  /// No requests in it: write `lines` to the child and answer `202 Accepted`.
  /// The lines are carried so a batch of notifications reaches the child one
  /// line per member, as `.stream`'s do.
  case accepted(lines: [Data])
  /// Write `lines` to the child, in order, and answer this POST as SSE. Never
  /// empty.
  case stream(lines: [Data])
  /// Answer `status` and write nothing. `reason` is for the log.
  case invalid(status: Int, reason: String)
}

/// Where one line from the child goes.
nonisolated enum Delivery: Equatable {
  /// Send the line as one SSE event on that stream.
  case toStream(Int, Data)
  /// That POST stream has every response it was waiting for: end it.
  case closeStream(Int)
  /// No stream wants it, which the transport allows.
  case dropped
}

/// One Streamable HTTP session's routing between its HTTP streams and the
/// newline-delimited JSON-RPC stream to the host.
///
/// Pure state: no sockets, no clocks. The listener assigns stream ids, one per
/// open HTTP response stream, and tells the router when one opens or closes.
/// Ids are matched within this session only, so two sessions may both have an
/// id `2` pending without either seeing the other's response.
///
/// A response whose id is not pending (late, duplicated, or for a POST whose
/// stream has closed) is not a response to anything on a POST stream, so it
/// goes where every unrouted line goes: the GET stream, or nowhere. It is
/// never delivered to a stream that has closed.
nonisolated struct HTTPSessionRouter {
  let id: String

  private var getStream: Int?
  /// Request id, as `McpFrame.id` serialises it, to the POST stream that sent it.
  private var pending: [Data: Int] = [:]
  /// Each open POST stream's ids still waiting for a response.
  private var waiting: [Int: Set<Data>] = [:]
  /// Progress token, in canonical JSON, to the request id that registered it.
  private var tokenOwner: [Data: Data] = [:]
  /// Request id to the progress token it registered.
  private var tokenOf: [Data: Data] = [:]

  init(id: String) { self.id = id }

  var hasGet: Bool { getStream != nil }

  /// The POST streams still waiting for a response.
  var openPosts: Set<Int> { Set(waiting.keys) }

  /// Routes one POST body, sent on `stream`.
  ///
  /// The body is checked whole before anything is remembered: a refused POST
  /// leaves the session as it was.
  mutating func post(_ body: Data, stream: Int) -> PostOutcome {
    let messages: [Message]
    switch Self.messages(in: body) {
    case .failure(let refusal): return .invalid(status: 400, reason: refusal.reason)
    case .success(let parsed): messages = parsed
    }

    var ids = Set<Data>()
    for message in messages where message.frame.kind == .request {
      guard let id = message.frame.id else { continue }
      guard pending[id] == nil, ids.insert(id).inserted else {
        return .invalid(
          status: 400,
          reason: "request id \(String(decoding: id, as: UTF8.self)) is already pending")
      }
    }

    let lines = messages.map(\.line)
    guard !ids.isEmpty else { return .accepted(lines: lines) }

    for message in messages where message.frame.kind == .request {
      guard let id = message.frame.id else { continue }
      pending[id] = stream
      waiting[stream, default: []].insert(id)
      if let token = Self.progressToken(inRequest: message.frame.params) {
        tokenOwner[token] = id
        tokenOf[id] = token
      }
    }
    return .stream(lines: lines)
  }

  /// Where one line from the child goes, and whether a POST stream is done.
  mutating func fromChild(_ line: Data) -> [Delivery] {
    let frame = McpFrame.parse(line)
    if frame.kind == .response, let id = frame.id, let stream = pending[id] {
      forget(id)
      var deliveries: [Delivery] = [.toStream(stream, line)]
      waiting[stream]?.remove(id)
      if waiting[stream]?.isEmpty == true {
        waiting[stream] = nil
        deliveries.append(.closeStream(stream))
      }
      return deliveries
    }
    if frame.kind == .notification, frame.method == "notifications/progress",
      let token = Self.progressToken(inNotification: frame.params),
      let owner = tokenOwner[token], let stream = pending[owner]
    {
      return [.toStream(stream, line)]
    }
    return [getStream.map { .toStream($0, line) } ?? .dropped]
  }

  /// The session's server-to-client stream opened. A second GET replaces the
  /// first; whether to allow one is the listener's call.
  mutating func openGet(stream: Int) { getStream = stream }

  /// An HTTP response stream ended, by either side. A POST stream's pending
  /// ids and progress tokens go with it.
  mutating func closeStream(_ stream: Int) {
    if getStream == stream { getStream = nil }
    guard let ids = waiting.removeValue(forKey: stream) else { return }
    for id in ids { forget(id) }
  }

  private mutating func forget(_ id: Data) {
    pending[id] = nil
    guard let token = tokenOf.removeValue(forKey: id) else { return }
    if tokenOwner[token] == id { tokenOwner[token] = nil }
  }

  // MARK: Parsing

  struct Message {
    /// What goes to the child: one line, no CR or LF in it.
    let line: Data
    let frame: McpFrame
  }

  struct Refusal: Error {
    let reason: String
  }

  /// The JSON-RPC messages a POST body holds, one line each.
  ///
  /// A single message keeps its bytes, minus CR and LF at either end. One
  /// written over several lines (JSON allows newlines between tokens, and a
  /// raw one can only be that) is re-serialised, since a line stream cannot
  /// carry it. Batch members are always re-serialised.
  static func messages(in body: Data) -> Result<[Message], Refusal> {
    guard
      let value = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])
    else { return .failure(Refusal(reason: "body is not JSON")) }

    if let batch = value as? [Any] {
      guard !batch.isEmpty else { return .failure(Refusal(reason: "batch is empty")) }
      var messages: [Message] = []
      for member in batch {
        guard member is [String: Any], let line = serialise(member) else {
          return .failure(Refusal(reason: "batch member is not an object"))
        }
        guard let message = message(line) else {
          return .failure(Refusal(reason: "batch member is not a JSON-RPC message"))
        }
        messages.append(message)
      }
      return .success(messages)
    }

    guard value is [String: Any] else {
      return .failure(Refusal(reason: "body is neither an object nor a batch"))
    }
    var line = trimmingLineEnds(body)
    if line.contains(cr) || line.contains(lf) {
      guard let flat = serialise(value) else {
        return .failure(Refusal(reason: "body could not be written as one line"))
      }
      line = flat
    }
    guard let message = message(line) else {
      return .failure(Refusal(reason: "body is not a JSON-RPC message"))
    }
    return .success([message])
  }

  private static let cr = UInt8(ascii: "\r")
  private static let lf = UInt8(ascii: "\n")

  private static func message(_ line: Data) -> Message? {
    let frame = McpFrame.parse(line)
    return frame.kind == .unparsed ? nil : Message(line: line, frame: frame)
  }

  private static func serialise(_ value: Any) -> Data? {
    try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])
  }

  private static func trimmingLineEnds(_ body: Data) -> Data {
    var start = body.startIndex
    var end = body.endIndex
    while start < end, body[start] == cr || body[start] == lf { start += 1 }
    while end > start, body[end - 1] == cr || body[end - 1] == lf { end -= 1 }
    return LineBuffer.copy(body[start..<end])
  }

  // MARK: Progress tokens

  static func progressToken(inRequest params: Any?) -> Data? {
    let meta = (params as? [String: Any])?["_meta"] as? [String: Any]
    return canonicalToken(meta?["progressToken"])
  }

  static func progressToken(inNotification params: Any?) -> Data? {
    canonicalToken((params as? [String: Any])?["progressToken"])
  }

  /// A string or integer token as JSON, so `"7"` and `7` stay apart. Anything
  /// else (a boolean, a fraction, an object) is no token: the spec allows only
  /// those two, and a progress notification carrying one is left unrouted.
  static func canonicalToken(_ value: Any?) -> Data? {
    switch value {
    case let string as String:
      return try? JSONSerialization.data(
        withJSONObject: string, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    case let number as NSNumber:
      guard CFGetTypeID(number) != CFBooleanGetTypeID(), !CFNumberIsFloatType(number) else {
        return nil
      }
      return Data(number.stringValue.utf8)
    default:
      return nil
    }
  }
}

/// What a POST carrying no `Mcp-Session-Id` comes to.
nonisolated enum PreSession: Equatable {
  /// A single `initialize` request: open a session and route the POST to it.
  case initialize
  /// A `server/discover`: answer `status` with `body`, a `-32601` error.
  case discoverRefused(status: Int, body: Data)
  /// Anything else, a batch included.
  case invalid(status: Int)
}

nonisolated enum HTTPSessionGate {
  /// Decides a POST that names no session.
  ///
  /// Only a single `initialize` request opens one. A batch never does, even a
  /// batch holding `initialize`: the 2025-06-18 revision dropped batches, and
  /// the handshake's response must be the session's first and only answer on
  /// the stream that carries `Mcp-Session-Id`.
  static func preSession(_ body: Data) -> PreSession {
    guard
      let value = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]),
      value is [String: Any]
    else { return .invalid(status: 400) }
    let frame = McpFrame.parse(body)
    guard frame.kind == .request, let id = frame.id else { return .invalid(status: 400) }
    switch frame.method {
    case "initialize":
      return .initialize
    case "server/discover":
      var answer = Data(#"{"jsonrpc":"2.0","id":"#.utf8)
      answer.append(id)
      answer.append(
        Data(
          #","error":{"code":-32601,"message":"Method not found: server/discover; use initialize"}}"#
            .utf8))
      return .discoverRefused(status: DiscoverRefusal.status, body: answer)
    default:
      return .invalid(status: 400)
    }
  }
}

nonisolated enum SessionID {
  /// 128 bits from the system's CSPRNG, as 32 lowercase hex characters.
  static func mint() -> String {
    var generator = SystemRandomNumberGenerator()
    return (0..<16).map { _ in
      String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator))
    }
    .joined()
  }

  /// Exactly what `mint` makes: 32 characters of `0-9a-f`.
  static func isWellFormed(_ id: String) -> Bool {
    let utf8 = id.utf8
    return utf8.count == 32
      && utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }
}

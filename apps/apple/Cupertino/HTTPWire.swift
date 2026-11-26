import Foundation

/// The request line and headers of one HTTP/1.1 request, read before its body.
///
/// This stands in for `swift-mcp-kit`'s `HTTPParser` until the kit can return a
/// head before its body. The kit's `parse` hands back the head only once the
/// whole body has arrived, and it refuses any body over 4 MiB as malformed,
/// so the gate could not run before the body is read and a large `tools/call`
/// could not arrive at all. The header rules are the kit's, so swapping this
/// for a kit `parseHead` later changes nothing a client sees:
///
/// - lines end in CRLF and the head ends at the first empty line;
/// - the request line is split on spaces, the method uppercased, and the
///   target's query string dropped;
/// - header names are lowercased, values trimmed;
/// - a field sent more than once is joined with a bare `,`, in the order sent,
///   so a second `Host` or `Authorization` never quietly replaces the first.
///
/// Refusals the kit does not make: a head over `maxHeadBytes` (431), and
/// (400) a line still holding a CR, an LF or a NUL after the split, a header
/// with an empty name, whitespace between a name and its colon, and a line
/// folded onto the one before it (obs-fold, a line opening with a space or a
/// tab). A bare LF inside a value would otherwise ride into a header the gate
/// reads, and RFC 9112 has a server reject the other two rather than guess
/// which header a folded or spaced line belongs to.
nonisolated enum HTTPHeadParser {
  /// The largest head accepted, request line and headers and the blank line.
  static let maxHeadBytes = 16 * 1024

  enum Outcome: Equatable {
    /// More bytes are needed. TCP may split anywhere.
    case incomplete
    /// The head, and the index in the buffer where the body starts.
    case head(HTTPHead, bodyStart: Int)
    /// No blank line within `maxHeadBytes`: answer 431 and close.
    case tooLarge
    /// Answer 400 and close.
    case malformed(String)
  }

  private static let terminator: [UInt8] = [13, 10, 13, 10]

  static func parse(_ buffer: [UInt8]) -> Outcome {
    guard let end = headEnd(buffer) else {
      return buffer.count >= maxHeadBytes ? .tooLarge : .incomplete
    }
    guard end + terminator.count <= maxHeadBytes else { return .tooLarge }
    guard let text = String(bytes: buffer[..<end], encoding: .utf8) else {
      return .malformed("the head is not UTF-8")
    }
    var lines = text.components(separatedBy: "\r\n")
    let requestLine = lines.removeFirst()
    guard !([requestLine] + lines).contains(where: Self.holdsControl) else {
      return .malformed("a line holds a bare CR, LF or NUL")
    }

    let parts = requestLine.split(separator: " ", omittingEmptySubsequences: true)
    guard parts.count >= 2 else { return .malformed("malformed request line") }
    let method = String(parts[0]).uppercased()
    let target = String(
      parts[1].split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])

    var fields: [String: String] = [:]
    for line in lines where !line.isEmpty {
      if line.first == " " || line.first == "\t" {
        return .malformed("a header line folded onto the one before it")
      }
      guard let colon = line.firstIndex(of: ":") else {
        return .malformed("malformed header line")
      }
      let raw = line[..<colon]
      guard !raw.isEmpty else { return .malformed("a header with no name") }
      guard raw.last != " ", raw.last != "\t" else {
        return .malformed("whitespace between a header name and its colon")
      }
      let name = String(raw).lowercased()
      let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      fields[name] = fields[name].map { "\($0),\(value)" } ?? value
    }
    return .head(
      HTTPHead(method: method, path: target, headers: fields), bodyStart: end + terminator.count)
  }

  /// The index of the first CRLFCRLF, searched within the head cap only.
  private static func headEnd(_ buffer: [UInt8]) -> Int? {
    let limit = min(buffer.count, maxHeadBytes + terminator.count)
    guard limit >= terminator.count else { return nil }
    var i = 0
    while i <= limit - terminator.count {
      if buffer[i] == 13, buffer[i + 1] == 10, buffer[i + 2] == 13, buffer[i + 3] == 10 {
        return i
      }
      i += 1
    }
    return nil
  }

  private static func holdsControl(_ line: String) -> Bool {
    line.utf8.contains { $0 == 13 || $0 == 10 || $0 == 0 }
  }

  /// The declared body length: nil for none, `.failure` for a value that is
  /// not one non-negative decimal number. Two `Content-Length` fields arrive
  /// joined (`10,10`) and are refused, as RFC 9112 allows, rather than one of
  /// them being picked.
  static func contentLength(_ head: HTTPHead) -> Result<Int, ContentLengthError>? {
    guard let raw = head.header("content-length") else { return nil }
    guard !raw.isEmpty, raw.utf8.count <= 18, raw.utf8.allSatisfy({ (48...57).contains($0) }),
      let value = Int(raw)
    else { return .failure(ContentLengthError()) }
    return .success(value)
  }

  struct ContentLengthError: Error, Equatable {}
}

/// A ceiling on concurrent HTTP connections, taken before a thread is made
/// for one.
///
/// Stands in for `swift-mcp-kit`'s `ConnectionBudget`, which the kit keeps
/// internal; the shape is the kit's. The order is the point: a listener that
/// spawns the thread and then finds itself over budget has already paid for
/// the thread.
nonisolated final class HTTPConnectionBudget: @unchecked Sendable {
  private let limit: Int
  private var inFlight = 0
  private let lock = NSLock()

  init(limit: Int) { self.limit = limit }

  /// Takes a slot, or false when there is none.
  func acquire() -> Bool {
    lock.withLock {
      guard inFlight < limit else { return false }
      inFlight += 1
      return true
    }
  }

  func release() { lock.withLock { inFlight = max(0, inFlight - 1) } }

  var current: Int { lock.withLock { inFlight } }
}

/// The bytes the listener writes: response heads, plain responses, and SSE
/// events framed in HTTP/1.1 chunks.
///
/// Every SSE response is chunked, so the connection it went over can carry the
/// next request once the stream ends: keep-alive holds for streams as for
/// every other answer.
nonisolated enum HTTPWire {
  static func reason(_ status: Int) -> String {
    switch status {
    case 200: "OK"
    case 202: "Accepted"
    case 400: "Bad Request"
    case 401: "Unauthorized"
    case 403: "Forbidden"
    case 404: "Not Found"
    case 405: "Method Not Allowed"
    case 413: "Content Too Large"
    case 431: "Request Header Fields Too Large"
    case 500: "Internal Server Error"
    case 501: "Not Implemented"
    case 503: "Service Unavailable"
    default: "Status"
    }
  }

  /// A response head. `fields` are written in the order given.
  static func head(_ status: Int, _ fields: [(String, String)], close: Bool) -> Data {
    var text = "HTTP/1.1 \(status) \(reason(status))\r\n"
    for (name, value) in fields { text += "\(name): \(value)\r\n" }
    if close { text += "Connection: close\r\n" }
    text += "\r\n"
    return Data(text.utf8)
  }

  /// A whole response with a body of known length.
  static func response(
    _ status: Int, body: Data = Data(), contentType: String? = nil,
    extra: [(String, String)] = [], close: Bool
  ) -> Data {
    var fields = extra
    if let contentType { fields.append(("Content-Type", contentType)) }
    fields.append(("Content-Length", String(body.count)))
    return head(status, fields, close: close) + body
  }

  /// A refusal, with a JSON-RPC error body that names why. `reason` is the
  /// gate's or the listener's sentence, never a token.
  static func refusal(_ status: Int, _ reason: String, close: Bool, extra: [(String, String)] = [])
    -> Data
  {
    let frame: [String: Any] = [
      "jsonrpc": "2.0", "id": NSNull(),
      "error": ["code": status == 404 ? -32001 : -32600, "message": reason],
    ]
    let body =
      (try? JSONSerialization.data(withJSONObject: frame, options: [.withoutEscapingSlashes]))
      ?? Data()
    return response(
      status, body: body, contentType: "application/json", extra: extra, close: close)
  }

  /// The head of an SSE response.
  static func streamHead(sessionID: String?, close: Bool) -> Data {
    var fields: [(String, String)] = [
      ("Content-Type", "text/event-stream"), ("Cache-Control", "no-cache"),
      ("Transfer-Encoding", "chunked"),
    ]
    if let sessionID { fields.append(("Mcp-Session-Id", sessionID)) }
    return head(200, fields, close: close)
  }

  /// One JSON-RPC line as one SSE event, in one chunk.
  static func event(_ line: Data) -> Data {
    chunk(Data("event: message\ndata: ".utf8) + line + Data("\n\n".utf8))
  }

  static func chunk(_ payload: Data) -> Data {
    Data("\(String(payload.count, radix: 16))\r\n".utf8) + payload + Data("\r\n".utf8)
  }

  /// The last chunk, which ends a chunked body.
  static let lastChunk = Data("0\r\n\r\n".utf8)

  /// An SSE comment, in one chunk: framing a client reads and ignores, so a
  /// held stream with nothing to say still writes.
  static let keepAlive = chunk(Data(": \n\n".utf8))
}

/// Identical refusal lines, coalesced: the first is logged at once, the same
/// line again within `window` is only counted, and the count is logged as one
/// line when the window ends. A page in a browser can make a refused request
/// per `<img>`, and each used to be a line of its own.
///
/// Pure: the caller hands in the time, logs what `note` and `due` return, and
/// calls `due` once a window it opened has ended.
nonisolated struct HTTPRefusalLog {
  static let window: TimeInterval = 10

  private struct Held {
    let since: Date
    var more = 0
  }
  private var held: [String: Held] = [:]

  /// The lines to log now for one refusal: the line itself when it opens a
  /// window, nothing while one is open, and a window that ended unclosed
  /// gives its count first.
  mutating func note(_ line: String, at now: Date) -> [String] {
    if let open = held[line] {
      if now.timeIntervalSince(open.since) < Self.window {
        held[line]?.more += 1
        return []
      }
      held[line] = Held(since: now)
      return (open.more > 0 ? [Self.summary(line, open.more)] : []) + [line]
    }
    held[line] = Held(since: now)
    return [line]
  }

  /// The counts of every window that has ended, one line each, and those
  /// windows closed. A window nothing repeated in closes silently.
  mutating func due(at now: Date) -> [String] {
    var out: [String] = []
    for (line, open) in held.sorted(by: { $0.key < $1.key })
    where now.timeIntervalSince(open.since) >= Self.window {
      held[line] = nil
      if open.more > 0 { out.append(Self.summary(line, open.more)) }
    }
    return out
  }

  static func summary(_ line: String, _ more: Int) -> String { "\(line) …and \(more) more" }
}

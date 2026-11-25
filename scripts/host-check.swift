import Foundation

/// Drives `ServerHost` over a real socket: the handshake, the eviction
/// watchdog, and a stop that has to return.
///
/// ## Why this exists
///
/// `ServerHost` is the highest-risk file in the app — three separate multi-hour
/// production incidents are recorded in its own comments — and until now nothing
/// exercised it at all. Every other gate drives a server; none drives the thing
/// that accepts the connection, checks the gates and tears the socket down.
///
/// Two of the assertions below are regression tests for defects recorded in
/// `ServerHost` itself, both of which shipped with every other gate green:
///
///   * **The eviction watchdog never fired.** `acceptLoop` blocks in `accept(2)`
///     for the life of the process and used to be dispatched onto `queue`,
///     which is SERIAL — so it owned that queue outright and the timer scheduled
///     on it never ran once. The watchdog was written after a 3½-hour incident in
///     which an evicted host went on accepting on an inode no path pointed at,
///     and it had been dead ever since. `acceptLoop` now runs on a thread of its
///     own; this is what keeps it there.
///
///   * **`stop()` has to return.** A stop that blocks on anything long-running
///     is an app that cannot quit or update, so it is timed here.
///
/// `BridgeProtocol`'s HOME is replaced rather than the file compiled as is, and
/// that is what makes this runnable at all: the real one derives its path from
/// `homeDirectoryForCurrentUser`, which ignores `$HOME`, so an unchanged copy
/// would fight the installed Cupertino for its lock and its socket. `make
/// host-check` compiles a copy in which that one expression reads
/// `HostCheckHome.url` instead, so the wire format, the identifiers and the
/// socket helpers are the shipped ones and only the root moves. The check then
/// asserts the path it got, which also catches the substitution not happening.
///
/// Run with `make host-check`.

/// The home the socket path is built from, in place of the user's own.
///
/// Under `/tmp` rather than `NSTemporaryDirectory()`: a `sockaddr_un` path is
/// capped at 104 bytes, and `/var/folders/…/T/` plus `Library/Application
/// Support/io.mgcrea.cupertino/cupertino.sock` does not fit in it.
enum HostCheckHome {
  nonisolated(unsafe) static var url = URL(fileURLWithPath: "/tmp", isDirectory: true)
}

/// Set by a SIGTERM handler, which can capture nothing.
enum HostCheckSignals {
  nonisolated(unsafe) static var terminated: sig_atomic_t = 0
}

/// `AppInfo` reaches for screenshot-mode state, and that pulls half the app in
/// behind it.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}

/// A stand-in for the Screen server, compiled in place of `ScreenServer.swift`.
///
/// The loop under test is `ServerHost.serveInProcess`, which every in-process
/// surface shares, and checking it needs a call that is still running when the
/// next frame arrives. No real surface has one that is safe to run here, and
/// giving `InProcessServers.handle` a test branch would put a hook in the app
/// for the sake of a check. So `make host-check` leaves the real Screen server
/// out and this answers under its name instead: the handshake, the enablement
/// check, the dispatch in `InProcessServers` and the loop are the shipped ones,
/// and only the work at the bottom is a stub. `screen-check` and
/// `dispatch-check` cover the real server.
///
/// `test/slow` registers a canceller the way a long call does, and waits for
/// it for up to three seconds. `test/late` does the same after a 300 ms pause
/// before registering, which is the window in which a hang-up or a cancel can
/// beat the call to `register`. The connection it registers under comes from
/// the thread that handles the call, which is also what `test/where` reports:
/// `DrivingSession` finds its connection the same way.
enum ScreenServer {
  /// Signalled once `test/slow` has registered its canceller.
  nonisolated(unsafe) static var registered = DispatchSemaphore(value: 0)
  /// Signalled by the canceller.
  nonisolated(unsafe) static var cancelled = DispatchSemaphore(value: 0)
  /// Signalled when `test/late` is about to pause, before it registers.
  nonisolated(unsafe) static var pausing = DispatchSemaphore(value: 0)
  /// The connection the last call arrived on.
  nonisolated(unsafe) static var connection: UUID?

  static func handle(
    _ line: String, surface: Surface, captureAllowed: Bool, anyAppAllowed: Bool,
    targetEnabled: @escaping (Surface) -> Bool
  ) -> String? {
    guard let data = line.data(using: .utf8),
      let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let method = msg["method"] as? String
    else { return nil }
    guard let id = msg["id"] else { return nil }
    let connection = Thread.current.threadDictionary[DrivingSession.connectionKey] as? UUID
    Self.connection = connection
    switch method {
    case "ping":
      return InProcessRPC.result(id, [String: Any]())
    case "test/where":
      return InProcessRPC.result(id, ["connectionKey": connection != nil])
    case "test/slow", "test/late":
      if method == "test/late" {
        pausing.signal()
        Thread.sleep(forTimeInterval: 0.3)
      }
      guard let connection, let key = InProcessCalls.requestId(id) else {
        return InProcessRPC.error(id, code: -32603, message: "no connection on this thread")
      }
      let gone = DispatchSemaphore(value: 0)
      let observed = cancelled
      let token = InProcessCalls.register(connection: connection, requestId: key) {
        gone.signal()
        observed.signal()
      }
      defer { token.done() }
      registered.signal()
      let wasCancelled = gone.wait(timeout: .now() + 3) == .success
      return InProcessRPC.result(id, ["cancelled": wasCancelled])
    default:
      return InProcessRPC.error(id, code: -32601, message: "unknown method '\(method)'")
    }
  }
}

/// One in-process connection past its handshake, as an MCP client holds it.
///
/// A `self` handshake, because this process is the host's own and that is the
/// one admission the licence gate does not stand in front of: the check machine
/// is unlicensed, and the loop is what is under test, not the gate.
final class Client {
  enum Read: Equatable {
    case line(String)
    case closed
    case timedOut
  }

  private(set) var fd: Int32

  convenience init?(server: String) {
    self.init(handshake: BridgeProtocol.selfHandshake(server: server))
  }

  /// Past `line`, a whole handshake with its newline, once the host said ok.
  init?(handshake line: String) {
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0, let address = unixAddress(BridgeProtocol.socketPath) else { return nil }
    guard address.withSockaddr({ connect(fd, $0, $1) }) == 0 else {
      close(fd)
      return nil
    }
    send(line, newline: false)
    guard next(within: 2) == .line(BridgeProtocol.ok) else {
      close(fd)
      return nil
    }
  }

  deinit { hangUp() }

  func send(_ text: String, newline: Bool = true) {
    let bytes = Array((newline ? text + "\n" : text).utf8)
    var offset = 0
    while offset < bytes.count {
      let n = bytes.withUnsafeBufferPointer {
        write(fd, $0.baseAddress! + offset, $0.count - offset)
      }
      if n < 0, errno == EINTR { continue }
      guard n > 0 else { return }
      offset += n
    }
  }

  /// The ids of every reply that arrives within `seconds`, in order.
  func ids(within seconds: Double) -> [Int] {
    var ids: [Int] = []
    let deadline = Date().addingTimeInterval(seconds)
    while case .line(let text) = next(within: deadline.timeIntervalSinceNow) {
      let msg = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
      ids.append(msg?["id"] as? Int ?? -1)
    }
    return ids
  }

  /// The ids of the replies up to and including the one for `last`, waited
  /// for up to `seconds`, then of whatever else arrives within `drain`.
  ///
  /// Returns as soon as `last` is answered, so a generous deadline costs
  /// nothing when the server is quick and covers a cold node start on a loaded
  /// machine. The drain is what shows a duplicate: one more id after `last`.
  func ids(until last: Int, within seconds: Double = 5, drain: Double = 0) -> [Int] {
    var ids: [Int] = []
    let deadline = Date().addingTimeInterval(seconds)
    while case .line(let text) = next(within: deadline.timeIntervalSinceNow) {
      let msg = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
      let id = msg?["id"] as? Int ?? -1
      ids.append(id)
      if id == last { break }
    }
    return drain > 0 ? ids + self.ids(within: drain) : ids
  }

  /// The next line, or why there is none within `seconds`.
  func next(within seconds: Double) -> Read {
    let deadline = Date().addingTimeInterval(seconds)
    var out = [UInt8]()
    while true {
      let left = deadline.timeIntervalSinceNow
      guard left > 0 else { return .timedOut }
      var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&poller, 1, Int32(left * 1000))
      if ready < 0, errno == EINTR { continue }
      guard ready > 0 else { return .timedOut }
      var byte: UInt8 = 0
      let n = read(fd, &byte, 1)
      if n <= 0 { return .closed }
      if byte == UInt8(ascii: "\n") { return .line(String(decoding: out, as: UTF8.self)) }
      out.append(byte)
    }
  }

  /// Whether the host closes the connection within `seconds`, past any
  /// replies still on their way. Returns as soon as it does.
  func closed(within seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while true {
      switch next(within: deadline.timeIntervalSinceNow) {
      case .closed: return true
      case .timedOut: return false
      case .line: continue
      }
    }
  }

  /// The `result` of the next reply, if it is one for `id`.
  func result(for id: Int, within seconds: Double) -> [String: Any]? {
    guard case .line(let text) = next(within: seconds),
      let msg = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
      msg["id"] as? Int == id
    else { return nil }
    return msg["result"] as? [String: Any]
  }

  func hangUp() {
    guard fd >= 0 else { return }
    close(fd)
    fd = -1
  }
}

/// A raw HTTP/1.1 client on a loopback TCP socket, with no `URLSession`, so the
/// bytes the listener writes are exactly the bytes read here.
///
/// One request at a time, over one connection that stays open between them,
/// which is what keep-alive is for. An SSE body is read as it comes, one event
/// at a time, out of its chunks.
final class HTTPProbe {
  enum Event: Equatable {
    case message(String)
    /// The body ended: the last chunk, or the connection closed.
    case ended
    case timedOut
  }

  private(set) var fd: Int32
  private var raw: [UInt8] = []
  private var decoded: [UInt8] = []
  private var chunked = false
  private var bodyEnded = false
  private var peerClosed = false
  private(set) var status = 0
  private(set) var headers: [String: String] = [:]

  init?(port: Int) {
    fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(port).bigEndian)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard connected == 0 else {
      close(fd)
      return nil
    }
  }

  deinit { hangUp() }

  func hangUp() {
    guard fd >= 0 else { return }
    close(fd)
    fd = -1
  }

  @discardableResult
  func send(_ text: String) -> Bool { send(Data(text.utf8)) }

  @discardableResult
  func send(_ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
        if n < 0, errno == EINTR { continue }
        guard n > 0 else { return false }
        offset += n
      }
      return true
    }
  }

  /// One request, written whole.
  @discardableResult
  func request(_ method: String, _ path: String, headers: [(String, String)], body: Data? = nil)
    -> Bool
  {
    var text = "\(method) \(path) HTTP/1.1\r\n"
    for (name, value) in headers { text += "\(name): \(value)\r\n" }
    if let body { text += "Content-Length: \(body.count)\r\n" }
    text += "\r\n"
    return send(Data(text.utf8) + (body ?? Data()))
  }

  /// At least one more byte into `raw`, by `deadline`.
  private func fill(_ deadline: Date) -> Bool {
    guard !peerClosed else { return false }
    while true {
      let left = deadline.timeIntervalSinceNow
      guard left > 0 else { return false }
      var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&poller, 1, Int32(max(1, left * 1000)))
      if ready < 0, errno == EINTR { continue }
      guard ready > 0 else { return false }
      var chunk = [UInt8](repeating: 0, count: 256 * 1024)
      let n = read(fd, &chunk, chunk.count)
      if n < 0, errno == EINTR { continue }
      if n <= 0 {
        peerClosed = true
        return false
      }
      raw.append(contentsOf: chunk[0..<n])
      return true
    }
  }

  private func line(_ deadline: Date) -> String? {
    while true {
      if let end = (0..<max(0, raw.count - 1)).first(where: { raw[$0] == 13 && raw[$0 + 1] == 10 })
      {
        let text = String(decoding: raw[..<end], as: UTF8.self)
        raw.removeFirst(end + 2)
        return text
      }
      guard fill(deadline) else { return nil }
    }
  }

  private func take(_ count: Int, _ deadline: Date) -> [UInt8]? {
    while raw.count < count { guard fill(deadline) else { return nil } }
    defer { raw.removeFirst(count) }
    return Array(raw[..<count])
  }

  /// The status line and headers of the next response, within `seconds`.
  func head(within seconds: Double) -> Int? {
    let deadline = Date().addingTimeInterval(seconds)
    guard let first = line(deadline) else { return nil }
    let parts = first.split(separator: " ")
    guard parts.count >= 2, let code = Int(parts[1]) else { return nil }
    var fields: [String: String] = [:]
    while let field = line(deadline), !field.isEmpty {
      guard let colon = field.firstIndex(of: ":") else { continue }
      fields[field[..<colon].lowercased()] = field[field.index(after: colon)...]
        .trimmingCharacters(in: .whitespaces)
    }
    status = code
    headers = fields
    chunked = fields["transfer-encoding"]?.lowercased() == "chunked"
    bodyEnded = false
    decoded = []
    return code
  }

  /// A body of `Content-Length`, or a whole chunked one.
  func body(within seconds: Double) -> Data? {
    let deadline = Date().addingTimeInterval(seconds)
    if chunked {
      while !bodyEnded { guard nextChunk(deadline) else { return nil } }
      defer { decoded = [] }
      return Data(decoded)
    }
    return take(Int(headers["content-length"] ?? "0") ?? 0, deadline).map { Data($0) }
  }

  private func nextChunk(_ deadline: Date) -> Bool {
    guard let size = line(deadline), let count = Int(size, radix: 16) else { return false }
    if count == 0 {
      _ = line(deadline)
      bodyEnded = true
      return true
    }
    guard let payload = take(count, deadline), take(2, deadline) != nil else { return false }
    decoded += payload
    return true
  }

  /// The next SSE message's data, or why there is none within `seconds`.
  func event(within seconds: Double) -> Event {
    let deadline = Date().addingTimeInterval(seconds)
    while true {
      if let end = (0..<max(0, decoded.count - 1)).first(where: {
        decoded[$0] == 10 && decoded[$0 + 1] == 10
      }) {
        let block = String(decoding: decoded[..<end], as: UTF8.self)
        decoded.removeFirst(end + 2)
        let data = block.split(separator: "\n").filter { $0.hasPrefix("data: ") }
          .map { String($0.dropFirst(6)) }.joined(separator: "\n")
        return .message(data)
      }
      if bodyEnded || peerClosed { return .ended }
      if !nextChunk(deadline) { return peerClosed ? .ended : .timedOut }
    }
  }

  /// Every SSE message until the stream ends, waited for up to `seconds`.
  func messages(within seconds: Double) -> [String] {
    let deadline = Date().addingTimeInterval(seconds)
    var out: [String] = []
    while case .message(let data) = event(within: deadline.timeIntervalSinceNow) {
      out.append(data)
    }
    return out
  }

  /// Whether the server closes this connection within `seconds`.
  func closed(within seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while fill(deadline) {}
    return peerClosed
  }
}

/// One MCP session over HTTP, as a client speaking Streamable HTTP holds it.
final class HTTPMCP {
  let port: Int
  let surface: String
  let token: String
  var id: String?
  let probe: HTTPProbe

  init?(port: Int, surface: String = "mail", token: String = "t1") {
    guard let probe = HTTPProbe(port: port) else { return nil }
    self.port = port
    self.surface = surface
    self.token = token
    self.probe = probe
  }

  var headers: [(String, String)] {
    var fields = [
      ("Host", "127.0.0.1:\(port)"), ("Authorization", "Bearer \(token)"),
      ("Accept", "application/json, text/event-stream"), ("Content-Type", "application/json"),
    ]
    if let id {
      fields.append(("Mcp-Session-Id", id))
      fields.append(("MCP-Protocol-Version", "2025-06-18"))
    }
    return fields
  }

  /// POSTs `body`, and the status with every message of its stream, or the
  /// plain body's text for an answer that is not a stream.
  func post(_ body: String, within seconds: Double = 5) -> (status: Int?, messages: [String]) {
    probe.request("POST", "/s/\(surface)", headers: headers, body: Data(body.utf8))
    guard let status = probe.head(within: seconds) else { return (nil, []) }
    if probe.headers["content-type"] == "text/event-stream" {
      return (status, probe.messages(within: seconds))
    }
    let text = probe.body(within: seconds).map { String(decoding: $0, as: UTF8.self) } ?? ""
    return (status, text.isEmpty ? [] : [text])
  }

  /// `initialize`, keeping the session id it was answered with: the whole
  /// answer, a result or an error.
  func initialize() -> [String: Any]? {
    let (status, messages) = post(Frames.initialize)
    guard status == 200, let session = probe.headers["mcp-session-id"] else { return nil }
    id = session
    return messages.first.flatMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
    }
  }

  /// The whole opening a client makes: initialize, initialized, tools/list.
  func open(token progress: Int = 900) -> Bool {
    guard initialize() != nil else { return false }
    guard post(Frames.initialized).status == 202 else { return false }
    return post(Frames.list(token: progress)).messages.count == 1
  }

  func result(_ line: String) -> [String: Any]? {
    let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
    return message?["result"] as? [String: Any]
  }

  /// Opens the session's GET stream on a connection of its own, which is
  /// returned once its head has arrived.
  func openGet() -> HTTPProbe? {
    guard let get = HTTPProbe(port: port) else { return nil }
    get.request("GET", "/s/\(surface)", headers: headers)
    return get.head(within: 5) == 200 ? get : nil
  }

  func delete() -> Int? {
    probe.request("DELETE", "/s/\(surface)", headers: headers)
    let status = probe.head(within: 5)
    _ = probe.body(within: 5)
    return status
  }
}

/// A `TokenVault` in memory: host-check never reads or writes the Keychain.
final class MemoryTokenVault: TokenVault, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String: String]
  init(_ items: [String: String]) { self.items = items }
  func read(_ client: String) throws -> String? { lock.withLock { items[client] } }
  func write(_ client: String, _ token: String) throws { lock.withLock { items[client] = token } }
  func delete(_ client: String) throws { _ = lock.withLock { items.removeValue(forKey: client) } }
  func all() throws -> [String: String] { lock.withLock { items } }
}

/// The stub MCP server `run` starts in place of a real one, and what it saw.
///
/// `ServerHost.locateOverride` points mail at it. Its environment is the one
/// the host computes, which is also the cache key, so the stub is not given
/// `STUB_LOG` or `STUB_SKEW` by the host: `entry` sets them and then loads it.
/// The skew is read from a file at the stub's start, so one session can be
/// skewed without changing the key every other session is served under.
enum Stub {
  nonisolated(unsafe) static var log = URL(fileURLWithPath: "/dev/null")
  nonisolated(unsafe) static var skewFile = URL(fileURLWithPath: "/dev/null")
  nonisolated(unsafe) static var entry = URL(fileURLWithPath: "/dev/null")

  /// Writes the entry script into `directory` and returns the binaries to serve.
  static func install(node: String, stub: String, in directory: URL) -> ServerBinaries {
    log = directory.appendingPathComponent("stub.log")
    skewFile = directory.appendingPathComponent("stub.skew")
    entry = directory.appendingPathComponent("stub-entry.mjs")
    let script = """
      import { readFileSync } from "node:fs";
      process.env.STUB_LOG = \(quoted(log.path));
      try {
        process.env.STUB_SKEW = readFileSync(\(quoted(skewFile.path)), "utf8").trim();
      } catch {}
      await import(\(quoted(URL(fileURLWithPath: stub).absoluteString)));
      """
    FileManager.default.createFile(atPath: entry.path, contents: Data(script.utf8))
    FileManager.default.createFile(atPath: log.path, contents: Data())
    return ServerBinaries(
      node: URL(fileURLWithPath: node), script: entry, isDevelopment: false)
  }

  private static func quoted(_ text: String) -> String {
    String(
      decoding: try! JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed),
      as: UTF8.self)
  }

  static func skew(_ method: String?) {
    if let method {
      FileManager.default.createFile(atPath: skewFile.path, contents: Data(method.utf8))
    } else {
      try? FileManager.default.removeItem(at: skewFile)
    }
  }

  /// What a stub writes to the log as it boots, before it reads anything.
  static let bootLine = "started"

  /// Every line a stub logged, with its pid: its boot line, then every line it read.
  static func entries() -> [(pid: String, line: String)] {
    let text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
    return text.split(separator: "\n").compactMap { row in
      guard let space = row.firstIndex(of: " ") else { return nil }
      return (String(row[..<space]), String(row[space...].dropFirst()))
    }
  }

  static func pids() -> Set<String> { Set(entries().map(\.pid)) }

  /// Every stub that booted, whether or not it was written to.
  static func started() -> Set<String> {
    Set(entries().filter { $0.line == bootLine }.map(\.pid))
  }

  /// The lines `pid` read, without its boot line.
  static func lines(of pid: String) -> [String] {
    entries().filter { $0.pid == pid && $0.line != bootLine }.map(\.line)
  }

  /// Whether `pid` has exited, within `seconds`.
  static func exited(_ pid: String, within seconds: Double) -> Bool {
    guard let number = Int32(pid) else { return false }
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
      if kill(number, 0) != 0, errno == ESRCH { return true }
      Thread.sleep(forTimeInterval: 0.02)
    } while Date() < deadline
    return false
  }

  /// A pid not in `known` that has booted, within `seconds`.
  static func newPid(besides known: Set<String>, within seconds: Double) -> String? {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
      if let pid = pids().subtracting(known).first { return pid }
      Thread.sleep(forTimeInterval: 0.02)
    } while Date() < deadline
    return nil
  }

  /// Waits until `pid` has read `count` lines, within `seconds`.
  static func lines(of pid: String, count: Int, within seconds: Double) -> [String] {
    let deadline = Date().addingTimeInterval(seconds)
    var seen = lines(of: pid)
    while seen.count < count, Date() < deadline {
      Thread.sleep(forTimeInterval: 0.02)
      seen = lines(of: pid)
    }
    return seen
  }
}

/// The frames a wired client opens a session with, as Claude Code sends them.
enum Frames {
  static let initialize =
    #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"host-check","version":"0"}}}"#
  static let initialized = #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
  /// A different progress token each session, which the key leaves out.
  static func list(token: Int) -> String {
    #"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"progressToken":\#(token)}}}"#
  }
  static func call(_ id: Int = 3, text: String = "hi") -> String {
    #"{"jsonrpc":"2.0","id":\#(id),"method":"tools/call","params":{"name":"stub_echo","arguments":{"text":"\#(text)"}}}"#
  }
}

/// `read`, with the main run loop turning, until `done` holds or `seconds` pass.
///
/// `hostLog` and `Sessions` post to the main actor, which only runs while the
/// main run loop does, so a check reads them through this.
func polled<T>(within seconds: Double = 5, _ read: () -> T, until done: (T) -> Bool) -> T {
  let deadline = Date().addingTimeInterval(seconds)
  var value = read()
  while !done(value), Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    value = read()
  }
  return value
}

/// The host log lines, once `done` holds of them or `seconds` pass.
func hostLogLines(within seconds: Double = 5, until done: ([String]) -> Bool) -> [String] {
  polled(
    within: seconds, { MainActor.assumeIsolated { LogStore.shared.entries.map(\.text) } },
    until: done)
}

/// Puts a line of the check's own in the host log and waits for it, so the
/// lines after it are what happened since.
func hostLogMark() -> String {
  let mark = "host-check mark \(UUID().uuidString)"
  hostLog("host-check", .info, mark, mirror: false)
  _ = hostLogLines { $0.contains(mark) }
  return mark
}

/// The lines logged after `mark`, once `done` holds of them or `seconds` pass.
func hostLogLines(
  since mark: String, within seconds: Double = 5, until done: ([String]) -> Bool
) -> [String] {
  func after(_ lines: [String]) -> [String] {
    lines.lastIndex(of: mark).map { Array(lines[($0 + 1)...]) } ?? []
  }
  return after(hostLogLines(within: seconds) { done(after($0)) })
}

/// Everything logged after `mark` up to now, for a check that something was
/// NOT logged: a second mark is waited for, and the queue drained behind it,
/// so a line posted before it has landed.
func hostLogLines(since mark: String) -> [String] {
  let end = hostLogMark()
  RunLoop.main.run(until: Date().addingTimeInterval(0.1))
  let lines = hostLogLines(since: mark) { $0.contains(end) }
  return Array(lines.prefix { $0 != end })
}

/// Whether a line says a server was started, by either path.
func isServerStart(_ line: String) -> Bool {
  line.contains("server started (pid") || line.contains("starting server (pid")
}

/// The Activity window's mail rows.
func mailRows() -> [Sessions.Session] {
  MainActor.assumeIsolated { Sessions.shared.live.filter { $0.surface == "mail" } }
}

/// A request line.
func request(_ id: Int, _ method: String) -> String {
  #"{"jsonrpc":"2.0","id":\#(id),"method":"\#(method)"}"#
}

/// What Claude Code sends when somebody presses Esc.
func cancelled(_ id: Int) -> String {
  #"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":\#(id),"reason":"Esc"}}"#
}

/// The same cancel with its slash escaped, which JSON allows.
func escapedCancelled(_ id: Int) -> String {
  #"{"jsonrpc":"2.0","method":"notifications\/cancelled","params":{"requestId":\#(id)}}"#
}

/// The same cancel with its method spelled in `\u` escapes, which JSON allows too.
func unicodeCancelled(_ id: Int) -> String {
  #"{"jsonrpc":"2.0","method":"notifications\u002fcancell\u0065d","params":{"requestId":\#(id)}}"#
}

/// Wait for `count` signals on `semaphore`, all within `seconds`.
func signals(_ semaphore: DispatchSemaphore, _ count: Int, within seconds: Double) -> Bool {
  let deadline = DispatchTime.now() + seconds
  return (0..<count).allSatisfy { _ in semaphore.wait(timeout: deadline) == .success }
}

/// Fresh semaphores for the stand-in, so one case's signals never satisfy another's.
func resetStandIn() {
  ScreenServer.registered = DispatchSemaphore(value: 0)
  ScreenServer.cancelled = DispatchSemaphore(value: 0)
  ScreenServer.pausing = DispatchSemaphore(value: 0)
  ScreenServer.connection = nil
}

@main
struct HostCheck {
  static var failures = 0
  static var checks = 0

  static func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    checks += 1
    if condition() {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  /// One handshake, and whatever the host answered.
  static func handshake(_ line: String) -> String? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0, let address = unixAddress(BridgeProtocol.socketPath) else { return nil }
    defer { close(fd) }
    guard address.withSockaddr({ connect(fd, $0, $1) }) == 0 else { return nil }
    _ = line.withCString { write(fd, $0, strlen($0)) }

    var out = [UInt8]()
    var byte: UInt8 = 0
    while out.count < 512 {
      let n = read(fd, &byte, 1)
      if n <= 0 { break }
      if byte == UInt8(ascii: "\n") { break }
      out.append(byte)
    }
    return String(decoding: out, as: UTF8.self)
  }

  static func main() {
    print("\nserver host\n")

    // This check can HANG rather than fail: a regression that puts anything
    // `stop()` waits on behind the blocking accept sits there forever. A gate
    // that hangs a build is worse than one that fails it — the same argument
    // `audit-network.sh` makes about dying silently — so it is given a deadline
    // of its own.
    let limit = 60.0
    Thread.detachNewThread {
      Thread.sleep(forTimeInterval: limit)
      print("\n  FAIL host-check did not finish within \(Int(limit))s — something is deadlocked")
      exit(1)
    }

    let scratch = URL(fileURLWithPath: "/tmp/cupertino-host-check-\(getpid())", isDirectory: true)
    HostCheckHome.url = scratch

    // `shell` is in `Surface.all`, so anything here that asks `SurfaceSettings.isEnabled` of every
    // surface asks `ShellSeal` too. A scratch suite and a key held in memory, so that never reads
    // the app's own defaults or touches the Keychain.
    let shellSuite = "host-check-shell"
    let shellStore = UserDefaults(suiteName: shellSuite)!
    shellStore.removePersistentDomain(forName: shellSuite)
    defer { shellStore.removePersistentDomain(forName: shellSuite) }
    ShellSeal.domain = shellSuite
    ShellSeal.source = MemoryKey()
    ShellServer.defaults = shellStore
    ShellRecord.directory = scratch.appendingPathComponent("shell-runs", isDirectory: true)
    check(
      "Shell reads off here, from the scratch suite",
      Surface.named("shell").map { !SurfaceSettings.isEnabled($0) } == true)
    try? FileManager.default.createDirectory(
      atPath: BridgeProtocol.socketDirectory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: scratch) }
    // Refused outright rather than merely failed: if the substitution did not
    // happen, the host below would bind the real socket.
    guard BridgeProtocol.socketPath.hasPrefix(scratch.path) else {
      print("  FAIL the socket would be \(BridgeProtocol.socketPath), not under \(scratch.path)")
      exit(1)
    }
    check(
      "the socket is in a scratch directory, not the real one",
      BridgeProtocol.socketPath.hasPrefix(scratch.path))

    // The HTTP listener on a scratch port with its tokens in memory, set before
    // the host starts it. Never 8830 or 8831, which an installed copy may hold,
    // and never the Keychain.
    let httpPort =
      ProcessInfo.processInfo.environment["HOST_CHECK_HTTP_PORT"].flatMap { Int($0) } ?? 18830
    guard ![8830, 8831].contains(httpPort), (1024...65535).contains(httpPort) else {
      print("  FAIL HOST_CHECK_HTTP_PORT \(httpPort) is a real Cupertino port or out of range")
      exit(1)
    }
    let httpTokens = HTTPTokens(vault: MemoryTokenVault(["claude-code": "t1"]))
    ServerHost.httpOverride = (port: httpPort, tokens: httpTokens)

    // ─── it comes up ────────────────────────────────────────────────────────

    do {
      try ServerHost.shared.start()
    } catch {
      print("  FAIL could not start the host: \(error.localizedDescription)")
      exit(1)
    }
    check("the host starts with no error", ServerHost.shared.startupError == nil)
    check(
      "the socket file exists",
      FileManager.default.fileExists(atPath: BridgeProtocol.socketPath))

    // ─── the handshake ──────────────────────────────────────────────────────
    //
    // Every one of these is answered on a session thread, which is the half of
    // `serve` that no other gate reaches.

    check(
      "a malformed handshake is refused",
      handshake("nonsense\n")?.hasPrefix("err ") == true)
    check(
      "an unknown protocol version is refused by name",
      handshake("cupertino/999 mail\n")?.contains("unsupported protocol") == true)
    check(
      "an unknown server is refused by name",
      handshake("\(BridgeProtocol.version) nosuchsurface\n")?.contains("unknown server") == true)

    // ─── the store lane's door ──────────────────────────────────────────────
    //
    // `store` is a verb, not a surface, so it must never read as an unknown
    // server. And it saves into an Apple app's own store, so the only caller it
    // admits is the node server this host spawned for that surface: this check
    // process is in nobody's `serverPIDs`, so it is refused before any gate.
    // The lines are spelled out rather than built, because they are the
    // contract the node client is written against.
    check(
      "a store connection from a process that is not the surface's server is refused",
      handshake("\(BridgeProtocol.version) store for=voice-memos\n")?
        .hasPrefix("err this connection is not a voice-memos server") == true)
    check(
      "a store connection for a surface with no lane is refused by name",
      handshake("\(BridgeProtocol.version) store for=mail\n")?
        .hasPrefix("err 'mail' has no store lane") == true)
    check(
      "a store connection that names no surface is malformed",
      handshake("\(BridgeProtocol.version) store\n")?.hasPrefix("err malformed handshake") == true)

    // Unlicensed, which is what a check machine is: the licence gate refuses
    // before anything is spawned, and saying so proves the gate ran rather than
    // that the connection failed.
    let mail = handshake(BridgeProtocol.handshake(server: "mail"))
    check(
      "a real surface reaches the licence gate and is refused with a reason",
      mail?.hasPrefix("err ") == true && mail?.contains("licence") == true)

    // ─── an in-process session ──────────────────────────────────────────────
    //
    // The loop every Swift surface shares. It used to read a line, handle it
    // and only then read the next, so a `notifications/cancelled` sent while a
    // call ran, and a client hanging up, went unseen until the call ended. The
    // stand-in `ScreenServer` above is what answers.
    //
    // In the registration domain, so nothing is written to a preferences file.
    guard let screen = Surface.named("screen") else {
      print("  FAIL there is no screen surface to serve")
      exit(1)
    }
    UserDefaults.standard.register(defaults: [SurfaceSettings.enabledKey(screen): true])

    if let client = Client(server: "screen") {
      client.send(cancelled(99))
      client.send(request(1, "ping"))
      check(
        "cancel for an unknown id is ignored",
        client.result(for: 1, within: 2) != nil)
    } else {
      check("cancel for an unknown id is ignored (could not connect)", false)
    }

    if let client = Client(server: "screen") {
      ScreenServer.registered = DispatchSemaphore(value: 0)
      ScreenServer.cancelled = DispatchSemaphore(value: 0)
      client.send(request(7, "test/slow"))
      let started = ScreenServer.registered.wait(timeout: .now() + 2) == .success
      client.send(cancelled(7))
      let reached = started && ScreenServer.cancelled.wait(timeout: .now() + 1) == .success
      let reply = client.result(for: 7, within: 5)
      check(
        "cancel mid-call reaches the registered canceller",
        reached && reply?["cancelled"] as? Bool == true)
    } else {
      check("cancel mid-call reaches the registered canceller (could not connect)", false)
    }

    if let client = Client(server: "screen") {
      ScreenServer.registered = DispatchSemaphore(value: 0)
      ScreenServer.cancelled = DispatchSemaphore(value: 0)
      client.send(request(8, "test/slow"))
      let started = ScreenServer.registered.wait(timeout: .now() + 2) == .success
      client.hangUp()
      check(
        "EOF mid-call cancels every in-flight call",
        started && ScreenServer.cancelled.wait(timeout: .now() + 1) == .success)
    } else {
      check("EOF mid-call cancels every in-flight call (could not connect)", false)
    }

    if let client = Client(server: "screen") {
      client.send(request(1, "ping") + "\n" + request(2, "ping"))
      let first = client.result(for: 1, within: 2)
      let second = client.result(for: 2, within: 2)
      check("requests still answered in order", first != nil && second != nil)
    } else {
      check("requests still answered in order (could not connect)", false)
    }

    if let client = Client(server: "screen") {
      client.send(request(3, "test/where"))
      check(
        "driving connection key is set on the handling thread",
        client.result(for: 3, within: 2)?["connectionKey"] as? Bool == true)
    } else {
      check("driving connection key is set on the handling thread (could not connect)", false)
    }

    // A stop that arrives before the call has registered. The reader can see
    // a hang-up or a cancel while the worker is still on its way to
    // `register`, or while the request is queued behind another; either has to
    // be remembered, or the call it was for runs anyway.
    if let client = Client(server: "screen") {
      resetStandIn()
      client.send(request(9, "test/late"))
      let paused = ScreenServer.pausing.wait(timeout: .now() + 2) == .success
      client.hangUp()
      check(
        "EOF before the call registers still cancels it",
        paused && ScreenServer.cancelled.wait(timeout: .now() + 1) == .success)
    } else {
      check("EOF before the call registers still cancels it (could not connect)", false)
    }

    if let client = Client(server: "screen") {
      resetStandIn()
      client.send(request(10, "test/late"))
      let paused = ScreenServer.pausing.wait(timeout: .now() + 2) == .success
      client.send(cancelled(10))
      let reached = paused && ScreenServer.cancelled.wait(timeout: .now() + 1) == .success
      check(
        "a cancel sent before its id registers fires on register",
        reached && client.result(for: 10, within: 2)?["cancelled"] as? Bool == true)
    } else {
      check("a cancel sent before its id registers fires on register (could not connect)", false)
    }

    if let client = Client(server: "screen") {
      resetStandIn()
      client.send(request(11, "test/slow"))
      client.send(request(12, "test/slow"))
      let started = ScreenServer.registered.wait(timeout: .now() + 2) == .success
      client.send(cancelled(12))
      client.send(cancelled(11))
      let both = started && signals(ScreenServer.cancelled, 2, within: 1)
      let first = client.result(for: 11, within: 2)?["cancelled"] as? Bool
      let second = client.result(for: 12, within: 2)?["cancelled"] as? Bool
      check(
        "a cancel for a queued request fires when it starts",
        both && first == true && second == true)
    } else {
      check("a cancel for a queued request fires when it starts (could not connect)", false)
    }

    for (label, frame) in [
      ("an escaped slash", escapedCancelled), ("unicode escapes", unicodeCancelled),
    ] {
      if let client = Client(server: "screen") {
        resetStandIn()
        client.send(request(13, "test/slow"))
        let started = ScreenServer.registered.wait(timeout: .now() + 2) == .success
        client.send(frame(13))
        check(
          "a cancel spelled with \(label) still cancels",
          started && ScreenServer.cancelled.wait(timeout: .now() + 1) == .success)
      } else {
        check("a cancel spelled with \(label) still cancels (could not connect)", false)
      }
    }

    // `forget` is what keeps the registry from holding every connection that
    // ever cancelled anything. A tombstone (a cancel for an id never sent) and
    // the hang-up's closed mark are both held while the session lives, and
    // must both be gone once it has torn down.
    if let client = Client(server: "screen") {
      resetStandIn()
      client.send(request(14, "test/where"))
      _ = client.result(for: 14, within: 2)
      let connection = ScreenServer.connection
      client.send(cancelled(77))
      // Answered after the reader has handled the cancel before it.
      client.send(request(15, "ping"))
      _ = client.result(for: 15, within: 2)
      let heldWhileOpen = connection.flatMap { InProcessCalls.held(connection: $0) }
      client.hangUp()
      var gone = false
      let deadline = Date().addingTimeInterval(2)
      while let connection, Date() < deadline {
        if InProcessCalls.held(connection: connection) == nil {
          gone = true
          break
        }
        Thread.sleep(forTimeInterval: 0.02)
      }
      check(
        "forget leaves nothing behind once the session ends",
        heldWhileOpen?.tombstones == 1 && gone)
    } else {
      check("forget leaves nothing behind once the session ends (could not connect)", false)
    }

    // The registry on its own: a client cannot grow the tombstones without limit.
    let flood = UUID()
    for id in 0..<1000 { InProcessCalls.cancel(connection: flood, requestId: "i\(id)") }
    let kept = InProcessCalls.held(connection: flood)?.tombstones ?? 0
    InProcessCalls.forget(connection: flood)
    check(
      "tombstones are capped at \(InProcessCalls.tombstoneLimit) per connection",
      kept == InProcessCalls.tombstoneLimit && InProcessCalls.held(connection: flood) == nil)

    // Switching a surface off ends its sessions at their next request, which
    // the loop cannot do by returning any more: the thread that returns is the
    // one handling calls, and the one reading the socket has to stop as well
    // or the connection stays open with nobody answering it.
    if let client = Client(server: "screen") {
      UserDefaults.standard.register(defaults: [SurfaceSettings.enabledKey(screen): false])
      client.send(request(4, "ping"))
      check("a switched-off surface closes the connection", client.next(within: 2) == .closed)
      UserDefaults.standard.register(defaults: [SurfaceSettings.enabledKey(screen): true])
    } else {
      check("a switched-off surface closes the connection (could not connect)", false)
    }

    // ─── the licence decision ───────────────────────────────────────────────
    //
    // Pure, so every combination is pinned without a key or a trial on this
    // machine. The case it exists for is a LEND: a server the host itself
    // spawned borrowing Desktop for its own app. The Chat pane's servers are
    // spawned under the `self` exemption, and their lends used to be sent
    // through the gate the pane is exempt from — so with an expired trial,
    // Chat → Mail's reply and forward, and Chat → Maps' writes, failed with a
    // sentence about Accessibility or a missing key.

    let refused = Entitlement.refused("no licence key")
    let licensed = Entitlement.licensed(
      License(id: "check", email: "check@example.com", major: 1, issuedAt: "2026-01-01"))
    check(
      "the app talking to itself is admitted without a licence",
      ServerHost.licenceDecision(
        isSelf: true, lent: false, borrowerOnTrial: false, entitlement: refused)
        == .admit(onTrial: false))
    check(
      "a lend is admitted without a licence — its borrower already passed the gate",
      ServerHost.licenceDecision(
        isSelf: false, lent: true, borrowerOnTrial: false, entitlement: refused)
        == .admit(onTrial: false))
    check(
      "a lend from a trial-admitted borrower is on the trial too, so the reaper closes it",
      ServerHost.licenceDecision(
        isSelf: false, lent: true, borrowerOnTrial: true, entitlement: .trial)
        == .admit(onTrial: true))
    check(
      "a lend from a borrower the app spawned for itself is not, during a trial",
      ServerHost.licenceDecision(
        isSelf: false, lent: true, borrowerOnTrial: false, entitlement: .trial)
        == .admit(onTrial: false))
    check(
      "a client's own connection without a licence is refused with the reason",
      ServerHost.licenceDecision(
        isSelf: false, lent: false, borrowerOnTrial: false, entitlement: refused)
        == .refuse("no licence key"))
    check(
      "a client's own connection on a trial is admitted on the trial",
      ServerHost.licenceDecision(
        isSelf: false, lent: false, borrowerOnTrial: false, entitlement: .trial)
        == .admit(onTrial: true))
    check(
      "a client's own connection with a key is admitted outright",
      ServerHost.licenceDecision(
        isSelf: false, lent: false, borrowerOnTrial: false, entitlement: licensed)
        == .admit(onTrial: false))

    // ─── a setting narrowed under a running server ──────────────────────────
    //
    // A node server reads its settings once, at spawn, and registers its tools
    // once. Switching writes or a gate off used to leave every running session
    // on the old setting until its editor restarted — `send_message` and
    // `find_codes` still there after the switch said otherwise. `exceeds` is
    // the decision `settingsChanged` acts on: narrower stops, wider never does.

    let spawned = SpawnConfig(
      surface: "messages", enabled: true, allowWrites: true, gates: ["allowCodes"])
    check(
      "writes switched off is a narrowing",
      spawned.exceeds(
        SpawnConfig(surface: "messages", enabled: true, allowWrites: false, gates: ["allowCodes"])))
    check(
      "a gate switched off is a narrowing",
      spawned.exceeds(
        SpawnConfig(surface: "messages", enabled: true, allowWrites: true, gates: [])))
    check(
      "the surface switched off is a narrowing",
      spawned.exceeds(
        SpawnConfig(
          surface: "messages", enabled: false, allowWrites: true, gates: ["allowCodes"])))
    check(
      "nothing changed is not",
      !spawned.exceeds(spawned))
    let narrow = SpawnConfig(surface: "messages", enabled: true, allowWrites: false, gates: [])
    check(
      "writes and a gate switched ON is not — a server is never restarted to widen",
      !narrow.exceeds(spawned))
    check(
      "the reason names what was switched off",
      spawned.narrowing(
        to: SpawnConfig(surface: "messages", enabled: true, allowWrites: false, gates: []))
        == "writes switched off")
    check(
      "and names the gate",
      spawned.narrowing(
        to: SpawnConfig(surface: "messages", enabled: true, allowWrites: true, gates: []))
        == "allowCodes switched off")

    // ─── a node session whose server waits for a call ───────────────────────
    //
    // Through the real socket and `serve`, as a wired client: `run` answers the
    // handshake and the lists from what an earlier server said, and starts one
    // only for the call. The server is the stub, so what it read is in its log,
    // by pid. A trial admits these past the licence gate, which refused mail
    // above; it lives in memory and ends with this process.
    let environment = ProcessInfo.processInfo.environment
    guard let node = environment["HOST_CHECK_NODE"], !node.isEmpty,
      FileManager.default.isExecutableFile(atPath: node),
      let stubPath = environment["HOST_CHECK_STUB"],
      FileManager.default.fileExists(atPath: stubPath)
    else {
      print(
        "  FAIL HOST_CHECK_NODE and HOST_CHECK_STUB must name node and the stub server — "
          + "run this through `make host-check`, with node on PATH")
      exit(1)
    }
    let stub = Stub.install(node: node, stub: stubPath, in: scratch)
    ServerHost.locateOverride = { surface in
      guard surface.id == "mail" else {
        throw LocateError.devConfigInvalid("host-check: mail only")
      }
      return stub
    }
    guard let mailSurface = Surface.named("mail") else {
      print("  FAIL there is no mail surface to serve")
      exit(1)
    }
    UserDefaults.standard.register(defaults: [SurfaceSettings.enabledKey(mailSurface): true])
    Trial.start()
    let wired = BridgeProtocol.handshake(server: "mail", client: "claude-code")
    var token = 100
    /// One session's opening, each answer waited for as a client does.
    func open(_ client: Client) -> [Int] {
      token += 1
      var ids: [Int] = []
      client.send(Frames.initialize)
      ids += client.ids(until: 1)
      client.send(Frames.initialized)
      client.send(Frames.list(token: token))
      ids += client.ids(until: 2)
      return ids
    }
    /// A session's whole opening and one call, then hung up and its stub gone.
    func warm() {
      guard let client = Client(handshake: wired) else { return }
      _ = open(client)
      client.send(Frames.call())
      _ = client.result(for: 3, within: 5)
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    }

    // The switch off is today's behaviour: a server at connect, before any
    // frame. On a warm cache, where the deferral would answer `initialize`
    // itself and start nothing, so only the switch can make a server read it,
    // and only the undeferred path logs `server started`.
    HandshakeCache.shared.reset()
    warm()
    UserDefaults.standard.register(defaults: ["deferServerSpawn": false])
    if let client = Client(handshake: wired) {
      let known = Stub.pids()
      client.send(Frames.initialize)
      let answered = client.result(for: 1, within: 5) != nil
      let pid = Stub.newPid(besides: known, within: 5)
      check(
        "with the deferral off a warm session's server reads its first frame",
        answered && pid != nil)
      let started = pid.map { pid in
        { (line: String) in line.hasPrefix("server started (pid \(pid))") }
      }
      check(
        "and it was started at connect, not deferred",
        started.map { started in
          hostLogLines { $0.contains(where: started) }.contains(where: started)
        }
          == true)
      client.hangUp()
    } else {
      check(
        "with the deferral off a warm session's server reads its first frame (no connect)", false)
    }
    UserDefaults.standard.register(defaults: ["deferServerSpawn": true])
    Thread.sleep(forTimeInterval: 0.2)

    HandshakeCache.shared.reset()
    if let client = Client(handshake: wired) {
      let known = Stub.pids()
      let ids = open(client)
      client.send(Frames.call())
      let all = ids + client.ids(until: 3, drain: 0.3)
      let pid = Stub.newPid(besides: known, within: 5)
      check(
        "first session spawns and answers",
        all == [1, 2, 3] && pid != nil && Stub.pids().subtracting(known).count == 1)
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("first session spawns and answers (could not connect)", false)
    }

    // Marked before connecting, so the lines after it are this session's whole life.
    var mark = hostLogMark()
    if let client = Client(handshake: wired) {
      let known = Stub.pids()
      let booted = Stub.started()
      let ids = open(client)
      Thread.sleep(forTimeInterval: 0.5)
      let quiet = Stub.pids().subtracting(known).isEmpty
      check("second session starts nothing before a call", ids == [1, 2] && quiet)
      check(
        "no stub booted for it and the host logged no start",
        Stub.started().subtracting(booted).isEmpty
          && !hostLogLines(since: mark).contains(where: isServerStart))
      let call = Frames.call()
      client.send(call)
      let after = client.ids(until: 3, drain: 0.3)
      let pid = Stub.newPid(besides: known, within: 5)
      let read = pid.map { Stub.lines(of: $0, count: 4, within: 5) }
      check(
        "its call starts one, which reads the whole session in order",
        read == [Frames.initialize, Frames.initialized, Frames.list(token: token), call])
      check("and the client gets exactly one answer per id", ids + after == [1, 2, 3])
      let startedLine = "first tools/call, starting server (pid \(pid ?? "none"))"
      let log = hostLogLines(since: mark) { $0.contains { $0.hasPrefix(startedLine) } }
      let deferredAt = log.firstIndex(of: "session open, server deferred")
      let startedAt = log.firstIndex { $0.hasPrefix(startedLine) }
      check(
        "the log says the server was deferred, then why it started",
        pid != nil && deferredAt != nil && startedAt != nil && deferredAt! < startedAt!)
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("second session starts nothing before a call (could not connect)", false)
    }

    mark = hostLogMark()
    if let client = Client(handshake: wired) {
      let known = Stub.pids()
      let booted = Stub.started()
      client.send(Frames.initialize)
      let answered = client.result(for: 1, within: 5) != nil
      client.send(Frames.initialized)
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.5)
      check(
        "hang-up while deferred starts nothing",
        answered && Stub.pids().subtracting(known).isEmpty)
      let log = hostLogLines(since: mark) { $0.contains("session closed, no server was started") }
      check(
        "nothing booted for it, and the host logged its close and no start",
        Stub.started().subtracting(booted).isEmpty
          && log.contains("session closed, no server was started")
          && !log.contains(where: isServerStart))
    } else {
      check("hang-up while deferred starts nothing (could not connect)", false)
    }

    if let client = Client(handshake: wired) {
      let known = Stub.pids()
      _ = open(client)
      let call = Frames.call()
      let bytes = Array(call.utf8)
      let half = bytes.count / 2
      client.send(String(decoding: bytes[..<half], as: UTF8.self), newline: false)
      Thread.sleep(forTimeInterval: 0.1)
      client.send(String(decoding: bytes[half...], as: UTF8.self))
      let answered = client.result(for: 3, within: 5) != nil
      let pid = Stub.newPid(besides: known, within: 5)
      check(
        "split trigger frame reaches the server whole",
        answered && pid.map { Stub.lines(of: $0, count: 4, within: 5).last } == call)
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("split trigger frame reaches the server whole (could not connect)", false)
    }

    // What arrives with the trigger is the relay's: the next frame in the same
    // read, and half of the one after, which the relay must finish framing.
    if let client = Client(handshake: wired) {
      let known = Stub.pids()
      _ = open(client)
      let third = Array(Frames.call(5).utf8)
      client.send(
        Frames.call() + "\n" + Frames.call(4) + "\n"
          + String(decoding: third[..<20], as: UTF8.self), newline: false)
      Thread.sleep(forTimeInterval: 0.1)
      client.send(String(decoding: third[20...], as: UTF8.self))
      let after = client.ids(until: 5, drain: 0.3)
      let pid = Stub.newPid(besides: known, within: 5)
      let read = pid.map { Stub.lines(of: $0, count: 6, within: 5).suffix(3) }
      check(
        "frames behind the trigger reach the server once, in order",
        read.map(Array.init) == [Frames.call(), Frames.call(4), Frames.call(5)]
          && after == [3, 4, 5])
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("frames behind the trigger reach the server once, in order (could not connect)", false)
    }

    if let client = Client(handshake: wired) {
      let known = Stub.pids()
      client.send(Frames.initialize)
      let answered = client.result(for: 1, within: 5) != nil
      let big = Frames.call(7, text: String(repeating: "x", count: 200 * 1024))
      client.send(big)
      let reply = client.result(for: 7, within: 5)
      let pid = Stub.newPid(besides: known, within: 5)
      check(
        "oversized first frame arrives whole",
        answered && reply != nil && pid.map { Stub.lines(of: $0, count: 2, within: 5).last } == big)
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("oversized first frame arrives whole (could not connect)", false)
    }

    HandshakeCache.shared.reset()
    warm()
    Stub.skew("tools/list")
    if let client = Client(handshake: wired) {
      let ids = open(client)
      client.send(Frames.call())
      let after = client.ids(until: 3, drain: 0.3)
      check(
        "skewed replay disables the cache",
        ids + after == [1, 2, 3] && HandshakeCache.shared.isDisabled(surface: "mail"))
      let skewed = { (line: String) in
        line.hasPrefix("handshake cache: tools/list answered differently on replay")
      }
      check(
        "and the host log says so",
        hostLogLines { $0.contains(where: skewed) }.contains(where: skewed))
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("skewed replay disables the cache (could not connect)", false)
    }
    Stub.skew(nil)
    HandshakeCache.shared.reset()

    // ─── the Activity window, before the server starts ──────────────────────
    //
    // A deferred session is connected, so it has a row from the moment it
    // opens, with no pid, and that row gains the pid when the server starts.
    // A second row then would count one connection twice.
    warm()
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    let rowsBefore = Set(mailRows().map(\.id))
    if let client = Client(handshake: wired) {
      _ = open(client)
      let rows = polled(
        { mailRows().filter { !rowsBefore.contains($0.id) } }, until: { !$0.isEmpty })
      check(
        "a deferred session has its Activity row, with no pid yet",
        rows.count == 1 && rows.first?.pid == nil)
      let known = Stub.pids()
      client.send(Frames.call())
      _ = client.ids(until: 3)
      let pid = Stub.newPid(besides: known, within: 5)
      let row = rows.first?.id
      let after = polled({ mailRows().filter { $0.id == row } }, until: { $0.first?.pid != nil })
      check(
        "and the row gains its server's pid when it starts, with no second row",
        pid != nil && after.count == 1 && after.first?.pid.map { String($0) } == pid
          && mailRows().filter { !rowsBefore.contains($0.id) }.count == 1)
      client.hangUp()
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("a deferred session has its Activity row, with no pid yet (could not connect)", false)
    }

    // ─── a setting narrowed under a session whose server has not started ────
    //
    // A deferred session answers from what it was given at connect, so a
    // switch turned off reaches it as it reaches a running server: it is
    // closed, and its client reconnects under the settings as they now are.
    // Each case warms the cache for the settings it opens under, so the
    // session is still deferred when the switch moves, and says no stub booted
    // for it, so the close is the deferred one and not a server stopped.
    let writesKey = "allowWrites.mail"
    let writesWere = UserDefaults.standard.bool(forKey: writesKey)
    func writes(_ on: Bool) { UserDefaults.standard.register(defaults: [writesKey: on]) }
    /// A session past its opening and still deferred, with the stubs booted before it.
    func deferredSession() -> (client: Client, booted: Set<String>)? {
      let booted = Stub.started()
      guard let client = Client(handshake: wired) else { return nil }
      return open(client) == [1, 2] ? (client, booted) : nil
    }

    writes(true)
    HandshakeCache.shared.reset()
    warm()
    if let (client, booted) = deferredSession() {
      writes(false)
      ServerHost.shared.settingsChanged()
      check("writes off closes a deferred session", client.closed(within: 1))
      check("and nothing was started for it", Stub.started().subtracting(booted).isEmpty)
      client.hangUp()
    } else {
      check("writes off closes a deferred session (could not open one)", false)
    }

    warm()
    if let (client, booted) = deferredSession() {
      writes(true)
      ServerHost.shared.settingsChanged()
      check("widening leaves it alone", client.next(within: 1) == .timedOut)
      check("and starts nothing", Stub.started().subtracting(booted).isEmpty)
      client.hangUp()
    } else {
      check("widening leaves it alone (could not open one)", false)
    }

    if let (client, booted) = deferredSession() {
      ServerHost.shared.stopSessions(for: mailSurface)
      check("switched off closes it", client.closed(within: 1))
      check(
        "and nothing was started for the switched-off one",
        Stub.started().subtracting(booted).isEmpty)
      client.hangUp()
    } else {
      check("switched off closes it (could not open one)", false)
    }

    // The call and the narrowing race: the session may still be deferred, be
    // between the two maps, or be running. Whichever, it ends.
    if let (client, _) = deferredSession() {
      let known = Stub.pids()
      client.send(Frames.call())
      writes(false)
      ServerHost.shared.settingsChanged()
      let deadline = Date().addingTimeInterval(2)
      var ended = false
      while !ended, Date() < deadline {
        ended =
          client.closed(within: 0.05)
          || Stub.pids().subtracting(known).first.map { Stub.exited($0, within: 0) } == true
      }
      check("narrowed while starting, it still ends", ended)
      client.hangUp()
      writes(true)
      Thread.sleep(forTimeInterval: 0.2)
    } else {
      check("narrowed while starting, it still ends (could not open one)", false)
    }

    // A quit or an update relaunch: the sweep closes a session still deferred,
    // which could otherwise start a server at its first call during the grace.
    if let (client, booted) = deferredSession() {
      ServerHost.shared.terminateChildren()
      check("terminating every child closes a deferred session", client.closed(within: 1))
      check(
        "and nothing was started for the closed one", Stub.started().subtracting(booted).isEmpty)
      client.hangUp()
    } else {
      check("terminating every child closes a deferred session (could not open one)", false)
    }

    // ─── HTTP: the loopback listener ────────────────────────────────────────
    //
    // Each HTTP session is a socketpair into `serve`, so everything above holds
    // for it unchanged; these drive it through a raw socket, with the stub and
    // the trial the deferred cases use. The cases below wait with deadlines that
    // return as soon as their answer arrives, never a fixed sleep over a node start.
    let http = ServerHost.shared.httpListener
    check(
      "HTTP: binds 127.0.0.1 only",
      http?.boundAddress == "127.0.0.1:\(httpPort)" && ServerHost.shared.httpStartupError == nil)

    mark = hostLogMark()
    if let probe = HTTPProbe(port: httpPort) {
      let started = Date()
      probe.send(
        "POST /s/mail HTTP/1.1\r\nHost: localhost:\(httpPort)\r\nAuthorization: Bearer t1\r\n"
          + "Content-Type: application/json\r\nContent-Length: 10000000\r\n\r\n")
      let status = probe.head(within: 1)
      let refusal = hostLogLines(since: mark) {
        $0.contains { $0.contains("Host is not 127.0.0.1") }
      }
      check(
        "HTTP: refused before the body, within 1 s, and the Host refusal logged",
        status == 400 && Date().timeIntervalSince(started) < 1
          && refusal.contains { $0.contains("Host is not 127.0.0.1") })
    } else {
      check("HTTP: refused before the body (could not connect)", false)
    }

    mark = hostLogMark()
    if let probe = HTTPProbe(port: httpPort) {
      let fields = [("Host", "127.0.0.1:\(httpPort)"), ("Content-Type", "application/json")]
      probe.request(
        "POST", "/s/mail",
        headers: fields + [("Origin", "http://evil.example"), ("Authorization", "Bearer t1")],
        body: Data(Frames.initialize.utf8))
      let origin = probe.head(within: 2)
      let wrong = HTTPProbe(port: httpPort)
      wrong?.request(
        "POST", "/s/mail", headers: fields + [("Authorization", "Bearer not-the-token-417")],
        body: Data(Frames.initialize.utf8))
      let token = wrong?.head(within: 2)
      let log = hostLogLines(since: mark) {
        $0.contains { $0.contains("Origin present") }
          && $0.contains { $0.contains("token not recognised") }
      }
      check(
        "HTTP: foreign origin and bad token refused, logged without the token",
        origin == 403 && token == 401 && log.contains { $0.contains("Origin present") }
          && log.contains { $0.contains("token not recognised") }
          && !log.contains { $0.contains("not-the-token-417") })
    } else {
      check("HTTP: foreign origin and bad token refused (could not connect)", false)
    }

    if let session = HTTPMCP(port: httpPort) {
      session.id = SessionID.mint()
      let first = session.delete()
      let second = session.delete()
      check(
        "HTTP: a kept-alive connection answers each request once",
        first == 404 && second == 404 && session.probe.head(within: 0.3) == nil)
      session.id = nil
      session.probe.request(
        "POST", "/s/mail",
        headers: session.headers + [("Content-Length", String(HTTPListener.maxBodyBytes + 1))])
      check(
        "HTTP: a body over 64 MB is refused 413 before it is read",
        session.probe.head(within: 1) == 413)
    } else {
      check("HTTP: a kept-alive connection answers each request once (could not connect)", false)
    }

    // The same stub, warm, answered over the socket and over HTTP.
    HandshakeCache.shared.reset()
    warm()
    var bridged: [[String: Any]] = []
    if let client = Client(handshake: wired) {
      client.send(Frames.initialize)
      bridged += client.result(for: 1, within: 5).map { [$0] } ?? []
      client.send(Frames.initialized)
      client.send(Frames.list(token: 900))
      bridged += client.result(for: 2, within: 5).map { [$0] } ?? []
      client.send(Frames.call())
      bridged += client.result(for: 3, within: 5).map { [$0] } ?? []
      client.hangUp()
    }
    if let session = HTTPMCP(port: httpPort) {
      var answers: [[String: Any]] = []
      answers += (session.initialize()?["result"] as? [String: Any]).map { [$0] } ?? []
      let accepted = session.post(Frames.initialized).status
      answers += session.post(Frames.list(token: 900)).messages.compactMap(session.result)
      answers += session.post(Frames.call()).messages.compactMap(session.result)
      check(
        "HTTP: a session answers as the bridge does",
        bridged.count == 3 && answers.count == 3 && accepted == 202
          && zip(bridged, answers).allSatisfy {
            NSDictionary(dictionary: $0) == NSDictionary(dictionary: $1)
          })
    } else {
      check("HTTP: a session answers as the bridge does (could not connect)", false)
    }

    mark = hostLogMark()
    if let session = HTTPMCP(port: httpPort) {
      let booted = Stub.started()
      let known = Stub.pids()
      let opened = session.open()
      check(
        "HTTP: no child before a call",
        opened && Stub.started().subtracting(booted).isEmpty && Stub.pids() == known
          && !hostLogLines(since: mark).contains(where: isServerStart))
    } else {
      check("HTTP: no child before a call (could not connect)", false)
    }

    /// An open session whose child has started, and that child's pid.
    func started(_ session: HTTPMCP) -> String? {
      let known = Stub.pids()
      guard session.open(), session.post(Frames.call()).messages.count == 1 else { return nil }
      return Stub.newPid(besides: known, within: 5)
    }

    if let first = HTTPMCP(port: httpPort), let second = HTTPMCP(port: httpPort) {
      let one = started(first)
      let two = started(second)
      check(
        "HTTP: two sessions get two children",
        one != nil && two != nil && one != two && first.id != second.id)
    } else {
      check("HTTP: two sessions get two children (could not connect)", false)
    }

    if let session = HTTPMCP(port: httpPort) {
      session.id = SessionID.mint()
      let status = session.post(request(5, "ping")).status
      check("HTTP: unknown session is 404", status == 404)
    } else {
      check("HTTP: unknown session is 404 (could not connect)", false)
    }

    if let session = HTTPMCP(port: httpPort), session.open() {
      http?.stop()
      var restarted = false
      do {
        try http?.start()
        restarted = true
      } catch {}
      let again = HTTPMCP(port: httpPort)
      again?.id = session.id
      let stale = again?.post(request(6, "ping")).status
      let fresh = HTTPMCP(port: httpPort)
      check(
        "HTTP: restart gives 404 then a fresh session works",
        restarted && stale == 404 && fresh?.open() == true && fresh?.id != session.id)
    } else {
      check("HTTP: restart gives 404 then a fresh session works (could not open one)", false)
    }

    if let session = HTTPMCP(port: httpPort), let pid = started(session) {
      let status = session.delete()
      let after = HTTPMCP(port: httpPort)
      after?.id = session.id
      check(
        "HTTP: DELETE ends the child",
        status == 200 && Stub.exited(pid, within: 3)
          && after?.post(request(7, "ping")).status == 404)
    } else {
      check("HTTP: DELETE ends the child (could not start one)", false)
    }

    HTTPListener.getCloseGrace = 0.5
    if let session = HTTPMCP(port: httpPort), let pid = started(session),
      let get = session.openGet()
    {
      let held = !Stub.exited(pid, within: 0.8)
      get.hangUp()
      check("HTTP: GET close ends after grace", held && Stub.exited(pid, within: 3))
    } else {
      check("HTTP: GET close ends after grace (could not open one)", false)
    }
    HTTPListener.getCloseGrace = 30

    HTTPListener.idleLimit = 1
    if let session = HTTPMCP(port: httpPort), let pid = started(session) {
      let gone = Stub.exited(pid, within: 3)
      check(
        "HTTP: idle session ends",
        gone && session.post(request(8, "ping")).status == 404)
    } else {
      check("HTTP: idle session ends (could not start one)", false)
    }
    HTTPListener.idleLimit = 1800

    if let session = HTTPMCP(port: httpPort), session.open() {
      let known = Stub.pids()
      let big = Frames.call(9, text: String(repeating: "y", count: 4 * 1024 * 1024))
      let answered = session.post(big, within: 10).messages.count == 1
      let pid = Stub.newPid(besides: known, within: 5)
      check(
        "HTTP: large POST body arrives whole",
        answered && pid.map { Stub.lines(of: $0, count: 4, within: 5).last } == big)
    } else {
      check("HTTP: large POST body arrives whole (could not open one)", false)
    }

    writes(true)
    if let session = HTTPMCP(port: httpPort), session.open() {
      let known = Stub.pids()
      let slow =
        #"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"stub_echo","arguments":{"delayMs":20000}}}"#
      session.probe.request("POST", "/s/mail", headers: session.headers, body: Data(slow.utf8))
      let streaming = session.probe.head(within: 5) == 200
      let pid = Stub.newPid(besides: known, within: 5)
      let read = pid.map { Stub.lines(of: $0, count: 4, within: 5).last } == slow
      writes(false)
      ServerHost.shared.settingsChanged()
      let ended = session.probe.event(within: 2) == .ended
      check(
        "HTTP: narrowed setting ends open POST streams",
        streaming && read && ended)
      writes(true)
    } else {
      check("HTTP: narrowed setting ends open POST streams (could not open one)", false)
    }

    HTTPListener.getCloseGrace = 1
    mark = hostLogMark()
    if let session = HTTPMCP(port: httpPort, surface: "screen"), session.initialize() != nil,
      session.post(request(11, "ping")).messages.count == 1, let get = session.openGet()
    {
      get.hangUp()
      let early = hostLogLines(since: mark).contains("server stopped")
      let log = hostLogLines(since: mark, within: 2) { $0.contains("server stopped") }
      check(
        "HTTP: in-process surface session tears down after its GET closes",
        !early && log.contains("server stopped"))
    } else {
      check("HTTP: in-process surface session tears down (could not open one)", false)
    }
    HTTPListener.getCloseGrace = 30

    if let session = HTTPMCP(port: httpPort) {
      let (status, body) = session.post(request(12, "server/discover"))
      let error =
        body.first.flatMap {
          (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
        }?["error"] as? [String: Any]
      check(
        "HTTP: discover without a session",
        status == DiscoverRefusal.status && error?["code"] as? Int == -32601)
    } else {
      check("HTTP: discover without a session (could not connect)", false)
    }

    let sources = ProcessInfo.processInfo.environment["HOST_CHECK_SOURCES"] ?? ""
    let binders = (FileManager.default.enumerator(atPath: sources)?.allObjects as? [String] ?? [])
      .filter { $0.hasSuffix(".swift") }
      .filter { name in
        let text = (try? String(contentsOfFile: "\(sources)/\(name)", encoding: .utf8)) ?? ""
        return text.contains("AF_INET") && text.contains("bind(")
      }
    check(
      "HTTP: one listener — only HTTPListener.swift binds an AF_INET socket",
      binders == ["HTTPListener.swift"])

    // Last: it stops every server admitted on the trial, which is all of these.
    if let (client, booted) = deferredSession() {
      ServerHost.shared.endTrialSessions()
      check("trial end closes it", !LicenseStore.isLicensed && client.closed(within: 1))
      check("and nothing was started for the trial one", Stub.started().subtracting(booted).isEmpty)
      client.hangUp()
    } else {
      check("trial end closes it (could not open one)", false)
    }
    writes(writesWere)
    HandshakeCache.shared.reset()
    ServerHost.locateOverride = nil

    // ─── a second copy ──────────────────────────────────────────────────────
    //
    // The lock, and the guarded unlink in `stop()` that goes with it. A second
    // copy whose `start` lost the lock never bound anything, so quitting it must
    // leave the first copy's socket alone — it used to unlink the path on the way
    // out, and every bridge after that found nothing to connect to.
    //
    // Two `flock`s on one file conflict within one process as well as across
    // two (each `open` is its own open file description), so a second
    // `ServerHost` here is a faithful second copy for this purpose.

    let second = ServerHost()
    var heldBy: String??
    do {
      try second.start()
    } catch let error as ServerHost.HostError {
      if case .lockHeld(let holder) = error { heldBy = .some(holder) }
    } catch {}
    check("a second copy's start() is refused with lockHeld", heldBy != nil)
    check(
      "and the refusal names the holder it read from the lock file",
      (heldBy ?? nil)?.contains("pid \(getpid())") == true)
    second.stop()
    check(
      "stopping the second copy leaves the first copy's socket in place",
      FileManager.default.fileExists(atPath: BridgeProtocol.socketPath))
    check(
      "and the first copy still answers on it",
      handshake("nonsense\n")?.hasPrefix("err ") == true)

    // ─── the eviction watchdog ──────────────────────────────────────────────
    //
    // The regression test. Put somebody else's file where the socket was: the
    // host must notice within a couple of ticks and say so, rather than going
    // on accepting on an inode no path points at.
    //
    // A REPLACEMENT rather than a bare unlink, and that is what gives `stop()`
    // below something to get wrong. With the path simply gone, "the socket is
    // gone afterwards" held whatever `stop` did. With a different inode at the
    // path the file is not ours, and a `stop` that unlinked it anyway would
    // delete another copy's socket — the exact bug its guard was written for.
    //
    // Created beside the socket and renamed over it, so the squatter exists
    // while the socket still does and cannot be handed the socket's inode.

    let squatter = BridgeProtocol.socketPath + ".squatter"
    FileManager.default.createFile(atPath: squatter, contents: Data("not a socket\n".utf8))
    check(
      "the socket is replaced by a regular file",
      rename(squatter, BridgeProtocol.socketPath) == 0)
    var noticed = false
    let deadline = Date().addingTimeInterval(12)
    while Date() < deadline {
      if ServerHost.shared.startupError != nil {
        noticed = true
        break
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    check("the watchdog notices the socket was replaced", noticed)
    check(
      "and says another process replaced it",
      ServerHost.shared.startupError?.contains("replaced the socket file") == true)
    check(
      "and that this copy is no longer reachable",
      ServerHost.shared.startupError?.contains("no longer reachable") == true)

    // ─── stopping ───────────────────────────────────────────────────────────

    // Stopping the reaped host must not signal this process. `serverPIDs` holds
    // node servers only — the app's own pid is in `Sessions` for display, and
    // the updater used to walk THAT. SIGTERM is caught for the length of the
    // call, so a regression reads as a failed check rather than as this process
    // dying with no report.
    HostCheckSignals.terminated = 0
    let previous = signal(SIGTERM) { _ in HostCheckSignals.terminated = 1 }
    ServerHost.shared.terminateChildren()
    Thread.sleep(forTimeInterval: 0.1)
    signal(SIGTERM, previous)
    check(
      "terminating every child does not signal this process",
      HostCheckSignals.terminated == 0)

    let started = Date()
    ServerHost.shared.stop()
    let elapsed = Date().timeIntervalSince(started)
    check("stop() returns rather than deadlocking (\(Int(elapsed * 1000))ms)", elapsed < 2)
    var squatted = stat()
    check(
      "stop() leaves a file it did not bind in place",
      stat(BridgeProtocol.socketPath, &squatted) == 0 && (squatted.st_mode & S_IFMT) == S_IFREG)

    // ─── and again, cleanly ─────────────────────────────────────────────────
    //
    // The other half of the guard: a host that is still the one at the path
    // DOES remove its socket. Starting over the squatter is also the state a
    // crash leaves behind — holding the lock proves nothing live is there.

    do {
      try ServerHost.shared.start()
    } catch {
      print("  FAIL could not restart the host: \(error.localizedDescription)")
      exit(1)
    }
    check("the host starts again once the lock is released", ServerHost.shared.startupError == nil)
    var rebound = stat()
    check(
      "and binds a socket over the leftover file",
      stat(BridgeProtocol.socketPath, &rebound) == 0 && (rebound.st_mode & S_IFMT) == S_IFSOCK)
    ServerHost.shared.stop()
    check(
      "stop() removes the socket it bound",
      !FileManager.default.fileExists(atPath: BridgeProtocol.socketPath))

    print("\n\(checks - failures)/\(checks) passed\n")
    if failures > 0 { exit(1) }
  }
}

/// A seal key held in memory, so this check never reads or writes the real Keychain.
final class MemoryKey: ShellSeal.KeySource, @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Data?
  func key() -> Data? { lock.withLock { stored } }
  func rotate() -> Data? {
    let fresh = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    lock.withLock { stored = fresh }
    return fresh
  }
}

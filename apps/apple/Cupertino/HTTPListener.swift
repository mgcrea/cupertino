import Foundation
import os

/// One HTTP session, as `endSessions(where:)` sees it.
nonisolated struct HTTPSessionInfo: Equatable {
  let id: String
  /// The client id the session's token named.
  let client: String
  /// A `Surface.id`.
  let surface: String
}

/// The loopback HTTP endpoint: Streamable HTTP at
/// `http://127.0.0.1:<port>/s/<surface>`, one host session per HTTP session.
///
/// The listener is a translator and nothing else. Each HTTP session gets a
/// socketpair. One end goes to `ServerHost.serveInternal`, which runs `serve`
/// on it exactly as on an accepted unix socket: the handshake, admission, the
/// licence gate, deferral, one node child, in-process teardown, narrowing and
/// trial end are the host's, unchanged. This end writes the handshake line a
/// bridge would, `cupertino/1 <surface> client=<id>`, with the client id taken
/// from the verified token, then carries newline-delimited JSON-RPC both ways:
/// each POSTed message is one line down, and each line up is routed by
/// `HTTPSessionRouter` to the POST stream that asked for it, or the GET stream.
///
/// Ending a session from this side (DELETE, the GET-close grace, the idle
/// limit, `stop`) shuts the session end down, which the host sees as a
/// bridge's hang-up. The host ending it (narrowed, trial end, a server that
/// exited) closes the host's end, which this side sees as end of stream: every
/// open HTTP stream of that session ends with it.
///
/// Every request is judged on its head alone first, by `HTTPGate` in
/// Bastion's order, and its body is read only once the gate admitted it.
///
/// Descriptor ownership, one owner each, each closed once:
/// - the listening socket: `start` opens it, `stop` closes it;
/// - an accepted connection: its connection thread, after it is untracked
///   (`stop` only ever shuts one down, under the lock that tracks it);
/// - a session's own end: its reader thread, under the session's write lock,
///   so no writer is mid-write; everyone else only shuts it down, and only
///   while it is still open;
/// - the host's end: `serve`.
nonisolated final class HTTPListener: @unchecked Sendable {
  /// How long a session whose GET stream closed is kept, with no POST open or
  /// arriving, before it is ended. Long enough for a client reconnecting its
  /// stream, short enough that hang-up-bound state (a recording, a driving
  /// session) does not outlive its client by more than half a minute.
  /// Settable for the checks only.
  nonisolated(unsafe) static var getCloseGrace: TimeInterval = 30
  /// How long a session that never opened a GET stream is kept with no
  /// request. Settable for the checks only.
  nonisolated(unsafe) static var idleLimit: TimeInterval = 1800

  /// The defaults key the port is kept under, for the Settings pane.
  static let portKey = "httpPort"
  #if DEBUG
    static let defaultPort = 8831
  #else
    static let defaultPort = 8830
  #endif

  /// The port the app listens on: the user's setting, or the build's
  /// default. The one place the default lives; wiring and Settings read it here.
  static var configuredPort: Int {
    let stored = UserDefaults.standard.integer(forKey: portKey)
    return (1...65535).contains(stored) ? stored : defaultPort
  }

  /// Every session may hold a GET stream for its life, so a Mac with 19
  /// Claude Code sessions wired to 14 surfaces holds 266 idle connections.
  static let connectionLimit = 1024
  static let maxBodyBytes = 64 * 1024 * 1024
  /// How long a kept-alive connection may sit with no request before it is
  /// closed, in milliseconds.
  static let keepAliveIdleMs: Int32 = 75_000
  /// How long a request may pause mid-head or mid-body, in milliseconds.
  static let ioTimeoutMs: Int32 = 10_000

  enum ListenError: LocalizedError {
    case socket(String)

    var errorDescription: String? {
      switch self {
      case .socket(let detail): detail
      }
    }
  }

  private let port: Int
  private let tokens: HTTPTokens
  private weak var host: ServerHost?
  private let gate: HTTPGate
  private let budget = HTTPConnectionBudget(limit: HTTPListener.connectionLimit)
  private let streamIDs = OSAllocatedUnfairLock(initialState: 0)

  private struct State {
    var fd: Int32 = -1
    var bound: String?
    var sessions: [String: HTTPSession] = [:]
    /// Accepted connections still served, so `stop` can shut them down.
    var connections: Set<Int32> = []
    /// Whether the budget refusal was logged since the last connection it took.
    var overBudgetLogged = false
  }
  private let state = OSAllocatedUnfairLock(uncheckedState: State())

  init(port: Int, tokens: HTTPTokens, host: ServerHost) {
    self.port = port
    self.tokens = tokens
    self.host = host
    gate = HTTPGate(port: port, verify: { [tokens] in tokens.client(for: $0) })
  }

  /// `127.0.0.1:<port>` while listening, nil otherwise.
  var boundAddress: String? { state.withLock { $0.bound } }

  // MARK: - Lifecycle

  /// Binds `127.0.0.1:<port>` and starts accepting. Throws when the port
  /// cannot be bound, most often because another process holds it.
  func start() throws {
    guard state.withLock({ $0.fd }) < 0 else { return }
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw ListenError.socket("socket: \(errnoText())") }
    closeOnExec(fd)
    // So a restart can bind while connections it closed sit in TIME_WAIT. It
    // does not let a second listener take the same address: that needs
    // SO_REUSEPORT, which is never set.
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))

    // The loopback address by number, never a name: `localhost` can be made
    // to resolve elsewhere.
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(truncatingIfNeeded: port).bigEndian)
    address.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0 else {
      let detail = errnoText()
      close(fd)
      throw ListenError.socket(detail)
    }
    guard listen(fd, 128) == 0 else {
      let detail = errnoText()
      close(fd)
      throw ListenError.socket("listen: \(detail)")
    }

    var actual = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &actual) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    let address127 = "127.0.0.1:\(UInt16(bigEndian: actual.sin_port))"
    state.withLock {
      $0.fd = fd
      $0.bound = address127
    }
    hostLog("cupertino", .info, "HTTP listening at http://\(address127)/s/<surface>")
    // Off the main thread, and before any request: the first one should not
    // wait on the Keychain.
    let tokens = self.tokens
    DispatchQueue.global(qos: .utility).async { tokens.preload() }
    onDedicatedThread("cupertino.http.accept") { self.acceptLoop(fd) }
  }

  /// Stops accepting, ends every session and shuts every connection down.
  /// Returns at once; the threads finish on their own.
  func stop() {
    let (fd, sessions) = state.withLock { state -> (Int32, [HTTPSession]) in
      let taken = (state.fd, Array(state.sessions.values))
      state.fd = -1  // read by acceptLoop to tell a deliberate stop from a failure
      state.bound = nil
      state.sessions = [:]
      // Under the lock, for the reason `ServerHost.trialClients` gives: a
      // connection thread untracks its descriptor here before closing it.
      for connection in state.connections { shutdown(connection, SHUT_RDWR) }
      return taken
    }
    guard fd >= 0 else { return }
    close(fd)
    for session in sessions { session.end("the HTTP listener stopped") }
    hostLog("cupertino", .info, "HTTP listener stopped")
  }

  /// Ends every session `pick` chooses, as a hang-up would.
  func endSessions(where pick: (HTTPSessionInfo) -> Bool) {
    let chosen = state.withLock { Array($0.sessions.values) }.filter { pick($0.info) }
    for session in chosen { session.end("ended by the host") }
  }

  fileprivate func forget(_ session: HTTPSession) {
    state.withLock { state in
      if state.sessions[session.id] === session { state.sessions[session.id] = nil }
    }
  }

  private func nextStreamID() -> Int {
    streamIDs.withLock {
      $0 += 1
      return $0
    }
  }

  // MARK: - Accepting

  /// `ServerHost.acceptLoop`'s rules: transient failures are recovered from,
  /// and a stop is told from a failure by the descriptor having changed.
  private func acceptLoop(_ fd: Int32) {
    while true {
      let client = accept(fd, nil, nil)
      if client < 0 {
        let failure = errno
        if state.withLock({ $0.fd }) != fd { return }
        switch failure {
        case EINTR, ECONNABORTED:
          continue
        case EMFILE, ENFILE, ENOMEM, ENOBUFS:
          hostLog(
            "cupertino", .error, "HTTP accept deferred: \(String(cString: strerror(failure)))")
          usleep(100_000)
          continue
        default:
          hostLog("cupertino", .error, "HTTP accept failed: \(String(cString: strerror(failure)))")
          return
        }
      }
      closeOnExec(client)
      var one: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

      // Before the thread, which is what the budget is for.
      guard budget.acquire() else {
        refuseOverBudget(client)
        continue
      }
      let tracked = state.withLock { state -> Bool in
        guard state.fd == fd else { return false }
        state.connections.insert(client)
        state.overBudgetLogged = false
        return true
      }
      guard tracked else {
        budget.release()
        close(client)
        return
      }
      onDedicatedThread("cupertino.http") { self.serveConnection(client) }
    }
  }

  private func refuseOverBudget(_ client: Int32) {
    var brief = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &brief, socklen_t(MemoryLayout<timeval>.size))
    _ = writeAll(
      client,
      HTTPWire.refusal(
        503, "over \(Self.connectionLimit) connections; close one and retry", close: true))
    close(client)
    let first = state.withLock { state -> Bool in
      defer { state.overBudgetLogged = true }
      return !state.overBudgetLogged
    }
    if first {
      hostLog(
        "cupertino", .error,
        "HTTP refused connections past the limit of \(Self.connectionLimit)")
    }
  }

  // MARK: - One connection

  /// Requests one after another on one connection, for as long as the client
  /// keeps it.
  private func serveConnection(_ fd: Int32) {
    defer {
      state.withLock { _ = $0.connections.remove(fd) }
      close(fd)
      budget.release()
    }
    // A client that stops reading must not hold a session's reader thread,
    // which writes the events, for ever.
    var sendLimit = timeval(tv_sec: 30, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sendLimit, socklen_t(MemoryLayout<timeval>.size))

    // What has been read and not yet answered. The head is taken out of it
    // as soon as it is parsed, so the buffer always starts at the request's
    // body, then at the next request.
    var buffer: [UInt8] = []
    while let (head, bodyStart) = readHead(fd, &buffer) {
      buffer.removeFirst(bodyStart)
      guard handle(Exchange(fd: fd, head: head), &buffer) else { return }
    }
  }

  /// The next request's head, or nil when the connection is done: closed,
  /// idle past keep-alive, or refused for a head that could not be read.
  private func readHead(_ fd: Int32, _ buffer: inout [UInt8]) -> (HTTPHead, Int)? {
    while true {
      if !buffer.isEmpty {
        switch HTTPHeadParser.parse(buffer) {
        case .head(let head, let bodyStart):
          return (head, bodyStart)
        case .tooLarge:
          hostLog("cupertino", .error, "HTTP refused: a request head over 16 KB")
          _ = writeAll(fd, HTTPWire.refusal(431, "request head over 16 KB", close: true))
          return nil
        case .malformed(let reason):
          hostLog("cupertino", .error, "HTTP refused: \(reason)")
          _ = writeAll(fd, HTTPWire.refusal(400, reason, close: true))
          return nil
        case .incomplete:
          break
        }
      }
      let wait = buffer.isEmpty ? Self.keepAliveIdleMs : Self.ioTimeoutMs
      guard Self.readMore(fd, &buffer, waitMs: wait) else { return nil }
    }
  }

  /// One more read into `buffer`, waited for up to `waitMs`. False on end of
  /// stream, a failure or the wait running out.
  private static func readMore(_ fd: Int32, _ buffer: inout [UInt8], waitMs: Int32) -> Bool {
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&poller, 1, waitMs)
      if ready < 0, errno == EINTR { continue }
      guard ready > 0 else { return false }
      let n = chunk.withUnsafeMutableBufferPointer { read(fd, $0.baseAddress, $0.count) }
      if n < 0, errno == EINTR || errno == EAGAIN { continue }
      guard n > 0 else { return false }
      buffer.append(contentsOf: chunk[0..<n])
      return true
    }
  }

  /// One request's head and what has been decided about its connection.
  nonisolated private final class Exchange {
    let fd: Int32
    let head: HTTPHead
    /// The client asked to close after this answer.
    let closeAfter: Bool
    /// A body was declared and not yet read: the connection cannot carry
    /// another request after a refusal.
    var bodyUnread: Bool

    init(fd: Int32, head: HTTPHead) {
      self.fd = fd
      self.head = head
      closeAfter = head.header("connection")?.lowercased().contains("close") == true
      bodyUnread =
        head.header("transfer-encoding") != nil
        || (head.header("content-length").map { $0 != "0" } ?? false)
    }

    var closes: Bool { closeAfter || bodyUnread }

    /// The method as the log may show it: the client chose it, so anything
    /// but a short run of capitals is not written out.
    var loggedMethod: String {
      let method = head.method
      return method.count <= 10 && method.utf8.allSatisfy({ (65...90).contains($0) })
        ? method : "a request"
    }

    /// Answers a refusal, logs it by reason (never a token), and says whether
    /// the connection carries on.
    func refuse(_ status: Int, _ reason: String, extra: [(String, String)] = []) -> Bool {
      hostLog("cupertino", .error, "HTTP refused \(loggedMethod) with \(status): \(reason)")
      let close = closes
      _ = writeAll(fd, HTTPWire.refusal(status, reason, close: close, extra: extra))
      return !close
    }

    /// An answer that is not a refusal.
    func answer(_ status: Int, body: Data = Data(), contentType: String? = nil) -> Bool {
      let close = closes
      _ = writeAll(
        fd, HTTPWire.response(status, body: body, contentType: contentType, close: close))
      return !close
    }
  }

  /// Answers one request; false when the connection is done.
  private func handle(_ exchange: Exchange, _ buffer: inout [UInt8]) -> Bool {
    let head = exchange.head
    let surface: String
    let client: String
    switch gate.check(head) {
    case .refuse(let status, let reason):
      return exchange.refuse(status, reason)
    case .admit(let admittedSurface, let admittedClient):
      surface = admittedSurface
      client = admittedClient
    }
    // The only source of a client's identity over HTTP, and it goes into a
    // one-line handshake: it must be one the handshake can carry.
    guard BridgeProtocol.isWellFormedClient(client) else {
      return exchange.refuse(401, "the token names a malformed client id")
    }

    let named = head.header("mcp-session-id")
    // Everything about the session is read from the head, so a request for a
    // session it may not reach is refused before its body is.
    var session: HTTPSession?
    if let named {
      guard let found = lookup(named, client: client, surface: surface) else {
        return exchange.refuse(404, "no such session")
      }
      guard head.header("mcp-protocol-version") != nil else {
        return exchange.refuse(400, "MCP-Protocol-Version is required after initialize")
      }
      session = found
    }

    switch head.method {
    case "POST":
      guard let body = readBody(exchange, &buffer) else { return false }
      if let session { return post(body, to: session, exchange, &buffer) }
      switch HTTPSessionGate.preSession(body) {
      case .initialize:
        guard let opened = open(surface: surface, client: client, exchange) else {
          return !exchange.closes
        }
        return post(body, to: opened, exchange, &buffer, carriesID: true)
      case .discoverRefused(let status, let answer):
        return exchange.answer(status, body: answer, contentType: "application/json")
      case .invalid(let status):
        return exchange.refuse(status, "a POST without a session must be one initialize request")
      }
    case "GET":
      guard let session else { return exchange.refuse(400, "Mcp-Session-Id is required") }
      return stream(get: session, exchange, &buffer)
    case "DELETE":
      guard let session else { return exchange.refuse(400, "Mcp-Session-Id is required") }
      session.end("DELETE")
      return exchange.answer(200)
    default:
      return exchange.refuse(405, "method not allowed", extra: [("Allow", "GET, POST, DELETE")])
    }
  }

  private func lookup(_ id: String, client: String, surface: String) -> HTTPSession? {
    guard SessionID.isWellFormed(id), let session = state.withLock({ $0.sessions[id] }),
      session.client == client, session.surface == surface
    else { return nil }
    return session
  }

  /// The body, read only now that the gate and the session checks passed,
  /// and capped before a byte of it is read. Nil once a refusal has been
  /// answered or the client went away; either ends the connection.
  private func readBody(_ exchange: Exchange, _ buffer: inout [UInt8]) -> Data? {
    let head = exchange.head
    guard head.header("transfer-encoding") == nil else {
      _ = exchange.refuse(501, "chunked request bodies are not supported")
      return nil
    }
    let length: Int
    switch HTTPHeadParser.contentLength(head) {
    case nil: length = 0
    case .failure?:
      _ = exchange.refuse(400, "Content-Length is not one decimal number")
      return nil
    case .success(let value)?: length = value
    }
    guard length <= Self.maxBodyBytes else {
      _ = exchange.refuse(413, "body over \(Self.maxBodyBytes >> 20) MB")
      return nil
    }
    while buffer.count < length {
      guard Self.readMore(exchange.fd, &buffer, waitMs: Self.ioTimeoutMs) else { return nil }
    }
    let body = Data(buffer[..<length])
    buffer.removeFirst(length)
    exchange.bodyUnread = false
    return body
  }

  // MARK: - Sessions

  /// A session for an `initialize` the gate admitted: a socketpair, its far
  /// end served by the host, and the host's answer to the handshake. Nil once
  /// the refusal has been answered.
  private func open(surface: String, client: String, _ exchange: Exchange) -> HTTPSession? {
    guard let host else {
      _ = exchange.refuse(503, "Cupertino is not serving")
      return nil
    }
    var pair: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else {
      _ = exchange.refuse(503, "could not open a session: \(errnoText())")
      return nil
    }
    let mine = pair[0]
    closeOnExec(mine)
    var one: Int32 = 1
    setsockopt(mine, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    // The host's from here; `serve` closes it.
    host.serveInternal(pair[1])

    let line = BridgeProtocol.handshake(server: surface, client: client)
    let reply = writeAll(mine, Data(line.utf8)) ? Self.readReply(mine) : nil
    guard reply == BridgeProtocol.ok else {
      close(mine)
      let reason =
        reply.map {
          $0.hasPrefix(BridgeProtocol.errorPrefix)
            ? String($0.dropFirst(BridgeProtocol.errorPrefix.count)) : $0
        } ?? "the host did not answer the handshake"
      hostLog(surface, .error, "HTTP session refused: \(reason)")
      _ = writeAll(
        exchange.fd, HTTPWire.refusal(503, reason, close: exchange.closes))
      return nil
    }

    let session = HTTPSession(
      id: SessionID.mint(), client: client, surface: surface, fd: mine, listener: self)
    let registered = state.withLock { state -> Bool in
      guard state.fd >= 0 else { return false }
      state.sessions[session.id] = session
      return true
    }
    onDedicatedThread("cupertino.http.session") { session.readLoop() }
    guard registered else {
      session.end("the HTTP listener stopped")
      _ = exchange.refuse(503, "Cupertino stopped serving HTTP")
      return nil
    }
    hostLog(surface, .info, "HTTP session \(session.short) opened for \(client)")
    return session
  }

  /// The host's one-line answer to the handshake, `ok` or `err …`.
  private static func readReply(_ fd: Int32) -> String? {
    var out: [UInt8] = []
    let deadline = Date().addingTimeInterval(Double(BridgeProtocol.handshakeTimeoutSeconds) + 5)
    while out.count < 4096 {
      let left = Int32(max(0, deadline.timeIntervalSinceNow) * 1000)
      guard left > 0 else { return nil }
      var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&poller, 1, left)
      if ready < 0, errno == EINTR { continue }
      guard ready > 0 else { return nil }
      var byte: UInt8 = 0
      let n = read(fd, &byte, 1)
      if n < 0, errno == EINTR { continue }
      guard n > 0 else { return nil }
      if byte == UInt8(ascii: "\n") { return String(decoding: out, as: UTF8.self) }
      out.append(byte)
    }
    return nil
  }

  /// A POST to a live session, answered `202`, as a stream, or refused.
  private func post(
    _ body: Data, to session: HTTPSession, _ exchange: Exchange, _ buffer: inout [UInt8],
    carriesID: Bool = false
  ) -> Bool {
    let id = nextStreamID()
    switch session.post(
      body, stream: id, fd: exchange.fd,
      head: HTTPWire.streamHead(sessionID: carriesID ? session.id : nil, close: exchange.closeAfter)
    )
    {
    case .gone:
      return exchange.refuse(404, "the session ended")
    case .invalid(let status, let reason):
      session.settle()
      return exchange.refuse(status, reason)
    case .accepted:
      session.settle()
      return exchange.answer(202)
    case .stream(let stream):
      return hold(stream, id: id, of: session, exchange, &buffer)
    }
  }

  /// The session's GET stream.
  private func stream(get session: HTTPSession, _ exchange: Exchange, _ buffer: inout [UInt8])
    -> Bool
  {
    let id = nextStreamID()
    guard
      let stream = session.openGet(
        stream: id, fd: exchange.fd,
        head: HTTPWire.streamHead(sessionID: nil, close: exchange.closeAfter))
    else { return exchange.refuse(404, "the session ended") }
    return hold(stream, id: id, of: session, exchange, &buffer)
  }

  /// Holds the connection while its stream is open, then gives the session
  /// the end of it. Bytes the client sent meanwhile are kept for the next
  /// request.
  private func hold(
    _ stream: SSEStream, id: Int, of session: HTTPSession, _ exchange: Exchange,
    _ buffer: inout [UInt8]
  ) -> Bool {
    var early: [UInt8] = []
    let end = stream.wait(early: &early)
    buffer += early
    session.streamEnded(id)
    return end == .finished && !exchange.closeAfter
  }
}

/// One HTTP session: its end of the socketpair, its router and its open streams.
nonisolated private final class HTTPSession: @unchecked Sendable {
  let id: String
  let client: String
  let surface: String
  let fd: Int32
  private weak var listener: HTTPListener?

  /// Held by whoever writes to `fd`, and by the reader while it closes it, so
  /// lines from two POSTs never interleave and no write lands on a closed
  /// descriptor. Taken before `state`, never after it.
  private let writeLock = NSLock()

  private struct State {
    var router: HTTPSessionRouter
    var streams: [Int: SSEStream] = [:]
    var getStream: Int?
    var everHadGet = false
    /// Bumped by every request and every stream that ends; a timer that finds
    /// it moved has been overtaken.
    var activity = 0
    /// Why this side ended the session; set once, with the shutdown.
    var ending: String?
    /// `fd` is closed. Set by the reader, under `writeLock`.
    var closed = false
  }
  private let state: OSAllocatedUnfairLock<State>

  init(id: String, client: String, surface: String, fd: Int32, listener: HTTPListener) {
    self.id = id
    self.client = client
    self.surface = surface
    self.fd = fd
    self.listener = listener
    state = OSAllocatedUnfairLock(uncheckedState: State(router: HTTPSessionRouter(id: id)))
  }

  var info: HTTPSessionInfo { HTTPSessionInfo(id: id, client: client, surface: surface) }

  /// Enough of the id to tell sessions apart in the log, not enough to use.
  var short: String { String(id.prefix(8)) }

  nonisolated enum Posted {
    case gone
    case invalid(Int, String)
    case accepted
    case stream(SSEStream)
  }

  /// Routes one POST body and writes its lines to the host. A stream's head
  /// is written on the connection before any line goes down, so no answer
  /// can reach the stream ahead of it.
  func post(_ body: Data, stream id: Int, fd connection: Int32, head: Data) -> Posted {
    writeLock.lock()
    defer { writeLock.unlock() }
    let decided = state.withLock { state -> (PostOutcome, SSEStream?)? in
      guard !state.closed, state.ending == nil else { return nil }
      state.activity += 1
      assert(
        !state.router.openPosts.contains(id), "a stream id is posted on once, never while pending")
      let outcome = state.router.post(body, stream: id)
      guard case .stream = outcome else { return (outcome, nil) }
      let stream = SSEStream(fd: connection)
      stream.open(head)
      state.streams[id] = stream
      return (outcome, stream)
    }
    guard let (outcome, stream) = decided else { return .gone }
    switch outcome {
    case .invalid(let status, let reason):
      return .invalid(status, reason)
    case .accepted(let lines):
      writeLines(lines)
      return .accepted
    case .stream(let lines):
      writeLines(lines)
      return stream.map(Posted.stream) ?? .gone
    }
  }

  /// Under `writeLock`, which `post` holds: `fd` is open, since only the
  /// reader closes it and only under that lock. A failed write is a session
  /// already ending, and the reader ends its streams.
  private func writeLines(_ lines: [Data]) {
    var data = Data()
    for line in lines {
      data += line
      data.append(UInt8(ascii: "\n"))
    }
    _ = writeAll(fd, data)
  }

  /// Opens the session's GET stream. One already open is ended: a client that
  /// opens a second has given up on the first.
  func openGet(stream id: Int, fd connection: Int32, head: Data) -> SSEStream? {
    let opened = state.withLock { state -> (SSEStream, SSEStream?)? in
      guard !state.closed, state.ending == nil else { return nil }
      state.activity += 1
      let previous = state.getStream.flatMap { state.streams[$0] }
      state.router.openGet(stream: id)
      state.getStream = id
      state.everHadGet = true
      let stream = SSEStream(fd: connection)
      stream.open(head)
      state.streams[id] = stream
      return (stream, previous)
    }
    opened?.1?.finish()
    return opened?.0
  }

  /// A stream ended, by either side; the connection thread that held it says so.
  func streamEnded(_ id: Int) {
    state.withLock { state in
      state.router.closeStream(id)
      state.streams[id] = nil
      if state.getStream == id { state.getStream = nil }
      state.activity += 1
    }
    settle()
  }

  /// Arms the timer that ends a session nothing is using: the GET-close grace
  /// for one that had a GET stream, the idle limit for one that never did.
  /// Overtaken by any request or stream end in between.
  func settle() {
    let plan = state.withLock { state -> (Int, TimeInterval, String)? in
      guard !state.closed, state.ending == nil, !state.router.hasGet,
        state.router.openPosts.isEmpty
      else { return nil }
      return state.everHadGet
        ? (state.activity, HTTPListener.getCloseGrace, "its GET stream closed")
        : (state.activity, HTTPListener.idleLimit, "idle")
    }
    guard let (activity, delay, reason) = plan else { return }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      let due = self.state.withLock { state in
        state.activity == activity && !state.router.hasGet && state.router.openPosts.isEmpty
      }
      if due { self.end("\(reason), \(Self.seconds(delay)) with no request") }
    }
  }

  private static func seconds(_ interval: TimeInterval) -> String {
    interval >= 60 ? "\(Int(interval / 60)) min" : "\(interval) s"
  }

  /// Ends the session from the HTTP side: the session end is shut down, and
  /// the host sees what a bridge's hang-up looks like. The reader then sees
  /// end of stream and ends every open stream.
  func end(_ reason: String) {
    let first = state.withLock { state -> Bool in
      guard !state.closed, state.ending == nil else { return false }
      state.ending = reason
      shutdown(fd, SHUT_RDWR)
      return true
    }
    guard first else { return }
    listener?.forget(self)
    hostLog(surface, .info, "HTTP session \(short) ending: \(reason)")
  }

  /// The session end's lines, to the streams the router names, until it ends.
  func readLoop() {
    var lines = LineBuffer()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let n = buffer.withUnsafeMutableBufferPointer { read(fd, $0.baseAddress, $0.count) }
      if n < 0, errno == EINTR { continue }
      guard n > 0 else { break }
      for line in lines.append(Data(buffer[0..<n])) {
        // Decided under the lock, written outside it, so a slow client holds
        // up its own session's events and never the lock other requests take.
        let deliveries = state.withLock { state -> [(SSEStream, Data?)] in
          state.router.fromChild(line).compactMap { delivery in
            switch delivery {
            case .toStream(let id, let data): state.streams[id].map { ($0, data) }
            case .closeStream(let id): state.streams[id].map { ($0, nil) }
            case .dropped: nil
            }
          }
        }
        for (stream, data) in deliveries {
          if let data { stream.send(data) } else { stream.finish() }
        }
      }
    }

    // End of stream: the host ended the session, or this side did. Closed
    // under the write lock, so no POST is mid-write on it.
    writeLock.lock()
    let (streams, reason) = state.withLock { state -> ([SSEStream], String?) in
      state.closed = true
      close(fd)
      let open = Array(state.streams.values)
      state.streams = [:]
      return (open, state.ending)
    }
    writeLock.unlock()
    for stream in streams { stream.finish() }
    listener?.forget(self)
    if reason == nil { hostLog(surface, .info, "HTTP session \(short) ended by the host") }
  }
}

/// One SSE response: written by the session's reader, held by the
/// connection's thread until it ends.
///
/// `done` is set once, under the lock, by whichever comes first: the last
/// chunk written, a write that failed, or the connection thread abandoning
/// the stream. Nothing writes to the connection after it, so the connection
/// thread may answer the next request on it, or close it.
nonisolated private final class SSEStream: @unchecked Sendable {
  nonisolated enum End: Equatable {
    /// The last chunk was written: the connection can carry another request.
    case finished
    /// A write failed.
    case failed
    /// The client closed, or the connection was shut down.
    case clientGone
  }

  private let fd: Int32
  private let lock = NSLock()
  private var done = false
  private var failed = false
  /// Wakes `wait` when `done` is set from another thread.
  private var wake: [Int32] = [-1, -1]

  init(fd: Int32) {
    self.fd = fd
    if pipe(&wake) == 0 {
      closeOnExec(wake[0])
      closeOnExec(wake[1])
      _ = fcntl(wake[1], F_SETFL, fcntl(wake[1], F_GETFL) | O_NONBLOCK)
    }
  }

  deinit {
    for end in wake where end >= 0 { close(end) }
  }

  func open(_ head: Data) {
    lock.withLock {
      if !writeAll(fd, head) {
        failed = true
        done = true
      }
    }
  }

  func send(_ line: Data) {
    lock.withLock {
      guard !done else { return }
      if !writeAll(fd, HTTPWire.event(line)) {
        failed = true
        done = true
        poke()
      }
    }
  }

  func finish() {
    lock.withLock {
      guard !done else { return }
      done = true
      if !writeAll(fd, HTTPWire.lastChunk) { failed = true }
      poke()
    }
  }

  private func poke() {
    var byte: UInt8 = 1
    _ = write(wake[1], &byte, 1)
  }

  private func abandon() {
    lock.withLock {
      done = true
      failed = true
    }
  }

  /// Blocks until the stream ends. Watches the connection meanwhile, so a
  /// client closing it is seen at once.
  func wait(early: inout [UInt8]) -> End {
    var chunk = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      if let end = lock.withLock({ done ? (failed ? End.failed : End.finished) : nil }) {
        return end
      }
      var fds = [
        pollfd(fd: fd, events: Int16(POLLIN), revents: 0),
        pollfd(fd: wake[0], events: Int16(POLLIN), revents: 0),
      ]
      // Without a wake pipe (none could be made), a finish is seen on the
      // next tick rather than never.
      let ready = poll(&fds, 2, wake[0] >= 0 ? -1 : 100)
      if ready < 0 {
        if errno == EINTR { continue }
        abandon()
        return .clientGone
      }
      if fds[1].revents != 0 {
        _ = chunk.withUnsafeMutableBufferPointer { read(wake[0], $0.baseAddress, 16) }
      }
      if fds[0].revents != 0 {
        let n = chunk.withUnsafeMutableBufferPointer { read(fd, $0.baseAddress, $0.count) }
        if n < 0, errno == EINTR || errno == EAGAIN { continue }
        guard n > 0, early.count < HTTPHeadParser.maxHeadBytes + HTTPListener.maxBodyBytes else {
          abandon()
          return .clientGone
        }
        early.append(contentsOf: chunk[0..<n])
      }
    }
  }
}

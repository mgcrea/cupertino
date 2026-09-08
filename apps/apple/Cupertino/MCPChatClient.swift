import Foundation
import os

/// An MCP client that dials Cupertino's own socket.
///
/// ## Why the long way round
///
/// The Chat pane could reach a surface's tools the way `SurfaceCatalog` does —
/// spawn `node dist/cli.js` on a pipe and talk to it directly. That was
/// rejected. A call made that way is a second path to the same servers, and
/// every guarantee the app makes lives on the first one: the write gate is
/// applied by `ServerLocator.environment`, the surface switch is re-read per
/// request, sessions appear in the Connections pane, calls land in the Log and
/// in `CallCapture`. A private path would have to reimplement all of it, and
/// would drift.
///
/// So this connects to `BridgeProtocol.socketPath` and sends the handshake
/// `cupertino-bridge` sends, with one extra field. Every byte after that is
/// ordinary MCP. A tool call from the Chat pane is indistinguishable from a
/// tool call made by Claude Code, because it *is* one — which is the only way
/// the pane can honestly claim to be exercising the servers.
///
/// The extra field is `self`, and `ServerHost.serve` accepts it only from this
/// process. It buys two things: the licence carve-out (the chat is not a relay,
/// so it works before a key is entered), and `lazyTools: false` (a lazy server
/// answers `tools/list` with a search tool and a dispatcher, which would give
/// the model four tools on every surface).
///
/// ## Threading
///
/// Everything here blocks, and every entry point must be called off the main
/// actor. This is not a preference. `serveInProcess` answers `screen`, `sound`,
/// `desktop` and `simulator` on a thread of its own, and those servers reach
/// the main actor through `InProcessRPC.blocking` — so a main thread sitting in
/// `read(2)` waiting for the reply deadlocks the app outright, with no watchdog
/// and nothing in the log. `ChatConversation` hops through `onDedicatedThread`
/// for exactly this, and the hop is load-bearing rather than tidy.
final class MCPChatClient: @unchecked Sendable {
  enum Failure: LocalizedError {
    case notHosting(String)
    case unaddressable(String)
    case noSocket
    case refused(String)
    case disconnected
    case timedOut(String)
    case badReply(String)

    var errorDescription: String? {
      switch self {
      case .notHosting(let why): why
      case .unaddressable(let path):
        "The socket path is too long for a unix address: \(path)"
      case .noSocket:
        "Cupertino is not listening on its own socket. Check the Activity window."
      case .refused(let why): why
      case .disconnected:
        "The server stopped. Pick a surface again to start over."
      case .timedOut(let what): "\(what) did not answer in time."
      case .badReply(let what): what
      }
    }
  }

  /// The setup phase only. Past the handshake this is cleared, because a chat
  /// is idle between questions by design and a residual timeout would kill
  /// every conversation that paused for fifteen seconds — the same reasoning
  /// `ServerHost.serve` writes down on the other end of this socket.
  private static let setupTimeout: time_t = 15

  /// One tool call. Not a protocol deadline — MCP has none — but a surface that
  /// has wedged should not leave a spinner up forever. Generous, because
  /// `apple_mail_query` over a large store is slow rather than broken.
  private static let callTimeout: TimeInterval = 60

  private let fd: Int32
  private let surface: Surface
  private let writing = OSAllocatedUnfairLock<Void>(initialState: ())
  private let state = OSAllocatedUnfairLock<State>(initialState: State())
  /// Called once, from the reader thread, when the connection ends.
  private let onClosed: @Sendable () -> Void

  private struct State {
    var nextID = 10
    var waiting: [Int: Waiter] = [:]
    /// Ids whose caller has already given up. The reply still arrives on this
    /// connection and must be dropped — without this it would be sitting in the
    /// buffer when the next call went looking for its own answer.
    var abandoned: Set<Int> = []
    var closed = false
  }

  private final class Waiter {
    let ready = DispatchSemaphore(value: 0)
    var result: Result<[String: Any], Failure>?
  }

  private init(fd: Int32, surface: Surface, onClosed: @escaping @Sendable () -> Void) {
    self.fd = fd
    self.surface = surface
    self.onClosed = onClosed
  }

  // MARK: - Opening

  /// Connect, handshake, initialise. Blocking; never call from the main actor.
  static func open(
    surface: Surface, onClosed: @escaping @Sendable () -> Void
  ) throws -> MCPChatClient {
    // Refuse rather than connect to somebody else's servers.
    //
    // A second copy of Cupertino holds the host lock — a Debug build against an
    // installed one, or an old copy still running from another directory — and
    // `connect` to that path succeeds perfectly well. It would reach THAT
    // build's servers, with that build's surface switches, and `peerPID` there
    // is not `getpid()` here, so the licence gate would apply and produce a
    // refusal sentence nobody could explain. `startupError` already names the
    // holder's path.
    if let why = ServerHost.shared.startupError {
      throw Failure.notHosting(why)
    }

    let path = BridgeProtocol.socketPath
    guard let address = unixAddress(path) else { throw Failure.unaddressable(path) }

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Failure.noSocket }
    closeOnExec(fd)
    guard address.withSockaddr({ connect(fd, $0, $1) }) == 0 else {
      Foundation.close(fd)
      throw Failure.noSocket
    }

    // A deadline for the handshake and the two setup calls, cleared below.
    var deadline = timeval(tv_sec: setupTimeout, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size))

    guard writeAll(fd, Data(BridgeProtocol.selfHandshake(server: surface.id).utf8)) else {
      Foundation.close(fd)
      throw Failure.noSocket
    }

    // The host answers `ok` or `err <prose>` — a switched-off surface, or a
    // build with no in-process server for it. The prose is written to be shown.
    let reader = SocketLineReader(fd: fd)
    guard let greeting = reader.next().map({ String(decoding: $0, as: UTF8.self) }) else {
      Foundation.close(fd)
      throw Failure.timedOut("The host")
    }
    guard greeting == BridgeProtocol.ok else {
      Foundation.close(fd)
      throw Failure.refused(
        greeting.hasPrefix("err ") ? String(greeting.dropFirst(4)) : greeting)
    }

    let client = MCPChatClient(fd: fd, surface: surface, onClosed: onClosed)

    // Past this point the socket belongs to JSON-RPC, and blocking forever on a
    // read is correct.
    var forever = timeval(tv_sec: 0, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &forever, socklen_t(MemoryLayout<timeval>.size))
    client.startReading(reader)

    _ = try client.request(
      "initialize",
      [
        "protocolVersion": "2025-06-18", "capabilities": [:],
        // What the Connections pane and every log line will call this.
        "clientInfo": ["name": Self.clientName, "version": AppInfo.version],
      ])
    client.notify("notifications/initialized")
    return client
  }

  /// The name this shows up under in Activity and Connections.
  ///
  /// Opening the Chat pane really does add a client, and saying so is the
  /// honest rendering: those calls are real, they touched the user's data, and
  /// a pane that made them invisible would be the one place in the app where
  /// something happened and the Log did not say so.
  static let clientName = "Cupertino (chat)"

  // MARK: - Reading

  private func startReading(_ reader: SocketLineReader) {
    onDedicatedThread("cupertino.chat.read") { [self] in
      while let line = reader.next() {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          let id = object["id"] as? Int
        else { continue }  // a notification, or a log line that happens to be JSON
        let waiter: Waiter? = state.withLock {
          if $0.abandoned.remove(id) != nil { return nil }
          return $0.waiting.removeValue(forKey: id)
        }
        guard let waiter else { continue }
        if let error = object["error"] as? [String: Any] {
          waiter.result = .failure(
            .badReply(error["message"] as? String ?? "the server reported an error"))
        } else {
          waiter.result = .success(object["result"] as? [String: Any] ?? [:])
        }
        waiter.ready.signal()
      }
      finish()
      // The one place the descriptor is released. `close` above only shuts the
      // socket down, because this thread is parked in `read(2)` on it and
      // closing it from another thread would be a use-after-free rather than an
      // end of stream.
      Foundation.close(fd)
    }
  }

  /// End of stream: the child exited, or the surface was switched off and
  /// `stopSessions` sent it a SIGTERM. Everything still waiting fails, once.
  private func finish() {
    let stranded: [Waiter] = state.withLock {
      guard !$0.closed else { return [] }
      $0.closed = true
      let waiting = Array($0.waiting.values)
      $0.waiting.removeAll()
      return waiting
    }
    for waiter in stranded {
      waiter.result = .failure(.disconnected)
      waiter.ready.signal()
    }
    onClosed()
  }

  // MARK: - Writing

  private func notify(_ method: String) {
    guard
      var line = try? JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0", "method": method,
      ])
    else { return }
    line.append(0x0A)
    writing.withLock { _ = writeAll(fd, line) }
  }

  /// One request, blocking until its own reply arrives.
  ///
  /// Matched by id rather than by position, because more than one can be in
  /// flight: the model is allowed to call two tools in a single turn.
  private func request(
    _ method: String, _ params: [String: Any], timeout: TimeInterval? = nil
  ) throws -> [String: Any] {
    let waiter = Waiter()
    let id: Int = try state.withLock {
      if $0.closed { throw Failure.disconnected }
      let id = $0.nextID
      $0.nextID += 1
      $0.waiting[id] = waiter
      return id
    }

    var line = try JSONSerialization.data(withJSONObject: [
      "jsonrpc": "2.0", "id": id, "method": method, "params": params,
    ])
    line.append(0x0A)
    guard writing.withLock({ writeAll(fd, line) }) else {
      state.withLock { $0.waiting[id] = nil }
      throw Failure.disconnected
    }

    if let timeout {
      guard waiter.ready.wait(timeout: .now() + timeout) == .success else {
        // The reply is still coming. Mark the id so the reader drops it rather
        // than handing it to whoever asks next.
        state.withLock {
          $0.waiting[id] = nil
          $0.abandoned.insert(id)
        }
        throw Failure.timedOut(method)
      }
    } else {
      waiter.ready.wait()
    }
    switch waiter.result {
    case .success(let result): return result
    case .failure(let error): throw error
    case nil: throw Failure.disconnected
    }
  }

  // MARK: - The two things the pane needs

  /// Every tool this surface exposes, under the write setting it was opened
  /// with. Blocking.
  func listTools() throws -> [ChatTool] {
    let result = try request("tools/list", [:], timeout: TimeInterval(Self.setupTimeout))
    let raw = result["tools"] as? [[String: Any]] ?? []
    return raw.compactMap(ChatTool.init(json:))
  }

  /// One `tools/call`, as the pane renders it.
  ///
  /// Never throws. The model reads this string, and a failure is something it
  /// should be told about and allowed to recover from — a refused argument is
  /// information, not a crash. Two kinds of failure are worth telling apart and
  /// both end up here: `isError` is a tool that ran and failed, an exception is
  /// a call that never happened.
  func call(_ name: String, argumentsJSON json: String) -> ChatCall {
    let parsed =
      (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
    let began = Date()
    do {
      let result = try request(
        "tools/call", ["name": name, "arguments": parsed], timeout: Self.callTimeout)
      return ChatCall(
        tool: name, arguments: json, output: renderMCPResult(result),
        failed: result["isError"] as? Bool ?? false,
        seconds: Date().timeIntervalSince(began))
    } catch {
      return ChatCall(
        tool: name, arguments: json, output: error.localizedDescription, failed: true,
        seconds: Date().timeIntervalSince(began))
    }
  }

  /// Hang up. Idempotent — `finish` runs once whether it is reached from here
  /// or from end of stream.
  func close() {
    let alreadyClosed = state.withLock { $0.closed }
    guard !alreadyClosed else { return }
    // `shutdown` rather than `close`: the reader thread is parked in `read(2)`
    // on this descriptor, and closing it underneath would be a use-after-free
    // rather than an end of stream. This wakes it, it sees EOF, it calls
    // `finish`, and the descriptor is released there.
    shutdown(fd, SHUT_RDWR)
  }

}

/// Newline-delimited reader over a socket.
///
/// The same framing problem `SurfaceCatalog.LineReader` and `RequestObserver`
/// both document — reads come back in chunks with no regard for line
/// boundaries — but over a descriptor rather than a `FileHandle`, because this
/// one is a socket and it has to survive `shutdown` from another thread.
private final class SocketLineReader {
  private let fd: Int32
  private var pending = Data()
  private var done = false
  private var buffer = [UInt8](repeating: 0, count: 64 * 1024)

  init(fd: Int32) { self.fd = fd }

  func next() -> Data? {
    while true {
      if let index = pending.firstIndex(of: 0x0A) {
        let line = pending[..<index]
        pending = Data(pending[pending.index(after: index)...])
        if !line.isEmpty { return Data(line) }
        continue
      }
      if done { return nil }
      let n = buffer.withUnsafeMutableBufferPointer { read(fd, $0.baseAddress, $0.count) }
      if n <= 0 {
        done = true
        let rest = pending
        pending = Data()
        return rest.isEmpty ? nil : rest
      }
      pending.append(contentsOf: buffer[0..<n])
    }
  }
}

import Foundation

/// Hosts the MCP servers, so that Cupertino — not the MCP client — is the
/// process macOS holds responsible for reading Mail and driving Apple Events.
///
/// Measured in `scripts/spike-app-tcc`: Full Disk Access and Automation granted
/// to a signed `.app` are inherited by the processes it spawns, two levels
/// deep, and do not leak to identical binaries run from a shell. That is what
/// `native/launcher.c` used a private SPI to obtain, and why the SPI is no
/// longer needed.
///
/// One accepted connection maps to one server process. There is no session
/// multiplexing because there is no need for any: MCP clients open one stdio
/// connection each, and a process per connection keeps their state, their
/// crashes and their write permissions separate.
nonisolated final class ServerHost: @unchecked Sendable {
  static let shared = ServerHost()

  private var listenFD: Int32 = -1
  private let queue = DispatchQueue(label: "io.mgcrea.cupertino.host", qos: .userInitiated)

  /// Why the socket never came up, if it did not. Kept rather than only logged:
  /// a host that failed to listen is the one state where nothing will ever
  /// work, and stderr is invisible to someone who launched the app from Finder.
  private(set) var startupError: String?

  enum HostError: LocalizedError {
    case pathTooLong(String)
    case socketFailed(String)

    var errorDescription: String? {
      switch self {
      case .pathTooLong(let path):
        return "socket path exceeds the unix address limit: \(path)"
      case .socketFailed(let detail):
        return "could not listen: \(detail)"
      }
    }
  }

  // MARK: - Lifecycle

  func start() throws {
    // SIGPIPE's default action is to kill the process, and this app writes to
    // descriptors whose far end routinely disappears: a client socket whose
    // bridge exited because its editor window closed, or a server's stdin
    // after the server crashed. Unhandled, one client quitting mid-request
    // took Cupertino down and every *other* client's session with it — which
    // read as "the server cannot handle multiple connections", because the
    // surviving clients are the ones who report the failure.
    //
    // Ignored rather than trapped: `writeAll` already checks every return
    // value, so EPIPE arrives as a failed write on the one connection that
    // deserves it. This must be set before the first connection is served.
    _ = signal(SIGPIPE, SIG_IGN)

    do {
      try openSocket()
      startupError = nil
    } catch {
      startupError = error.localizedDescription
      throw error
    }
  }

  // Not `listen()`: that is `Darwin.listen`, which this method calls.
  private func openSocket() throws {
    let path = BridgeProtocol.socketPath
    guard let address = unixAddress(path) else { throw HostError.pathTooLong(path) }

    try FileManager.default.createDirectory(
      atPath: BridgeProtocol.socketDirectory, withIntermediateDirectories: true)

    // A unix socket is a filesystem entry that outlives a crash, so a stale one
    // from a previous run would make bind() fail with EADDRINUSE forever.
    unlink(path)

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw HostError.socketFailed(errnoText()) }

    guard address.withSockaddr({ bind(fd, $0, $1) }) == 0 else {
      let detail = errnoText()
      close(fd)
      throw HostError.socketFailed(detail)
    }
    // Only this user may connect. The socket brokers whole-disk access; it is
    // not something to leave group- or world-writable.
    chmod(path, 0o600)

    guard listen(fd, 8) == 0 else {
      let detail = errnoText()
      close(fd)
      throw HostError.socketFailed(detail)
    }

    // Every server this host spawns would otherwise inherit the listening
    // socket, so a wedged server would keep the socket alive after Cupertino
    // quit and later connections would hang against a listener nobody is
    // accepting on.
    closeOnExec(fd)

    listenFD = fd
    hostLog("cupertino", .info, "listening at \(path)")
    queue.async { [weak self] in self?.acceptLoop(fd) }
  }

  func stop() {
    if listenFD >= 0 { close(listenFD); listenFD = -1 }
    unlink(BridgeProtocol.socketPath)
  }

  /// Accept forever, and treat "forever" literally.
  ///
  /// Returning from here retires the socket for the lifetime of the app: the
  /// path stays bound, so `connect` still succeeds and a bridge sits waiting on
  /// a handshake reply that will never come. Every transient reason `accept`
  /// can fail — a peer that hung up between connect and accept, a momentary
  /// descriptor shortage — is therefore recovered from rather than fatal.
  private func acceptLoop(_ fd: Int32) {
    while true {
      let client = accept(fd, nil, nil)
      if client < 0 {
        let failure = errno  // read before hostLog, which may clobber it
        if listenFD < 0 { return }  // stopped deliberately
        switch failure {
        case EINTR, ECONNABORTED:
          continue
        case EMFILE, ENFILE, ENOMEM, ENOBUFS:
          // The listener is fine; the machine is out of something. Back off so
          // this does not spin, and let whatever is holding the descriptors
          // release them.
          hostLog("cupertino", .error, "accept deferred: \(String(cString: strerror(failure)))")
          usleep(100_000)
          continue
        default:
          hostLog("cupertino", .error, "accept failed: \(String(cString: strerror(failure)))")
          return
        }
      }
      // Not inherited by the servers: a connection belongs to the host, and a
      // server holding a copy of some *other* client's socket keeps that client
      // from ever seeing EOF.
      closeOnExec(client)
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        self?.serve(client)
      }
    }
  }

  // MARK: - One connection

  private func serve(_ client: Int32) {
    defer { close(client) }

    guard let line = readLine(client, max: 256) else {
      reply(client, "err malformed handshake")
      return
    }
    let parts = line.split(separator: " ").map(String.init)
    guard parts.count == 2, parts[0] == BridgeProtocol.version else {
      reply(client, "err unsupported protocol '\(line)'")
      return
    }

    // Validate against the closed table. This is the same invariant
    // native/launcher.c held by compiling its paths in: a caller names a
    // surface, never a path, so this can never be turned into a
    // read-anything-with-my-permissions gadget.
    guard let surface = Surface.named(parts[1]) else {
      reply(client, "err unknown server '\(parts[1])'")
      return
    }

    // The licence gate, and the only one in the app.
    //
    // Here rather than a few lines further down because this is the last point
    // where nothing has been spawned and no `ok` has been sent. Past
    // `reply(client, BridgeProtocol.ok)` the socket belongs to JSON-RPC and
    // there is no channel left to refuse on.
    //
    // What stops is the relay — the brokered Full Disk Access grant, which is
    // the thing actually being sold. Writes are NOT gated and must not be:
    // docs/licensing.md rules that out, because it would make the free tier the
    // safe one and the paid tier the dangerous one.
    //
    // Logged as well as replied. The bridge relays this sentence to its MCP
    // host, where it lands in a log file nobody opens; the Activity window is
    // where someone will actually look for it.
    if case .refused(let reason) = LicenseStore.check {
      hostLog(surface.id, .error, "refused: \(reason)")
      reply(client, "err \(reason) — open Cupertino to enter a licence key")
      return
    }

    let binaries: ServerBinaries
    do {
      binaries = try ServerLocator.locate(surface)
    } catch {
      let detail = error.localizedDescription
      hostLog(surface.id, .error, detail)
      reply(client, "err \(detail)")
      return
    }

    reply(client, BridgeProtocol.ok)
    run(surface: surface, binaries: binaries, client: client)
  }

  private func run(surface: Surface, binaries: ServerBinaries, client: Int32) {
    let process = Process()
    process.executableURL = binaries.node
    process.arguments = [binaries.script.path]
    process.environment = ServerLocator.environment(
      for: surface, allowWrites: Settings.allowWrites(surface))

    let writes = Settings.allowWrites(surface)
    hostLog(surface.id, .info, "allowWrites=\(writes)")

    let toChild = Pipe(), fromChild = Pipe(), childErr = Pipe()
    process.standardInput = toChild
    process.standardOutput = fromChild
    process.standardError = childErr

    // The ends this host keeps. `Process` hands the child the opposite end of
    // each pair, so nothing downstream needs these — and a server that inherited
    // another connection's read end would hold that pipe open after its owner
    // exited, leaving the other connection waiting on an EOF that never lands.
    for handle in [
      toChild.fileHandleForWriting, fromChild.fileHandleForReading,
      childErr.fileHandleForReading,
    ] {
      closeOnExec(handle.fileDescriptor)
    }

    do {
      try process.run()
    } catch {
      hostLog(surface.id, .error, "could not start server: \(error.localizedDescription)")
      return
    }
    let session = UUID()
    let pid = process.processIdentifier
    Task(priority: Sessions.priority) { @MainActor in
      Sessions.shared.opened(id: session, surface: surface.id, pid: pid)
    }
    hostLog(
      surface.id, .info,
      "server started (pid \(pid))"
        + (binaries.isDevelopment ? " — development build" : ""))

    let group = DispatchGroup()
    let observer = RequestObserver(surface: surface, session: session)

    // Client -> server. Also the only place that sees requests, so it is where
    // tool calls are picked out for the log. On EOF, close the child's stdin so
    // the server shuts down cleanly; nothing else here owns that handle.
    let childStdin = toChild.fileHandleForWriting
    pump(
      from: client, to: childStdin.fileDescriptor, group: group,
      observe: { observer.saw($0) },
      onFinish: { try? childStdin.close() })

    // Server -> client. Half-close only: `serve` owns the socket and closes it
    // exactly once, in its `defer`.
    pump(
      from: fromChild.fileHandleForReading.fileDescriptor, to: client, group: group,
      onFinish: { shutdown(client, SHUT_WR) })

    // stderr is log output by construction: packages/core/src/cli.ts keeps
    // stdout clear because stdout is the JSON-RPC channel.
    DispatchQueue.global(qos: .utility).async(group: group) {
      while true {
        let data = childErr.fileHandleForReading.availableData
        if data.isEmpty { break }
        let text = String(decoding: data, as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { hostLog(surface.id, .info, text) }
      }
    }

    group.wait()
    process.waitUntilExit()
    Task(priority: Sessions.priority) { @MainActor in Sessions.shared.closed(id: session) }
    hostLog(surface.id, .info, "server exited (\(process.terminationStatus))")
  }

  // MARK: - Plumbing

  /// Copy bytes until EOF, then run `onFinish`.
  ///
  /// A pump never closes `sink`. It used to, and `serve` closed the client
  /// socket again in its `defer` — a double close. Between the two, `accept`
  /// can hand the same fd number to a new connection, so the stray close tears
  /// down an unrelated client. Two MCP clients at once is the normal case, so
  /// ownership is now explicit: whoever created a descriptor closes it, once.
  private func pump(
    from source: Int32, to sink: Int32, group: DispatchGroup,
    observe: ((Data) -> Void)? = nil,
    onFinish: @escaping () -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async(group: group) {
      var buffer = [UInt8](repeating: 0, count: 64 * 1024)
      while true {
        let n = buffer.withUnsafeMutableBufferPointer { read(source, $0.baseAddress, $0.count) }
        if n < 0 { if errno == EINTR { continue } else { break } }
        if n == 0 { break }
        let chunk = Data(buffer[0..<n])
        observe?(chunk)
        guard writeAll(sink, chunk) else { break }
      }
      // Let the far side see EOF instead of waiting forever — how, and whether
      // the descriptor is closed at all, is the caller's business.
      onFinish()
    }
  }

  private func reply(_ fd: Int32, _ line: String) {
    _ = writeAll(fd, Data("\(line)\n".utf8))
  }

  private func readLine(_ fd: Int32, max limit: Int) -> String? {
    var out = [UInt8]()
    while out.count < limit {
      var byte: UInt8 = 0
      let n = read(fd, &byte, 1)
      if n < 0 { if errno == EINTR { continue } else { return nil } }
      if n == 0 { return nil }
      if byte == UInt8(ascii: "\n") { return String(decoding: out, as: UTF8.self) }
      out.append(byte)
    }
    return nil
  }
}

@discardableResult
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
  data.withUnsafeBytes { raw -> Bool in
    guard let base = raw.baseAddress else { return true }
    var offset = 0
    while offset < raw.count {
      let n = write(fd, base + offset, raw.count - offset)
      if n <= 0 {
        if errno == EINTR { continue }
        return false
      }
      offset += n
    }
    return true
  }
}

func errnoText() -> String { String(cString: strerror(errno)) }

/// Mark `fd` FD_CLOEXEC, so spawned servers do not inherit it.
func closeOnExec(_ fd: Int32) {
  let flags = fcntl(fd, F_GETFD)
  if flags >= 0 { _ = fcntl(fd, F_SETFD, flags | FD_CLOEXEC) }
}

/// Per-surface user settings.
enum Settings {
  static func allowWrites(_ surface: Surface) -> Bool {
    UserDefaults.standard.bool(forKey: "allowWrites.\(surface.id)")
  }
}

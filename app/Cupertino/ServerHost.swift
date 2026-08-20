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

    listenFD = fd
    hostLog("cupertino", .info, "listening at \(path)")
    queue.async { [weak self] in self?.acceptLoop(fd) }
  }

  func stop() {
    if listenFD >= 0 { close(listenFD); listenFD = -1 }
    unlink(BridgeProtocol.socketPath)
  }

  private func acceptLoop(_ fd: Int32) {
    while true {
      let client = accept(fd, nil, nil)
      if client < 0 {
        if errno == EINTR { continue }
        if listenFD < 0 { return }  // stopped deliberately
        hostLog("cupertino", .error, "accept failed: \(errnoText())")
        return
      }
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

/// Per-surface user settings.
enum Settings {
  static func allowWrites(_ surface: Surface) -> Bool {
    UserDefaults.standard.bool(forKey: "allowWrites.\(surface.id)")
  }
}

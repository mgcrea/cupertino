import Foundation
import os

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

  /// Servers admitted on a trial, so the window can actually close on them.
  ///
  /// The host otherwise keeps no state — a connection lives on the stack inside
  /// `serve`/`run` and dies with it, which `Sessions` documents as the reason it
  /// exists. This is the one exception, and it is deliberately a set of pids
  /// rather than a reach back into `Sessions`: that type is observation for the
  /// Activity window, nothing in the host reads from it, and making the reaper
  /// the first thing that does would quietly turn a view model into a registry.
  private let trialPIDs = OSAllocatedUnfairLock<Set<Int32>>(initialState: [])

  /// Why the socket never came up, if it did not. Kept rather than only logged:
  /// a host that failed to listen is the one state where nothing will ever
  /// work, and stderr is invisible to someone who launched the app from Finder.
  private(set) var startupError: String?

  enum HostError: LocalizedError {
    case pathTooLong(String)
    case socketFailed(String)
    case alreadyServing(String)

    var errorDescription: String? {
      switch self {
      case .pathTooLong(let path):
        return "socket path exceeds the unix address limit: \(path)"
      case .socketFailed(let detail):
        return "could not listen: \(detail)"
      case .alreadyServing(let path):
        return """
          another copy of Cupertino is already serving \(path). \
          Quit it before starting this one — most often it is a development \
          build from a checkout and the copy in /Applications, both launched \
          by bridges from different MCP entries.
          """
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
  /// Is another host answering on this path right now?
  ///
  /// `connect(2)` is the only honest test. The file proves nothing — it outlives
  /// the process that created it — and `stat` cannot tell a live socket from the
  /// wreckage of one. A refused connection (ECONNREFUSED, or ENOENT for no file
  /// at all) means nobody is listening and the entry is safe to clear; a
  /// connection that succeeds belongs to a running Cupertino.
  ///
  /// Closed immediately: this is a probe, not a session. The far end sees a
  /// connection that hangs up before sending a handshake, which `serve` already
  /// has to tolerate — a bridge whose host quits mid-handshake does the same.
  private func socketIsLive(_ address: sockaddr_un) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    return address.withSockaddr { connect(fd, $0, $1) } == 0
  }

  private func openSocket() throws {
    let path = BridgeProtocol.socketPath
    guard let address = unixAddress(path) else { throw HostError.pathTooLong(path) }

    try FileManager.default.createDirectory(
      atPath: BridgeProtocol.socketDirectory, withIntermediateDirectories: true)

    // A unix socket is a filesystem entry that outlives a crash, so a stale one
    // from a previous run would make bind() fail with EADDRINUSE forever.
    //
    // But an unconditional unlink does not only clear stale entries — it evicts
    // LIVE ones. Two copies of Cupertino share this path (a checkout's Debug
    // build and /Applications), and the MCP config reaches both: `-dev` entries
    // point at the checkout, the rest at the installed app, and a bridge starts
    // whichever its own bundle contains. Whoever started LAST used to win
    // silently, and the earlier one went on accepting connections on a path that
    // no longer named it — a listener nobody could reach, with no error anywhere
    // and a menu bar that looked perfectly healthy.
    //
    // So ask first. A socket nobody answers is genuinely stale and safe to
    // clear; one that accepts a connection belongs to a running host, and taking
    // it is never the right move.
    if socketIsLive(address) {
      throw HostError.alreadyServing(path)
    }
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
      onDedicatedThread("cupertino.session") { [weak self] in
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
    // A key or an open trial window, and nothing else is consulted.
    //
    // Refusing here is necessary and nowhere near sufficient for the trial. An
    // MCP host opens one stdio connection when the editor launches and keeps it
    // for the life of that editor, so a gate that only turned away *new*
    // connections would hand out a thirty-minute window that really expired
    // whenever somebody next quit Cursor. `endTrialSessions` closes the ones
    // admitted here; this is the point that records which those are.
    //
    // Logged as well as replied. The bridge relays this sentence to its MCP
    // host, where it lands in a log file nobody opens; the Activity window is
    // where someone will actually look for it.
    var onTrial = false
    switch Entitlement.current {
    case .licensed:
      break
    case .trial:
      onTrial = true
      hostLog(surface.id, .info, "trial: \(Trial.remainingText)")
    case .refused(let reason):
      hostLog(surface.id, .error, "refused: \(reason)")
      reply(
        client,
        "err \(reason) — open Cupertino to enter a licence key, or to start a "
          + "\(Int(Trial.duration / 60))-minute trial")
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
    run(surface: surface, binaries: binaries, client: client, onTrial: onTrial)
  }

  /// Close every server started on the trial, when the window closes.
  ///
  /// SIGTERM rather than SIGKILL, and rather than tearing down the socket from
  /// this end: the child gets to exit on its own, `run`'s pumps see EOF, the
  /// session is removed from the Activity window and the exit is logged by the
  /// same path as any other. The MCP host sees its server exit and reports a
  /// dropped connection; reconnecting lands on the refusal above, which is the
  /// sentence that explains why.
  func endTrialSessions() {
    let pids = trialPIDs.withLock { live -> Set<Int32> in
      let taken = live
      live.removeAll()
      return taken
    }
    // A key entered during the window keeps everything running. The half hour
    // bought the answer it was for; taking the servers away from somebody who
    // has just paid because a timer they have already satisfied went off would
    // be indefensible.
    guard !LicenseStore.isLicensed else { return }
    for pid in pids {
      hostLog("host", .info, "trial ended — stopping server (pid \(pid))")
      kill(pid, SIGTERM)
    }
  }

  private func run(surface: Surface, binaries: ServerBinaries, client: Int32, onTrial: Bool) {
    let process = Process()
    process.executableURL = binaries.node
    process.arguments = [binaries.script.path]
    process.environment = ServerLocator.environment(
      for: surface, allowWrites: SurfaceSettings.allowWrites(surface))

    let writes = SurfaceSettings.allowWrites(surface)
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
    if onTrial { trialPIDs.withLock { $0.insert(pid) } }
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
    //
    // Deliberately NOT a member of `group`. Logging is not plumbing, and a
    // group member that only ends when the child exits makes every teardown
    // hostage to the child agreeing to go — the group is the two pumps, which
    // is exactly the set of things that must finish before the socket can be
    // closed. `process.waitUntilExit()` below still reaps the child, so the
    // exit status is still reported; the only thing given up is the guarantee
    // that a final stderr line is logged before the "server exited" line.
    onDedicatedThread("cupertino.stderr") {
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
    // Whether it was reaped or the client simply went away: a pid is reused by
    // the kernel eventually, and a stale one left here is a signal sent to
    // whatever inherits the number.
    if onTrial { trialPIDs.withLock { $0.remove(pid) } }
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
    group.enter()
    onDedicatedThread("cupertino.pump") {
      defer { group.leave() }
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

/// Run `body` on a thread of its own, off libdispatch's global pools.
///
/// Everything this host does per session blocks: two pumps sit in `read(2)` for
/// the life of a connection, the stderr drain sits in `availableData`, and `run`
/// sits in `group.wait()` until the pumps finish. libdispatch's global queues
/// are a BOUNDED pool — roughly 64 threads per QoS — and a blocked thread is not
/// a free one, so sessions consumed that pool instead of sharing it.
///
/// Past the limit the failure was not slowness, it was silence. Blocks already
/// submitted stayed queued indefinitely, and the block that never ran was
/// `serve(client)` in `acceptLoop`. So `accept` kept succeeding, every new
/// bridge completed its `connect`, wrote its handshake, and then waited on a
/// reply from a function that was never scheduled. Nothing logged an error,
/// because from the host's point of view nothing had failed.
///
/// MEASURED, on a host that had been up three days: 68 threads on
/// com.apple.root.user-initiated-qos, every one of them parked in
/// `_dispatch_group_wait_slow`; `acceptLoop` healthy and blocked in `accept`;
/// 68 server processes still alive because their pumps had never run to hand
/// them the EOF that tells them to quit; and a hand-written probe getting zero
/// bytes back in eight seconds from a socket that had accepted it in two
/// milliseconds.
///
/// A pump is a long-lived blocking task. That is what a thread is for, and
/// precisely what a bounded work queue is not.
func onDedicatedThread(_ name: String, _ body: @escaping () -> Void) {
  let thread = Thread(block: body)
  thread.name = name
  // The default is 512 KB and these frames are shallow — a 64 KB read buffer
  // and nothing recursive — but it is set explicitly because the whole point of
  // this function is that there may be a great many of these at once.
  thread.stackSize = 512 * 1024
  thread.start()
}

/// Mark `fd` FD_CLOEXEC, so spawned servers do not inherit it.
func closeOnExec(_ fd: Int32) {
  let flags = fcntl(fd, F_GETFD)
  if flags >= 0 { _ = fcntl(fd, F_SETFD, flags | FD_CLOEXEC) }
}

/// Per-surface user settings.
///
/// Not `Settings`: that name shadows SwiftUI's `Settings` scene, and the
/// collision is invisible until someone writes one and gets "cannot be
/// constructed because it has no accessible initializers" pointing at the
/// wrong file.
enum SurfaceSettings {
  static func allowWrites(_ surface: Surface) -> Bool {
    UserDefaults.standard.bool(forKey: "allowWrites.\(surface.id)")
  }
}

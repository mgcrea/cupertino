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
  /// Held for the lifetime of the process. `flock` releases on close, and on
  /// death — which is the whole reason it can replace the unlink dance below.
  private var lockFD: Int32 = -1
  /// The socket we actually bound, by inode. Anything else answering on our
  /// path means we were evicted, and `socketWatch` is what notices.
  private var boundIdentity: (dev: dev_t, ino: ino_t)?
  private var socketWatch: DispatchSourceTimer?
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

  /// Every live server, by pid, so `stopSessions(for:)` can find one surface's.
  ///
  /// The second exception to "the host keeps no state", and it exists for the
  /// same reason `trialPIDs` does: a preference changed in the UI has to reach
  /// connections that were admitted before it changed. Deliberately not a reach
  /// into `Sessions` — that type is observation for the Activity window, and the
  /// comment above says why the host must not start reading from it.
  private let serverPIDs = OSAllocatedUnfairLock<[Int32: String]>(initialState: [:])

  /// Why the socket never came up, if it did not. Kept rather than only logged:
  /// a host that failed to listen is the one state where nothing will ever
  /// work, and stderr is invisible to someone who launched the app from Finder.
  private(set) var startupError: String?

  enum HostError: LocalizedError {
    case pathTooLong(String)
    case socketFailed(String)
    case alreadyServing(String)
    /// The lock was taken, and by whom if the holder wrote itself down.
    case lockHeld(by: String?)

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
      case .lockHeld(let holder):
        // Naming the holder is the point. "Another copy is already serving" was
        // true and useless: the two copies share a bundle identifier, so the
        // only way to tell which one answered was to go reading `lsof`. The
        // holder writes its own path into the lock file precisely so this
        // sentence can name it.
        let who = holder.map { "\n\nIt is: \($0)" } ?? ""
        return """
          another copy of Cupertino holds the host lock. Quit it before \
          starting this one — most often it is a development build from a \
          checkout and the copy in /Applications, both launched by bridges \
          from different MCP entries.\(who)
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

  /// Is another host answering on this path right now?
  ///
  /// `connect(2)` is the only honest test: the file outlives the process that
  /// made it, and `stat` cannot tell a live socket from wreckage.
  ///
  /// Kept ONLY as the courtesy check in `openSocket`, never again as the way
  /// two hosts exclude each other — that is the lock's job. The distinction is
  /// the whole lesson: this answers "is anyone there *right now*", which stops
  /// being true the instant it returns.
  ///
  /// Closed immediately: a probe, not a session. The far end sees a connection
  /// that hangs up before the handshake, which `serve` already tolerates.
  private func socketIsLive(_ address: sockaddr_un) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    return address.withSockaddr { connect(fd, $0, $1) } == 0
  }

  /// Where the single-instance lock lives. A sibling of the socket, so the two
  /// cannot end up in different directories.
  private static var lockPath: String {
    (BridgeProtocol.socketDirectory as NSString).appendingPathComponent("cupertino.lock")
  }

  /// Take the host lock, or fail saying who has it.
  ///
  /// This replaces a `connect`-probe followed by `unlink`, and the reason is
  /// that check-then-act is not an exclusion mechanism. The probe asked "is
  /// anyone answering?" and the answer was only true at the instant it was
  /// asked: an incumbent that was restarting, paused under a debugger, or busy
  /// enough to not accept in time read as absent — and the loser then UNLINKED
  /// a live socket and bound its own over the top.
  ///
  /// MEASURED, in the wild: two hosts, both holding
  /// `…/io.mgcrea.cupertino/cupertino.sock` in `lsof`, one with 62 live
  /// sessions and one with 36. The evicted host kept accepting on an inode no
  /// path pointed at any more, so every NEW bridge reached the other copy — a
  /// development build with no Full Disk Access — and every mail tool reported
  /// the grant as missing while System Settings showed it granted.
  ///
  /// `flock` cannot be raced: the kernel owns it, `LOCK_NB` fails instead of
  /// waiting, and it is released on close AND on death. That last part is what
  /// the unlink was really for — clearing the wreckage of a crash — and the
  /// kernel does it correctly, which a heuristic cannot.
  ///
  /// `closeOnExec` matters as much as the lock. Without it every spawned server
  /// inherits this descriptor, and a wedged server would go on holding the lock
  /// after Cupertino quit — locking out the next launch with no process anyone
  /// could see. Same argument as the listening socket below.
  private func claimHostLock() throws {
    let path = Self.lockPath
    let fd = open(path, O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else {
      throw HostError.socketFailed("could not open \(path): \(errnoText())")
    }
    closeOnExec(fd)

    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      // Read before closing: the holder's note is readable by anyone, the lock
      // only stops a second *writer* of the socket.
      let holder = Self.lockHolder()
      close(fd)
      throw HostError.lockHeld(by: holder)
    }

    // Write down who we are, so the next loser gets a sentence naming a path
    // instead of "another copy". Truncate first: a longer previous line would
    // otherwise leave a tail behind this one.
    ftruncate(fd, 0)
    lseek(fd, 0, SEEK_SET)
    let identity = "\(getpid())\t\(Bundle.main.bundlePath)\n"
    _ = writeAll(fd, Data(identity.utf8))

    lockFD = fd
  }

  /// The path the current lock holder wrote down, if it wrote one.
  ///
  /// Best effort by construction — a holder that died mid-write, or an older
  /// build that never wrote anything, both yield nil and the caller says less
  /// rather than saying something wrong.
  private static func lockHolder() -> String? {
    guard let data = FileManager.default.contents(atPath: lockPath),
      let line = String(data: data, encoding: .utf8)?
        .split(separator: "\n").first
    else { return nil }
    let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { return nil }
    return "\(parts[1]) (pid \(parts[0]))"
  }

  private func openSocket() throws {
    let path = BridgeProtocol.socketPath
    guard let address = unixAddress(path) else { throw HostError.pathTooLong(path) }

    try FileManager.default.createDirectory(
      atPath: BridgeProtocol.socketDirectory, withIntermediateDirectories: true)

    // Exclusion first, and everything below is safe because of it.
    try claimHostLock()

    // Belt and braces, for one specific case: a copy that predates the lock.
    //
    // An older build never opens the lock file, so ours is uncontended and we
    // would sail past it and unlink a socket that a running host is still
    // serving — reintroducing the exact eviction this change exists to stop,
    // for as long as both versions are installed. That window is not
    // hypothetical: the `-dev` entries and the installed copy are routinely
    // different builds.
    //
    // So ask the socket too. This is NOT the exclusion mechanism — the lock is,
    // and a probe on its own is the check-then-act that failed. It is a
    // one-way courtesy to a version that cannot answer for itself: if somebody
    // is serving, stand down and say so.
    if socketIsLive(address) {
      close(lockFD)
      lockFD = -1
      throw HostError.alreadyServing(path)
    }

    // NOW the unlink is unconditional and correct. A socket file is a
    // filesystem entry that outlives the process that made it, so a stale one
    // would fail `bind` with EADDRINUSE forever — but holding the lock is proof
    // that whatever left this entry behind is gone, so there is nothing live to
    // destroy.
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

    // Remember which inode we bound, so `socketWatch` can tell our socket from
    // somebody else's file at the same path.
    var bound = stat()
    if stat(path, &bound) == 0 { boundIdentity = (bound.st_dev, bound.st_ino) }

    listenFD = fd
    hostLog("cupertino", .info, "listening at \(path)")
    queue.async { [weak self] in self?.acceptLoop(fd) }
    startSocketWatch()
  }

  func stop() {
    socketWatch?.cancel()
    socketWatch = nil
    if listenFD >= 0 { close(listenFD); listenFD = -1 }
    unlink(BridgeProtocol.socketPath)
    // Closing releases the flock. The file itself stays: unlinking a lock file
    // is how two processes end up locking two different inodes and both winning.
    if lockFD >= 0 { close(lockFD); lockFD = -1 }
  }

  // MARK: - Noticing eviction

  /// Watch for our socket being replaced underneath us.
  ///
  /// The lock makes this nearly impossible between two builds that both have
  /// it — but "nearly" is doing real work: an older build predating the lock,
  /// or a stray `rm` of the socket, can still leave this host accepting on an
  /// inode that no path points at. That state is invisible from the inside,
  /// which is exactly what made it cost 3½ hours of a working day: the host
  /// looked healthy, kept its existing sessions, and quietly took no new ones.
  ///
  /// Five seconds because the cost is one `stat` and the thing being caught is
  /// measured in hours.
  private func startSocketWatch() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 5, repeating: 5)
    timer.setEventHandler { [weak self] in self?.checkStillBound() }
    timer.resume()
    socketWatch = timer
  }

  private func checkStillBound() {
    guard listenFD >= 0, let want = boundIdentity else { return }

    var now = stat()
    let lost: String?
    if stat(BridgeProtocol.socketPath, &now) != 0 {
      lost = "the socket file was removed"
    } else if now.st_dev != want.dev || now.st_ino != want.ino {
      lost = "another process replaced the socket file"
    } else {
      lost = nil
    }
    guard let reason = lost else { return }

    // Stop rather than re-bind. Re-binding is how two hosts take turns evicting
    // each other forever, and the honest state to be in is "not serving, and
    // saying so" — `startupError` is what the Settings window reads.
    let detail =
      "\(reason) — this copy is no longer reachable and has stopped serving. "
      + "Quit any other copy of Cupertino, then reopen this one."
    hostLog("cupertino", .error, detail)
    startupError = detail

    socketWatch?.cancel()
    socketWatch = nil
    let fd = listenFD
    listenFD = -1  // read by acceptLoop to tell a deliberate stop from a failure
    if fd >= 0 { close(fd) }
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

    // The backstop for a config entry we could not remove. Command clients keep
    // their config in files this app refuses to write — see `ClientWiring.Wiring`
    // — so a surface switched off in the app can still be spawned by Claude
    // Code, VS Code or Codex until the user runs the removal line. This is where
    // that ends.
    //
    // Before the licence gate, and deliberately. Enablement is a fact about the
    // user's own configuration rather than about payment, and offering to sell a
    // licence for a surface somebody has just switched off sends them to the
    // wrong screen. It also keeps the trial out of it: the path below logs the
    // remaining window and `run` files the pid into `trialPIDs`, and burning
    // either on a connection that is about to be refused would be wrong.
    //
    // `Surface.named` above is deliberately NOT filtered to the enabled set.
    // Narrowing it would collapse "switched off" into "unknown server", which is
    // a different sentence, logged against a different surface id — namely none.
    guard SurfaceSettings.isEnabled(surface) else {
      hostLog(surface.id, .error, "refused: \(surface.id) is off")
      reply(
        client,
        "err \(surface.displayName) is switched off in Cupertino — turn it back on "
          + "in the app, or remove this server from your client's configuration")
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

    // A swift-hosted surface is served here rather than spawned. There is no
    // node package to locate, and there could not be: ScreenCaptureKit is
    // unreachable from node and a server's PATH holds no `screencapture`. The
    // bridge cannot tell — it never parses JSON-RPC — so `--server=screen`
    // arrives by exactly the path `--server=mail` does.
    if surface.runtime == .swift {
      reply(client, BridgeProtocol.ok)
      serveInProcess(surface: surface, client: client)
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

  /// Stop every server running for one surface, when it is switched off.
  ///
  /// Without this, "off" is not off until every editor is restarted: an MCP host
  /// opens one stdio connection when it launches and keeps it for the life of
  /// that editor, so refusing new connections alone would leave the tools the
  /// user has just switched off sitting in a session that outlives the decision.
  ///
  /// SIGTERM, and by exactly the reasoning `endTrialSessions` gives: the child
  /// exits on its own, `run`'s pumps see EOF, the session leaves the Activity
  /// window and the exit is logged by the same path as any other.
  func stopSessions(for surface: Surface) {
    let pids = serverPIDs.withLock { live in
      live.filter { $0.value == surface.id }.map(\.key)
    }
    for pid in pids {
      hostLog(surface.id, .info, "switched off — stopping server (pid \(pid))")
      kill(pid, SIGTERM)
    }
  }

  private func serveInProcess(surface: Surface, client: Int32) {
    let session = UUID()
    let pid = ProcessInfo.processInfo.processIdentifier
    Task(priority: Sessions.priority) { @MainActor in
      Sessions.shared.opened(id: session, surface: surface.id, pid: pid)
    }
    defer {
      Task(priority: Sessions.priority) { @MainActor in Sessions.shared.closed(id: session) }
      hostLog(surface.id, .info, "server stopped")
    }

    let gateOn = surface.gates.first.map { SurfaceSettings.isGateOn(surface, $0) } ?? false
    hostLog(surface.id, .info, "server started (in-process) allowCapture=\(gateOn)")

    while let line = ScreenServer.nextLine(client) {
      if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }

      // Switching a surface off has to take effect without restarting every
      // editor. A node server is stopped with SIGTERM by `stopSessions`; this
      // one has no pid of its own to signal — the app's own pid is in that map
      // for display only, and signalling it would kill Cupertino — so the check
      // lives here, on the request, which is the same guarantee by a different
      // route.
      guard SurfaceSettings.isEnabled(surface) else {
        hostLog(surface.id, .info, "switched off — closing session")
        return
      }

      // Read per request, so flipping the toggle takes effect without
      // restarting the editor — the same guarantee `stopSessions` gives a node
      // server by signalling it.
      let captureAllowed = surface.gates.first.map { SurfaceSettings.isGateOn(surface, $0) } ?? false
      guard
        let response = ScreenServer.handle(line, surface: surface, captureAllowed: captureAllowed)
      else { continue }
      _ = writeAll(client, Data("\(response)\n".utf8))
    }
  }


  private func run(surface: Surface, binaries: ServerBinaries, client: Int32, onTrial: Bool) {
    let process = Process()
    process.executableURL = binaries.node
    process.arguments = [binaries.script.path]
    let gates = SurfaceSettings.enabledGates(surface)
    process.environment = ServerLocator.environment(
      for: surface, allowWrites: SurfaceSettings.allowWrites(surface), gates: gates)

    let writes = SurfaceSettings.allowWrites(surface)
    hostLog(surface.id, .info, "allowWrites=\(writes)")
    if !surface.gates.isEmpty {
      hostLog(surface.id, .info, "gates=[\(gates.joined(separator: ","))]")
    }

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
    serverPIDs.withLock { $0[pid] = surface.id }
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
    //
    // Observed too now, for a surface that records results. `observe` was
    // already an optional parameter and simply unused on this call; what is new
    // is that two threads now feed one observer, which is what the lock inside
    // it is for.
    pump(
      from: fromChild.fileHandleForReading.fileDescriptor, to: client, group: group,
      observe: { observer.answered($0) },
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
    serverPIDs.withLock { $0[pid] = nil }
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

  static func captureKey(_ surface: Surface) -> String { "captureMode.\(surface.id)" }
  static func contentKey(_ surface: Surface) -> String { "captureContent.\(surface.id)" }

  /// How much of a call this surface records.
  ///
  /// Absence means "follow the app-wide default", which is itself absent-means
  /// `CallCapture.defaultMode`. Read as a STRING rather than through a coercion
  /// — see the note on `isEnabled` below: `NSArgumentDomain` stores launch
  /// arguments as strings, so a mode pinned by the screenshot pipeline with
  /// `-captureMode.mail off` reads back correctly here and would not through
  /// `object(forKey:) as? SomeEnum`.
  static func captureMode(_ surface: Surface) -> CallCapture.Mode {
    if let raw = UserDefaults.standard.string(forKey: captureKey(surface)),
      let mode = CallCapture.Mode(rawValue: raw)
    {
      return mode
    }
    return appCaptureMode
  }

  /// The app-wide default, for every surface that has not been told otherwise.
  static var appCaptureMode: CallCapture.Mode {
    guard let raw = UserDefaults.standard.string(forKey: appCaptureKey),
      let mode = CallCapture.Mode(rawValue: raw)
    else { return CallCapture.defaultMode }
    return mode
  }

  static let appCaptureKey = "captureMode"
  static let appContentKey = "captureContent"

  /// Whether this surface records prose as well as structure.
  ///
  /// Written the way `allowWrites` is and NOT the way `isEnabled` is: absence
  /// means OFF. The body of a mail, the text of a message and the content of a
  /// note all arrive as arguments here, so a surface that gains content
  /// recording must gain it because somebody asked, never because a key was
  /// missing.
  static func capturesContent(_ surface: Surface) -> Bool {
    if UserDefaults.standard.object(forKey: contentKey(surface)) != nil {
      return UserDefaults.standard.bool(forKey: contentKey(surface))
    }
    return UserDefaults.standard.bool(forKey: appContentKey)
  }

  static func gateKey(_ surface: Surface, _ gate: Surface.Gate) -> String {
    "gate.\(surface.id).\(gate.id)"
  }

  /// Whether one extra gate is on.
  ///
  /// Written the way `allowWrites` is and NOT the way `isEnabled` is: absence
  /// means OFF. That is the safe default here and the opposite of the surface
  /// toggle, where absence has to mean enabled so a newly shipped surface turns
  /// itself on. A gate exists precisely because the thing behind it should not
  /// arrive switched on, so a surface that gains one in a later version must
  /// read it as off on every existing Mac.
  static func isGateOn(_ surface: Surface, _ gate: Surface.Gate) -> Bool {
    UserDefaults.standard.bool(forKey: gateKey(surface, gate))
  }

  /// The env suffixes of every gate currently on, for `ServerLocator`.
  static func enabledGates(_ surface: Surface) -> [String] {
    surface.gates.filter { isGateOn(surface, $0) }.map(\.envSuffix)
  }

  static func enabledKey(_ surface: Surface) -> String { "surfaceEnabled.\(surface.id)" }

  /// Whether this surface is served at all.
  ///
  /// **Absence means enabled**, which is the whole reason this is not written
  /// the way `allowWrites` above is. `bool(forKey:)` alone returns false for a
  /// missing key, so copying that one line would ship every surface off for
  /// every existing install, and the first Update click would then strip all
  /// eight keys out of somebody's `claude_desktop_config.json`. It is also what
  /// keeps the NEXT surface on: a surface that ships in a later version has no
  /// key on an existing Mac, reads enabled, and lands in `entries` and
  /// `expected` exactly as adding a surface does today.
  ///
  /// The two-step is not redundant either, and `as? Bool` is the trap.
  /// MEASURED, with `-surfaceEnabled.safari NO` on the command line:
  ///
  ///     object=Optional(NO)  type=NSTaggedPointerString  as? Bool=nil  bool(forKey:)=false
  ///
  /// `NSArgumentDomain` stores launch arguments as STRINGS, so
  /// `object(forKey:) as? Bool ?? true` reads a surface pinned off by the
  /// screenshot pipeline as *enabled* — and the golden would silently
  /// photograph the wrong thing. `object(forKey:)` answers only "is this set
  /// anywhere in the search list", and `bool(forKey:)` does the coercion.
  ///
  /// `UserDefaults.register(defaults:)` was the other candidate and is worse:
  /// it has to run before any read, and this is read from `serve`, which can
  /// answer a handshake very early in launch.
  static func isEnabled(_ surface: Surface) -> Bool {
    let key = enabledKey(surface)
    guard UserDefaults.standard.object(forKey: key) != nil else { return true }
    return UserDefaults.standard.bool(forKey: key)
  }

  /// The surfaces this Mac actually serves.
  ///
  /// Deliberately here rather than as `Surface.enabled`. `Surface.all` is a
  /// closed compile-time table and this is one user's preference; the two
  /// sitting side by side in one type is an autocomplete trap in exactly the
  /// file — `ServerHost.serve` — where picking the wrong one turns a refusal
  /// into a hole. Making every call site type `SurfaceSettings` is the
  /// distinction.
  static var enabledSurfaces: [Surface] { Surface.all.filter(isEnabled) }
}

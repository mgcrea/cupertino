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
/// it for up to three seconds. The connection it registers under comes from
/// the thread that handles the call, which is also what `test/where` reports:
/// `DrivingSession` finds its connection the same way.
enum ScreenServer {
  /// Signalled once `test/slow` has registered its canceller.
  nonisolated(unsafe) static var registered = DispatchSemaphore(value: 0)
  /// Signalled by the canceller.
  nonisolated(unsafe) static var cancelled = DispatchSemaphore(value: 0)

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
    switch method {
    case "ping":
      return InProcessRPC.result(id, [String: Any]())
    case "test/where":
      return InProcessRPC.result(id, ["connectionKey": connection != nil])
    case "test/slow":
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

  init?(server: String) {
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0, let address = unixAddress(BridgeProtocol.socketPath) else { return nil }
    guard address.withSockaddr({ connect(fd, $0, $1) }) == 0 else {
      close(fd)
      return nil
    }
    send(BridgeProtocol.selfHandshake(server: server), newline: false)
    guard next(within: 2) == .line(BridgeProtocol.ok) else {
      close(fd)
      return nil
    }
  }

  deinit { hangUp() }

  func send(_ text: String, newline: Bool = true) {
    let bytes = Array((newline ? text + "\n" : text).utf8)
    _ = bytes.withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
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

/// A request line.
func request(_ id: Int, _ method: String) -> String {
  #"{"jsonrpc":"2.0","id":\#(id),"method":"\#(method)"}"#
}

/// What Claude Code sends when somebody presses Esc.
func cancelled(_ id: Int) -> String {
  #"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":\#(id),"reason":"Esc"}}"#
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

    // ─── the eviction watchdog ──────────────────────────────────────────────
    //
    // The regression test. Remove the socket underneath the host: it must
    // notice within a couple of ticks and say so, rather than going on
    // accepting on an inode no path points at.

    unlink(BridgeProtocol.socketPath)
    var noticed = false
    let deadline = Date().addingTimeInterval(12)
    while Date() < deadline {
      if ServerHost.shared.startupError != nil {
        noticed = true
        break
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    check("the watchdog notices the socket was removed", noticed)
    check(
      "and says the copy is no longer reachable",
      ServerHost.shared.startupError?.contains("no longer reachable") == true)

    // ─── stopping ───────────────────────────────────────────────────────────

    // Stopping the reaped host must not signal this process. `serverPIDs` holds
    // node servers only — the app's own pid is in `Sessions` for display, and
    // the updater used to walk THAT — so the assertion is simply that we are
    // still here afterwards.
    ServerHost.shared.terminateChildren()
    check("terminating every child does not signal this process", true)

    let started = Date()
    ServerHost.shared.stop()
    let elapsed = Date().timeIntervalSince(started)
    check("stop() returns rather than deadlocking (\(Int(elapsed * 1000))ms)", elapsed < 2)
    check(
      "the socket is gone afterwards",
      !FileManager.default.fileExists(atPath: BridgeProtocol.socketPath))

    print("\n\(checks - failures)/\(checks) passed\n")
    if failures > 0 { exit(1) }
  }
}

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

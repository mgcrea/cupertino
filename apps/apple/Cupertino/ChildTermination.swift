import Foundation

/// Stopping every server process this app spawned, and making sure they stopped.
///
/// SIGTERM first, always: a server may have a write to finish or a rollback to
/// do, and an MCP host sees an ordinary shutdown. But SIGTERM used to be the
/// whole of it, at quit and at an update relaunch, and a server that ignores it
/// or is wedged went on running: after a quit, holding the permissions it was
/// spawned under with nothing supervising it; after an update, serving the
/// outgoing bundle's code from an inode Sparkle had already replaced. So SIGKILL
/// follows for whatever is still there after the grace.
///
/// Synchronous, for the two callers that have no later: the app quitting and
/// the app relaunching. A SIGKILL scheduled for after the grace would never
/// fire. The per-session deadline in `ServerHost.endAfterGrace` is the
/// asynchronous version, for a process that is not about to exit.
///
/// Liveness is asked of the `Process`, never of a bare pid, for the reason
/// `endAfterGrace` gives: a reaped child's number is the next process's.
///
/// Its own file, Foundation only, so `scripts/unit-check.swift` compiles it.
nonisolated enum ChildTermination {
  /// SIGTERM to all of them, wait up to `grace` for them to go, SIGKILL the
  /// rest, and wait briefly for those too. Children that exit on SIGTERM cost
  /// only as long as they take.
  static func terminateAll(_ processes: [Process], grace: TimeInterval) {
    let running = processes.filter(\.isRunning)
    guard !running.isEmpty else { return }
    for process in running { process.terminate() }
    waitUntilGone(running, deadline: Date().addingTimeInterval(grace))
    let stubborn = running.filter(\.isRunning)
    for process in stubborn { kill(process.processIdentifier, SIGKILL) }
    waitUntilGone(stubborn, deadline: Date().addingTimeInterval(1))
  }

  private static func waitUntilGone(_ processes: [Process], deadline: Date) {
    while processes.contains(where: \.isRunning), Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
  }
}

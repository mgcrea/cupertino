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
/// Shell's runs are the exception, and have `terminateGroups`. Each is a process
/// group (`ShellRunner`), so `terminateAll`, which signals one pid per
/// `Process`, would stop the leader and leave whatever it backgrounded running
/// with every grant this app holds. A group is asked by its id: the id cannot be
/// handed to another process while the group has a member, and `ShellRunner`
/// reaps its leader only after it has SIGKILLed the group.
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

  /// `terminateAll` for process groups: SIGTERM to each group, wait up to
  /// `grace` while any member is left, SIGKILL the groups that still have one,
  /// and wait briefly for those too.
  static func terminateGroups(_ pgids: [pid_t], grace: TimeInterval) {
    // Never 0 or 1: `kill(0, _)` is this app's own group and `kill(-1, _)` is
    // every process the user owns.
    let groups = pgids.filter { $0 > 1 }
    let running = groups.filter(groupExists)
    guard !running.isEmpty else { return }
    for pgid in running { kill(-pgid, SIGTERM) }
    waitUntilGroupsGone(running, deadline: Date().addingTimeInterval(grace))
    let stubborn = running.filter(groupExists)
    for pgid in stubborn { kill(-pgid, SIGKILL) }
    waitUntilGroupsGone(stubborn, deadline: Date().addingTimeInterval(1))
  }

  private static func groupExists(_ pgid: pid_t) -> Bool { kill(-pgid, 0) == 0 }

  private static func waitUntilGroupsGone(_ pgids: [pid_t], deadline: Date) {
    while pgids.contains(where: groupExists), Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
  }

  private static func waitUntilGone(_ processes: [Process], deadline: Date) {
    while processes.contains(where: \.isRunning), Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
  }
}

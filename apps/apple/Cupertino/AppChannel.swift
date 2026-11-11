import AppKit

/// Cupertino's half of swift-support-kit's `SupportKitDriving`: a Debug build of
/// one of our own apps, launched with `-DrivingChannel YES`, reads commands from
/// a file and delivers them to its own windows as `NSEvent`s. A click, a drag, a
/// hover, a shortcut or a keystroke sent this way never reaches the session the
/// person is typing in, and the app never comes forward.
///
/// The channel is `<the app's temporary directory>/SupportKitDriving/<pid>/`:
/// inside its container when it is sandboxed, else the same per-user directory
/// this process has. `commands.jsonl` is ours to append to; `events.jsonl` holds
/// the app's `ready`, then an `ack` or an `error` for each command's `seq`.
///
/// Cupertino never links `SupportKitDriving` itself, and must not: it is an
/// input channel that bypasses the Accessibility permission, and Cupertino's
/// Shell window takes only a hardware click.
nonisolated struct AppChannel {
  let directory: URL

  /// The ack window. Long enough for a SwiftUI update, short enough that an app
  /// stuck on its main thread is reported rather than waited on.
  static let ackTimeout: TimeInterval = 2

  /// The channel the process `pid` opened, or nil. A directory is believed only
  /// when its `ready` names `pid` and `pid` is alive: a crashed app leaves its
  /// directory behind, and pids are reused.
  static func find(pid: pid_t, bundleId: String) -> AppChannel? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let candidates = [
      home.appendingPathComponent("Library/Containers/\(bundleId)/Data/tmp"),
      URL(fileURLWithPath: NSTemporaryDirectory()),
    ]
    return find(pid: pid, in: candidates.map { $0.appendingPathComponent("SupportKitDriving/\(pid)") })
  }

  /// The channel of the running application `bundleId`, if THIS Cupertino
  /// launched it with one.
  ///
  /// Only a launch is trusted. A channel is a directory any process of this
  /// user can write: the per-user temporary directory is shared by every
  /// unsandboxed process. Believing whatever is there would let a process with
  /// no grant at all plant one for Safari and read the agent's keystrokes off
  /// it, a password included, since a secure field is exactly what the
  /// background lane hands on. So `register` records the process
  /// `apple_desktop_launch` started, with its launch date, and only that
  /// process, still alive and never replaced by a reused pid, has a channel.
  static func find(bundleId: String) -> AppChannel? {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
    else { return nil }
    lock.lock()
    let launched = registry[app.processIdentifier]
    lock.unlock()
    guard let launched, launched.bundleId == bundleId, launched.launchDate == app.launchDate
    else { return nil }
    return find(pid: app.processIdentifier, bundleId: bundleId)
  }

  /// Record the process `apple_desktop_launch` just started with
  /// `-DrivingChannel YES`, so its channel is believed.
  static func register(pid: pid_t, bundleId: String) {
    guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundleId
    else { return }
    lock.lock()
    registry = registry.filter { pid, _ in kill(pid, 0) == 0 || errno == EPERM }
    registry[app.processIdentifier] = Launched(bundleId: bundleId, launchDate: app.launchDate)
    lock.unlock()
  }

  private struct Launched {
    let bundleId: String
    let launchDate: Date?
  }
  private nonisolated(unsafe) static var registry: [pid_t: Launched] = [:]

  /// `directories` are channel directories themselves, for `channel-check`.
  static func find(pid: pid_t, in directories: [URL]) -> AppChannel? {
    guard kill(pid, 0) == 0 || errno == EPERM else { return nil }
    for directory in directories {
      let events = directory.appendingPathComponent("events.jsonl")
      guard let text = try? String(contentsOf: events, encoding: .utf8),
        let first = text.split(separator: "\n").first,
        let ready = try? JSONSerialization.jsonObject(with: Data(first.utf8)) as? [String: Any],
        ready["kind"] as? String == "ready",
        (ready["pid"] as? NSNumber)?.int32Value == pid
      else { continue }
      return AppChannel(directory: directory)
    }
    return nil
  }

  private static let lock = NSLock()
  private nonisolated(unsafe) static var lastSeq = Int(Date().timeIntervalSince1970 * 1000) % 1_000_000_000

  /// Send one command and wait for its answer. An `error` from the app is a
  /// refusal carrying its message; no answer within `timeout` is a refusal too,
  /// never a hang.
  func send(_ command: [String: Any], timeout: TimeInterval = ackTimeout) throws -> [String: Any] {
    Self.lock.lock()
    Self.lastSeq += 1
    let seq = Self.lastSeq
    Self.lock.unlock()

    var line = command
    line["seq"] = seq
    var data = try JSONSerialization.data(withJSONObject: line)
    data.append(0x0A)
    let commands = directory.appendingPathComponent("commands.jsonl")
    guard let handle = try? FileHandle(forWritingTo: commands) else {
      throw AccessibilityDriver.Failure.refused(
        "The application's driving channel is gone, so nothing was sent.")
    }
    _ = try? handle.seekToEnd()
    try handle.write(contentsOf: data)
    try? handle.close()

    let verb = command["verb"] as? String ?? "command"
    let events = directory.appendingPathComponent("events.jsonl")
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      usleep(10_000)
      guard let text = try? String(contentsOf: events, encoding: .utf8) else { continue }
      for raw in text.split(separator: "\n").reversed() {
        guard let event = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
          (event["seq"] as? NSNumber)?.intValue == seq
        else { continue }
        if event["kind"] as? String == "error" {
          throw AccessibilityDriver.Failure.refused(
            "The application refused the \(verb): \(event["message"] as? String ?? "no reason").")
        }
        return event
      }
    }
    throw AccessibilityDriver.Failure.refused(
      "The application did not answer the \(verb) within \(Int(timeout)) s. It may be busy on its "
        + "main thread; read the screen before sending more.")
  }
}

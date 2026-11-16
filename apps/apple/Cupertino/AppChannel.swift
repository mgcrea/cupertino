import AppKit

/// Cupertino's half of swift-support-kit's `SupportKitDriving`: a Debug build of
/// one of our own apps, launched with `-DrivingChannel YES`, reads commands from
/// a file and delivers them to its own windows as `NSEvent`s. A click, a drag, a
/// hover, a scroll, a shortcut or a keystroke sent this way never reaches the
/// session the person is typing in, and the app never comes forward.
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
  /// The process that opened it.
  let pid: pid_t
  /// What its `ready` says it takes. 1 when it says nothing: swift-support-kit
  /// before 1.25.0 wrote no version.
  let version: Int

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
    return find(
      pid: pid, in: candidates.map { $0.appendingPathComponent("SupportKitDriving/\(pid)") })
  }

  /// The channel of the running copy of `bundleId` that `pid` names, or of its
  /// only copy when `pid` is nil, if THIS Cupertino launched it with one.
  ///
  /// Only a launch is trusted. A channel is a directory any process of this
  /// user can write: the per-user temporary directory is shared by every
  /// unsandboxed process. Believing whatever is there would let a process with
  /// no grant at all plant one for Safari and read the agent's keystrokes off
  /// it, a password included, since a secure field is exactly what the
  /// background lane hands on. So `register` records the process
  /// `apple_desktop_launch` started, with its launch date, and only that
  /// process, still alive and never replaced by a reused pid, has a channel.
  ///
  /// Several copies and no `pid` is a refusal, the one every verb named by a
  /// bundle id alone gets (`AccessibilityDriver.app(forBundleId:pid:)`), never
  /// a guess. None running is nil: the verb's own lookup says it is not.
  static func find(bundleId: String, pid: pid_t? = nil) throws -> AppChannel? {
    let app: NSRunningApplication
    if let pid {
      guard let running = NSRunningApplication(processIdentifier: pid),
        running.bundleIdentifier == bundleId
      else { return nil }
      app = running
    } else {
      let copies = AccessibilityDriver.copies(of: bundleId)
      guard let only = copies.first else { return nil }
      guard copies.count == 1 else { throw AccessibilityDriver.severalCopies(bundleId, copies) }
      app = only
    }
    guard launchedWithChannel(app) else { return nil }
    return find(pid: app.processIdentifier, bundleId: bundleId)
  }

  /// Whether `app` is the very process this Cupertino launched with a channel.
  static func launchedWithChannel(_ app: NSRunningApplication) -> Bool {
    lock.lock()
    let launched = registry[app.processIdentifier]
    lock.unlock()
    guard let launched else { return false }
    return launched.bundleId == app.bundleIdentifier && launched.launchDate == app.launchDate
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
  ///
  /// Only the first line is read, `ready`: the file grows for the life of the
  /// app, and this runs on every verb that might go through a channel.
  static func find(pid: pid_t, in directories: [URL]) -> AppChannel? {
    guard kill(pid, 0) == 0 || errno == EPERM else { return nil }
    for directory in directories {
      let events = directory.appendingPathComponent("events.jsonl")
      guard let handle = try? FileHandle(forReadingFrom: events) else { continue }
      let head = (try? handle.read(upToCount: 4096)) ?? nil
      try? handle.close()
      guard let head,
        let first = head.split(separator: 0x0A, omittingEmptySubsequences: false).first,
        let ready = try? JSONSerialization.jsonObject(with: Data(first)) as? [String: Any],
        ready["kind"] as? String == "ready",
        (ready["pid"] as? NSNumber)?.int32Value == pid
      else { continue }
      return AppChannel(
        directory: directory, pid: pid, version: (ready["version"] as? NSNumber)?.intValue ?? 1)
    }
    return nil
  }

  // ─── what a version 1 app would do differently ─────────────────────────────

  /// The fields of `command` that only a version 2 channel honours, named for
  /// a refusal. Empty when version 1 would do the same thing.
  ///
  /// A version 1 app ignores a field it does not know and does what it did
  /// before: a middle-button drag arrives as a left drag, a drag holding Option
  /// as a plain one, a paced drag queued at once, a hover with a start as one
  /// that never moves, a pixel scroll as lines. Each is a different edit, made
  /// with nothing to say so, which is why `send` refuses rather than sends.
  static func versionTwoFields(_ command: [String: Any]) -> [String] {
    var fields: [String] = []
    switch command["verb"] as? String {
    case "drag":
      if let button = command["button"] as? String, button != "left" {
        fields.append("a drag's middle button")
      }
      if let modifiers = command["modifiers"] as? [String], !modifiers.isEmpty {
        fields.append("a drag's modifiers")
      }
      if command["paced"] as? Bool == true { fields.append("a paced drag") }
    case "hover":
      if command["from"] != nil { fields.append("a hover's 'from'") }
    case "scroll":
      if let units = command["units"] as? String, units != "line" {
        fields.append("a pixel scroll")
      }
    default:
      break
    }
    return fields
  }

  /// How far from the main display's origin a point may be: swift-support-kit
  /// 1.25.0 refuses past it, and an app built before then could trap where it
  /// makes such a point a whole number, so none is sent to either.
  static let maxCoordinate: Double = 1_000_000

  /// What is wrong with a command's points, or nil.
  static func pointProblem(_ command: [String: Any]) -> String? {
    var points: [(String, Double, Double)] = []
    if let x = (command["x"] as? NSNumber)?.doubleValue,
      let y = (command["y"] as? NSNumber)?.doubleValue
    {
      points.append(("point", x, y))
    }
    for key in ["from", "to"] {
      if let pair = command[key] as? [NSNumber], pair.count == 2 {
        points.append((key, pair[0].doubleValue, pair[1].doubleValue))
      }
    }
    for (name, x, y) in points where !(abs(x) <= maxCoordinate && abs(y) <= maxCoordinate) {
      return
        "The \(name) (\(x), \(y)) is past any display: the driving channel takes points within "
        + "±\(Int(maxCoordinate)), so nothing was sent."
    }
    return nil
  }

  // ─── sending ───────────────────────────────────────────────────────────────

  private static let lock = NSLock()

  /// Where `seq` starts counting. Random over 52 bits, so a Debug Cupertino and
  /// the installed one, both driving one app, do not count from one base and
  /// take each other's acks; and below 2^53, the largest whole number a JSON
  /// reader holds exactly. It was the clock's milliseconds mod 10^9, which two
  /// processes started together shared.
  static func randomSeqBase() -> Int { Int.random(in: 0..<(1 << 52)) }

  private nonisolated(unsafe) static var lastSeq = randomSeqBase()

  /// Reads `events.jsonl` from where the last read ended. Each read returns the
  /// lines completed since, holding back a line the app has not finished
  /// writing. A file that shrank or was replaced, a new process in a reused
  /// directory, is read whole.
  struct EventTail {
    private(set) var offset: UInt64 = 0
    private var file: (device: dev_t, inode: ino_t)?
    private var pending = Data()

    init() {}

    mutating func read(_ url: URL) -> [Data] {
      guard let handle = try? FileHandle(forReadingFrom: url) else { return [] }
      defer { try? handle.close() }
      var info = stat()
      guard fstat(handle.fileDescriptor, &info) == 0 else { return [] }
      if file?.device != info.st_dev || file?.inode != info.st_ino
        || UInt64(info.st_size) < offset
      {
        file = (info.st_dev, info.st_ino)
        offset = 0
        pending = Data()
      }
      guard (try? handle.seek(toOffset: offset)) != nil,
        let chunk = try? handle.readToEnd(), !chunk.isEmpty
      else { return [] }
      offset += UInt64(chunk.count)
      pending.append(chunk)
      var lines: [Data] = []
      while let newline = pending.firstIndex(of: 0x0A) {
        let line = pending[pending.startIndex..<newline]
        if !line.isEmpty { lines.append(Data(line)) }
        pending.removeSubrange(pending.startIndex...newline)
      }
      return lines
    }
  }

  /// One channel's conversation: a command in flight, and where its events
  /// were last read to.
  private final class Line: @unchecked Sendable {
    /// Held from a command's write to its answer.
    let busy = NSLock()
    /// Touched only while `busy` is held.
    var tail = EventTail()
  }
  private nonisolated(unsafe) static var lines: [String: Line] = [:]

  private static func line(for directory: URL) -> Line {
    lock.lock()
    defer { lock.unlock() }
    if let line = lines[directory.path] { return line }
    let line = Line()
    lines[directory.path] = line
    return line
  }

  /// What `send` refuses before it writes anything: a point past any display,
  /// or a version 2 field to a version 1 app. Asked by the desktop server before
  /// it admits a session too, since a refused verb must put nothing on screen;
  /// `send` asks again, so no caller can skip it.
  func check(_ command: [String: Any]) throws {
    if let problem = Self.pointProblem(command) {
      throw AccessibilityDriver.Failure.refused(problem)
    }
    let newer = Self.versionTwoFields(command)
    if version < 2, !newer.isEmpty {
      throw AccessibilityDriver.Failure.refused(
        "The application's driving channel is version \(version), which ignores "
          + "\(newer.joined(separator: " and ")) and would do something else instead, so nothing "
          + "was sent. Rebuild it against swift-support-kit 1.25.0 or later, then launch it again "
          + "with channel: true.")
    }
  }

  /// Send one command and wait for its answer. An `error` from the app is a
  /// refusal carrying its message; no answer within `timeout` is a refusal too,
  /// never a hang.
  ///
  /// **One command in flight per channel.** The app does not wait for one
  /// command to finish before it performs the next, so a click sent while a
  /// paced drag holds the button down would land in the middle of the drag,
  /// and two hovers would sweep at once. A second connection driving the same
  /// app waits here for the first command's answer, or its timeout.
  func send(_ command: [String: Any], timeout: TimeInterval = ackTimeout) throws -> [String: Any] {
    try check(command)

    let line = Self.line(for: directory)
    line.busy.lock()
    defer { line.busy.unlock() }

    Self.lock.lock()
    Self.lastSeq += 1
    let seq = Self.lastSeq
    var entry = command
    entry["seq"] = seq
    // Appended with O_APPEND in one write, under the lock: a seek to the end
    // then a write let two connections interleave a line, which the app read as
    // two broken commands and answered as a timeout.
    let written: Bool = {
      guard var data = try? JSONSerialization.data(withJSONObject: entry) else { return false }
      data.append(0x0A)
      let commands = directory.appendingPathComponent("commands.jsonl")
      let fd = open(commands.path, O_WRONLY | O_APPEND)
      guard fd >= 0 else { return false }
      defer { close(fd) }
      return data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) } == data.count
    }()
    Self.lock.unlock()
    guard written else {
      throw AccessibilityDriver.Failure.refused(
        "The application's driving channel is gone, so nothing was sent.")
    }

    let verb = command["verb"] as? String ?? "command"
    let events = directory.appendingPathComponent("events.jsonl")
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      usleep(10_000)
      for raw in line.tail.read(events) {
        guard let event = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
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

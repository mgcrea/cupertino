import Foundation

/// Running one approved Shell script as a child of this app, in a process group of its own.
///
/// ## Why `posix_spawn` and not `Process`
///
/// A script backgrounds things (`sleep 100 &`, a server it starts, a pipeline's left half), and
/// every one of them holds the grants Cupertino holds, because macOS charges a child's access to
/// the responsible process, which is this app. Stopping only the process we started would leave
/// those running with nothing supervising them. So the script starts as the leader of a new
/// process group (`POSIX_SPAWN_SETPGROUP` with group 0, which `Process` cannot ask for), and
/// every stop is a signal to the whole group: SIGTERM then SIGKILL after `killGrace` at a timeout
/// or a cancel, and SIGKILL to the stragglers when the leader exits on its own.
///
/// ## Why everything starts through `/bin/zsh -l -c`
///
/// So that `PATH` is the one Terminal has. The servers get `PATH=/usr/bin:/bin`, which hides
/// Homebrew's `node` and `python3`. For `zsh` the script is the `-c` argument; for the others it
/// is written to a 0600 file and the login shell `exec`s the interpreter on it, so the leader is
/// the interpreter itself. The environment is `baseEnvironment` and nothing else: no variable of
/// this app's own, and none of the `APPLE_*` server settings, reaches the script.
///
/// ## What the child inherits, and what it must not
///
/// `POSIX_SPAWN_CLOEXEC_DEFAULT`, so the only descriptors it gets are its three pipes; this app
/// holds sockets to every client. Signal dispositions are reset and the mask cleared: the app
/// ignores SIGPIPE (`ServerHost.start`), an ignored signal survives `exec`, and a script that
/// inherited it would print "Broken pipe" where Terminal's would end quietly.
///
/// ## Output
///
/// stdout and stderr are drained on threads of their own, each keeping the first `outputCap`
/// bytes and reading the rest only to discard it, so the child never blocks on a full pipe.
/// They are decoded as UTF-8 with replacement characters. A process that left the group (a
/// `setsid` daemon) can hold a pipe open after the group is gone; the drains wait `killGrace`
/// for end of file after the kill and then stop, so such a process cannot hold a run open.
///
/// Foundation only, so `make shell-check` compiles it.
nonisolated enum ShellRunner {
  enum Interpreter: String, CaseIterable, Sendable {
    case zsh, bash, python3, node, osascript, jxa

    /// What the login shell `exec`s on the script file. Empty for `zsh`, whose script is the
    /// `-c` argument itself.
    var prefix: [String] {
      switch self {
      case .zsh: []
      case .bash: ["bash"]
      case .python3: ["python3"]
      case .node: ["node"]
      case .osascript: ["osascript"]
      case .jxa: ["osascript", "-l", "JavaScript"]
      }
    }

    /// The command `resolve` looks up.
    var command: String { prefix.first ?? rawValue }
  }

  struct Request: Sendable {
    var script: String
    var interpreter: Interpreter
    var cwd: URL
    /// Written to the script's stdin, then closed. Nil means stdin is `/dev/null`, so a script
    /// that reads it sees end of file rather than waiting for input nobody will send.
    var stdin: String?
    var timeout: TimeInterval
  }

  struct Outcome: Sendable, Equatable {
    /// Nil when the leader was ended by a signal.
    var exitCode: Int32?
    /// The signal that ended the leader, as `SIGTERM`, `SIGKILL` and so on.
    var signal: String?
    var timedOut: Bool
    var cancelled: Bool
    var durationMs: Int
    var stdout: String
    var stdoutTruncated: Bool
    var stderr: String
    var stderrTruncated: Bool
  }

  /// The script could not be started. Nothing ran.
  struct StartError: Error, CustomStringConvertible {
    var step: String
    var code: Int32
    var description: String { "\(step): \(String(cString: strerror(code)))" }
  }

  static let outputCap = 256 * 1024
  static let killGrace: TimeInterval = 2

  /// Where scripts for interpreters other than `zsh` are written for the length of their run.
  static var scriptDirectory: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(
      "cupertino-shell", isDirectory: true)
  }

  static func argv(_ request: Request, scriptFile: URL?) -> [String] {
    let login = ["/bin/zsh", "-l", "-c"]
    guard request.interpreter != .zsh else { return login + [request.script] }
    guard let scriptFile else {
      preconditionFailure("\(request.interpreter) runs from a script file")
    }
    return login + ["exec \"$0\" \"$@\""] + request.interpreter.prefix + [scriptFile.path]
  }

  /// The whole environment the login shell starts with. It extends `PATH` itself.
  static func baseEnvironment(home: String, user: String, tmp: String) -> [String: String] {
    [
      "HOME": home,
      "USER": user,
      "LOGNAME": user,
      "SHELL": "/bin/zsh",
      "TMPDIR": tmp,
      "LANG": "en_US.UTF-8",
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    ]
  }

  /// Starts the script and returns at once. The run is in `live` until it has been waited out,
  /// whether or not anybody calls `wait`.
  static func start(_ request: Request) throws -> Running {
    let scriptFile = request.interpreter == .zsh ? nil : try writeScript(request.script)
    do {
      return try spawn(request, scriptFile: scriptFile)
    } catch {
      if let scriptFile { try? FileManager.default.removeItem(at: scriptFile) }
      throw error
    }
  }

  /// The interpreter's path as the login shell finds it, or nil when it is not installed.
  /// Asked once per interpreter; an answer that timed out is not kept.
  static func resolve(_ interpreter: Interpreter) -> String? {
    if let known = resolved.withLock({ $0[interpreter] }) { return known }
    let lookup = try? start(
      Request(
        script: "command -v \(interpreter.command)", interpreter: .zsh,
        cwd: URL(fileURLWithPath: NSHomeDirectory()), stdin: nil, timeout: 10)
    ).wait()
    guard let lookup, !lookup.timedOut else { return nil }
    // The last line, in case a profile prints something of its own first.
    let line = lookup.stdout.split(separator: "\n").last.map(String.init) ?? ""
    let path = lookup.exitCode == 0 && line.hasPrefix("/") ? line : nil
    resolved.withLock { $0[interpreter] = .some(path) }
    return path
  }

  /// Runs started and not yet waited out, for quit and for switching Shell off.
  static var live: [Running] { registry.withLock { $0 } }

  // MARK: - Running

  final class Running: @unchecked Sendable {
    /// Also the process group id: the leader was started as the group's first member.
    let pid: pid_t

    private let state = NSCondition()
    // Guarded by `state`.
    private var leaderExited = false
    private var cancelRequested = false
    private var stopReading = false
    private var openStreams = 2
    private var captured: [Int32: (bytes: [UInt8], truncated: Bool)] = [:]
    private var result: Outcome?

    fileprivate init(pid: pid_t) { self.pid = pid }

    /// SIGTERM to the group, SIGKILL after `killGrace`. Does nothing once the leader has
    /// exited on its own.
    func cancel() {
      state.lock()
      cancelRequested = true
      state.broadcast()
      state.unlock()
    }

    /// Blocks until the run is over, its group killed and its output drained. Any number of
    /// callers, any number of times, get the same outcome.
    func wait() -> Outcome {
      state.lock()
      defer { state.unlock() }
      while result == nil { state.wait() }
      return result!
    }

    fileprivate func begin(
      timeout: TimeInterval, stdout: Int32, stderr: Int32, stdin: (fd: Int32, bytes: [UInt8])?,
      scriptFile: URL?, started: UInt64
    ) {
      thread("leader") { $0.watchLeader() }
      thread("stdout") { $0.drain(stdout, as: 1) }
      thread("stderr") { $0.drain(stderr, as: 2) }
      if let stdin { thread("stdin") { $0.feed(stdin.fd, stdin.bytes) } }
      thread("supervisor") {
        $0.supervise(timeout: timeout, scriptFile: scriptFile, started: started)
      }
    }

    private func thread(_ role: String, _ body: @escaping @Sendable (Running) -> Void) {
      let worker = Thread { [self] in body(self) }
      worker.name = "shell \(pid) \(role)"
      worker.start()
    }

    /// Notices the leader's exit without reaping it, so the group id cannot be handed to
    /// another process while the stragglers are still being signalled.
    private func watchLeader() {
      var info = siginfo_t()
      while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) != 0, errno == EINTR {}
      state.lock()
      leaderExited = true
      state.broadcast()
      state.unlock()
    }

    private var stopping: Bool {
      state.lock()
      defer { state.unlock() }
      return stopReading
    }

    private func drain(_ fd: Int32, as stream: Int32) {
      var kept: [UInt8] = []
      var truncated = false
      var buffer = [UInt8](repeating: 0, count: 64 * 1024)
      while !stopping {
        var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let polled = poll(&ready, 1, 100)
        if polled < 0, errno == EINTR { continue }
        if polled < 0 { break }
        if polled == 0 { continue }
        let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if count == 0 { break }
        if count < 0 {
          if errno == EINTR || errno == EAGAIN { continue }
          break
        }
        let room = ShellRunner.outputCap - kept.count
        if room > 0 { kept.append(contentsOf: buffer[0..<min(count, room)]) }
        if count > room { truncated = true }
      }
      close(fd)
      state.lock()
      captured[stream] = (kept, truncated)
      openStreams -= 1
      state.broadcast()
      state.unlock()
    }

    /// Non-blocking with a poll, so a reader that never reads cannot pin this thread past the
    /// run. EPIPE comes back as a failed write: the descriptor has `F_SETNOSIGPIPE`.
    private func feed(_ fd: Int32, _ bytes: [UInt8]) {
      _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
      var offset = 0
      while offset < bytes.count, !stopping {
        var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        let polled = poll(&ready, 1, 100)
        if polled < 0, errno == EINTR { continue }
        if polled < 0 { break }
        if polled == 0 { continue }
        let written = bytes.withUnsafeBytes {
          write(fd, $0.baseAddress! + offset, $0.count - offset)
        }
        if written > 0 {
          offset += written
        } else if written < 0, errno == EINTR || errno == EAGAIN {
          continue
        } else {
          break
        }
      }
      close(fd)
    }

    private func supervise(timeout: TimeInterval, scriptFile: URL?, started: UInt64) {
      state.lock()
      let deadline = Date().addingTimeInterval(timeout)
      while !leaderExited, !cancelRequested {
        if !state.wait(until: deadline) { break }
      }
      let stopped = !leaderExited
      let cancelled = stopped && cancelRequested
      if stopped {
        state.unlock()
        kill(-pid, SIGTERM)
        state.lock()
        let grace = Date().addingTimeInterval(ShellRunner.killGrace)
        while !leaderExited {
          if !state.wait(until: grace) { break }
        }
      }
      state.unlock()

      // The stragglers when the leader exited on its own, and everything when it would not.
      kill(-pid, SIGKILL)
      state.lock()
      while !leaderExited { state.wait() }
      state.unlock()
      var status: Int32 = 0
      var reaped: pid_t
      repeat { reaped = waitpid(pid, &status, 0) } while reaped < 0 && errno == EINTR
      let durationMs = Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)

      state.lock()
      let drained = Date().addingTimeInterval(ShellRunner.killGrace)
      while openStreams > 0 {
        if !state.wait(until: drained) { break }
      }
      stopReading = true
      while openStreams > 0 { state.wait() }
      let out = captured[1] ?? ([], false)
      let err = captured[2] ?? ([], false)
      state.unlock()

      let ended: (exitCode: Int32?, signal: String?) =
        reaped == pid ? ShellRunner.decode(status) : (nil, nil)
      let outcome = Outcome(
        exitCode: ended.exitCode, signal: ended.signal, timedOut: stopped && !cancelled,
        cancelled: cancelled, durationMs: durationMs,
        stdout: String(decoding: out.bytes, as: UTF8.self), stdoutTruncated: out.truncated,
        stderr: String(decoding: err.bytes, as: UTF8.self), stderrTruncated: err.truncated)
      if let scriptFile { try? FileManager.default.removeItem(at: scriptFile) }
      ShellRunner.registry.withLock { runs in runs.removeAll { $0 === self } }

      state.lock()
      result = outcome
      state.broadcast()
      state.unlock()
    }
  }

  // MARK: - Spawning

  private static let registry = Locked<[Running]>([])
  private static let resolved = Locked<[Interpreter: String?]>([:])

  private static func spawn(_ request: Request, scriptFile: URL?) throws -> Running {
    var opened: [Int32] = []
    func pipePair(_ step: String) throws -> (read: Int32, write: Int32) {
      var ends: [Int32] = [0, 0]
      guard pipe(&ends) == 0 else { throw StartError(step: step, code: errno) }
      opened += ends
      // Another thread of this app may spawn something before these are handed over.
      for end in ends { _ = fcntl(end, F_SETFD, FD_CLOEXEC) }
      return (ends[0], ends[1])
    }
    func closeOpened() { for fd in opened { close(fd) } }

    let input: (read: Int32, write: Int32)?
    let out: (read: Int32, write: Int32)
    let err: (read: Int32, write: Int32)
    var actions: posix_spawn_file_actions_t?
    var attributes: posix_spawnattr_t?
    posix_spawn_file_actions_init(&actions)
    posix_spawnattr_init(&attributes)
    defer {
      posix_spawn_file_actions_destroy(&actions)
      posix_spawnattr_destroy(&attributes)
    }
    do {
      input = request.stdin == nil ? nil : try pipePair("stdin pipe")
      out = try pipePair("stdout pipe")
      err = try pipePair("stderr pipe")

      if let input {
        try check(posix_spawn_file_actions_adddup2(&actions, input.read, 0), "stdin")
      } else {
        try check(
          posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0), "stdin")
      }
      try check(posix_spawn_file_actions_adddup2(&actions, out.write, 1), "stdout")
      try check(posix_spawn_file_actions_adddup2(&actions, err.write, 2), "stderr")
      try check(posix_spawn_file_actions_addchdir(&actions, request.cwd.path), "cwd")

      let flags =
        POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF
        | POSIX_SPAWN_SETSIGMASK
      try check(posix_spawnattr_setflags(&attributes, Int16(flags)), "flags")
      try check(posix_spawnattr_setpgroup(&attributes, 0), "process group")
      var defaults = sigset_t()
      sigfillset(&defaults)
      sigdelset(&defaults, SIGKILL)
      sigdelset(&defaults, SIGSTOP)
      try check(posix_spawnattr_setsigdefault(&attributes, &defaults), "signals")
      var unblocked = sigset_t()
      sigemptyset(&unblocked)
      try check(posix_spawnattr_setsigmask(&attributes, &unblocked), "signal mask")
    } catch {
      closeOpened()
      throw error
    }

    let environment = baseEnvironment(
      home: NSHomeDirectory(), user: NSUserName(), tmp: NSTemporaryDirectory()
    ).map { "\($0.key)=\($0.value)" }.sorted()
    let arguments = argv(request, scriptFile: scriptFile)
    let started = DispatchTime.now().uptimeNanoseconds
    var pid: pid_t = 0
    let spawned = withCStrings(arguments) { argv in
      withCStrings(environment) { envp in
        posix_spawn(&pid, "/bin/zsh", &actions, &attributes, argv, envp)
      }
    }
    guard spawned == 0 else {
      closeOpened()
      throw StartError(step: "start", code: spawned)
    }

    // The child has its own copies. Ours of the child's ends would keep its pipes open.
    if let input { close(input.read) }
    close(out.write)
    close(err.write)
    if let input { _ = fcntl(input.write, F_SETNOSIGPIPE, 1) }

    let running = Running(pid: pid)
    registry.withLock { $0.append(running) }
    running.begin(
      timeout: request.timeout, stdout: out.read, stderr: err.read,
      stdin: input.map { ($0.write, Array((request.stdin ?? "").utf8)) },
      scriptFile: scriptFile, started: started)
    return running
  }

  private static func check(_ code: Int32, _ step: String) throws {
    guard code == 0 else { throw StartError(step: step, code: code) }
  }

  private static func writeScript(_ script: String) throws -> URL {
    let directory = scriptDirectory
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    // This process's pid first, so a file left by a crash says whose it was.
    let file = directory.appendingPathComponent("\(getpid())-\(UUID().uuidString)")
    let fd = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw StartError(step: "script file", code: errno) }
    defer { close(fd) }
    let bytes = Array(script.utf8)
    var offset = 0
    while offset < bytes.count {
      let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress! + offset, $0.count - offset) }
      if written < 0, errno == EINTR { continue }
      guard written > 0 else {
        let code = errno
        unlink(file.path)
        throw StartError(step: "script file", code: code)
      }
      offset += written
    }
    return file
  }

  private static func withCStrings<R>(
    _ strings: [String], _ body: (UnsafePointer<UnsafeMutablePointer<CChar>?>) -> R
  ) -> R {
    let pointers: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) } + [nil]
    defer { for pointer in pointers { free(pointer) } }
    return pointers.withUnsafeBufferPointer { body($0.baseAddress!) }
  }

  /// `wait(2)`'s status, without the C macros Swift does not import.
  private static func decode(_ status: Int32) -> (exitCode: Int32?, signal: String?) {
    let low = status & 0x7f
    if low == 0 { return ((status >> 8) & 0xff, nil) }
    if low == 0x7f { return (nil, nil) }  // stopped, which waitpid without WUNTRACED never reports
    return (nil, signalName(low))
  }

  private static func signalName(_ number: Int32) -> String {
    let names: [Int32: String] = [
      SIGHUP: "SIGHUP", SIGINT: "SIGINT", SIGQUIT: "SIGQUIT", SIGILL: "SIGILL",
      SIGTRAP: "SIGTRAP", SIGABRT: "SIGABRT", SIGEMT: "SIGEMT", SIGFPE: "SIGFPE",
      SIGKILL: "SIGKILL", SIGBUS: "SIGBUS", SIGSEGV: "SIGSEGV", SIGSYS: "SIGSYS",
      SIGPIPE: "SIGPIPE", SIGALRM: "SIGALRM", SIGTERM: "SIGTERM", SIGXCPU: "SIGXCPU",
      SIGXFSZ: "SIGXFSZ", SIGVTALRM: "SIGVTALRM", SIGPROF: "SIGPROF", SIGUSR1: "SIGUSR1",
      SIGUSR2: "SIGUSR2",
    ]
    return names[number] ?? "SIG\(number)"
  }

  private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func withLock<R>(_ body: (inout Value) -> R) -> R {
      lock.lock()
      defer { lock.unlock() }
      return body(&value)
    }
  }
}

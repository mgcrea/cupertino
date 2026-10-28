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
/// every stop is a signal to the whole group: SIGTERM, then SIGKILL once the group is empty or
/// `killGrace` has passed, whichever is first. That is the same at a timeout, at a cancel, and
/// for the stragglers when the leader exits on its own, so a member that traps SIGTERM to clean
/// up gets the grace even when the leader dies at once.
///
/// "Empty" is `kill(-pgid, 0)` failing. The leader is only noticed, not reaped, until the run
/// is over, so the group id stays ours, and XNU skips zombies there: a group whose only member
/// is the unreaped leader answers EPERM (measured 2026-10-27 on macOS 27), so an obliging group
/// ends at once rather than after the whole grace. `make shell-check` pins both halves.
///
/// ## Why everything starts through `/bin/zsh -f -c`, and where PATH comes from
///
/// `-f` is NO_RCS: zsh reads none of the person's startup files, only a root-owned
/// `/etc/zshenv` if there is one. `~/.zshenv`, `~/.zprofile`, `~/.zshrc` and `~/.zlogin` are
/// writable by any process running as the person, Full Disk Access or not, and the window never
/// shows them. Read by a run, they would run code nobody approved under every grant this app
/// holds. A script that needs a version manager sets it up itself, where the window shows it.
///
/// The environment is `baseEnvironment` and nothing else: no variable of this app's own, and
/// none of the `APPLE_*` server settings, reaches the script.
///
/// ## How the script reaches the interpreter: as an argument, never a file
///
/// For `zsh` the script is the `-c` argument. For the others zsh `exec`s the interpreter with the
/// script as an argument of its own (`bash -c`, `python3 -I -c`, `node --eval=`, `osascript -e`),
/// so the leader is the interpreter itself. A script is never written to a file and read back by
/// path: any process running as the person can rewrite or rename a file between the write and
/// the read, Full Disk Access or not, and the person would have approved one text while another
/// ran with every grant. An argument is copied into the new process by the kernel at `exec`, and
/// nothing else can reach it there. A file removed after it is opened is no better: whoever
/// opened it first can still write to it.
///
/// `--` (zsh, bash) and `--eval=` (node) keep a script that starts with a dash from being read as
/// an option; `python3 -c` and `osascript -e` take the next argument whatever it starts with. A
/// multi-line script as one `-e` compiles as it does from a file, for AppleScript and for
/// JavaScript, and a 512 KB script fits: `ARG_MAX` is 1 MiB for the arguments and the
/// environment together, and the environment is a few short variables. `make shell-check`
/// pins both for every installed interpreter ("ShellRunner: the script reaches the interpreter
/// as an argument, never a file").
///
/// PATH is `searchPath`: `/etc/paths`, then `/etc/paths.d`, as `/usr/libexec/path_helper`
/// reads them for Terminal, then Homebrew's folders. Without it the servers' `/usr/bin:/bin`
/// would hide Homebrew's `node` and `python3`. `resolve` walks the same PATH in Swift and starts
/// nothing, so a diagnostics call runs no process at all.
///
/// `python3` runs with `-I`, isolated, for the same reason. Without it Python imports `site`,
/// which runs every `import` line of a `.pth` file in the user site-packages
/// (`~/Library/Python/<version>/lib/python/site-packages`) and imports `usercustomize`, and it
/// puts the current folder first on `sys.path` for a `-c` script, where a planted `json.py`
/// would shadow the standard library's. A same-user process can write both. A script that needs
/// the user site-packages adds them to `sys.path` itself.
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

    /// What zsh `exec`s, the script among its arguments. Empty for `zsh`, whose script is
    /// the `-c` argument itself.
    func arguments(_ script: String) -> [String] {
      switch self {
      case .zsh: []
      case .bash: ["bash", "-c", "--", script]
      // Isolated: see the type's comment.
      case .python3: ["python3", "-I", "-c", script]
      case .node: ["node", "--eval=" + script]
      case .osascript: ["osascript", "-e", script]
      case .jxa: ["osascript", "-l", "JavaScript", "-e", script]
      }
    }

    /// The command `resolve` looks up.
    var command: String {
      switch self {
      case .zsh, .bash, .python3, .node, .osascript: rawValue
      case .jxa: "osascript"
      }
    }
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

  /// The command line, the script in it. `-f`: no startup file of the person's is read. See the
  /// type's comment.
  static func argv(_ request: Request) -> [String] {
    let shell = ["/bin/zsh", "-f", "-c"]
    guard request.interpreter != .zsh else { return shell + ["--", request.script] }
    return shell + ["exec \"$0\" \"$@\""] + request.interpreter.arguments(request.script)
  }

  /// The whole environment zsh starts with. Nothing reads a startup file to extend it.
  static func baseEnvironment(
    home: String, user: String, tmp: String, path: [String] = searchPath()
  ) -> [String: String] {
    [
      "HOME": home,
      "USER": user,
      "LOGNAME": user,
      "SHELL": "/bin/zsh",
      "TMPDIR": tmp,
      "LANG": "en_US.UTF-8",
      "PATH": path.joined(separator: ":"),
    ]
  }

  /// Stands in for `/etc/paths` when it cannot be read, or when nothing at all is listed.
  static let fallbackPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  /// Appended when they exist, so Homebrew's tools are found where its installer added no file
  /// to `/etc/paths.d`.
  static let homebrewPath = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]

  /// The folders a script's PATH lists, from root-owned files only, never a shell's startup
  /// files: the lines of `/etc/paths`, then those of each file in `/etc/paths.d` in file name
  /// order, as `path_helper` reads them (blank lines skipped, spaces around a line dropped,
  /// each folder once, kept where it first appears); then each of `homebrewPath` that exists
  /// and is not listed yet.
  ///
  /// `root` stands in for `/` when reading those files and asking whether a Homebrew folder
  /// exists, so the checks can give it a fake `/etc`. The folders it returns are as written.
  static func searchPath(root: String = "/") -> [String] {
    let base = URL(fileURLWithPath: root, isDirectory: true)
    let etc = base.appendingPathComponent("etc", isDirectory: true)
    func lines(_ file: URL) -> [String]? {
      guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
      return text.components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    }

    var listed = lines(etc.appendingPathComponent("paths")) ?? fallbackPath
    let drop = etc.appendingPathComponent("paths.d", isDirectory: true)
    // Byte order, as `path_helper`'s strcmp sorts them.
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: drop.path)) ?? [])
      .sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
    for name in names {
      var isDirectory: ObjCBool = false
      let file = drop.appendingPathComponent(name)
      guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory),
        !isDirectory.boolValue
      else { continue }
      listed += lines(file) ?? []
    }
    for folder in homebrewPath {
      var isDirectory: ObjCBool = false
      let there = base.appendingPathComponent(String(folder.dropFirst())).path
      if FileManager.default.fileExists(atPath: there, isDirectory: &isDirectory),
        isDirectory.boolValue
      {
        listed.append(folder)
      }
    }

    var seen = Set<String>()
    let path = listed.filter { seen.insert($0).inserted }
    return path.isEmpty ? fallbackPath : path
  }

  /// The first `<folder>/<command>` on `path` that is an executable file, as `command -v`
  /// finds it, without starting a shell to ask. Relative entries are skipped.
  static func find(_ command: String, in path: [String]) -> String? {
    for folder in path where folder.hasPrefix("/") {
      let candidate = (folder as NSString).appendingPathComponent(command)
      var isDirectory: ObjCBool = false
      if FileManager.default.fileExists(atPath: candidate, isDirectory: &isDirectory),
        !isDirectory.boolValue, FileManager.default.isExecutableFile(atPath: candidate)
      {
        return candidate
      }
    }
    return nil
  }

  /// Starts the script and returns at once. The run is in `live` until it has been waited out,
  /// whether or not anybody calls `wait`. `home` and `tmp`, the script's `HOME` and `TMPDIR`,
  /// are for the checks, which give it scratch folders; the app leaves them alone.
  static func start(
    _ request: Request, home: String = NSHomeDirectory(), tmp: String = NSTemporaryDirectory()
  ) throws -> Running {
    try spawn(request, home: home, tmp: tmp)
  }

  /// The interpreter's path on a script's PATH, or nil when it is not installed. Starts no
  /// process. Asked once per interpreter.
  static func resolve(_ interpreter: Interpreter) -> String? {
    if let known = resolved.withLock({ $0[interpreter] }) { return known }
    let path = find(interpreter.command, in: searchPath())
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
    private var leaderExitedAt: UInt64 = 0
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
      started: UInt64
    ) {
      thread("leader") { $0.watchLeader() }
      thread("stdout") { $0.drain(stdout, as: 1) }
      thread("stderr") { $0.drain(stderr, as: 2) }
      if let stdin { thread("stdin") { $0.feed(stdin.fd, stdin.bytes) } }
      thread("supervisor") {
        $0.supervise(timeout: timeout, started: started)
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
      leaderExitedAt = DispatchTime.now().uptimeNanoseconds
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

    /// Whether a live process is left in the group. The unreaped leader does not count.
    private var groupHasMembers: Bool { kill(-pid, 0) == 0 }

    private func supervise(timeout: TimeInterval, started: UInt64) {
      state.lock()
      let deadline = Date().addingTimeInterval(timeout)
      while !leaderExited, !cancelRequested {
        if !state.wait(until: deadline) { break }
      }
      let stopped = !leaderExited
      let cancelled = stopped && cancelRequested
      state.unlock()

      // The whole group, at a timeout or a cancel, and the stragglers when the leader exited
      // on its own. The grace is the group's, not the leader's.
      if groupHasMembers {
        kill(-pid, SIGTERM)
        let grace = Date().addingTimeInterval(ShellRunner.killGrace)
        while groupHasMembers, Date() < grace { Thread.sleep(forTimeInterval: 0.02) }
        kill(-pid, SIGKILL)
      }

      state.lock()
      while !leaderExited { state.wait() }
      let durationMs = Int((leaderExitedAt - started) / 1_000_000)
      // A process that left the group can hold a pipe open: wait for end of file, not forever.
      let drained = Date().addingTimeInterval(ShellRunner.killGrace)
      while openStreams > 0 {
        if !state.wait(until: drained) { break }
      }
      stopReading = true
      while openStreams > 0 { state.wait() }
      let out = captured[1] ?? ([], false)
      let err = captured[2] ?? ([], false)
      state.unlock()

      // Reaped only now, beside leaving `live`: until then the group id cannot be handed to
      // another process, so a teardown signalling `live` cannot reach a stranger.
      var status: Int32 = 0
      var reaped: pid_t
      repeat { reaped = waitpid(pid, &status, 0) } while reaped < 0 && errno == EINTR
      ShellRunner.registry.withLock { runs in runs.removeAll { $0 === self } }

      let ended: (exitCode: Int32?, signal: String?) =
        reaped == pid ? ShellRunner.decode(status) : (nil, nil)
      let outcome = Outcome(
        exitCode: ended.exitCode, signal: ended.signal, timedOut: stopped && !cancelled,
        cancelled: cancelled, durationMs: durationMs,
        stdout: String(decoding: out.bytes, as: UTF8.self), stdoutTruncated: out.truncated,
        stderr: String(decoding: err.bytes, as: UTF8.self), stderrTruncated: err.truncated)

      state.lock()
      result = outcome
      state.broadcast()
      state.unlock()
    }
  }

  // MARK: - Spawning

  private static let registry = Locked<[Running]>([])
  private static let resolved = Locked<[Interpreter: String?]>([:])

  private static func spawn(_ request: Request, home: String, tmp: String) throws -> Running {
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
      home: home, user: NSUserName(), tmp: tmp
    ).map { "\($0.key)=\($0.value)" }.sorted()
    let arguments = argv(request)
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
      started: started)
    return running
  }

  private static func check(_ code: Int32, _ step: String) throws {
    guard code == 0 else { throw StartError(step: step, code: code) }
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

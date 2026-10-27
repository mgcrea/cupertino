import Foundation

/// Asserts what the Shell surface does with a script once it has been allowed to run.
///
/// A standalone `swiftc` binary for the reason `unit-check.swift` gives, and Foundation only so
/// it runs on a CI runner with no app, no socket and no grant. Unlike the other checks it spawns
/// real processes (`zsh`, `sleep`, `head`, and whichever interpreters are installed), because
/// what it pins is how those processes start and stop: the command line, the environment, the
/// output cap, and that a timeout or a cancel takes the whole process group with it. A
/// backgrounded grandchild that outlives its run keeps every grant Cupertino holds with nothing
/// supervising it, and nothing else would notice.
///
/// Run with `make shell-check`.
@main
struct ShellCheck {
  static var failures = 0
  static var checks = 0

  /// A thrown error counts as a failure, so one broken spawn reports and the rest still run.
  static func check(_ label: String, _ condition: @autoclosure () throws -> Bool) {
    checks += 1
    let passed: Bool
    do { passed = try condition() } catch {
      print("  FAIL \(label) (threw \(error))")
      failures += 1
      return
    }
    if passed {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  static func run(
    _ s: String, _ i: ShellRunner.Interpreter = .zsh, cwd: String = NSTemporaryDirectory(),
    stdin: String? = nil, timeout: TimeInterval = 10
  ) throws -> ShellRunner.Outcome {
    try ShellRunner.start(
      .init(
        script: s, interpreter: i, cwd: URL(fileURLWithPath: cwd), stdin: stdin, timeout: timeout)
    ).wait()
  }

  /// A file of this run's own, so two checks running at once do not read each other's pids.
  static func pidFile(_ name: String) -> String { scratch("\(name).pid") }

  static func scratch(_ name: String) -> String {
    NSTemporaryDirectory() + "shell-check-\(getpid())-\(name)"
  }

  /// A run whose backgrounded member traps SIGTERM to clean up for half a second, returned
  /// once that trap is set. The leader runs `leader` after it, and dies of SIGTERM at once.
  static func startCleaner(_ name: String, leader: String, timeout: TimeInterval = 60) throws
    -> ShellRunner.Running
  {
    let cleaned = scratch("\(name)-cleaned")
    let ready = scratch("\(name)-ready")
    let script =
      "(trap 'sleep 0.5; echo cleaned > \(cleaned); exit 0' TERM; echo > \(ready); "
      + "while :; do sleep 0.1; done) & "
      + "while [[ ! -e \(ready) ]]; do sleep 0.02; done; \(leader)"
    let run = try ShellRunner.start(
      .init(
        script: script, interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil,
        timeout: timeout))
    let seen = Date().addingTimeInterval(5)
    while !FileManager.default.fileExists(atPath: ready), Date() < seen {
      Thread.sleep(forTimeInterval: 0.02)
    }
    return run
  }

  /// Whether the member of `startCleaner(name, …)` ran its TERM trap to the end. Its files are
  /// removed. The leader polls the ready file, so it stays until here.
  static func cleanedUp(_ name: String) -> Bool {
    let cleaned = scratch("\(name)-cleaned")
    defer {
      try? FileManager.default.removeItem(atPath: cleaned)
      try? FileManager.default.removeItem(atPath: scratch("\(name)-ready"))
    }
    return (try? String(contentsOfFile: cleaned, encoding: .utf8)) == "cleaned\n"
  }

  /// The pid the script wrote, or 0 while it has not finished writing it. The file is removed
  /// once it has been read.
  static func readPid(_ path: String) throws -> pid_t {
    let text = try String(contentsOfFile: path, encoding: .utf8)
    guard let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return 0 }
    try? FileManager.default.removeItem(atPath: path)
    return pid
  }

  /// The two settings that lower the bar, against a scratch suite and a key held in memory. The
  /// real Keychain and the app's own defaults domain are never touched.
  static func sealChecks() {
    print("ShellSeal: settings another program cannot forge")
    let suite = "shell-check"
    let store = UserDefaults(suiteName: suite)!
    store.removePersistentDomain(forName: suite)
    defer { store.removePersistentDomain(forName: suite) }
    ShellSeal.domain = suite
    ShellSeal.source = MemoryKey()
    let enabled = "surfaceEnabled.shell"

    check(
      "fresh: off and ask", !ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .ask)
    store.set(true, forKey: enabled)
    store.set("none", forKey: ShellPolicy.key)
    check(
      "forged plain values: still off and ask",
      !ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .ask)
    ShellSeal.setEnabled(true, store)
    ShellSeal.setBefore(.none, store)
    check(
      "sealed: on and none",
      ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .none)

    // The seal is bound to its own preference: one setting's seal is no use to the other.
    let enabledSeal = store.string(forKey: ShellSeal.enabledSealKey)
    let beforeSeal = store.string(forKey: ShellSeal.beforeSealKey)
    store.set(enabledSeal, forKey: ShellSeal.beforeSealKey)
    check(
      "a seal moved to the other setting does not validate",
      ShellSeal.effectiveBefore(store) == .ask)
    store.set(beforeSeal, forKey: ShellSeal.beforeSealKey)
    check("put back, it does", ShellSeal.effectiveBefore(store) == .none)

    // A launch argument lands in NSArgumentDomain, which is in every store's search list.
    // Restored by setting it back: `removeVolatileDomain` leaves it in the search list.
    let arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
    store.removeObject(forKey: enabled)
    store.removeObject(forKey: ShellSeal.enabledSealKey)
    UserDefaults.standard.setVolatileDomain(
      [enabled: true, ShellSeal.enabledSealKey: enabledSeal ?? ""],
      forName: UserDefaults.argumentDomain)
    check(
      "the argument domain is seen by object(forKey:)",
      store.object(forKey: ShellSeal.enabledSealKey) as? String == enabledSeal)
    check("but a sealed value there does not count", !ShellSeal.isEnabled(store))
    UserDefaults.standard.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)

    ShellSeal.setEnabled(true, store)
    let copied = store.string(forKey: ShellSeal.enabledSealKey)
    ShellSeal.setEnabled(false, store)
    check(
      "turning off removes the value and its seal",
      store.object(forKey: enabled) == nil && store.object(forKey: ShellSeal.enabledSealKey) == nil)
    check(
      "and puts \"Before running\" back to ask, unsealed",
      ShellSeal.effectiveBefore(store) == .ask && store.string(forKey: ShellPolicy.key) == "ask"
        && store.object(forKey: ShellSeal.beforeSealKey) == nil)
    store.set(true, forKey: enabled)
    store.set(copied, forKey: ShellSeal.enabledSealKey)
    check("a seal copied before turn-off does not validate after", !ShellSeal.isEnabled(store))

    ShellSeal.setEnabled(true, store)
    ShellSeal.setBefore(.none, store)
    ShellSeal.setEnabled(false, store)
    ShellSeal.setEnabled(true, store)
    check(
      "on with \"Don't ask\", turned off and on again, reads ask",
      ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .ask)

    ShellSeal.setBefore(.none, store)
    let copiedNone = store.string(forKey: ShellSeal.beforeSealKey)
    ShellSeal.setBefore(.session, store)
    check("session needs no seal", ShellSeal.effectiveBefore(store) == .session)
    check(
      "lowering \"Don't ask\" removes its seal",
      store.object(forKey: ShellSeal.beforeSealKey) == nil)
    check("and leaves Shell on", ShellSeal.isEnabled(store))
    store.set("none", forKey: ShellPolicy.key)
    store.set(copiedNone, forKey: ShellSeal.beforeSealKey)
    check(
      "a \"Don't ask\" seal copied before lowering does not validate after",
      ShellSeal.effectiveBefore(store) == .ask)
    ShellSeal.setBefore(.ask, store)
    check("ask needs no seal", ShellSeal.effectiveBefore(store) == .ask)
    store.set("bogus", forKey: ShellPolicy.key)
    check("an unknown value reads as ask", ShellSeal.effectiveBefore(store) == .ask)

    store.set("garbage", forKey: ShellSeal.enabledSealKey)
    check("bad seal reads off", !ShellSeal.isEnabled(store))
    ShellSeal.setEnabled(true, store)
    store.set(String(repeating: "0", count: 64), forKey: ShellSeal.enabledSealKey)
    check("a well-formed wrong seal reads off", !ShellSeal.isEnabled(store))
    ShellSeal.setEnabled(true, store)
    store.set("YES", forKey: enabled)
    check("a value that is not a bool reads off", !ShellSeal.isEnabled(store))

    ShellSeal.setEnabled(true, store)
    ShellSeal.setBefore(.none, store)
    (ShellSeal.source as! MemoryKey).drop()
    check(
      "no key reads off and ask",
      !ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .ask)
  }

  /// Where the seal key lives, from the pure query alone. The real Keychain is never touched:
  /// this binary has no application identifier, so its `Keychain` source never gets a query.
  static func keychainChecks() {
    print("\nShellSeal.Keychain: the data protection keychain, in the app's own group")
    let debugID = "75QE9PRT3V.io.mgcrea.cupertino.debug"
    let releaseID = "75QE9PRT3V.io.mgcrea.cupertino"
    let debug = ShellSeal.Keychain.query(
      applicationIdentifier: debugID, appIdentifier: "io.mgcrea.cupertino.debug")
    check(
      "the data protection keychain",
      debug?[kSecUseDataProtectionKeychain as String] as? Bool == true)
    check(
      "the access group is the application identifier",
      debug?[kSecAttrAccessGroup as String] as? String == debugID)
    check(
      "a generic password, account shell-seal, service of its own build",
      debug?[kSecClass as String] as? String == kSecClassGenericPassword as String
        && debug?[kSecAttrAccount as String] as? String == "shell-seal"
        && debug?[kSecAttrService as String] as? String == "io.mgcrea.cupertino.debug.shell-seal")
    let release = ShellSeal.Keychain.query(
      applicationIdentifier: releaseID, appIdentifier: "io.mgcrea.cupertino")
    check(
      "release has a group of its own",
      release?[kSecAttrAccessGroup as String] as? String == releaseID
        && release?[kSecUseDataProtectionKeychain as String] as? Bool == true)
    check(
      "a legacy App ID prefix is kept as signed",
      ShellSeal.Keychain.accessGroup(
        applicationIdentifier: "CDV6DT8QF2.io.mgcrea.cupertino.debug",
        appIdentifier: "io.mgcrea.cupertino.debug") == "CDV6DT8QF2.io.mgcrea.cupertino.debug")
    check(
      "the other build's identifier gets no query",
      ShellSeal.Keychain.query(applicationIdentifier: debugID, appIdentifier: "io.mgcrea.cupertino")
        == nil
        && ShellSeal.Keychain.query(
          applicationIdentifier: releaseID, appIdentifier: "io.mgcrea.cupertino.debug") == nil
    )
    check(
      "a wildcard, a bare bundle id or no identifier gets none",
      ["75QE9PRT3V.*", "io.mgcrea.cupertino", ".io.mgcrea.cupertino", nil].allSatisfy {
        ShellSeal.Keychain.query(applicationIdentifier: $0, appIdentifier: "io.mgcrea.cupertino")
          == nil
      })
    check(
      "this binary is signed with no application identifier",
      ShellSeal.Keychain.signedApplicationIdentifier == nil)
    let unentitled = ShellSeal.Keychain()
    check(
      "so its Keychain source reads no key and keeps a reason",
      unentitled.key() == nil && unentitled.rotate() == nil && ShellSeal.lastKeyError != nil)
  }

  /// The run record, in a scratch directory of its own. The app's own `shell-runs` is never
  /// touched.
  static func recordChecks() throws {
    print("\nShellRecord: one chained line per request")
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("shell-record-check-\(UUID())")
    defer { try? FileManager.default.removeItem(at: dir) }
    // A fixed instant, so the month a line lands in does not depend on the day the check runs.
    let t0 = ISO8601DateFormatter().date(from: "2026-10-27T12:00:00Z")!
    let script = String(repeating: "a", count: 5000) + "SECRET"
    var e = ShellRecord.Entry(
      at: t0, client: "c", connection: UUID(), purpose: "p", interpreter: "zsh", cwd: "/",
      scriptBytes: script.utf8.count, scriptSHA256: AuditChain.digest(script),
      decision: .declined, exitCode: nil, signal: nil, timedOut: false, durationMs: nil)
    ShellRecord.append(e, in: dir, now: t0)
    e.decision = .approved
    e.exitCode = 0
    ShellRecord.append(e, in: dir, now: t0)
    ShellRecord.flushForCheck()
    let text = try FileManager.default.contentsOfDirectory(
      at: dir, includingPropertiesForKeys: nil
    ).map { try String(contentsOf: $0, encoding: .utf8) }.joined()
    check(
      "a refusal is a line too",
      ShellRecord.recent(in: dir).map(\.decision) == [.approved, .declined])
    check(
      "hash covers the part past 4 KB",
      ShellRecord.recent(in: dir)[0].scriptSHA256 == AuditChain.digest(script))
    check("no script text on file", !text.contains("SECRET"))
    check("chain verifies", ShellRecord.verify(in: dir).isIntact)
    let old = Calendar(identifier: .gregorian).date(byAdding: .day, value: -200, to: t0)!
    e.at = old
    ShellRecord.append(e, in: dir, now: old)
    e.at = t0
    ShellRecord.append(e, in: dir, now: t0)
    ShellRecord.flushForCheck()
    check(
      "a segment older than 90 days is dropped",
      try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 1)
    check("the chain still verifies after the drop", ShellRecord.verify(in: dir).isIntact)
    check("an entry reads back whole", ShellRecord.recent(1, in: dir) == [e])

    let next = Calendar(identifier: .gregorian).date(byAdding: .day, value: 10, to: t0)!
    ShellRecord.append(e, in: dir, now: next)
    ShellRecord.flushForCheck()
    check(
      "a new month opens from the last one's head",
      try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 2
        && ShellRecord.verify(in: dir).isIntact)

    // A crash mid-write leaves a last line with no line break.
    let newest = try FileManager.default.contentsOfDirectory(
      at: dir, includingPropertiesForKeys: nil
    )
    .max { $0.lastPathComponent < $1.lastPathComponent }!
    let torn = try FileHandle(forWritingTo: newest)
    try torn.seekToEnd()
    try torn.write(contentsOf: Data("{\"v\":1,\"seq\":".utf8))
    try torn.close()
    e.decision = .busy
    ShellRecord.append(e, in: dir, now: next)
    let failures = ShellRecord.verify(in: dir).failures
    check(
      "a torn line is named, and the next line still links past it",
      failures.count == 1 && { if case .unreadable = failures[0] { true } else { false } }())
    check("and reads back", ShellRecord.recent(1, in: dir).map(\.decision) == [.busy])

    // Torn inside a multi-byte character: `purpose` and `cwd` are free text, written raw, so
    // the file can end on the first byte of an "é". The month must not stop being UTF-8 and
    // vanish from `recent` and `verify` with it.
    let cut = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("shell-record-check-\(UUID())")
    defer { try? FileManager.default.removeItem(at: cut) }
    e.decision = .declined
    ShellRecord.append(e, in: cut, now: t0)
    ShellRecord.flushForCheck()
    let month = try FileManager.default.contentsOfDirectory(
      at: cut, includingPropertiesForKeys: nil
    )[0]
    let fragment = try FileHandle(forWritingTo: month)
    try fragment.seekToEnd()
    try fragment.write(contentsOf: Data("{\"v\":1,\"seq\":2,\"text\":\"r".utf8) + [0xC3])
    try fragment.close()
    e.decision = .approved
    ShellRecord.append(e, in: cut, now: t0)
    let cutVerdict = ShellRecord.verify(in: cut)
    check(
      "a line torn mid-character is named, and the month still verifies around it",
      cutVerdict.records == 2 && cutVerdict.failures.count == 1
        && { if case .unreadable = cutVerdict.failures[0] { true } else { false } }())
    check(
      "and the month still reads back",
      ShellRecord.recent(in: cut).map(\.decision) == [.approved, .declined])
  }

  static func main() throws {
    // As the app does in `ServerHost.start`. A spawned script must not inherit it.
    _ = signal(SIGPIPE, SIG_IGN)

    sealChecks()
    keychainChecks()
    try recordChecks()

    print("\nShellRunner: the command line and the environment")
    check(
      "argv zsh",
      ShellRunner.argv(
        .init(
          script: "echo hi", interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil,
          timeout: 1), scriptFile: nil) == ["/bin/zsh", "-l", "-c", "echo hi"])
    check(
      "argv jxa",
      ShellRunner.argv(
        .init(
          script: "1", interpreter: .jxa, cwd: URL(fileURLWithPath: "/"), stdin: nil, timeout: 1),
        scriptFile: URL(fileURLWithPath: "/t/s"))
        == [
          "/bin/zsh", "-l", "-c", "exec \"$0\" \"$@\"", "osascript", "-l", "JavaScript", "/t/s",
        ])
    check(
      "argv python3",
      ShellRunner.argv(
        .init(
          script: "1", interpreter: .python3, cwd: URL(fileURLWithPath: "/"), stdin: nil,
          timeout: 1),
        scriptFile: URL(fileURLWithPath: "/t/s"))
        == ["/bin/zsh", "-l", "-c", "exec \"$0\" \"$@\"", "python3", "/t/s"])
    check(
      "env has only the base keys",
      Set(ShellRunner.baseEnvironment(home: "/h", user: "u", tmp: "/t").keys)
        == ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "PATH"])
    check(
      "env values",
      ShellRunner.baseEnvironment(home: "/h", user: "u", tmp: "/t")
        == [
          "HOME": "/h", "USER": "u", "LOGNAME": "u", "SHELL": "/bin/zsh", "TMPDIR": "/t",
          "LANG": "en_US.UTF-8", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        ])

    print("\nShellRunner: a run")
    let a = try run("echo out; echo err >&2; exit 3")
    check("exit code", a.exitCode == 3 && a.signal == nil && !a.timedOut)
    check("stdout and stderr apart", a.stdout == "out\n" && a.stderr == "err\n")
    check("cwd honoured", try run("pwd -P", cwd: "/private/tmp").stdout == "/private/tmp\n")
    check("stdin delivered", try run("cat", stdin: "abc").stdout == "abc")
    let noStdin = try run("cat; echo done", timeout: 5)
    check("no stdin is EOF, not a hang", noStdin.stdout == "done\n" && !noStdin.timedOut)
    check(
      "nothing of this process's environment leaks in",
      try run("echo ${APPLE_SHELL_LEAK-unset}").stdout == "unset\n")
    // The app ignores SIGPIPE, and an ignored signal survives exec. Inherited, `yes | head -1`
    // would see EPIPE and complain instead of dying quietly as it does in Terminal.
    check(
      "SIGPIPE is back to its default in the script",
      try run("yes | head -1; echo ${pipestatus[1]}").stdout == "y\n141\n")
    check(
      "a missing cwd is an error, not a run",
      (try? run("true", cwd: "/nonexistent-shell-check-\(getpid())")) == nil)

    print("\nShellRunner: output")
    let big = try run("head -c 10000000 /dev/zero | tr '\\0' a")
    check(
      "capped at 256 KB",
      big.stdout.utf8.count == 262_144 && big.stdoutTruncated && big.exitCode == 0)
    check("stderr untouched by stdout's cap", big.stderr.isEmpty && !big.stderrTruncated)
    let bin = try run(
      "printf '\\xff\\xfeok'; head -c 262143 /dev/zero | tr '\\0' a; printf '\\xc3\\xa9'")
    check(
      "non-UTF-8 survives as replacement characters",
      bin.stdout.hasPrefix("\u{FFFD}\u{FFFD}ok") && bin.stdoutTruncated)

    print("\nShellRunner: stopping")
    let slowFile = pidFile("slow")
    let slowStart = Date()
    let slow = try run("sleep 100 & echo $! > \(slowFile); wait", timeout: 1)
    let slowTook = Date().timeIntervalSince(slowStart)
    let orphan = try readPid(slowFile)
    check("timeout reported", slow.timedOut && slow.exitCode == nil && slow.signal != nil)
    check("timeout killed the backgrounded grandchild", orphan > 0 && kill(orphan, 0) != 0)
    // Everything died of the SIGTERM, so nothing waited out the grace. This also pins that the
    // unreaped leader does not keep the group looking alive.
    check("an obliging group ends without the grace", slowTook < 1.8)
    let leftFile = pidFile("left")
    let leftStart = Date()
    let left = try run("sleep 100 & echo $! > \(leftFile); echo started")
    let leftTook = Date().timeIntervalSince(leftStart)
    let stray = try readPid(leftFile)
    check(
      "a leader that exits takes its stragglers with it",
      left.stdout == "started\n" && stray > 0 && kill(stray, 0) != 0)
    check("and does not wait out the grace for them", leftTook < 1)
    let r = try ShellRunner.start(
      .init(
        script: "sleep 30", interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil,
        timeout: 60))
    Thread.sleep(forTimeInterval: 0.3)
    let cancelStart = Date()
    r.cancel()
    let c = r.wait()
    check("cancel stops it and says so", c.cancelled && !c.timedOut && c.durationMs < 5_000)
    check("a cancel of an obliging run is prompt", Date().timeIntervalSince(cancelStart) < 1)
    check("wait is idempotent", r.wait() == c)
    check("nothing left live", ShellRunner.live.isEmpty)

    print("\nShellRunner: the grace is the group's, not the leader's")
    // The leader dies of SIGTERM at once; a member trapping it to clean up must still get its
    // half second rather than a SIGKILL a moment later. And no stop waits the whole grace when
    // the group empties sooner.
    do {
      let cancelled = try startCleaner("cancel", leader: "wait")
      let start = Date()
      cancelled.cancel()
      let outcome = cancelled.wait()
      let took = Date().timeIntervalSince(start)
      check(
        "a cancel lets a member's TERM trap finish",
        outcome.cancelled && cleanedUp("cancel"))
      check("and ends when the group is empty, not after the grace", took >= 0.4 && took < 1.8)

      let timed = try startCleaner("timeout", leader: "wait", timeout: 0.5)
      let timedOutcome = timed.wait()
      check(
        "a timeout lets a member's TERM trap finish",
        timedOutcome.timedOut && cleanedUp("timeout"))

      let exited = try startCleaner("exited", leader: "echo started")
      let exitedOutcome = exited.wait()
      check(
        "a straggler of a leader that exited gets the grace too",
        exitedOutcome.exitCode == 0 && cleanedUp("exited"))

      let quit = try startCleaner("quit", leader: "wait")
      let quitStart = Date()
      ChildTermination.terminateGroups([quit.pid], grace: 3)
      let quitTook = Date().timeIntervalSince(quitStart)
      _ = quit.wait()
      check("terminateGroups lets a member's TERM trap finish", cleanedUp("quit"))
      check("and returns when the group is empty", quitTook >= 0.4 && quitTook < 2)
    }

    print("\nChildTermination: a process group that will not stop")
    // What quit and an update relaunch call for runs still going. `terminateAll` signals single
    // pids, so it would stop the leader and leave the group's other members running.
    do {
      let stubbornFile = pidFile("stubborn")
      let stubborn = try ShellRunner.start(
        .init(
          // Both the leader and the member it backgrounds ignore SIGTERM. A bare `sleep &`
          // would not: zsh hands its background jobs SIGTERM's default back.
          script: "trap '' TERM; (trap '' TERM; while :; do sleep 0.1; done) & "
            + "echo $! > \(stubbornFile); wait",
          interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil, timeout: 60))
      check("the run is live while it runs", ShellRunner.live.contains { $0 === stubborn })
      var child: pid_t = 0
      let seen = Date().addingTimeInterval(5)
      while child == 0, Date() < seen {
        Thread.sleep(forTimeInterval: 0.05)
        child = (try? readPid(stubbornFile)) ?? 0
      }
      let started = Date()
      ChildTermination.terminateGroups([stubborn.pid], grace: 0.5)
      let took = Date().timeIntervalSince(started)
      let outcome = stubborn.wait()
      check("a group ignoring SIGTERM is killed after the grace", outcome.signal == "SIGKILL")
      check("and its backgrounded member too", child > 0 && kill(child, 0) != 0)
      check("in about the grace", took >= 0.4 && took < 2)
      let obliging = try ShellRunner.start(
        .init(
          script: "sleep 30", interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil,
          timeout: 60))
      Thread.sleep(forTimeInterval: 0.2)
      let quickStart = Date()
      ChildTermination.terminateGroups([obliging.pid], grace: 3)
      check(
        "a group that exits on SIGTERM costs nothing like the grace",
        Date().timeIntervalSince(quickStart) < 1 && obliging.wait().signal == "SIGTERM")
      let emptyStart = Date()
      ChildTermination.terminateGroups([], grace: 3)
      check("an empty list returns at once", Date().timeIntervalSince(emptyStart) < 0.1)
    }

    print("\nShellRunner: interpreters through the login shell")
    for i in [ShellRunner.Interpreter.python3, .node, .bash, .osascript, .jxa] {
      guard ShellRunner.resolve(i) != nil else {
        print("  skip \(i) not installed")
        continue
      }
      let script = [
        "python3": "print(6*7)", "node": "console.log(6*7)", "bash": "echo $((6*7))",
        "osascript": "6*7", "jxa": "6*7",
      ][i.rawValue]!
      check(
        "\(i) runs through the login shell",
        try run(script, i).stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "42")
    }
    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("cupertino-shell")
    check(
      "script files are removed after the run",
      ((try? FileManager.default.contentsOfDirectory(atPath: scratch.path)) ?? [])
        .filter { $0.hasPrefix("\(getpid())-") }.isEmpty)
    try serverChecks()
    check("nothing left live at the end", ShellRunner.live.isEmpty)

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }
}

/// A seal key held in memory, so no check ever reads or writes the real Keychain.
final class MemoryKey: ShellSeal.KeySource, @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Data?

  func key() -> Data? { lock.withLock { stored } }

  func rotate() -> Data? {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      return nil
    }
    let fresh = Data(bytes)
    lock.withLock { stored = fresh }
    return fresh
  }

  /// As if the Keychain item were deleted.
  func drop() { lock.withLock { stored = nil } }
}

/// `AppInfo` reaches for screenshot-mode state, and that pulls half the app in behind it. The
/// server only ever asks it for a version string.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}

/// A window that is never drawn: it answers what it is told and counts what it was asked.
///
/// With `hold` on, `ask` waits as an open window does, until a cancel names its prompt. A cancel
/// that arrives before the prompt it names is kept and answers that prompt `.cancelled` at once,
/// which is the contract `ShellConsenting.cancel` states.
final class FakeConsent: ShellConsenting, @unchecked Sendable {
  private let state = NSCondition()
  private var answer: ShellPromptAnswer = .dontRun
  private var holding = false
  private var asked: [ShellPrompt] = []
  private var cancels: [String] = []
  private var shown = 0
  private var finished = 0
  private var lastStop: (@Sendable () -> Void)?
  /// Signalled each time a held `ask` starts waiting.
  let waiting = DispatchSemaphore(value: 0)

  var next: ShellPromptAnswer {
    get { state.withLock { answer } }
    set { state.withLock { answer = newValue } }
  }
  var hold: Bool {
    get { state.withLock { holding } }
    set { state.withLock { holding = newValue } }
  }
  var asks: Int { state.withLock { asked.count } }
  var prompts: [ShellPrompt] { state.withLock { asked } }
  var notices: Int { state.withLock { shown } }
  var ended: Int { state.withLock { finished } }
  var stop: (@Sendable () -> Void)? { state.withLock { lastStop } }

  private static func key(_ connection: UUID, _ requestId: String) -> String {
    "\(connection)|\(requestId)"
  }

  func ask(_ prompt: ShellPrompt) -> ShellPromptAnswer {
    state.lock()
    defer { state.unlock() }
    asked.append(prompt)
    let key = Self.key(prompt.connection, prompt.requestId)
    if let early = cancels.firstIndex(of: key) {
      cancels.remove(at: early)
      return .cancelled
    }
    guard holding else { return answer }
    waiting.signal()
    let deadline = Date().addingTimeInterval(5)
    while !cancels.contains(key) {
      if !state.wait(until: deadline) { return .noAnswer }
    }
    cancels.removeAll { $0 == key }
    return .cancelled
  }

  func cancel(connection: UUID, requestId: String) {
    state.lock()
    cancels.append(Self.key(connection, requestId))
    state.broadcast()
    state.unlock()
  }

  func running(_ prompt: ShellPrompt, stop: @escaping @Sendable () -> Void)
    -> any ShellNoticeToken
  {
    state.withLock {
      shown += 1
      lastStop = stop
    }
    return Notice(owner: self)
  }

  fileprivate func noticeEnded() { state.withLock { finished += 1 } }

  private final class Notice: ShellNoticeToken, @unchecked Sendable {
    let owner: FakeConsent
    init(owner: FakeConsent) { self.owner = owner }
    func ended() { owner.noticeEnded() }
  }
}

/// A count several threads add to.
final class Tally: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int
  init(_ value: Int = 0) { self.value = value }
  var count: Int { lock.withLock { value } }
  func next() -> Int {
    lock.withLock {
      value += 1
      return value
    }
  }
}

/// What a tool call came back with.
struct ToolAnswer {
  var isError: Bool
  var text: String
  /// The JSON a successful result carries as its text, parsed.
  var structured: [String: Any]
  var reply: [String: Any]
}

extension ShellCheck {
  static let conn = UUID()
  static let requestsMade = Tally()
  static let ids = Tally(1000)

  static let declinedCopy =
    "The person chose not to run this. Nothing ran. Ask them in the conversation what they want; "
    + "do not retry on your own."
  static let noAnswerCopy =
    "Nobody answered within 60 s, so nothing ran. They may have stepped away. Ask them before "
    + "trying again."
  static let busyCopy = "Four commands are already running. Nothing ran. Wait for one to finish."
  static let cancelledCopy = "Cancelled. The command was stopped."
  static let instructionsCopy =
    "Runs a script with Cupertino's access, including Full Disk Access when Cupertino has it. The "
    + "person sees the full script and decides each run unless they have chosen otherwise. A "
    + "refusal means ask them in the conversation, not retry. Put related work in one script "
    + "rather than many small runs: each run can cost them a decision."

  /// The cooldown sentence, with the wait it names, or nil when `text` is not it.
  static func cooldownWait(_ text: String) -> Int? {
    let head =
      "The person turned down a command from this session a moment ago. Nothing ran, and "
      + "Cupertino will not ask again for another "
    let tail = " s. Ask them in the conversation first."
    guard text.hasPrefix(head), text.hasSuffix(tail) else { return nil }
    return Int(text.dropFirst(head.count).dropLast(tail.count))
  }

  static func frame(_ method: String, _ params: [String: Any]? = nil, id: Int) -> String {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
    if let params { message["params"] = params }
    let data = try! JSONSerialization.data(withJSONObject: message)
    return String(decoding: data, as: UTF8.self)
  }

  static func send(_ line: String, on connection: UUID?) -> [String: Any]? {
    guard let surface = Surface.named("shell"),
      let text = ShellServer.handle(line, surface: surface, connection: connection)
    else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
  }

  static func result(_ method: String, _ params: [String: Any]? = nil) -> [String: Any] {
    send(frame(method, params, id: ids.next()), on: conn)?["result"] as? [String: Any] ?? [:]
  }

  static func call(
    _ tool: String, _ args: [String: Any], on connection: UUID = conn, id: Int? = nil
  ) -> ToolAnswer {
    if tool == "apple_shell_run" { _ = requestsMade.next() }
    let line = frame(
      "tools/call", ["name": tool, "arguments": args], id: id ?? ids.next())
    let reply = send(line, on: connection) ?? [:]
    let result = reply["result"] as? [String: Any] ?? [:]
    let text = ((result["content"] as? [[String: Any]])?.first?["text"] as? String) ?? ""
    let isError = result["isError"] as? Bool ?? (reply["error"] != nil)
    let structured =
      isError
      ? [:] : ((try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:])
    return ToolAnswer(isError: isError, text: text, structured: structured, reply: reply)
  }

  /// A run on a connection of its own, so no approval or cooldown carries in.
  static func callFresh(_ args: [String: Any]) -> ToolAnswer {
    call("apple_shell_run", args, on: UUID())
  }

  static func shellRun(
    _ script: String = "true", on connection: UUID = conn, _ extra: [String: Any] = [:],
    id: Int? = nil
  ) -> ToolAnswer {
    var args: [String: Any] = ["script": script, "purpose": "p"]
    for (key, value) in extra { args[key] = value }
    return call("apple_shell_run", args, on: connection, id: id)
  }

  /// `run` on a thread of its own, for a call that has to be stopped from here.
  static func runAside(
    _ script: String, on connection: UUID = UUID(), id: Int? = nil
  ) -> (answer: () -> ToolAnswer?, done: DispatchSemaphore) {
    let done = DispatchSemaphore(value: 0)
    let box = AnswerBox()
    Thread.detachNewThread {
      box.set(shellRun(script, on: connection, id: id))
      done.signal()
    }
    return ({ box.get() }, done)
  }

  static func toolNames() -> [String] {
    (result("tools/list")["tools"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
      .sorted()
  }

  static func tool(_ name: String) -> [String: Any] {
    (result("tools/list")["tools"] as? [[String: Any]] ?? []).first {
      $0["name"] as? String == name
    }
      ?? [:]
  }

  static func annotations(_ name: String) -> [String: Any] {
    tool(name)["annotations"] as? [String: Any] ?? [:]
  }

  /// Whether `condition` came true within `timeout`.
  static func eventually(_ timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      Thread.sleep(forTimeInterval: 0.02)
    }
    return condition()
  }

  /// `ShellServer` against a scratch defaults suite, a key held in memory, a record in a scratch
  /// folder and a fake window. The app's own defaults, Keychain and `shell-runs` are never touched.
  static func serverChecks() throws {
    print("\nShellServer: the tools, behind the policy, the seal and the record")
    let suite = "shell-check-server"
    let store = UserDefaults(suiteName: suite)!
    store.removePersistentDomain(forName: suite)
    defer { store.removePersistentDomain(forName: suite) }
    ShellSeal.domain = suite
    ShellSeal.source = MemoryKey()
    ShellServer.defaults = store
    let recordDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("shell-server-check-\(UUID())")
    defer { try? FileManager.default.removeItem(at: recordDir) }
    ShellRecord.directory = recordDir
    ShellServer.fullDiskAccess = { true }
    ShellServer.clientName = { _ in "check-client" }
    let marker = scratch("must-not-exist")
    defer { try? FileManager.default.removeItem(atPath: marker) }
    let exists = { FileManager.default.fileExists(atPath: marker) }
    let touch = "touch \(marker)"

    // Before any window is wired in, which is every build until the app sets its own.
    let probe = ShellPrompt(
      client: "c", purpose: "p", script: "true", stdin: nil, interpreter: .zsh, cwd: "/",
      timeoutSeconds: 60, offerSession: false, connection: UUID(), requestId: "i1")
    check(
      "with no window wired in, the stand-in answers cancelled",
      ShellServer.consent.ask(probe) == .cancelled)
    let standIn = shellRun(touch, on: UUID())
    check(
      "so nothing runs in a build that cannot ask",
      standIn.isError && standIn.text == cancelledCopy && !exists())
    ShellSeal.setBefore(.none, store)
    let standInNone = shellRun(touch, on: UUID())
    check(
      "nor under a sealed Don't ask, with no card to show",
      standInNone.isError && standInNone.text == cancelledCopy && !exists()
        && ShellServer.inFlight == 0)
    ShellSeal.setBefore(.ask, store)

    let fake = FakeConsent()
    ShellServer.consent = fake

    let initialize = result("initialize")
    check(
      "the server that answers is cupertino-shell",
      (initialize["serverInfo"] as? [String: Any])?["name"] as? String == "cupertino-shell")
    check(
      "the instructions, verbatim", initialize["instructions"] as? String == instructionsCopy)
    check(
      "tools/list has run and diagnostics",
      toolNames() == ["apple_shell_diagnostics", "apple_shell_run"])
    check(
      "run's annotations",
      annotations("apple_shell_run")["destructiveHint"] as? Bool == true
        && annotations("apple_shell_run")["openWorldHint"] as? Bool == true
        && annotations("apple_shell_run")["readOnlyHint"] as? Bool == false)
    check(
      "diagnostics is read-only",
      annotations("apple_shell_diagnostics")["readOnlyHint"] as? Bool == true)
    let schema = tool("apple_shell_run")["inputSchema"] as? [String: Any] ?? [:]
    let properties = schema["properties"] as? [String: Any] ?? [:]
    check(
      "run takes the spec's parameters, script and purpose required",
      Set(properties.keys) == [
        "script", "purpose", "interpreter", "cwd", "stdin", "timeoutSeconds",
      ]
        && Set(schema["required"] as? [String] ?? []) == ["script", "purpose"])
    check(
      "the interpreters on offer",
      (properties["interpreter"] as? [String: Any])?["enum"] as? [String]
        == ["zsh", "bash", "python3", "node", "osascript", "jxa"])
    let resources = (result("resources/list")["resources"] as? [[String: Any]] ?? [])
      .compactMap { $0["uri"] as? String }
    check(
      "the guide reads back",
      resources.contains("cupertino://shell/guide")
        && ((result("resources/read", ["uri": "cupertino://shell/guide"])["contents"]
          as? [[String: Any]])?.first?["text"] as? String)?.isEmpty == false
    )

    print("\nShellServer: asking")
    fake.next = .runOnce
    let ok = call("apple_shell_run", ["script": "echo hi", "purpose": "p"])
    check(
      "approved run returns output",
      ok.isError == false && ok.structured["stdout"] as? String == "hi\n"
        && ok.structured["decision"] as? String == "approved")
    check(
      "the result carries the spec's fields",
      Set(ok.structured.keys) == [
        "decision", "exitCode", "signal", "timedOut", "durationMs", "stdout", "stdoutTruncated",
        "stderr", "stderrTruncated",
      ] && ok.structured["exitCode"] as? Int == 0 && ok.structured["signal"] is NSNull)
    let shown = fake.prompts.last
    check(
      "the window is handed the whole request",
      shown?.script == "echo hi" && shown?.purpose == "p" && shown?.interpreter == .zsh
        && shown?.cwd == NSHomeDirectory() && shown?.timeoutSeconds == 60 && shown?.stdin == nil
        && shown?.offerSession == false && shown?.connection == conn
        && shown?.client == "check-client")
    fake.next = .dontRun
    let declined = call("apple_shell_run", ["script": touch, "purpose": "p"])
    check("declined is an error and runs nothing", declined.isError && !exists())
    check("declined, verbatim", declined.text == declinedCopy)
    let cooled = call("apple_shell_run", ["script": "true", "purpose": "p"])
    check("cooldown refuses without asking", cooled.isError && fake.asks == 2)
    check(
      "cooldown, verbatim, with the wait in whole seconds",
      cooldownWait(cooled.text).map { (1...30).contains($0) } == true)

    fake.next = .noAnswer
    let quiet = UUID()
    let unanswered = shellRun(touch, on: quiet)
    check(
      "no answer is an error, verbatim, and runs nothing",
      unanswered.isError && unanswered.text == noAnswerCopy && !exists())
    let asksAfterQuiet = fake.asks
    check(
      "no answer cools the connection down too",
      cooldownWait(shellRun(on: quiet).text) != nil && fake.asks == asksAfterQuiet)

    print("\nShellServer: the arguments")
    fake.next = .runOnce
    check(
      "tilde cwd expanded",
      callFresh(["script": "pwd", "purpose": "p", "cwd": "~"]).structured["stdout"] as? String
        == NSHomeDirectory() + "\n")
    check(
      "an absolute cwd is honoured",
      callFresh(["script": "pwd -P", "purpose": "p", "cwd": "/private/tmp"]).structured["stdout"]
        as? String == "/private/tmp\n")
    check(
      "stdin delivered",
      callFresh(["script": "cat", "purpose": "p", "stdin": "abc"]).structured["stdout"] as? String
        == "abc")
    check(
      "an interpreter by name",
      callFresh(["script": "echo ${BASH_VERSION:+bash}", "purpose": "p", "interpreter": "bash"])
        .structured["stdout"] as? String == "bash\n")
    let failed = callFresh(["script": "echo no >&2; exit 3", "purpose": "p"])
    check(
      "a failing script is a result, not an error",
      !failed.isError && failed.structured["exitCode"] as? Int == 3
        && failed.structured["stderr"] as? String == "no\n")
    let timed = callFresh(["script": "sleep 5", "purpose": "p", "timeoutSeconds": 1])
    check(
      "a timeout is reported",
      !timed.isError && timed.structured["timedOut"] as? Bool == true
        && timed.structured["exitCode"] is NSNull && timed.structured["signal"] as? String != nil)

    let asksBeforeInvalid = fake.asks
    check(
      "relative cwd refused", callFresh(["script": "pwd", "purpose": "p", "cwd": "tmp"]).isError)
    check(
      "a cwd that does not exist refused",
      callFresh(["script": "pwd", "purpose": "p", "cwd": "/nonexistent-\(getpid())"]).isError)
    check(
      "a cwd that is a file refused",
      callFresh(["script": "pwd", "purpose": "p", "cwd": "/etc/hosts"]).isError)
    check("missing purpose refused", callFresh(["script": "true"]).isError)
    check("blank purpose refused", callFresh(["script": "true", "purpose": "  \n"]).isError)
    check("missing script refused", callFresh(["purpose": "p"]).isError)
    check("empty script refused", callFresh(["script": "", "purpose": "p"]).isError)
    check(
      "script over 512 KB refused, connection fine",
      callFresh(["script": String(repeating: "a", count: 600_000), "purpose": "p"]).isError
        && !shellRun("true", on: UUID()).isError)
    check(
      "a script of exactly 512 KB is not refused for its size",
      !callFresh(["script": "#" + String(repeating: "a", count: 512 * 1024 - 1), "purpose": "p"])
        .isError)
    check(
      "purpose over 500 chars refused",
      callFresh(["script": "true", "purpose": String(repeating: "p", count: 501)]).isError)
    check(
      "timeout out of range refused",
      callFresh(["script": "true", "purpose": "p", "timeoutSeconds": 601]).isError
        && callFresh(["script": "true", "purpose": "p", "timeoutSeconds": 0]).isError)
    check(
      "a timeout that is not a whole number refused",
      callFresh(["script": "true", "purpose": "p", "timeoutSeconds": 1.5]).isError
        && callFresh(["script": "true", "purpose": "p", "timeoutSeconds": "60"]).isError
        && callFresh(["script": "true", "purpose": "p", "timeoutSeconds": true]).isError)
    check(
      "an unknown interpreter refused",
      callFresh(["script": "true", "purpose": "p", "interpreter": "fish"]).isError)
    check(
      "stdin that is not a string refused",
      callFresh(["script": "cat", "purpose": "p", "stdin": 5]).isError)
    // One more for the size check above, which ran a valid script to prove the connection.
    check(
      "no refused request opened a window", fake.asks == asksBeforeInvalid + 2)

    print("\nShellServer: once per session")
    ShellSeal.setBefore(.session, store)
    fake.next = .runForSession
    let a = UUID()
    _ = shellRun(on: a)
    let before = fake.asks
    check("the window offers the session", fake.prompts.last?.offerSession == true)
    let again = shellRun(on: a)
    check(
      "session approval skips the window",
      again.isError == false && fake.asks == before && fake.notices == 1
        && again.structured["decision"] as? String == "approvedForSession")
    check("and the card ends with the run", fake.ended == 1)
    let b = UUID()
    fake.next = .dontRun
    _ = shellRun(on: b)
    check("a session approval does not cross connections", fake.asks == before + 1)
    ShellServer.connectionClosed(a)
    fake.next = .runOnce
    check(
      "closing the connection ends the approval",
      {
        _ = shellRun(on: a)
        return fake.asks == before + 2
      }())
    ShellServer.connectionClosed(b)
    check(
      "closing the connection ends its cooldown",
      {
        _ = shellRun(on: b)
        return fake.asks == before + 3
      }())
    ShellSeal.setBefore(.ask, store)
    fake.next = .runForSession
    let c = UUID()
    _ = shellRun(on: c)
    let asksAfterAsk = fake.asks
    _ = shellRun(on: c)
    check(
      "under Ask every time a session answer approves only that run",
      fake.asks == asksAfterAsk + 1 && fake.prompts.last?.offerSession == false)

    print("\nShellServer: Don't ask")
    ShellSeal.setBefore(.none, store)
    let asksBeforeNone = fake.asks
    let noticesBeforeNone = fake.notices
    let free = shellRun("echo free", on: UUID())
    check(
      "a sealed Don't ask runs without the window, with the card",
      !free.isError && free.structured["stdout"] as? String == "free\n"
        && free.structured["decision"] as? String == "notAsked" && fake.asks == asksBeforeNone
        && fake.notices == noticesBeforeNone + 1)
    check("and the card ends with the run", fake.ended == fake.notices)
    let sealedNone = store.string(forKey: ShellSeal.beforeSealKey)
    store.removeObject(forKey: ShellSeal.beforeSealKey)
    _ = shellRun(on: UUID())
    check("an unsealed Don't ask still asks", fake.asks == asksBeforeNone + 1)
    store.set(sealedNone, forKey: ShellSeal.beforeSealKey)

    print("\nShellServer: four at once")
    let slow = (0..<4).map { _ in runAside("sleep 1.5") }
    check("four runs in flight", eventually { ShellServer.inFlight == 4 })
    let asksBeforeBusy = fake.asks
    let busy = shellRun(on: UUID())
    check(
      "a fifth is refused, verbatim, without asking",
      busy.isError && busy.text == busyCopy && fake.asks == asksBeforeBusy)
    check(
      "diagnostics count the runs in flight",
      call("apple_shell_diagnostics", [:]).structured["inFlight"] as? Int == 4)
    for (_, done) in slow { done.wait() }
    check("the four all ran", slow.allSatisfy { $0.answer()?.isError == false })
    check("their slots come back", ShellServer.inFlight == 0)

    print("\nShellServer: stopping")
    let noticesBeforeStop = fake.notices
    let carded = runAside("sleep 30")
    let cardShown = eventually {
      fake.notices == noticesBeforeStop + 1 && ShellServer.inFlight == 1
    }
    let stopStart = Date()
    fake.stop?()
    let stoppedFromCard = carded.done.wait(timeout: .now() + 5) == .success
    check(
      "Stop on the card ends the run as cancelled",
      cardShown && stoppedFromCard && carded.answer()?.text == cancelledCopy
        && Date().timeIntervalSince(stopStart) < 3)

    let switchedOff = runAside("sleep 30")
    let offRunning = eventually { ShellServer.inFlight == 1 }
    ShellServer.stopAll()
    check(
      "stopAll cancels a run in flight",
      offRunning && switchedOff.done.wait(timeout: .now() + 5) == .success
        && switchedOff.answer()?.text == cancelledCopy)

    // A cancel that reaches `InProcessCalls` before the call registers, and a client that hung up
    // first: nothing is asked and nothing runs, under "Don't ask" where nothing else would stop it.
    let early = UUID()
    InProcessCalls.cancel(connection: early, requestId: "i900")
    let earlyAnswer = shellRun(touch, on: early, id: 900)
    check(
      "a cancel that beats the call: nothing runs, and it says cancelled",
      earlyAnswer.isError && earlyAnswer.text == cancelledCopy && !exists())
    let gone = UUID()
    InProcessCalls.cancelAll(connection: gone)
    let goneAnswer = shellRun(touch, on: gone)
    check(
      "a hang-up that beats the call: nothing runs",
      goneAnswer.isError && goneAnswer.text == cancelledCopy && !exists())
    InProcessCalls.forget(connection: early)
    InProcessCalls.forget(connection: gone)

    ShellSeal.setBefore(.ask, store)
    let asksBeforeEarly = fake.asks
    let earlyAsk = UUID()
    InProcessCalls.cancel(connection: earlyAsk, requestId: "i901")
    let earlyAskAnswer = shellRun(touch, on: earlyAsk, id: 901)
    check(
      "a cancel that beats the window: nothing is asked",
      earlyAskAnswer.text == cancelledCopy && fake.asks == asksBeforeEarly && !exists())
    InProcessCalls.forget(connection: earlyAsk)

    fake.hold = true
    let held = UUID()
    let waiting = runAside(touch, on: held, id: 902)
    let windowUp = fake.waiting.wait(timeout: .now() + 5) == .success
    InProcessCalls.cancel(connection: held, requestId: "i902")
    check(
      "a cancel while the window waits closes it, and nothing runs",
      windowUp && waiting.done.wait(timeout: .now() + 5) == .success
        && waiting.answer()?.text == cancelledCopy && !exists())
    let heldAgain = runAside(touch)
    let windowAgain = fake.waiting.wait(timeout: .now() + 5) == .success
    ShellServer.stopAll()
    check(
      "stopAll closes a waiting window, and nothing runs",
      windowAgain && heldAgain.done.wait(timeout: .now() + 5) == .success
        && heldAgain.answer()?.text == cancelledCopy && !exists())
    fake.hold = false

    fake.next = .runOnce
    let approved = UUID()
    let long = runAside("sleep 30", on: approved, id: 903)
    let longRunning = eventually { ShellServer.inFlight == 1 }
    let cancelStart = Date()
    InProcessCalls.cancel(connection: approved, requestId: "i903")
    check(
      "a cancel mid-run stops it",
      longRunning && long.done.wait(timeout: .now() + 5) == .success
        && long.answer()?.text == cancelledCopy && Date().timeIntervalSince(cancelStart) < 3)
    InProcessCalls.forget(connection: approved)
    check(
      "nothing is left registered",
      InProcessCalls.held(connection: approved)?.running ?? 0 == 0
        && InProcessCalls.held(connection: held)?.running ?? 0 == 0)

    print("\nShellServer: diagnostics")
    let diagnostics = call("apple_shell_diagnostics", [:]).structured
    let interpreters = diagnostics["interpreters"] as? [String: Any] ?? [:]
    check("before is the effective setting", diagnostics["before"] as? String == "ask")
    check(
      "fullDiskAccess comes from the injected check", diagnostics["fullDiskAccess"] as? Bool == true
    )
    check(
      "every interpreter is listed, a path or null",
      Set(interpreters.keys) == Set(ShellRunner.Interpreter.allCases.map(\.rawValue))
        && interpreters.values.allSatisfy {
          ($0 as? String)?.hasPrefix("/") == true || $0 is NSNull
        }
        && (interpreters["zsh"] as? String)?.hasPrefix("/") == true)
    check("nothing in flight", diagnostics["inFlight"] as? Int == 0)
    check("the record is intact", diagnostics["recordIntact"] as? Bool == true)
    store.set("none", forKey: ShellPolicy.key)
    check(
      "an unsealed Don't ask reads as ask there too",
      call("apple_shell_diagnostics", [:]).structured["before"] as? String == "ask")
    ShellSeal.setBefore(.ask, store)

    print("\nShellServer: the record")
    let secret = "SHELL-CHECK-\(getpid())"
    fake.next = .runOnce
    // `conn` turned a command down at the start; closing it lifts the cooldown.
    ShellServer.connectionClosed(conn)
    let recorded = shellRun("echo \(secret)", on: conn)
    ShellRecord.flushForCheck()
    let entries = ShellRecord.recent(1000, in: recordDir)
    check("every request is on the record", entries.count == requestsMade.count)
    check(
      "every decision is recorded by its name",
      Set(entries.map(\.decision)) == [
        .approved, .approvedForSession, .notAsked, .declined, .noAnswer, .cooldown, .busy,
        .cancelled, .invalid,
      ])
    let line = entries.first
    check(
      "a run's line: who, what, where and how it ended",
      recorded.structured["stdout"] as? String == "\(secret)\n" && line?.decision == .approved
        && line?.client == "check-client" && line?.connection == conn && line?.purpose == "p"
        && line?.interpreter == "zsh" && line?.cwd == NSHomeDirectory()
        && line?.scriptBytes == "echo \(secret)".utf8.count
        && line?.scriptSHA256 == AuditChain.digest("echo \(secret)") && line?.exitCode == 0
        && line?.timedOut == false && line?.durationMs != nil)
    let onFile = try FileManager.default.contentsOfDirectory(
      at: recordDir, includingPropertiesForKeys: nil
    ).map { try String(contentsOf: $0, encoding: .utf8) }.joined()
    check("no script text or output on file", !onFile.contains(secret))
    check("the chain verifies", ShellRecord.verify(in: recordDir).isIntact)

    // The activity log needs nothing of its own: `serveInProcess` hands every in-process frame to
    // `RequestObserver`, which records it through `CallCapture`. These are the rules it applies.
    print("\nShellServer: through the activity log")
    let request =
      try JSONSerialization.jsonObject(
        with: Data(
          frame(
            "tools/call", ["name": "apple_shell_run", "arguments": ["script": "echo \(secret)"]],
            id: 1
          ).utf8)) as? [String: Any]
    check(
      "the script is in the call's arguments, under the payloads switch",
      CallCapture.arguments(
        params: request?["params"] as? [String: Any], mode: .arguments, content: false)?
        .contains(secret) == true
        && CallCapture.arguments(
          params: request?["params"] as? [String: Any], mode: .off, content: false) == nil
    )
    check(
      "stdout is in the result, kept only under the content switch",
      CallCapture.result(recorded.reply, mode: .argumentsAndResults, content: false)
        == CallCapture.redacted
        && CallCapture.result(recorded.reply, mode: .argumentsAndResults, content: true)?
          .contains(secret) == true
    )

    check("nothing left live after the server checks", ShellRunner.live.isEmpty)
  }
}

/// One answer handed from a thread of its own.
final class AnswerBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: ToolAnswer?
  func set(_ answer: ToolAnswer) { lock.withLock { value = answer } }
  func get() -> ToolAnswer? { lock.withLock { value } }
}

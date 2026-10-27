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

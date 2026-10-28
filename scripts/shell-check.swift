import CoreGraphics
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

  /// What the Shell pane decides: which way a switch goes, when a sheet is needed, and what a
  /// line of the run record says. Against a scratch suite and a key held in memory, as
  /// `sealChecks` is.
  static func paneChecks() {
    print("\nShellPane: the switches, \"Before running\" and the recent runs")
    let suite = "shell-check-pane"
    let store = UserDefaults(suiteName: suite)!
    store.removePersistentDomain(forName: suite)
    defer { store.removePersistentDomain(forName: suite) }
    ShellSeal.domain = suite
    ShellSeal.source = MemoryKey()

    typealias Step = ShellPane.SwitchStep
    check(
      "off, asked on: the sheet",
      ShellPane.switchStep(isOn: false, wantsOn: true, sealProblem: nil) == Step.confirmOn)
    check(
      "off, asked on with no seal to be had: stays off, says why",
      ShellPane.switchStep(isOn: false, wantsOn: true, sealProblem: "x") == Step.cannotSeal)
    check(
      "on, asked off: off at once, with no sheet",
      ShellPane.switchStep(isOn: true, wantsOn: false, sealProblem: nil) == Step.turnOff)
    check(
      "and a seal problem does not stand in the way of off",
      ShellPane.switchStep(isOn: true, wantsOn: false, sealProblem: "x") == Step.turnOff)
    check(
      "asked for what is in force: nothing",
      ShellPane.switchStep(isOn: true, wantsOn: true, sealProblem: nil) == Step.none
        && ShellPane.switchStep(isOn: false, wantsOn: false, sealProblem: nil) == Step.none)

    // A forged plain value is not "on" to a switch: it still draws off, and asking for on
    // still needs the sheet.
    store.set(true, forKey: ShellSeal.enabledKey)
    let forgedOn = ShellSeal.isEnabled(store)
    check(
      "a forged \"Shell is on\" draws off, and asking on still opens the sheet",
      !forgedOn
        && ShellPane.switchStep(isOn: forgedOn, wantsOn: true, sealProblem: nil) == Step.confirmOn)

    typealias Before = ShellPane.BeforeStep
    check(
      "ask to once per session applies at once",
      ShellPane.beforeStep(current: .ask, chosen: .session) == Before.apply(.session))
    check(
      "once per session to ask applies at once",
      ShellPane.beforeStep(current: .session, chosen: .ask) == Before.apply(.ask))
    check(
      "Don't ask to ask applies at once",
      ShellPane.beforeStep(current: .none, chosen: .ask) == Before.apply(.ask))
    check(
      "Don't ask needs the warning, from either",
      ShellPane.beforeStep(current: .ask, chosen: .none) == Before.confirmDontAsk
        && ShellPane.beforeStep(current: .session, chosen: .none) == Before.confirmDontAsk)
    check(
      "the setting in force: nothing",
      ShellPolicy.Before.allCases.allSatisfy {
        ShellPane.beforeStep(current: $0, chosen: $0) == Before.none
      })
    ShellSeal.setEnabled(true, store)
    store.set("none", forKey: ShellPolicy.key)
    let forgedNone = ShellSeal.effectiveBefore(store)
    check(
      "a forged Don't ask shows as ask, and choosing Don't ask still needs the warning",
      forgedNone == .ask
        && ShellPane.beforeStep(current: forgedNone, chosen: .none) == Before.confirmDontAsk)

    // A build with no application identifier of its own, as this binary is: the reason is
    // found before anybody confirms a sheet for a seal that could never hold. No Keychain call
    // is made for it: there is no access group to query.
    ShellSeal.source = ShellSeal.Keychain()
    let problem = ShellPane.sealProblem()
    check("with no access group, the pane has a reason Shell cannot go on", problem != nil)
    check(
      "and the switch stays off",
      ShellPane.switchStep(isOn: false, wantsOn: true, sealProblem: problem) == Step.cannotSeal)
    ShellSeal.source = MemoryKey()

    let hash = AuditChain.digest("echo hi")
    let base = ShellRecord.Entry(
      at: Date(), client: "Claude Code", connection: UUID(), purpose: "List the folder.",
      interpreter: "zsh", cwd: "/", scriptBytes: 7, scriptSHA256: hash, stdinBytes: nil,
      stdinSHA256: nil, decision: .approved, exitCode: 0, signal: nil, timedOut: false,
      durationMs: 12)
    let ran = ShellPane.row(base)
    check(
      "a run: client, decision and exit code",
      ran.client == "Claude Code" && ran.decision == "Approved" && ran.outcome == "exit 0")
    check(
      "the first 12 hex digits of the hash",
      hash.count == 64 && ran.hash.count == 12 && hash.hasPrefix(ran.hash))
    check("purpose is the help text", ran.help == "List the folder.")
    var failed = base
    failed.exitCode = 2
    check("a failing exit code is shown", ShellPane.row(failed).outcome == "exit 2")
    var declined = base
    declined.decision = .declined
    declined.exitCode = nil
    declined.durationMs = nil
    check(
      "a refusal says so, and that nothing ran",
      ShellPane.row(declined).decision == "Declined"
        && ShellPane.row(declined).outcome == "did not run")
    var timedOut = base
    timedOut.exitCode = nil
    timedOut.signal = "SIGTERM"
    timedOut.timedOut = true
    check("a timeout says timed out", ShellPane.row(timedOut).outcome == "timed out")
    var killed = base
    killed.exitCode = nil
    killed.signal = "SIGKILL"
    killed.decision = .cancelled
    check("a signal is named", ShellPane.row(killed).outcome == "ended by SIGKILL")
    var unstarted = base
    unstarted.exitCode = nil
    check(
      "an approved run with no exit says so", ShellPane.row(unstarted).outcome == "no exit code")
    var cutShort = unstarted
    cutShort.started = true
    cutShort.runId = UUID()
    check(
      "a started line with no outcome says so",
      ShellPane.row(cutShort).outcome == "no outcome recorded")

    let decisions: [ShellRecord.Decision] = [
      .approved, .approvedForSession, .notAsked, .declined, .noAnswer, .cooldown, .busy,
      .cancelled, .invalid,
    ]
    let labels = decisions.map(ShellPane.label)
    check("every decision has a label of its own", Set(labels).count == decisions.count)
    check("twenty runs are listed", ShellPane.recentLimit == 20)

    let copy =
      labels
      + ShellPolicy.Before.allCases.flatMap {
        [ShellPane.Copy.choice($0), ShellPane.Copy.caption($0)]
      }
      + [
        ShellPane.Copy.enableTitle, ShellPane.Copy.enableBody, ShellPane.Copy.enableSafeguard,
        ShellPane.Copy.enableConfirm, ShellPane.Copy.dontAskTitle, ShellPane.Copy.dontAskBody,
        ShellPane.Copy.dontAskCard, ShellPane.Copy.dontAskConfirm, ShellPane.Copy.cancel,
        ShellPane.Copy.sealProblem, ShellPane.Copy.beforeLabel, ShellPane.Copy.recentTitle,
        ShellPane.Copy.recentEmpty, ShellPane.Copy.recentFooter,
      ]
    check("no em dash in the pane's copy", !copy.contains { $0.contains("\u{2014}") })
    check(
      "the three choices, in the spec's words",
      ShellPolicy.Before.allCases.map(ShellPane.Copy.choice)
        == ["Ask every time", "Ask once per session", "Don't ask"])
    check(
      "the Don't ask warning names the injection risk",
      ShellPane.Copy.dontAskBody.contains("web page")
        && ShellPane.Copy.dontAskBody.contains("only safeguard"))
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
      stdinBytes: 3, stdinSHA256: AuditChain.digest("abc"),
      decision: .declined, exitCode: nil, signal: nil, timedOut: false, durationMs: nil)
    ShellRecord.append(e, in: dir, now: t0)
    e.decision = .approved
    e.exitCode = 0
    ShellRecord.append(e, in: dir, now: t0)
    ShellRecord.drain()
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
    let drained = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("shell-record-drain-\(UUID())")
    defer { try? FileManager.default.removeItem(at: drained) }
    ShellRecord.append(e, in: drained, now: t0)
    ShellRecord.drain()
    check(
      "drain lands a queued line before it returns, for quit",
      ((try? FileManager.default.contentsOfDirectory(atPath: drained.path)) ?? []).count == 1)
    check("chain verifies", ShellRecord.verify(in: dir).isIntact)
    let old = Calendar(identifier: .gregorian).date(byAdding: .day, value: -200, to: t0)!
    e.at = old
    ShellRecord.append(e, in: dir, now: old)
    e.at = t0
    ShellRecord.append(e, in: dir, now: t0)
    ShellRecord.drain()
    check(
      "a segment older than 90 days is dropped",
      try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 1)
    check("the chain still verifies after the drop", ShellRecord.verify(in: dir).isIntact)
    check("an entry reads back whole", ShellRecord.recent(1, in: dir) == [e])
    check(
      "stdin's length and hash read back",
      ShellRecord.recent(1, in: dir).first.map {
        $0.stdinBytes == 3 && $0.stdinSHA256 == AuditChain.digest("abc")
      } == true)
    var noStdin = e
    noStdin.stdinBytes = nil
    noStdin.stdinSHA256 = nil
    ShellRecord.append(noStdin, in: dir, now: t0)
    check("no stdin reads back as none", ShellRecord.recent(1, in: dir) == [noStdin])

    let next = Calendar(identifier: .gregorian).date(byAdding: .day, value: 10, to: t0)!
    ShellRecord.append(e, in: dir, now: next)
    ShellRecord.drain()
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
    ShellRecord.drain()
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

    print("\nShellRecord: a run's started line and its outcome")
    let pairs = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("shell-record-pairs-\(UUID())")
    defer { try? FileManager.default.removeItem(at: pairs) }
    // A line written before runs had an id, as every line on file before 2026-10-28 is.
    var legacy = e
    legacy.decision = .declined
    legacy.runId = nil
    ShellRecord.append(legacy, in: pairs, now: t0)
    // A run whose parent died mid-run: its started line and nothing after.
    var orphan = e
    orphan.decision = .notAsked
    orphan.exitCode = nil
    orphan.durationMs = nil
    orphan.runId = UUID()
    orphan.started = true
    ShellRecord.append(orphan, in: pairs, now: t0)
    var begun = orphan
    begun.decision = .approved
    begun.runId = UUID()
    ShellRecord.append(begun, in: pairs, now: t0)
    var ended = begun
    ended.started = false
    ended.exitCode = 0
    ended.durationMs = 5
    ShellRecord.append(ended, in: pairs, now: t0)
    ShellRecord.drain()
    let paired = ShellRecord.recent(in: pairs)
    check(
      "a started line and its outcome read back as one entry, the outcome",
      paired.count == 3 && paired.first == ended)
    check(
      "a started line with no outcome reads back as started",
      paired.count == 3 && paired[1] == orphan && paired[1].started)
    check(
      "a line from before run ids still reads back",
      paired.count == 3 && paired[2] == legacy && paired[2].runId == nil)
    check(
      "every line is on file, and the chain verifies",
      ShellRecord.verify(in: pairs).records == 4 && ShellRecord.verify(in: pairs).isIntact)
    check(
      "the limit counts entries, not lines",
      ShellRecord.recent(1, in: pairs) == [ended] && ShellRecord.recent(2, in: pairs).count == 2)
  }

  static func main() throws {
    // As the app does in `ServerHost.start`. A spawned script must not inherit it.
    _ = signal(SIGPIPE, SIG_IGN)

    sealChecks()
    keychainChecks()
    try recordChecks()
    inputChecks()
    promptQueueChecks()

    print("\nShellRunner: the command line and the environment")
    check(
      "env has only the base keys",
      Set(ShellRunner.baseEnvironment(home: "/h", user: "u", tmp: "/t").keys)
        == ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "PATH"])
    check(
      "env values",
      ShellRunner.baseEnvironment(home: "/h", user: "u", tmp: "/t", path: ["/p", "/q"])
        == [
          "HOME": "/h", "USER": "u", "LOGNAME": "u", "SHELL": "/bin/zsh", "TMPDIR": "/t",
          "LANG": "en_US.UTF-8", "PATH": "/p:/q",
        ])
    check(
      "PATH is the system's search path by default",
      ShellRunner.baseEnvironment(home: "/h", user: "u", tmp: "/t")["PATH"]
        == ShellRunner.searchPath().joined(separator: ":"))

    try searchPathChecks()
    try startupFileChecks()
    try scriptDeliveryChecks()

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

    print("\nShellRunner: interpreters through zsh, with no startup files")
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
        "\(i) runs through zsh with no startup files",
        try run(script, i).stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "42")
    }
    try serverChecks()
    check("nothing left live at the end", ShellRunner.live.isEmpty)

    paneChecks()

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

extension ShellCheck {
  /// A scratch folder standing in for `/` or for a home folder, emptied first.
  static func scratchFolder(_ name: String) throws -> String {
    let path = scratch(name)
    try? FileManager.default.removeItem(atPath: path)
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
  }

  static func write(_ text: String, to path: String, mode: Int = 0o644) throws {
    try FileManager.default.createDirectory(
      atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try text.write(toFile: path, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: path)
  }

  /// PATH from root-owned files only, read the way `path_helper` reads them, and finding an
  /// interpreter on it without starting anything. A lookup that started a shell would run
  /// whatever a same-user process put in that shell's startup files.
  static func searchPathChecks() throws {
    print("\nShellRunner: the search path, from /etc only")
    let root = try scratchFolder("root")
    defer { try? FileManager.default.removeItem(atPath: root) }
    check(
      "no /etc/paths falls back to the four system folders",
      ShellRunner.searchPath(root: root) == ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    try write("\n  \n", to: root + "/etc/paths")
    check(
      "an /etc/paths that lists nothing, with nothing else, falls back too",
      ShellRunner.searchPath(root: root) == ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    try FileManager.default.removeItem(atPath: root + "/etc/paths")
    try write("/x\n", to: root + "/etc/paths.d/extra")
    check(
      "and /etc/paths.d still follows the fallback",
      ShellRunner.searchPath(root: root) == ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/x"])

    try write("/a\n/b\n\n/a\n", to: root + "/etc/paths")
    try write("/c\n/b\n", to: root + "/etc/paths.d/b-file")
    try write("/d\n", to: root + "/etc/paths.d/a-file")
    try write("/e", to: root + "/etc/paths.d/10-x")
    try write("/f\n", to: root + "/etc/paths.d/100-y")
    try FileManager.default.removeItem(atPath: root + "/etc/paths.d/extra")
    check(
      "/etc/paths, then /etc/paths.d by file name, each folder once",
      ShellRunner.searchPath(root: root) == ["/a", "/b", "/e", "/f", "/d", "/c"])

    try FileManager.default.createDirectory(
      atPath: root + "/opt/homebrew/bin", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      atPath: root + "/usr/local/bin", withIntermediateDirectories: true)
    check(
      "Homebrew's folders follow, only those that exist",
      ShellRunner.searchPath(root: root)
        == ["/a", "/b", "/e", "/f", "/d", "/c", "/opt/homebrew/bin", "/usr/local/bin"])
    try write("/usr/local/bin\n/a\n/b\n", to: root + "/etc/paths")
    check(
      "and a folder already listed keeps its place",
      ShellRunner.searchPath(root: root)
        == ["/usr/local/bin", "/a", "/b", "/e", "/f", "/d", "/c", "/opt/homebrew/bin"])

    let systemPaths = ((try? String(contentsOfFile: "/etc/paths", encoding: .utf8)) ?? "")
      .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    if !systemPaths.isEmpty {
      check(
        "this Mac's search path starts with its /etc/paths",
        Array(ShellRunner.searchPath().prefix(systemPaths.count)) == systemPaths)
    }

    print("\nShellRunner: finding an interpreter starts nothing")
    // The first lookup of each in this process, so none is answered from the cache. A watcher
    // looks at `live` throughout: a lookup through `start` would show there while it ran.
    let stop = Tally()
    let seen = Tally()
    let watched = DispatchSemaphore(value: 0)
    Thread {
      while stop.count == 0 {
        if !ShellRunner.live.isEmpty { _ = seen.next() }
      }
      watched.signal()
    }.start()
    var found: [ShellRunner.Interpreter: String] = [:]
    for i in ShellRunner.Interpreter.allCases { found[i] = ShellRunner.resolve(i) }
    _ = stop.next()
    watched.wait()
    check("resolving every interpreter starts no process", seen.count == 0)
    check("zsh is found", found[.zsh]?.hasSuffix("/zsh") == true)
    check(
      "jxa is found as osascript", found[.osascript] != nil && found[.jxa] == found[.osascript])

    // Nothing else in the fake root, so only the fake folders are searched.
    for gone in ["/opt", "/usr", "/etc/paths.d"] {
      try FileManager.default.removeItem(atPath: root + gone)
    }
    let bin1 = root + "/bin1"
    let bin2 = root + "/bin2"
    try write("/nowhere\n\(bin1)\n\(bin2)\n", to: root + "/etc/paths")
    try write("#!/bin/sh\n", to: bin1 + "/osascript", mode: 0o755)
    try write("#!/bin/sh\n", to: bin2 + "/osascript", mode: 0o755)
    try write("not executable\n", to: bin1 + "/python3")
    try write("#!/bin/sh\n", to: bin2 + "/python3", mode: 0o755)
    try FileManager.default.createDirectory(
      atPath: bin1 + "/node", withIntermediateDirectories: true)
    let fake = ShellRunner.searchPath(root: root)
    check("the fake path is the fake /etc's alone", fake == ["/nowhere", bin1, bin2])
    check(
      "a fake /etc's path finds the fake interpreter placed there, the first one",
      ShellRunner.find(ShellRunner.Interpreter.jxa.command, in: fake) == bin1 + "/osascript")
    check(
      "a file that is not executable is passed over",
      ShellRunner.find("python3", in: fake) == bin2 + "/python3")
    check("a folder is not an interpreter", ShellRunner.find("node", in: fake) == nil)
    check(
      "a relative entry is never searched",
      ShellRunner.find("osascript", in: ["bin1", ""]) == nil)
  }

  /// A run reads none of the shell startup files in its home folder: `~/.zshenv` and the rest
  /// are writable by any process running as the person, and the window never shows them.
  static func startupFileChecks() throws {
    print("\nShellRunner: no shell startup files")
    let home = try scratchFolder("home")
    defer { try? FileManager.default.removeItem(atPath: home) }
    let files = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]
    for file in files { try write("touch \(home)/read\(file)\n", to: home + "/" + file) }
    for i in [ShellRunner.Interpreter.zsh, .bash] {
      let outcome = try ShellRunner.start(
        .init(
          script: "echo $HOME", interpreter: i, cwd: URL(fileURLWithPath: "/"), stdin: nil,
          timeout: 10),
        home: home
      ).wait()
      let read = files.filter { FileManager.default.fileExists(atPath: home + "/read" + $0) }
      check("a \(i) run gets the home folder it was given", outcome.stdout == home + "\n")
      check(
        "and reads none of its startup files"
          + (read.isEmpty ? "" : " (read \(read.joined(separator: ", ")))"),
        read.isEmpty)
      for file in read { try? FileManager.default.removeItem(atPath: home + "/read" + file) }
    }

    // python3 imports `site` unless it is isolated: every `import` line of a `.pth` file in the
    // user site-packages runs, and so does `usercustomize`. And a `-c` script has the current
    // folder first on `sys.path`, so a `json.py` planted there shadows the standard library's.
    // A process running as the person can write both places, Full Disk Access or not.
    print("\nShellRunner: python3 runs isolated")
    guard ShellRunner.resolve(.python3) != nil else {
      print("  skip python3 not installed")
      return
    }
    let fm = FileManager.default
    func zsh(_ script: String) throws -> ShellRunner.Outcome {
      try ShellRunner.start(
        .init(
          script: script, interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil,
          timeout: 30),
        home: home
      ).wait()
    }
    // Asked of the python3 a run finds, with the run's home folder.
    let userSite = try zsh("python3 -c 'import site; print(site.getusersitepackages())'")
      .stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    // Planted only in the scratch home: should a run ever stop getting it, the person's real
    // `~/Library/Python` would be written to, with nothing to clean it up.
    guard userSite.hasPrefix(home + "/") else {
      check("python3's user site-packages is in the scratch home (got \(userSite))", false)
      return
    }
    check("python3's user site-packages is in the scratch home", true)
    let pthMarker = home + "/read-pth"
    let customizeMarker = home + "/read-usercustomize"
    try write(
      "import os; open('\(pthMarker)', 'w').close()\n", to: userSite + "/shell-check.pth")
    try write("open('\(customizeMarker)', 'w').close()\n", to: userSite + "/usercustomize.py")

    // A `json.py` in the run's folder, where a `-c` script's `sys.path[0]` would point, and one
    // in its `$TMPDIR`, where scripts were written until 2026-10-28.
    let cwd = try scratchFolder("python-cwd")
    let tmp = try scratchFolder("python-tmp")
    defer {
      try? fm.removeItem(atPath: cwd)
      try? fm.removeItem(atPath: tmp)
    }
    let jsonMarker = home + "/read-json"
    for folder in [cwd, tmp] {
      try write("open('\(jsonMarker)', 'w').close()\n", to: folder + "/json.py")
    }

    // Without isolation, each plant runs: so the checks below are not vacuous.
    _ = try zsh("python3 -c pass")
    check(
      "a python3 that is not isolated runs the planted .pth and usercustomize",
      fm.fileExists(atPath: pthMarker) && fm.fileExists(atPath: customizeMarker))
    _ = try zsh("cd \(cwd) && python3 -c 'import json'")
    check("and imports a json.py from the folder it runs in", fm.fileExists(atPath: jsonMarker))
    for marker in [pthMarker, customizeMarker, jsonMarker] { try? fm.removeItem(atPath: marker) }

    let approved = try ShellRunner.start(
      .init(
        script: "import json; print(json.dumps(6*7))", interpreter: .python3,
        cwd: URL(fileURLWithPath: cwd), stdin: nil, timeout: 30),
      home: home, tmp: tmp
    ).wait()
    check("an approved python3 run still runs its script", approved.stdout == "42\n")
    check(
      "and runs no .pth and no usercustomize from the user site-packages",
      !fm.fileExists(atPath: pthMarker) && !fm.fileExists(atPath: customizeMarker))
    check(
      "and imports no json.py from its folder or its $TMPDIR", !fm.fileExists(atPath: jsonMarker))
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
  static let names = NameTable()
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
      "The person turned down a command from this client a moment ago. Nothing ran, and "
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

  /// The `decision` a result names in `structuredContent`, refusals included.
  static func decision(_ answer: ToolAnswer) -> String? {
    ((answer.reply["result"] as? [String: Any])?["structuredContent"] as? [String: Any])?[
      "decision"] as? String
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
    // A name of its own for each connection, as distinct clients have, so one connection's
    // cooldown does not reach the next; `names` gives several connections one name.
    ShellServer.clientName = { names.name($0) }
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
    check("a refusal names its decision beside the sentence", decision(standIn) == "cancelled")
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
    check(
      "structuredContent carries the same fields as the text",
      ((ok.reply["result"] as? [String: Any])?["structuredContent"] as? [String: Any])
        .map { NSDictionary(dictionary: $0).isEqual(to: ok.structured) } == true)
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
    check("declined, verbatim", declined.text == declinedCopy && decision(declined) == "declined")
    let cooled = call("apple_shell_run", ["script": "true", "purpose": "p"])
    check(
      "cooldown refuses without asking",
      cooled.isError && fake.asks == 2 && decision(cooled) == "cooldown")
    check(
      "cooldown, verbatim, with the wait in whole seconds",
      cooldownWait(cooled.text).map { (1...30).contains($0) } == true)

    fake.next = .noAnswer
    let quiet = UUID()
    let unanswered = shellRun(touch, on: quiet)
    check(
      "no answer is an error, verbatim, and runs nothing",
      unanswered.isError && unanswered.text == noAnswerCopy && !exists()
        && decision(unanswered) == "noAnswer")
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
      "a cwd under ~/ expanded",
      callFresh(["script": "pwd", "purpose": "p", "cwd": "~/Library"]).structured["stdout"]
        as? String == NSHomeDirectory() + "/Library\n")
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
    let noPurpose = callFresh(["script": "true"])
    check("missing purpose refused", noPurpose.isError && decision(noPurpose) == "invalid")
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
    check(
      "stdin over 256 KB refused",
      callFresh([
        "script": "cat", "purpose": "p", "stdin": String(repeating: "s", count: 256 * 1024 + 1),
      ])
      .isError)
    check(
      "stdin of exactly 256 KB is not refused for its size",
      !callFresh([
        "script": "wc -c", "purpose": "p", "stdin": String(repeating: "s", count: 256 * 1024),
      ])
      .isError)
    // For zsh the script is a C string in argv, which ends at the first NUL: the window and the
    // record would hold the whole text while only the part before it ran.
    check(
      "a NUL in the script refused",
      callFresh(["script": "echo shown\u{0}; \(touch)", "purpose": "p"]).isError && !exists())
    check(
      "a NUL in stdin refused",
      callFresh(["script": "cat", "purpose": "p", "stdin": "a\u{0}b"]).isError)
    // Three more: the size checks above each ran one valid request.
    check(
      "no refused request opened a window", fake.asks == asksBeforeInvalid + 3)

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
    let afterClose = shellRun(on: b)
    check(
      "closing the connection does not end its client's cooldown",
      decision(afterClose) == "cooldown" && fake.asks == before + 2)
    ShellSeal.setBefore(.ask, store)
    fake.next = .runForSession
    let c = UUID()
    _ = shellRun(on: c)
    let asksAfterAsk = fake.asks
    _ = shellRun(on: c)
    check(
      "under Ask every time a session answer approves only that run",
      fake.asks == asksAfterAsk + 1 && fake.prompts.last?.offerSession == false)

    // A person who moves away from "Ask once per session" withdraws every approval, even if
    // they move back before it would have run out.
    ShellSeal.setBefore(.session, store)
    ShellServer.beforeObserved(.session)
    fake.next = .runForSession
    let withdrawn = UUID()
    _ = shellRun(on: withdrawn)
    let asksApproved = fake.asks
    _ = shellRun(on: withdrawn)
    let stillApproved = fake.asks == asksApproved
    ShellSeal.setBefore(.ask, store)
    ShellServer.beforeObserved(.ask)
    ShellSeal.setBefore(.session, store)
    ShellServer.beforeObserved(.session)
    _ = shellRun(on: withdrawn)
    check(
      "switching away from once per session and back asks again",
      stillApproved && fake.asks == asksApproved + 1)
    // Approved again; this time the change is seen only by a request made under it.
    _ = shellRun(on: withdrawn)
    let reapproved = fake.asks
    ShellSeal.setBefore(.ask, store)
    fake.next = .runOnce
    _ = shellRun(on: UUID())
    ShellSeal.setBefore(.session, store)
    _ = shellRun(on: withdrawn)
    check(
      "a change seen first by a request withdraws it too", fake.asks == reapproved + 2)
    ShellSeal.setBefore(.ask, store)

    print("\nShellServer: a cooldown follows the client's name across connections")
    ShellSeal.setBefore(.ask, store)
    let first = UUID()
    let second = UUID()
    let elsewhere = UUID()
    names.set("Same Client", for: first, second)
    fake.next = .dontRun
    _ = shellRun(on: first)
    let asksAfterNo = fake.asks
    fake.next = .runOnce
    let retried = shellRun(touch, on: second)
    check(
      "a new connection under the same name is refused without asking",
      decision(retried) == "cooldown" && cooldownWait(retried.text) != nil
        && fake.asks == asksAfterNo && !exists())
    ShellServer.connectionClosed(first)
    ShellServer.connectionClosed(second)
    check(
      "and closing both connections does not lift it",
      decision(shellRun(on: UUID().named("Same Client"))) == "cooldown"
        && fake.asks == asksAfterNo)
    check(
      "another client is still asked",
      !shellRun(on: elsewhere).isError && fake.asks == asksAfterNo + 1)
    ShellServer.clock = { Date().addingTimeInterval(ShellPolicy.declineCooldown + 1) }
    check(
      "the name's cooldown expires on its own",
      !shellRun(on: UUID().named("Same Client")).isError && fake.asks == asksAfterNo + 2)
    ShellServer.clock = { Date() }
    fake.next = .noAnswer
    _ = shellRun(on: UUID().named("Quiet Client"))
    let asksAfterQuietName = fake.asks
    check(
      "no answer cools the name down too",
      decision(shellRun(on: UUID().named("Quiet Client"))) == "cooldown"
        && fake.asks == asksAfterQuietName)
    fake.next = .runOnce

    print("\nShellServer: at most four windows wait at once")
    fake.hold = true
    let windows = (0..<4).map { _ in runAside(touch) }
    let allUp = (0..<4).allSatisfy { _ in fake.waiting.wait(timeout: .now() + 5) == .success }
    let asksWithFour = fake.asks
    let fifth = shellRun(touch, on: UUID())
    check(
      "a fifth window is refused as busy, verbatim, and none opens",
      allUp && fifth.isError && fifth.text == busyCopy && decision(fifth) == "busy"
        && fake.asks == asksWithFour)
    ShellServer.stopAll()
    check(
      "the four waiting are answered when stopped",
      windows.allSatisfy { $0.done.wait(timeout: .now() + 5) == .success }
        && windows.allSatisfy { $0.answer()?.text == cancelledCopy } && !exists())
    fake.hold = false
    check(
      "once they are gone a window opens again",
      !shellRun(on: UUID()).isError && fake.asks == asksWithFour + 1)

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
      busy.isError && busy.text == busyCopy && fake.asks == asksBeforeBusy
        && decision(busy) == "busy")
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
    // Asked before `forget`, which would make the answer nil whatever was left.
    let approvedHeld = InProcessCalls.held(connection: approved)
    let heldHeld = InProcessCalls.held(connection: held)
    check(
      "nothing is left registered",
      approvedHeld?.running == 0 && heldHeld?.running == 0)
    InProcessCalls.forget(connection: approved)
    InProcessCalls.forget(connection: held)

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
    // `conn` turned a command down at the start, and its client is still cooling down.
    ShellServer.clock = { Date().addingTimeInterval(ShellPolicy.declineCooldown + 1) }
    let recorded = shellRun("echo \(secret)", on: conn)
    ShellServer.clock = { Date() }
    ShellRecord.drain()
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
    let fed = entries.first { $0.decision == .approved && $0.stdinBytes == 3 }
    check(
      "a run given stdin records its length and hash, not its text",
      fed?.stdinSHA256 == AuditChain.digest("abc") && line?.stdinBytes == nil
        && line?.stdinSHA256 == nil)
    check("the chain verifies", ShellRecord.verify(in: recordDir).isIntact)

    // A script that kills Cupertino, a crash or a force-quit must still leave a line: the
    // started line is on disk before the script starts, and the script reads it there.
    let freshDir = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("shell-server-started-\(UUID())")
    defer { try? FileManager.default.removeItem(at: freshDir) }
    ShellRecord.directory = freshDir
    let seen = shellRun(
      "/usr/bin/grep -h -c 'started\\\\\":true' \(freshDir.path)/*.jsonl", on: UUID())
    ShellRecord.drain()
    check(
      "the started line is on disk before the script runs",
      seen.structured["stdout"] as? String == "1\n")
    let freshLines = (try? FileManager.default.contentsOfDirectory(
      at: freshDir, includingPropertiesForKeys: nil))?.compactMap {
        try? String(contentsOf: $0, encoding: .utf8)
      }.joined().split(separator: "\n") ?? []
    let freshEntries = ShellRecord.recent(in: freshDir)
    check(
      "a run is two lines on file, and one entry with its outcome",
      freshLines.count == 2 && freshEntries.count == 1 && freshEntries.first?.exitCode == 0
        && freshEntries.first?.started == false && freshEntries.first?.runId != nil)
    let refusedDir = freshDir.appendingPathComponent("refused")
    ShellRecord.directory = refusedDir
    fake.next = .dontRun
    _ = shellRun("true", on: UUID())
    ShellRecord.drain()
    check(
      "a refusal is one line, with no started line",
      ShellRecord.verify(in: refusedDir).records == 1
        && ShellRecord.recent(in: refusedDir).first?.started == false)
    fake.next = .runOnce
    ShellRecord.directory = recordDir

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
    func parsed(_ text: String?) -> [String: Any]? {
      text.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
    func structure(_ text: String?) -> [String: Any] {
      parsed(text)?["structuredContent"] as? [String: Any] ?? [:]
    }
    let tool = "apple_shell_run"
    let live = CallCapture.result(
      recorded.reply, mode: .argumentsAndResults, content: false, tool: tool)
    let kept = structure(live)
    check(
      "without the content switch, a Shell result keeps the decision, exit and timing",
      kept["decision"] as? String == "approved" && kept["exitCode"] as? Int == 0
        && kept["signal"] is NSNull && kept["timedOut"] as? Bool == false
        && kept["durationMs"] as? Int != nil)
    check(
      "and redacts stdout and stderr, and the text",
      kept["stdout"] as? String == CallCapture.redacted
        && kept["stderr"] as? String == CallCapture.redacted
        && live?.contains(secret) == false)
    check(
      "a refusal keeps its decision there too",
      structure(
        CallCapture.result(busy.reply, mode: .argumentsAndResults, content: false, tool: tool))[
          "decision"] as? String == "busy")
    let withContent = CallCapture.result(
      recorded.reply, mode: .argumentsAndResults, content: true, tool: tool)
    check(
      "with the content switch, stdout is kept",
      structure(withContent)["stdout"] as? String == "\(secret)\n")
    check(
      "results are still kept only when results are recorded",
      CallCapture.result(recorded.reply, mode: .arguments, content: true, tool: tool) == nil)
    // On the way to disk the audit file redacts again, by its own switch. A row the window kept
    // whole must not take stdout to the file through `structuredContent`.
    let disk = CallCapture.reredactResult(withContent, tool: tool, content: false)
    check(
      "on disk without content: the decision stays and stdout goes",
      structure(disk)["decision"] as? String == "approved"
        && structure(disk)["exitCode"] as? Int == 0 && disk?.contains(secret) == false)
    check(
      "on disk with content: the row as it was",
      CallCapture.reredactResult(withContent, tool: tool, content: true) == withContent)
    // Every other tool records exactly what it did before, in both modes and on disk.
    let other: [String: Any] = [
      "jsonrpc": "2.0", "id": 4,
      "result": [
        "content": [["type": "text", "text": "a window list"]],
        "structuredContent": ["decision": "x", "stdout": "y"],
      ],
    ]
    for name in ["apple_screen_list_targets", "apple_mail_get_message", nil] as [String?] {
      let label = name ?? "no tool"
      check(
        "\(label): without content, the whole result is redacted, as before",
        CallCapture.result(other, mode: .argumentsAndResults, content: false, tool: name)
          == CallCapture.redacted)
      let whole = CallCapture.result(other, mode: .argumentsAndResults, content: true, tool: name)
      check(
        "\(label): with content, the whole result is kept, as before",
        whole == CallCapture.result(other, mode: .argumentsAndResults, content: true)
          && whole?.contains("a window list") == true)
      check(
        "\(label): on disk, the same as reredact",
        CallCapture.reredactResult(whole, tool: name, content: false)
          == CallCapture.reredact(whole, content: false)
          && CallCapture.reredactResult(whole, tool: name, content: true) == whole)
    }

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

// MARK: - The window's input and queue

extension ShellCheck {
  /// What `ShellPanel` lets through. Nothing here is posted: each event is only built and read,
  /// so no check moves the pointer or types on the Mac it runs on.
  static func inputChecks() {
    print("\nShellInput: only hardware input reaches the window")
    func key(_ state: CGEventSourceStateID?) -> CGEvent? {
      CGEvent(
        keyboardEventSource: state.flatMap { CGEventSource(stateID: $0) }, virtualKey: 36,
        keyDown: true)
    }
    check(
      "a keystroke from a combined-session source is not hardware",
      key(.combinedSessionState).map(ShellInput.isHardware) == false)
    check(
      "a keystroke from a private source is not hardware",
      key(.privateState).map(ShellInput.isHardware) == false)
    check(
      "a keystroke a process builds with a HID-state source is not hardware: it carries its pid",
      key(.hidSystemState).map(ShellInput.isHardware) == false)
    check(
      "a keystroke with no source is not hardware", key(nil).map(ShellInput.isHardware) == false)
    let click = CGEvent(
      mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: .leftMouseDown,
      mouseCursorPosition: .zero, mouseButton: .left)
    check("a click a process builds is not hardware", click.map(ShellInput.isHardware) == false)
    // The fields the rule reads, set as hardware's are expected to be.
    let forged = key(.hidSystemState)
    forged?.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    check("pid 0 and the HID state is hardware", forged.map(ShellInput.isHardware) == true)
    let pidOnly = key(.combinedSessionState)
    pidOnly?.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    check(
      "pid 0 from another state is not hardware", pidOnly.map(ShellInput.isHardware) == false)
  }

  static func prompt(_ connection: UUID = UUID(), _ requestId: String) -> ShellPrompt {
    ShellPrompt(
      client: "c", purpose: "p", script: "echo", stdin: nil, interpreter: .zsh, cwd: "/",
      timeoutSeconds: 60, offerSession: false, connection: connection, requestId: requestId)
  }

  /// `ask` on a thread of its own, with what it answered and when.
  final class Asked: @unchecked Sendable {
    private let lock = NSLock()
    private var answer: ShellPromptAnswer?
    private var at: Date?
    let done = DispatchSemaphore(value: 0)
    init(_ queue: ShellPromptQueue, _ prompt: ShellPrompt) {
      Thread.detachNewThread {
        let answer = queue.ask(prompt)
        self.lock.withLock {
          self.answer = answer
          self.at = Date()
        }
        self.done.signal()
      }
    }
    var result: ShellPromptAnswer? { lock.withLock { answer } }
    var answeredAt: Date? { lock.withLock { at } }
    func wait(_ seconds: TimeInterval = 5) -> ShellPromptAnswer? {
      _ = done.wait(timeout: .now() + seconds)
      return result
    }
  }

  static func promptQueueChecks() {
    print("\nShellPromptQueue: one window at a time, timed from when it shows")
    let changes = Tally()
    let timeout: TimeInterval = 0.4
    let queue = ShellPromptQueue(timeout: timeout, changed: { _ = changes.next() })

    // A cancel that beats its ask.
    let c1 = UUID()
    queue.cancel(connection: c1, requestId: "i1")
    let early = Date()
    check(
      "an ask whose cancel came first answers cancelled", queue.ask(prompt(c1, "i1")) == .cancelled)
    check("at once, with no window", Date().timeIntervalSince(early) < 0.1 && queue.front == nil)
    check("its tombstone is used up", queue.tombstones(c1) == 0)
    for n in 0..<40 { queue.cancel(connection: c1, requestId: "x\(n)") }
    check(
      "tombstones are capped per connection",
      queue.tombstones(c1) == ShellPromptQueue.tombstonesPerConnection)

    // A cancel for one connection does not reach another's request with the same id.
    let c2 = UUID()
    queue.cancel(connection: c1, requestId: "i7")
    let other = Asked(queue, prompt(c2, "i7"))
    check("another connection's ask with the same id is shown", eventually { queue.front != nil })
    if let front = queue.front { queue.answer(front.id, .runOnce) }
    check("and answered by the window", other.wait() == .runOnce)

    // A tombstone does not outlive the race it is for.
    let brief = ShellPromptQueue(timeout: timeout, tombstoneLife: 0.1)
    let c3 = UUID()
    brief.cancel(connection: c3, requestId: "i1")
    Thread.sleep(forTimeInterval: 0.25)
    let late = Asked(brief, prompt(c3, "i1"))
    check("a stale tombstone cancels nothing", eventually { brief.front != nil })
    if let front = brief.front { brief.answer(front.id, .dontRun) }
    check("so the window answers it", late.wait() == .dontRun)

    // Arrival order, and the timer.
    let before = changes.count
    let a = Asked(queue, prompt(UUID(), "a"))
    check("the first ask is in front", eventually { queue.front?.prompt.requestId == "a" })
    let b = Asked(queue, prompt(UUID(), "b"))
    check("the second waits behind it", eventually { queue.waiting == 2 })
    check("the front is still the first", queue.front?.prompt.requestId == "a")
    check("the front changing is announced", changes.count > before)
    Thread.sleep(forTimeInterval: timeout * 2)
    check("no timer runs before the window shows", a.result == nil && b.result == nil)
    guard let shownA = queue.front else { return check("a front to show", false) }
    let aShown = Date()
    queue.shown(shownA.id)
    queue.shown(shownA.id)
    check("unanswered, the shown window answers noAnswer", a.wait() == .noAnswer)
    check(
      "after the timeout from when it showed",
      (a.answeredAt?.timeIntervalSince(aShown) ?? 0) >= timeout * 0.95)
    check("the second comes to the front", eventually { queue.front?.prompt.requestId == "b" })
    Thread.sleep(forTimeInterval: timeout * 0.5)
    check("and has not timed out: it was waiting, not shown", b.result == nil)
    guard let shownB = queue.front else { return check("b in front", false) }
    let bShown = Date()
    queue.shown(shownB.id)
    check("it gets a full timeout of its own", b.wait() == .noAnswer)
    check(
      "measured from its own showing",
      (b.answeredAt?.timeIntervalSince(bShown) ?? 0) >= timeout * 0.95)
    check("nothing left", queue.front == nil && queue.waiting == 0)

    // Answers, and cancels of the front and of a queued ask.
    let d = Asked(queue, prompt(UUID(), "d"))
    check("d in front", eventually { queue.front?.prompt.requestId == "d" })
    let e2 = UUID()
    let e = Asked(queue, prompt(e2, "e"))
    let f = Asked(queue, prompt(UUID(), "f"))
    check("three waiting", eventually { queue.waiting == 3 })
    queue.answer(999_999, .runOnce)
    check("an answer for no window is ignored", queue.waiting == 3)
    queue.cancel(connection: e2, requestId: "e")
    check("a queued ask cancelled answers cancelled", e.wait() == .cancelled)
    check("and leaves the front alone", queue.front?.prompt.requestId == "d")
    check("no tombstone for a cancel that found its ask", queue.tombstones(e2) == 0)
    guard let frontD = queue.front else { return check("d in front", false) }
    queue.shown(frontD.id)
    queue.answer(frontD.id, .runForSession)
    check("the window's answer is the ask's", d.wait() == .runForSession)
    check("f comes to the front", eventually { queue.front?.prompt.requestId == "f" })
    if let frontF = queue.front {
      queue.shown(frontF.id)
      queue.cancel(connection: frontF.prompt.connection, requestId: "f")
    }
    check("a shown window cancelled answers cancelled", f.wait() == .cancelled)
    check("and the queue is empty", queue.front == nil && queue.waiting == 0)

    // With no screen, the window answers a request it could not show, and the queue moves on.
    let g = Asked(queue, prompt(UUID(), "g"))
    check("g in front", eventually { queue.front?.prompt.requestId == "g" })
    let h = Asked(queue, prompt(UUID(), "h"))
    check("h behind it", eventually { queue.waiting == 2 })
    if let frontG = queue.front { queue.answer(frontG.id, .cancelled) }
    check("a front answered before it showed is answered", g.wait() == .cancelled)
    check("and the next comes to the front", eventually { queue.front?.prompt.requestId == "h" })
    if let frontH = queue.front { queue.answer(frontH.id, .cancelled) }
    check("which can be answered the same way", h.wait() == .cancelled)
    check("leaving nothing waiting", queue.front == nil && queue.waiting == 0)
  }
}

// MARK: - How the script reaches the interpreter

extension ShellCheck {
  /// A run of `script` under `i`, with a scratch home and a scratch `$TMPDIR` of its own.
  static func runIn(
    _ script: String, _ i: ShellRunner.Interpreter, cwd: String = "/", tmp: String,
    timeout: TimeInterval = 30
  ) throws -> ShellRunner.Outcome {
    try ShellRunner.start(
      .init(
        script: script, interpreter: i, cwd: URL(fileURLWithPath: cwd), stdin: nil,
        timeout: timeout),
      tmp: tmp
    ).wait()
  }

  /// A script that searches its own `$TMPDIR` for `marker`, which its own text holds, and
  /// prints every file it finds and then `done`. A file the interpreter read the script from
  /// would hold the marker, so a run that prints only `done` had no such file while it ran.
  static func searchingScript(_ i: ShellRunner.Interpreter, marker: String) -> String {
    switch i {
    case .zsh, .bash:
      return "m='\(marker)'\n/usr/bin/grep -rlF -- \"$m\" \"$TMPDIR\"\necho done"
    case .python3:
      return """
        import os, subprocess
        m = '\(marker)'
        r = subprocess.run(['/usr/bin/grep', '-rlF', '--', m, os.environ['TMPDIR']],
                           capture_output=True, text=True)
        print(r.stdout + 'done')
        """
    case .node:
      return """
        const m = '\(marker)';
        const r = require('child_process').spawnSync(
          '/usr/bin/grep', ['-rlF', '--', m, process.env.TMPDIR], { encoding: 'utf8' });
        console.log(r.stdout + 'done');
        """
    case .osascript:
      return """
        set m to "\(marker)"
        set found to do shell script "/usr/bin/grep -rlF -- " & quoted form of m & " \\"$TMPDIR\\" || true"
        return found & "done"
        """
    case .jxa:
      return """
        const app = Application.currentApplication();
        app.includeStandardAdditions = true;
        const m = '\(marker)';
        app.doShellScript("/usr/bin/grep -rlF -- '" + m + "' \\"$TMPDIR\\" || true") + "done"
        """
    }
  }

  /// Several lines, both quote marks and a `$`, which must reach the interpreter as written.
  static func quotingScript(_ i: ShellRunner.Interpreter) -> String {
    switch i {
    case .zsh, .bash:
      return "a='it'\"'\"'s'\nb=\"say \\\"hi\\\"\"\nc='$HOME stays'\necho \"$a $b $c\""
    case .python3:
      return "a = \"it's\"\nb = 'say \"hi\"'\nc = '$HOME stays'\nprint(a, b, c)"
    case .node:
      return "const a = \"it's\";\nconst b = 'say \"hi\"';\nconst c = '$HOME stays';\n"
        + "console.log(a, b, c);"
    case .osascript:
      return "set a to \"it's\"\nset b to \"say \\\"hi\\\"\"\nset c to \"$HOME stays\"\n"
        + "return a & \" \" & b & \" \" & c"
    case .jxa:
      return "var a = \"it's\";\nvar b = 'say \"hi\"';\nvar c = '$HOME stays';\n"
        + "a + \" \" + b + \" \" + c"
    }
  }

  /// A script of exactly 512 KB, the request limit: one long comment, then 6*7.
  static func largestScript(_ i: ShellRunner.Interpreter) -> String {
    let (comment, body): (String, String) =
      switch i {
      case .zsh, .bash: ("#", "echo $((6*7))")
      case .python3: ("#", "print(6*7)")
      case .node: ("//", "console.log(6*7)")
      case .osascript: ("--", "return 6*7")
      case .jxa: ("//", "6*7")
      }
    let pad = ShellServer.maxScriptBytes - comment.utf8.count - body.utf8.count - 1
    return comment + String(repeating: "a", count: pad) + "\n" + body
  }

  /// Any same-user process can rewrite or rename a file between the moment it is written and
  /// the moment the interpreter reads it, Full Disk Access or not. The person would approve one
  /// text and another would run with every grant. So no interpreter is ever handed a path.
  static func scriptDeliveryChecks() throws {
    print("\nShellRunner: the script reaches the interpreter as an argument, never a file")
    check(
      "argv zsh",
      ShellRunner.argv(
        .init(
          script: "echo hi", interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil,
          timeout: 1)) == ["/bin/zsh", "-f", "-c", "--", "echo hi"])
    let wrapper = ["/bin/zsh", "-f", "-c", "exec \"$0\" \"$@\""]
    let expected: [ShellRunner.Interpreter: [String]] = [
      .bash: ["bash", "-c", "--", "S"],
      .python3: ["python3", "-I", "-c", "S"],
      .node: ["node", "--eval=S"],
      .osascript: ["osascript", "-e", "S"],
      .jxa: ["osascript", "-l", "JavaScript", "-e", "S"],
    ]
    for (i, tail) in expected.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
      check(
        "argv \(i)",
        ShellRunner.argv(
          .init(script: "S", interpreter: i, cwd: URL(fileURLWithPath: "/"), stdin: nil, timeout: 1)
        ) == wrapper + tail)
    }

    for i in ShellRunner.Interpreter.allCases {
      guard ShellRunner.resolve(i) != nil else {
        print("  skip \(i) not installed")
        continue
      }
      let tmp = try scratchFolder("tmp-\(i)")
      defer { try? FileManager.default.removeItem(atPath: tmp) }
      let marker = "SHELL-CHECK-MARK-\(UUID().uuidString)"
      let searched = try runIn(searchingScript(i, marker: marker), i, tmp: tmp)
      check(
        "\(i): no file under $TMPDIR holds the script while it runs"
          + (searched.stdout == "done\n" ? "" : " (got \(searched.stdout.debugDescription))"),
        searched.stdout == "done\n" && searched.exitCode == 0)
      let quoted = try runIn(quotingScript(i), i, tmp: tmp)
      check(
        "\(i): several lines, quotes and $ run as written",
        quoted.stdout == "it's say \"hi\" $HOME stays\n")
      let largest = try runIn(largestScript(i), i, tmp: tmp)
      check(
        "\(i): a 512 KB script runs",
        largest.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "42"
          && largest.exitCode == 0)
      check(
        "\(i): and leaves nothing in $TMPDIR",
        ((try? FileManager.default.contentsOfDirectory(atPath: tmp)) ?? []).isEmpty)
    }
    // A script that starts with a dash is still the script, not an option.
    for i in [ShellRunner.Interpreter.zsh, .bash] {
      check(
        "\(i): a script starting with a dash is not read as an option",
        try runIn("-x 2>/dev/null\necho ran", i, tmp: NSTemporaryDirectory()).stdout == "ran\n")
    }
    if ShellRunner.resolve(.node) != nil {
      check(
        "node: a script starting with a dash is not read as an option",
        try runIn("-1\nconsole.log('ran')", .node, tmp: NSTemporaryDirectory()).stdout
          == "ran\n")
    }
  }
}

/// The client name each connection reports, as `Sessions` would give it. Each connection has a
/// name of its own unless one is set; `ShellCheck.conn` is "check-client".
final class NameTable: @unchecked Sendable {
  private let lock = NSLock()
  private var table: [UUID: String] = [:]

  func name(_ connection: UUID) -> String {
    lock.withLock {
      if connection == ShellCheck.conn { return "check-client" }
      return table[connection] ?? "client \(connection.uuidString.prefix(8))"
    }
  }

  func set(_ name: String, for connections: UUID...) {
    lock.withLock { for connection in connections { table[connection] = name } }
  }
}

extension UUID {
  /// This connection, reporting `name` as its client.
  func named(_ name: String) -> UUID {
    ShellCheck.names.set(name, for: self)
    return self
  }
}

# Shell Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `shell` surface, served in-process by Cupertino, that runs a one-shot script under
Cupertino's grants after a person approves it in a window. The settings that lower that bar
cannot be forged by another process, and every request leaves a record.

**Architecture:**

- A pure policy (`ShellPolicy`) decides ask, run or refuse.
- A Foundation-only runner (`ShellRunner`) spawns `/bin/zsh -l -c` in its own process group, with
  capped output and a group kill.
- Two protected settings carry an HMAC seal whose key lives in the Keychain (`ShellSeal`).
- A chained, always-on file records each request (`ShellRecord`).
- `ShellServer` wires those to MCP, behind an injected consent protocol, so checks need no
  window.
- `ShellConsent` is the AppKit window, which accepts hardware input only.
- The shared in-process read loop learns `notifications/cancelled` and EOF, so a cancel stops a
  run.

**Tech Stack:** Swift 6 (AppKit + SwiftUI), Foundation, Security.framework, CryptoKit,
`posix_spawn`. The checks are `swiftc`-compiled scripts under `scripts/`, driven by `make` and run
in CI.

**Spec:** `docs/superpowers/specs/2026-10-27-shell-surface-design.md`. Read it first: the plan
argues from it and does not repeat its reasoning.

## Global Constraints

- Surface id `shell`, display name `Shell`, `kind: capability`, `runtime: swift`,
  `defaultEnabled: false`, `supportsWrites: false`, no gates, `storePermission:
full-disk-access`, `envPrefix: APPLE_SHELL_`, `iconPath:
/System/Applications/Utilities/Terminal.app`, `symbol: terminal`.
- Tools: `apple_shell_run`, `apple_shell_diagnostics`. `run` annotations: `destructiveHint: true`,
  `openWorldHint: true`.
- Interpreters: `zsh` (default), `bash`, `python3`, `node`, `osascript`, `jxa`. All start through
  `/bin/zsh -l -c`.
- `timeoutSeconds`: default 60, range 1…600. Output cap: 256 KB per stream. Kill grace: 2 s.
- Window answer timeout: 60 s. Decline cooldown: 30 s. Session approval: 30 min or until the
  connection closes. At most 4 runs in flight.
- Setting key `shell.before` = `ask` | `session` | `none`, default `ask`.
- A missing or invalid seal reads as Shell **off** and as **`ask`**. No launch argument can set
  either protected setting.
- Run record: one chained line per request, never the script text or output, 90-day retention,
  20 most recent shown in the pane.
- Shell is never offered to the Chat pane.
- Return and Escape in the window mean **Don't run**. The window and the confirming sheets drop
  input not from hardware.
- Copy follows the spec's fixed sentences. No em dashes in user-visible copy, as with the rest of
  the app's UI strings.
- Every new Swift file is Foundation-only unless its name is `ShellConsent.swift` or it is a view
  in `SurfaceDetail.swift`, so the checks can compile it without AppKit.
- The Xcode project uses synchronized groups: a new file under `apps/apple/Cupertino/` joins the
  target with no `project.pbxproj` edit. Any `make` check that compiles `ServerHost.swift` or
  `InProcessServers.swift` must have the new files added to its `swiftc` list (`host-check`,
  `dispatch-check`, and any other target the compiler names when it fails).
- Live checks on the real Mac that post events or take the foreground need Olivier's go first.
  This is a standing rule from memory.

## Review Focus

1. **A queued request's 60 s starts when its window is shown, not when it arrives.** With two
   connections asking at once, the second must not time out unseen behind the first. Test in Task 7.
2. **A script that reads stdin when none was given gets EOF at once and does not hang until the
   timeout.** Test in Task 2.
3. **Output that is not UTF-8 (binary, a cut multibyte sequence at the cap) comes back with
   replacement characters, not a crash or an empty string.** Test in Task 2.
4. **`cwd` given as `~/x` is expanded, and a relative path is refused with a message.** Test in
   Task 6.
5. **An oversized request gets an error instead of the connection closing.** A `script` over
   512 KB, or a `purpose` over 500 characters, is refused with `isError`. The transport's 1 MiB
   line limit (`InProcessRPC.nextLine`) would otherwise drop the connection with no message.
   Test in Task 6.

---

### Task 1: ShellPolicy, the pure decision

**Files:**

- Create: `apps/apple/Cupertino/ShellPolicy.swift`
- Modify: `Makefile` (`unit` target: add `apps/apple/Cupertino/ShellPolicy.swift` to the `swiftc` list)
- Test: `scripts/unit-check.swift` (new section after the `DrivingPolicy` one, around line 867)

**Interfaces:**

- Produces:

  ```swift
  nonisolated enum ShellPolicy {
    enum Before: String, CaseIterable, Sendable { case ask, session, none }
    enum Decision: Equatable { case run(notice: Bool), ask(timeout: TimeInterval, offerSession: Bool), declined(retryIn: TimeInterval), busy }
    static let key = "shell.before"
    static let askTimeout: TimeInterval = 60
    static let declineCooldown: TimeInterval = 30
    static let sessionLength: TimeInterval = 1800
    static let maxInFlight = 4
    static func decide(_ before: Before, sessionApprovedUntil: Date?, declinedUntil: Date?, inFlight: Int, now: Date) -> Decision
  }
  ```

  `before` is the **effective** value (Task 3 supplies it). This file never reads `UserDefaults`.

- [ ] **Step 1: Write the failing checks**

```swift
print("Shell policy: a cooldown outranks everything, a session never crosses into ask")
let t0 = Date(timeIntervalSince1970: 1_000_000)
func shell(_ b: ShellPolicy.Before, until: Date? = nil, declined: Date? = nil, inFlight: Int = 0) -> ShellPolicy.Decision {
  ShellPolicy.decide(b, sessionApprovedUntil: until, declinedUntil: declined, inFlight: inFlight, now: t0)
}
check("ask: window, no session button", shell(.ask) == .ask(timeout: 60, offerSession: false))
check("session: window offers the session button", shell(.session) == .ask(timeout: 60, offerSession: true))
check("session approved: runs, card shown", shell(.session, until: t0 + 10) == .run(notice: true))
check("session approval expired at 30 min asks again", shell(.session, until: t0) == .ask(timeout: 60, offerSession: true))
check("approval ignored once the setting is ask", shell(.ask, until: t0 + 10) == .ask(timeout: 60, offerSession: false))
check("none: runs, card shown", shell(.none) == .run(notice: true))
check("cooldown beats none", shell(.none, declined: t0 + 12) == .declined(retryIn: 12))
check("cooldown beats a session approval", shell(.session, until: t0 + 10, declined: t0 + 5) == .declined(retryIn: 5))
check("cooldown in the past is ignored", shell(.ask, declined: t0 - 1) == .ask(timeout: 60, offerSession: false))
check("fifth run is busy", shell(.none, inFlight: 4) == .busy)
check("fourth run is allowed", shell(.none, inFlight: 3) == .run(notice: true))
check("cooldown beats busy", shell(.none, declined: t0 + 3, inFlight: 4) == .declined(retryIn: 3))
```

- [ ] **Step 2: Run them and watch them fail**

Run: `make unit`
Expected: a compile failure on `ShellPolicy`.

- [ ] **Step 3: Implement `ShellPolicy.decide` in `ShellPolicy.swift`.** The order is cooldown,
      then busy, then `none`, then a live session approval (only while `before == .session`), then
      ask. Write a header comment in `DrivingPolicy.swift`'s style giving why the cooldown outranks
      `none` (the spec's "Cooldown" paragraph).

- [ ] **Step 4: Run `make unit`**
      Expected: every line `ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/Cupertino/ShellPolicy.swift scripts/unit-check.swift Makefile
git commit -m "feat(shell): the run-or-ask decision, as a pure function"
```

---

### Task 2: ShellRunner, spawn, cap, kill

**Files:**

- Create: `apps/apple/Cupertino/ShellRunner.swift`
- Modify: `apps/apple/Cupertino/ChildTermination.swift` (add the group variant)
- Create: `scripts/shell-check.swift`
- Modify: `Makefile`. Add a `shell-check` target (`ShellRunner.swift`, `ChildTermination.swift`,
  plus the later Shell files as Tasks 3, 4 and 6 add them) and add it to `.PHONY` and to the
  aggregate target that runs the other checks.
- Modify: `.github/workflows/ci.yml` (a `make shell-check` step beside `make sound-check`, around line 213)

**Interfaces:**

- Produces:
  ```swift
  nonisolated enum ShellRunner {
    enum Interpreter: String, CaseIterable, Sendable { case zsh, bash, python3, node, osascript, jxa }
    struct Request: Sendable { var script: String; var interpreter: Interpreter; var cwd: URL; var stdin: String?; var timeout: TimeInterval }
    struct Outcome: Sendable, Equatable {
      var exitCode: Int32?; var signal: String?; var timedOut: Bool; var cancelled: Bool; var durationMs: Int
      var stdout: String; var stdoutTruncated: Bool; var stderr: String; var stderrTruncated: Bool
    }
    final class Running: @unchecked Sendable {
      let pid: pid_t                      // also the process group id
      func cancel()                       // SIGTERM to the group, SIGKILL after killGrace
      func wait() -> Outcome              // blocks; idempotent
    }
    static let outputCap = 256 * 1024
    static let killGrace: TimeInterval = 2
    static func argv(_ request: Request, scriptFile: URL?) -> [String]
    static func baseEnvironment(home: String, user: String, tmp: String) -> [String: String]
    static func start(_ request: Request) throws -> Running
    static func resolve(_ interpreter: Interpreter) -> String?   // path via the login shell, nil if absent
    static var live: [Running] { get }                           // runs not yet waited out
  }
  extension ChildTermination { static func terminateGroups(_ pgids: [pid_t], grace: TimeInterval) }
  ```
- `argv` decides the command line, so pin it exactly:
  - zsh: `["/bin/zsh", "-l", "-c", script]`
  - everything else: `["/bin/zsh", "-l", "-c", "exec \"$0\" \"$@\"", <prefix…>, scriptFile.path]`
  - the prefix is `bash` / `python3` / `node` / `osascript`, and for `jxa` it is `osascript`,
    `-l`, `JavaScript`
- `baseEnvironment` keys: exactly `HOME`, `USER`, `LOGNAME`, `SHELL=/bin/zsh`, `TMPDIR`,
  `LANG=en_US.UTF-8`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.

- [ ] **Step 1: Write the failing checks** in `scripts/shell-check.swift`, in `unit-check.swift`'s
      `check(_:_:)` style, each run with `timeout: 10` unless stated otherwise:

```swift
func run(_ s: String, _ i: ShellRunner.Interpreter = .zsh, cwd: String = NSTemporaryDirectory(), stdin: String? = nil, timeout: TimeInterval = 10) throws -> ShellRunner.Outcome {
  try ShellRunner.start(.init(script: s, interpreter: i, cwd: URL(fileURLWithPath: cwd), stdin: stdin, timeout: timeout)).wait()
}
check("argv zsh", ShellRunner.argv(.init(script: "echo hi", interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil, timeout: 1), scriptFile: nil) == ["/bin/zsh", "-l", "-c", "echo hi"])
check("argv jxa", ShellRunner.argv(.init(script: "1", interpreter: .jxa, cwd: URL(fileURLWithPath: "/"), stdin: nil, timeout: 1), scriptFile: URL(fileURLWithPath: "/t/s")) == ["/bin/zsh", "-l", "-c", "exec \"$0\" \"$@\"", "osascript", "-l", "JavaScript", "/t/s"])
check("env has only the base keys", Set(ShellRunner.baseEnvironment(home: "/h", user: "u", tmp: "/t").keys) == ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "PATH"])
let a = try run("echo out; echo err >&2; exit 3")
check("exit code", a.exitCode == 3 && a.signal == nil && !a.timedOut)
check("stdout and stderr apart", a.stdout == "out\n" && a.stderr == "err\n")
check("cwd honoured", try run("pwd -P", cwd: "/private/tmp").stdout == "/private/tmp\n")
check("stdin delivered", try run("cat", stdin: "abc").stdout == "abc")
let noStdin = try run("cat; echo done", timeout: 5)
check("no stdin is EOF, not a hang", noStdin.stdout == "done\n" && !noStdin.timedOut)        // Review Focus 2
let big = try run("head -c 10000000 /dev/zero | tr '\\0' a")
check("capped at 256 KB", big.stdout.utf8.count == 262_144 && big.stdoutTruncated && big.exitCode == 0)
let bin = try run("printf '\\xff\\xfeok'; head -c 262143 /dev/zero | tr '\\0' a; printf '\\xc3\\xa9'")
check("non-UTF-8 survives as replacement characters", bin.stdout.hasPrefix("\u{FFFD}\u{FFFD}ok") && bin.stdoutTruncated)   // Review Focus 3
let slow = try run("sleep 100 & echo $! > \(NSTemporaryDirectory())shell-check.pid; wait", timeout: 1)
let orphan = pid_t(try String(contentsOfFile: NSTemporaryDirectory() + "shell-check.pid", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
check("timeout reported", slow.timedOut && slow.exitCode == nil && slow.signal != nil)
check("timeout killed the backgrounded grandchild", kill(orphan, 0) != 0)
let left = try run("sleep 100 & echo $! > \(NSTemporaryDirectory())shell-check.pid; echo started")
let stray = pid_t(try String(contentsOfFile: NSTemporaryDirectory() + "shell-check.pid", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
check("a leader that exits takes its stragglers with it", left.stdout == "started\n" && kill(stray, 0) != 0)
let r = try ShellRunner.start(.init(script: "sleep 30", interpreter: .zsh, cwd: URL(fileURLWithPath: "/"), stdin: nil, timeout: 60))
DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { r.cancel() }
let c = r.wait()
check("cancel stops it and says so", c.cancelled && !c.timedOut && c.durationMs < 5_000)
check("nothing left live", ShellRunner.live.isEmpty)
for i in [ShellRunner.Interpreter.python3, .node, .bash, .osascript, .jxa] {
  guard ShellRunner.resolve(i) != nil else { print("  skip \(i) not installed"); continue }
  let script = ["python3": "print(6*7)", "node": "console.log(6*7)", "bash": "echo $((6*7))", "osascript": "6*7", "jxa": "6*7"][i.rawValue]!
  check("\(i) runs through the login shell", try run(script, i).stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "42")
}
```

- [ ] **Step 2: Run `make shell-check`**
      Expected: a compile failure on `ShellRunner`.

- [ ] **Step 3: Implement `ShellRunner`.**
  - Spawn with `posix_spawn`, using `POSIX_SPAWN_SETPGROUP` with pgroup 0 and
    `POSIX_SPAWN_CLOEXEC_DEFAULT`, plus file actions for the three pipes (stdin from `/dev/null`
    when `stdin` is nil) and `posix_spawn_file_actions_addchdir_np` for `cwd`.
  - For non-zsh interpreters, write the script to a 0600 file under
    `FileManager.default.temporaryDirectory/cupertino-shell/` and remove it after `wait`.
  - Drain both pipes on their own threads, keeping the first `outputCap` bytes and discarding
    the rest. Decode with `String(decoding:as: UTF8.self)`, which replaces bad bytes.
  - On a timeout or a cancel, send `kill(-pgid, SIGTERM)`, then `SIGKILL` after `killGrace`.
  - When the leader exits on its own, send `kill(-pgid, SIGKILL)` to the stragglers before waiting
    for pipe EOF.
  - `resolve` runs `/bin/zsh -l -c 'command -v <name>'` once per interpreter and caches the result.
  - Keep `live` in an `NSLock`-guarded registry.
  - Implement `ChildTermination.terminateGroups`: SIGTERM to `-pgid`, wait up to `grace` while
    `kill(-pgid, 0) == 0`, then SIGKILL. The header gives the reason: `terminateAll` signals
    single pids and cannot reach a group.

- [ ] **Step 4: Run `make shell-check`**
      Expected: all `ok`, the skipped interpreters printed as `skip`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/Cupertino/ShellRunner.swift apps/apple/Cupertino/ChildTermination.swift scripts/shell-check.swift Makefile .github/workflows/ci.yml
git commit -m "feat(shell): run a script in its own process group, capped and killable"
```

---

### Task 3: ShellSeal, settings a program cannot forge

**Files:**

- Create: `apps/apple/Cupertino/ShellSeal.swift`
- Modify: `apps/apple/Cupertino/ServerHost.swift:1462` (`SurfaceSettings.isEnabled`: for `shell`, also require the seal)
- Modify: `Makefile` (`shell-check` list: add `ShellSeal.swift`)
- Test: `scripts/shell-check.swift`

**Interfaces:**

- Consumes: `ShellPolicy.Before`, `ShellPolicy.key` (Task 1); `KeyStore.read/write/delete` (`KeyStore.swift:49-83`).
- Produces:
  ```swift
  nonisolated enum ShellSeal {
    protocol KeySource: Sendable { func key() -> Data?; func rotate() -> Data? }  // rotate: new random 32 bytes, stored, returned
    struct Keychain: KeySource { }        // KeyStore account "shell-seal", base64; caches in memory
    static var source: KeySource          // Keychain() in the app; a check sets an in-memory one
    static let enabledSealKey = "shell.seal.enabled"
    static let beforeSealKey = "shell.seal.before"
    static func isEnabled(_ store: UserDefaults) -> Bool
    static func effectiveBefore(_ store: UserDefaults) -> ShellPolicy.Before
    static func setEnabled(_ on: Bool, _ store: UserDefaults)       // on: writes value + seal; off: removes both and rotates
    static func setBefore(_ before: ShellPolicy.Before, _ store: UserDefaults)  // none: writes value + seal; else: writes value, removes seal, rotates
  }
  ```
- The seal is a hex HMAC-SHA256 over `"\(BridgeProtocol.appIdentifier)|<preference key>|<value>"`.
  Values are read with `store.persistentDomain(forName: Bundle.main.bundleIdentifier!)` /
  `store.object(forKey:)` **excluding `NSArgumentDomain`**, which is how a launch argument is
  ignored. The builder confirms on the Debug build that `-shell.before none` on the command line
  does not reach the value read here.
- **Why it rotates:** the seal sits in a readable plist, so a process that copied it while Shell
  was on could write it back after the person turned Shell off. Rotating the key whenever a
  protected setting goes down makes any copied seal invalid. Put this in the file's header.

- [ ] **Step 1: Write the failing checks** (an in-memory `KeySource`, and a scratch
      `UserDefaults(suiteName:)` removed afterwards):

```swift
let store = UserDefaults(suiteName: "shell-check")!; store.removePersistentDomain(forName: "shell-check")
ShellSeal.source = MemoryKey()
check("fresh: off and ask", !ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .ask)
store.set(true, forKey: "surfaceEnabled.shell"); store.set("none", forKey: ShellPolicy.key)
check("forged plain values: still off and ask", !ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .ask)
ShellSeal.setEnabled(true, store); ShellSeal.setBefore(.none, store)
check("sealed: on and none", ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .none)
let copied = store.string(forKey: ShellSeal.enabledSealKey)
ShellSeal.setEnabled(false, store)
store.set(true, forKey: "surfaceEnabled.shell"); store.set(copied, forKey: ShellSeal.enabledSealKey)
check("a seal copied before turn-off does not validate after", !ShellSeal.isEnabled(store))
ShellSeal.setEnabled(true, store)
ShellSeal.setBefore(.session, store)
check("session needs no seal", ShellSeal.effectiveBefore(store) == .session)
store.set("garbage", forKey: ShellSeal.enabledSealKey)
check("bad seal reads off", !ShellSeal.isEnabled(store))
(ShellSeal.source as! MemoryKey).drop()
check("no key reads off and ask", !ShellSeal.isEnabled(store) && ShellSeal.effectiveBefore(store) == .ask)
```

- [ ] **Step 2: Run `make shell-check`**
      Expected: a compile failure on `ShellSeal`.

- [ ] **Step 3: Implement `ShellSeal`,** then make `SurfaceSettings.isEnabled` return
      `ShellSeal.isEnabled(.standard)` for `surface.id == "shell"`. Every other surface is unchanged.
      Add `ShellSeal.swift` to every `make` target whose `swiftc` list includes `ServerHost.swift`.
      The `Keychain` source uses `KeyStore` (whose service is already per bundle id, so the Debug key
      is separate) and caches the key so a request costs no Keychain call after the first.

- [ ] **Step 4: Run `make shell-check host-check dispatch-check unit`**
      Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/Cupertino/ShellSeal.swift apps/apple/Cupertino/ServerHost.swift scripts/shell-check.swift Makefile
git commit -m "feat(shell): seal the two settings that lower the bar, and rotate on the way down"
```

---

### Task 4: ShellRecord, the always-on run record

**Files:**

- Create: `apps/apple/Cupertino/ShellRecord.swift`
- Modify: `Makefile` (`shell-check` list: add `ShellRecord.swift`, `AuditChain.swift`)
- Test: `scripts/shell-check.swift`

**Interfaces:**

- Consumes: `AuditChain.Record`, `AuditChain.seal/line/verify/openingLink/genesis` (`AuditChain.swift:81-350`).
- Produces:
  ```swift
  nonisolated enum ShellRecord {
    enum Decision: String, Sendable { case approved, approvedForSession, notAsked, declined, noAnswer, cooldown, busy, cancelled, invalid }
    struct Entry: Sendable, Equatable {
      var at: Date; var client: String; var connection: UUID; var purpose: String
      var interpreter: String; var cwd: String; var scriptBytes: Int; var scriptSHA256: String
      var decision: Decision; var exitCode: Int32?; var signal: String?; var timedOut: Bool; var durationMs: Int?
    }
    static var directory: URL            // <Application Support>/<BridgeProtocol.appIdentifier>/shell-runs
    static let retentionDays = 90
    static func append(_ entry: Entry, in dir: URL = directory, now: Date = Date())
    static func recent(_ limit: Int = 20, in dir: URL = directory) -> [Entry]   // newest first
    static func verify(in dir: URL = directory) -> AuditChain.Verification
  }
  ```
- Files are monthly segments named `runs-YYYY-MM.jsonl`, each chain opening from the previous
  segment's head, as `AuditLog` does. Each line is an `AuditChain.Record` with:
  - `surface: "shell"`
  - `kind: .info`
  - `text`: the decision's raw value
  - `args`: the entry's other fields as sorted-key JSON

  A segment whose month ended more than `retentionDays` ago is deleted on `append`.

- `append` serialises through one serial `DispatchQueue` and never throws to its caller. A
  failure goes to the host log instead. It runs from server threads.

- [ ] **Step 1: Write the failing checks** (scratch directory):

```swift
let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("shell-record-check-\(UUID())")
let script = String(repeating: "a", count: 5000) + "SECRET"
var e = ShellRecord.Entry(at: t0, client: "c", connection: UUID(), purpose: "p", interpreter: "zsh", cwd: "/", scriptBytes: script.utf8.count, scriptSHA256: AuditChain.digest(script), decision: .declined, exitCode: nil, signal: nil, timedOut: false, durationMs: nil)
ShellRecord.append(e, in: dir, now: t0); e.decision = .approved; e.exitCode = 0; ShellRecord.append(e, in: dir, now: t0)
let text = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).map { try String(contentsOf: $0, encoding: .utf8) }.joined()
check("a refusal is a line too", ShellRecord.recent(in: dir).map(\.decision) == [.approved, .declined])
check("hash covers the part past 4 KB", ShellRecord.recent(in: dir)[0].scriptSHA256 == AuditChain.digest(script))
check("no script text on file", !text.contains("SECRET"))
check("chain verifies", ShellRecord.verify(in: dir).intact)   // use the Verification field AuditChain actually defines
let old = Calendar(identifier: .gregorian).date(byAdding: .day, value: -200, to: t0)!
e.at = old; ShellRecord.append(e, in: dir, now: old); e.at = t0; ShellRecord.append(e, in: dir, now: t0)
check("a segment older than 90 days is dropped", try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 1)
```

- [ ] **Step 2: Run `make shell-check`**
      Expected: a compile failure on `ShellRecord`.

- [ ] **Step 3: Implement `ShellRecord`.** Read `AuditLog.swift`'s segment code for the linking
      rule and reuse `AuditChain` as it is. Don't add a second hashing scheme. In tests, `append`
      flushes synchronously: give it an internal `sync` path, or have the check call a
      `flushForCheck()`. Pick one and keep it out of the app's call sites.

- [ ] **Step 4: Run `make shell-check`**
      Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/Cupertino/ShellRecord.swift scripts/shell-check.swift Makefile
git commit -m "feat(shell): a chained record of every request, whatever the log settings"
```

---

### Task 5: Cancellation and hang-up in the shared in-process loop

**Files:**

- Create: `apps/apple/Cupertino/InProcessCalls.swift`
- Modify: `apps/apple/Cupertino/ServerHost.swift:849-965` (`serveInProcess`)
- Modify: `Makefile` (add `InProcessCalls.swift` to every target compiling `ServerHost.swift` or `InProcessServers.swift`)
- Test: `scripts/host-check.swift`

**Interfaces:**

- Produces:
  ```swift
  nonisolated enum InProcessCalls {
    /// Register a canceller for one in-flight request. The returned token unregisters.
    static func register(connection: UUID, requestId: String, _ cancel: @escaping @Sendable () -> Void) -> Token
    static func cancel(connection: UUID, requestId: String)   // no-op for an unknown id
    static func cancelAll(connection: UUID)
    final class Token: Sendable { func done() }
    static func requestId(_ id: Any?) -> String?              // JSON-RPC id (Int or String) → stable String
  }
  ```
- New loop shape. The connection thread only reads. A per-connection worker `Thread` named
  `cupertino.session.worker` handles requests in order, and it carries
  `threadDictionary[DrivingSession.connectionKey] = session`, because `DrivingSession` reads it
  from the thread that handles the call.
  - Each line read is parsed just far enough to see `method`. For
    `notifications/cancelled`, call
    `InProcessCalls.cancel(connection: session, requestId: params.requestId)` at once, then
    enqueue the line like any other, so the observer still sees it.
  - On EOF, call `InProcessCalls.cancelAll(connection: session)`, close the queue and join the
    worker before the existing `defer` cleanup runs.
  - The worker keeps everything the old loop body did, in the same order:
    1. the switched-off check (which now stops the reader too)
    2. `observer.saw`
    3. `autoreleasepool { InProcessServers.handle }`
    4. `observer.answered`
    5. `writeAll`
  - Writes stay on the worker only.

- [ ] **Step 1: Write the failing host-check cases.** Use the check's existing socket harness
      and a test-only in-process surface hook. `InProcessServers.handle` gains no test branch:
      instead the check registers a canceller directly through `InProcessCalls` from a stub request
      handler. If the harness cannot inject a slow handler without a production hook, add
      `InProcessServers.testHandler` as a `nonisolated(unsafe) static var` that is nil in the app, and
      say so in a comment.

```swift
check("cancel for an unknown id is ignored", /* send notifications/cancelled id 99; connection stays open; next ping answers */)
check("cancel mid-call reaches the registered canceller", /* slow handler registers; send cancel; canceller ran within 1 s; reply arrives */)
check("EOF mid-call cancels every in-flight call", /* slow handler registers; close client fd; canceller ran within 1 s */)
check("requests still answered in order", /* two pings back to back answered 1 then 2 */)
check("driving connection key is set on the handling thread", /* handler reads Thread.current.threadDictionary[DrivingSession.connectionKey] != nil */)
```

Replace each comment with the harness calls. The assertion stays what the comment says.

- [ ] **Step 2: Run `make host-check`**
      Expected: the new cases FAIL or do not compile. Existing cases pass.

- [ ] **Step 3: Implement `InProcessCalls`** (an `NSLock`-guarded `[UUID: [String: canceller]]`)
      **and the reader/worker split in `serveInProcess`.** The worker's queue is an `NSCondition` and
      an array of lines. Keep `InProcessRPC.nextLine` as it is.

- [ ] **Step 4: Run `make host-check dispatch-check screen-check sound-check desktop-check simulator-check`**
      Expected: all pass, so Screen, Sound, Desktop and Simulator are unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/Cupertino/InProcessCalls.swift apps/apple/Cupertino/ServerHost.swift scripts/host-check.swift Makefile
git commit -m "feat(host): in-process surfaces hear notifications/cancelled and hang-up mid-call"
```

---

### Task 6: ShellServer and the manifest entry

**Files:**

- Modify: `surfaces.json`, then run `make surfaces`. This regenerates `Surfaces.swift`, the
  bridge `known` list, the Makefile regions, CI, the bundler map, `wiring-check` and the website
  union.
- Create: `apps/apple/Cupertino/ShellServer.swift`
- Modify: `apps/apple/Cupertino/InProcessServers.swift` (add `case "shell"`)
- Modify: `apps/apple/Cupertino/ServerHost.swift` (the `serveInProcess` defer: `ShellServer.connectionClosed(session)` beside `SoundCapture.connectionClosed`)
- Modify: `Makefile` (`shell-check` list: add `ShellServer.swift`, `InProcessRPC.swift`, `InProcessCalls.swift`, `Surfaces.swift` and whatever they need)
- Test: `scripts/shell-check.swift`, `scripts/dispatch-check.swift`

**Interfaces:**

- Consumes: Tasks 1–5.
- Produces:
  ```swift
  nonisolated enum ShellPromptAnswer: Sendable, Equatable { case runOnce, runForSession, dontRun, noAnswer, cancelled }
  nonisolated struct ShellPrompt: Sendable {
    var client: String; var purpose: String; var script: String; var stdin: String?
    var interpreter: ShellRunner.Interpreter; var cwd: String; var timeoutSeconds: Int
    var offerSession: Bool; var connection: UUID; var requestId: String
  }
  nonisolated protocol ShellConsenting: Sendable {
    func ask(_ prompt: ShellPrompt) -> ShellPromptAnswer   // blocks the calling (worker) thread
    func cancel(connection: UUID, requestId: String)
    func running(_ prompt: ShellPrompt, stop: @escaping @Sendable () -> Void) -> any ShellNoticeToken
  }
  nonisolated protocol ShellNoticeToken: Sendable { func ended() }
  nonisolated enum ShellServer {
    nonisolated(unsafe) static var consent: any ShellConsenting   // ShellConsent.shared in the app (Task 7); a fake in checks
    static var clientName: (UUID) -> String                       // Sessions lookup in the app; "a client" when unnamed
    static let maxScriptBytes = 512 * 1024
    static let maxPurposeChars = 500
    static func handle(_ line: String, surface: Surface, connection: UUID?) -> String?
    static func connectionClosed(_ connection: UUID)              // drops the session approval and cooldown
    static func stopAll()                                         // for "Shell switched off": cancel prompts and runs
  }
  ```
- `InProcessServers.handle` gets `case "shell": return reply(ShellServer.handle(line, surface: surface, connection: connection))`.
- The tool list does not depend on any gate. The surface switch is enforced by the host
  (`SurfaceSettings.isEnabled`, sealed in Task 3).
- Per-connection state lives in an `NSLock`-guarded `[UUID: (approvedUntil: Date?, declinedUntil: Date?)]`, plus an app-wide in-flight count.
- The call flow for `apple_shell_run`:
  1. Validate the arguments. Each failure returns `isError`, records `invalid`, and starts no
     window.
  2. Call `ShellPolicy.decide(ShellSeal.effectiveBefore(.standard), …)`.
  3. On `.ask`, register an `InProcessCalls` canceller that calls `consent.cancel`, then call
     `consent.ask`.
  4. `runForSession` sets `approvedUntil = now + 1800`. `dontRun` and `noAnswer` set
     `declinedUntil = now + 30`.
  5. On run, call `ShellRunner.start`, register a canceller that calls `running.cancel()`, call
     `consent.running(…)` when the decision was `.run(notice: true)`, then `wait`.
  6. Append a `ShellRecord` entry with the final decision. A cancel records `cancelled`.
  7. Answer.
- The refusal copy is exact, in the `DrivingSession.swift:208`/`:491` register:
  - declined: "The person chose not to run this. Nothing ran. Ask them in the conversation what
    they want; do not retry on your own."
  - no answer: "Nobody answered within 60 s, so nothing ran. They may have stepped away. Ask them
    before trying again."
  - cooldown: "The person turned down a command from this session a moment ago. Nothing ran, and
    Cupertino will not ask again for another N s. Ask them in the conversation first."
  - busy: "Four commands are already running. Nothing ran. Wait for one to finish."
  - cancelled: "Cancelled. The command was stopped."
- **The existing activity log needs no new code.** `serveInProcess`'s `RequestObserver` already
  records every in-process call and its reply under the existing capture and audit switches.
  Confirm in the check that a Shell call and its result reach `RequestObserver` the way a Screen
  call does, and that stdout sits in the result, where `auditContent` governs it. Add nothing
  beyond that.
- Diagnostics fields:
  - `before`, the effective value
  - `fullDiskAccess`, from the existing `Permissions` check the other diagnostics use
  - `interpreters`, as `{name: path|null}`
  - `inFlight`
  - `recordIntact`, from `ShellRecord.verify`
- Server instructions (exact):

  > Runs a script with Cupertino's access, including Full Disk Access when Cupertino has it. The
  > person sees the full script and decides each run unless they have chosen otherwise. A refusal
  > means ask them in the conversation, not retry. Put related work in one script rather than
  > many small runs: each run can cost them a decision.

- [ ] **Step 1: Write the failing checks** with a `FakeConsent` that returns scripted answers and
      counts calls, plus a sealed in-memory `ShellSeal.source`:

```swift
check("tools/list has run and diagnostics", toolNames() == ["apple_shell_diagnostics", "apple_shell_run"])
check("run's annotations", annotations("apple_shell_run")["destructiveHint"] as? Bool == true)
fake.next = .runOnce
let ok = call("apple_shell_run", ["script": "echo hi", "purpose": "p"])
check("approved run returns output", ok.isError == false && ok.structured["stdout"] as? String == "hi\n" && ok.structured["decision"] as? String == "approved")
fake.next = .dontRun
check("declined is an error and runs nothing", call("apple_shell_run", ["script": "touch /tmp/shell-check-must-not-exist", "purpose": "p"]).isError && !FileManager.default.fileExists(atPath: "/tmp/shell-check-must-not-exist"))
check("cooldown refuses without asking", call("apple_shell_run", ["script": "true", "purpose": "p"]).isError && fake.asks == 2)
check("tilde cwd expanded", callFresh(["script": "pwd", "purpose": "p", "cwd": "~"]).structured["stdout"] as? String == NSHomeDirectory() + "\n")      // Review Focus 4
check("relative cwd refused", callFresh(["script": "pwd", "purpose": "p", "cwd": "tmp"]).isError)
check("missing purpose refused", callFresh(["script": "true"]).isError)
check("script over 512 KB refused, connection fine", callFresh(["script": String(repeating: "a", count: 600_000), "purpose": "p"]).isError)  // Review Focus 5
check("purpose over 500 chars refused", callFresh(["script": "true", "purpose": String(repeating: "p", count: 501)]).isError)
check("timeout out of range refused", callFresh(["script": "true", "purpose": "p", "timeoutSeconds": 601]).isError)
seal(.session); fake.next = .runForSession
_ = callFresh(["script": "true", "purpose": "p"]); let before = fake.asks
check("session approval skips the window", call("apple_shell_run", ["script": "true", "purpose": "p"]).isError == false && fake.asks == before && fake.notices == 1)
ShellServer.connectionClosed(conn)
check("closing the connection ends the approval", { _ = call("apple_shell_run", ["script": "true", "purpose": "p"]); return fake.asks == before + 1 }())
check("every request is on the record", ShellRecord.recent(100, in: recordDir).count == requestsMade)
```

Write `call`, `callFresh` (a new connection UUID each time), `toolNames`, `annotations` and
`seal` as small helpers in the check, building JSON-RPC lines and feeding `ShellServer.handle`.
`ShellRecord.directory` points at a scratch directory for the check.
In `dispatch-check`, add: the `shell` surface is answered by `ShellServer` (its `serverInfo.name`
is `cupertino-shell`) and receives the connection id.

- [ ] **Step 2: Run `make surfaces shell-check dispatch-check`**
      Expected: a compile failure, or failures on the new cases.

- [ ] **Step 3: Implement `ShellServer`** on `InProcessRPC.dispatch` (`InProcessRPC.swift:47`),
      shaped like `ScreenServer`. Set `name: "cupertino-shell"` and pass the instructions above. Add
      the `surfaces.json` entry with the Global Constraints values, and give its `notes` a condensed
      version of the spec's risk paragraph.

- [ ] **Step 4: Run `make surfaces-check shell-check dispatch-check host-check unit readme-check`**
      Expected: all pass. If the README's Surfaces table needs a row, `readme-check` says so; add it.

- [ ] **Step 5: Commit**

```bash
git add surfaces.json apps/apple scripts Makefile .github apps/website/src/data/surfaces.ts README.md
git commit -m "feat(shell): the apple_shell_run tool, behind the policy, the seal and the record"
```

---

### Task 7: ShellConsent, the window, the card and teardown

**Files:**

- Create: `apps/apple/Cupertino/ShellConsent.swift` (AppKit + SwiftUI; the app's implementation of `ShellConsenting`)
- Modify: `apps/apple/Cupertino/CupertinoApp.swift` (at launch: `ShellServer.consent = ShellConsent.shared`, `ShellServer.clientName = { Sessions lookup }`; the menu bar gains "Stop running commands" while `ShellRunner.live` is non-empty)
- Modify: `apps/apple/Cupertino/ServerHost.swift:386` (beside `ChildTermination.terminateAll`: `ChildTermination.terminateGroups(ShellRunner.live.map(\.pid), grace: 3)`)
- Test: by hand on the Debug build (steps below), plus one automated check of the input filter

**Interfaces:**

- Consumes: `ShellConsenting`, `ShellPrompt`, `ShellPromptAnswer`, `ShellNoticeToken` (Task 6); `NoticeStyle` for the card's look.
- Produces:
  ```swift
  @MainActor final class ShellConsent: ShellConsenting {   // nonisolated entry points hop to main and block the worker with InProcessRPC.blocking
    static let shared: ShellConsent
  }
  nonisolated enum ShellInput {
    /// True only for an event that came from hardware. Decided from the CGEvent's source fields.
    static func isHardware(_ event: CGEvent) -> Bool
  }
  final class ShellPanel: NSPanel { }   // overrides sendEvent(_:) and drops any event failing ShellInput.isHardware
  ```
- Window content, order and copy: as the spec's "The confirmation window" section gives them,
  items 1–6.
  - **Don't run** is the default button and also gets the Escape key equivalent.
  - **Run once** and **Run, and stop asking this session** have no key equivalents.
  - The third button appears only when `prompt.offerSession`.
  - The script view is a non-editable, selectable `NSTextView` in monospaced font, inside a scroll
    view no taller than 60% of the screen.
- Queue: one window at a time, in arrival order. **The 60 s timer starts when the window is shown**
  (Review Focus 1). `cancel(connection:requestId:)` removes a queued prompt or closes the shown one
  and answers `.cancelled`.
- The card: a small non-activating panel reading "Running a command for <client>", with a
  **Stop** button that calls the `stop` closure. It stays for the life of the run, with no 30 s
  cap, and `ended()` removes it. When several runs are in flight, one card shows the count.
- Shell switched off: the switch's observer calls `ShellServer.stopAll()`, which closes every
  window with `.cancelled` and cancels every run.

- [ ] **Step 1: Measure what `isHardware` must test.**
  - With Olivier's go (it posts an event on the real Mac; see Global Constraints), log
    `eventSourceUnixProcessID` and `eventSourceStateID` for a real click and a real keystroke in a
    scratch panel.
  - Log the same for a `CGEvent` posted at `.cghidEventTap` by a separate process, and one posted
    by Cupertino itself.
  - Write the rule that separates them into `ShellInput.isHardware`'s doc comment with the
    measured values. The expected rule is source pid 0 and state id `.hidSystemState`; confirm it
    before relying on it.

- [ ] **Step 2: Write the failing check.** In `shell-check`, build a `CGEvent` with
      `CGEventSource(stateID: .combinedSessionState)` and check that `ShellInput.isHardware` is
      false. Add `ShellInput` to the `shell-check` list. It is `CoreGraphics` only, so put it in its
      own file `ShellInput.swift` if `ShellConsent.swift` would drag AppKit into the check.

- [ ] **Step 3: Run `make shell-check`**
      Expected: FAIL until `ShellInput` exists.

- [ ] **Step 4: Implement `ShellInput`, `ShellPanel`, `ShellConsent`, the card, the menu item,
      the launch wiring and the quit wiring.**

- [ ] **Step 5: Run `make shell-check` and `make app`**
      Expected: the check passes and the app builds.

- [ ] **Step 6: Check by hand on the Debug build.** Follow `use-the-dev-build`: Route B, `dev-mcp.mjs shell …`.
      Turn Shell on in the Debug app first (Task 8 adds the control; until then, seal it from a
      debugger or do this step after Task 8). Each of these is one tool call, and Olivier watches the
      screen:
  - the window shows the full script, a 200-line script scrolls, and `purpose` is labelled
  - Return declines, Escape declines, and a click on **Run once** runs it
  - no answer declines at 60 s
  - a second call within 30 s is refused with no window
  - two connections asking at once: the second window gets its full 60 s after the first closes
  - Esc in a real Claude Code session closes a waiting window, and stops a `sleep 120` run
  - quitting Cupertino mid-`sleep 120` leaves no `sleep` (`pgrep -f 'sleep 120'` prints nothing)

- [ ] **Step 7: Commit**

```bash
git add apps/apple/Cupertino/ShellConsent.swift apps/apple/Cupertino/ShellInput.swift apps/apple/Cupertino/CupertinoApp.swift apps/apple/Cupertino/ServerHost.swift scripts/shell-check.swift Makefile
git commit -m "feat(shell): the confirmation window, the running card, and nothing left at quit"
```

---

### Task 8: The Shell pane and the toggles

**Files:**

- Modify: `apps/apple/Cupertino/SurfaceDetail.swift` (a `ShellControls` view beside `DrivingPolicyControl`, shown when `surface.id == "shell"`, around line 364)
- Modify: `apps/apple/Cupertino/SurfaceDetail.swift:43`, `MainWindow.swift:702`, `CupertinoApp.swift:939` (the three surface switches)
- Modify: `apps/apple/Cupertino/ChatPane.swift:38` (`picks` excludes `shell`)
- Test: by hand on the Debug build, and the forging test

**Interfaces:**

- Consumes: `ShellSeal.setEnabled/setBefore/isEnabled/effectiveBefore` (Task 3), `ShellRecord.recent` (Task 4), `ShellServer.stopAll` (Task 6), `ShellPanel` (Task 7) for the sheets.
- Behaviour:
  - **Turning Shell on**, from any of the three switches, opens a confirming sheet with the
    spec's risk paragraph. It is shown in a `ShellPanel`, so a posted click cannot confirm it.
    Confirming calls `ShellSeal.setEnabled(true, .standard)`. The menu bar and main-window
    switches cannot turn Shell on in place: they open the Shell pane with the sheet up. This
    is **my call**, so there is only one place a seal is made.
  - **Turning Shell off**, from anywhere, calls `ShellSeal.setEnabled(false, .standard)` and
    `ShellServer.stopAll()` at once, with no sheet.
  - The switches bind to `ShellSeal.isEnabled`, not to the raw `@AppStorage` bool. A forged plain
    value must not draw the switch as on.
  - **"Before running"** is a picker with **Ask every time** / **Ask once per session** / **Don't
    ask**. Choosing **Don't ask** opens the warning sheet (in a `ShellPanel`) naming the injection
    risk, and confirming calls `ShellSeal.setBefore(.none, .standard)`. The other two choices
    apply at once through `setBefore`. The picker shows `ShellSeal.effectiveBefore`.
  - **Recent runs**: the 20 most recent `ShellRecord` entries, each showing time, client,
    decision, exit code and the first 12 hex digits of the hash, with `purpose` as help text.
    Reloaded when the pane appears.

- [ ] **Step 1: Implement `ShellControls`, route the three switches, filter `ChatPane.picks`.**

- [ ] **Step 2: Run `make app unit shell-check`**
      Expected: it builds and the checks pass.

- [ ] **Step 3: The forging test, on the Debug build** (`io.mgcrea.cupertino.debug`):

  ```bash
  defaults write io.mgcrea.cupertino.debug surfaceEnabled.shell -bool YES
  defaults write io.mgcrea.cupertino.debug shell.before -string none
  # relaunch the Debug app
  node .claude/skills/use-the-dev-build/scripts/dev-mcp.mjs shell   # expect: refused / no tools, Shell drawn off
  ```

  Then turn Shell on in the pane, run `defaults write … shell.before -string none` again, call
  `apple_shell_run`, and expect the window. Then launch with `-shell.before none` on the command
  line and expect the window again.

- [ ] **Step 4: Check by hand:**
  - the sheet appears from each of the three switches
  - "Don't ask" shows the warning, and afterwards runs show only the card
  - Recent runs lists refusals as well as runs
  - the Chat pane's surface list has no Shell

- [ ] **Step 5: Commit**

```bash
git add apps/apple/Cupertino/SurfaceDetail.swift apps/apple/Cupertino/MainWindow.swift apps/apple/Cupertino/CupertinoApp.swift apps/apple/Cupertino/ChatPane.swift
git commit -m "feat(shell): the Shell pane, sealed switches, and recent runs"
```

---

### Task 9: Docs and the release note

**Files:**

- Create: `docs/shell.md`
- Modify: `docs/surfaces.md` ("State of play": a Shell row), `CHANGELOG.md` (Unreleased, "### Added"), `CLAUDE.md` (only if it lists surface docs; one pointer line)

**Content of `docs/shell.md`.** It states what is true, cites the checks that pin it, and dates
anything measured:

- What the grant reaches: everything Cupertino holds, via the responsible process. Accessibility
  is unreliable for grandchildren (`Permissions.swift` around line 466).
- The threat model, in the spec's words. The sealed settings and key rotation. The one residual:
  a process that plants the Keychain key before Cupertino first creates it raises a Keychain
  prompt naming Cupertino, and approving that prompt is the only way past the seal.
- `sudo` fails, because there is no tty.
- A login shell's own output (a `.zprofile` that echoes) appears in stdout.
- The setting and the card. The run record's location, its contents, and that it holds no
  script text or output.
- Which `make` checks pin what. The hardware-input rule, with the values measured in Task 7.

- [ ] **Step 1: Write `docs/shell.md`, the `surfaces.md` row and the CHANGELOG entry.**
- [ ] **Step 2: Run `pnpm format` (Markdown) and `make surfaces-check readme-check changelog-check`**
      Expected: clean.
- [ ] **Step 3: Commit**

```bash
git add docs/shell.md docs/surfaces.md CHANGELOG.md
git commit -m "docs(shell): what it reaches, what stops it, and what pins each claim"
```

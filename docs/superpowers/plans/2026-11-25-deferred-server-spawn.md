# Deferred Server Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A node server starts only when its session sends something Cupertino cannot answer from a recording of what an identical server already said.

**Architecture:** Three pure files (frame parsing, the cache, the per-session state machine and reply filter), tested in `make unit` with no process. Then `ServerHost.run` gains a deferred phase in front of today's spawn and relay, tested in `make host-check` against a stub node server. A separate `make handshake-check` drives the real built servers to prove the key is not missing an input.

**Tech Stack:** Swift (standalone `swiftc` checks, no XCTest), Node for the stub and the equivalence check, GNU/BSD-portable Make.

**Spec:** `docs/superpowers/specs/2026-11-25-deferred-server-spawn-design.md`

## Global Constraints

- Answerable without a process: `initialize`, `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `ping`. `ping` is learned and keyed like the lists, never composed by the host: node answers it in the 2025 era and refuses it (`-32601`) in the 2026-07-28 era, and an error is never recorded, so a modern-era ping spawns. It is replayed like any other line.
- Errors are never recorded. Over-keying is safe; under-keying is the only way to be wrong, so keys take whole dicts.
- Volatile `_meta` fields dropped from the key start as `["progressToken"]` and grow only from Checkpoint A's findings.
- Cache off when `ServerBinaries.isDevelopment`, unless the default `deferSpawnInDevelopment` is true. A kill switch default `deferServerSpawn` (absent means on) turns the whole deferral off.
- Settings are frozen at connect: the environment computed at connect is the one the server is spawned with.
- Cached replies are whole node frames; only the `id` is swapped.
- Cache bounded by bytes: 8 MB, LRU.
- Mismatch on replay: log an error naming surface and method, evict, disable the cache for that surface until restart.
- Makefile changes must run under BSD tools and Apple make 3.81. Swift follows the surrounding style (`nonisolated` types, `OSAllocatedUnfairLock`) and passes `make format-swift-check`.
- Commits: `feat(host): …` / `test(host): …`, no Co-Authored-By trailers.

## Review Focus

1. **A first request bigger than any list call** (a `tools/call` with a multi-MB argument, before anything spawned): it must reach the server intact. → Task 4 Step 1, test `oversized first frame`.
2. **Several frames in one write** (`initialize` + `initialized` + `tools/list` in a single chunk): each answered, in order. → Task 3 Step 1, `pipelined chunk`.
3. **A frame split across reads exactly when the spawn happens**: the child receives it whole. → Task 4 Step 1, `split trigger frame`.
4. **The server writes a notification or a non-JSON line while the filter is active**: it passes through untouched. → Task 3 Step 1, `filter passes notifications`.
5. **A setting switched off at the instant a deferred session is starting its server**: the session ends one way or the other, never left running on old settings. → Task 5 Step 1, `narrowed while starting`.

---

### Task 1: Frame parsing and the connect-traffic log

Ships first, on its own, so Checkpoint A can measure real clients.

**Files:**

- Create: `apps/apple/Cupertino/McpFrame.swift`
- Create: `apps/apple/Cupertino/DeferredSpawn.swift`
- Modify: `apps/apple/Cupertino/RequestObserver.swift` (`init`, `note` at ~176, new `closed()`)
- Modify: `apps/apple/Cupertino/ServerHost.swift` (`run`: pass `wiredClient` to `RequestObserver`, call `observer.closed()` after `group.wait()`)
- Modify: `Makefile` (`unit` and `host-check` source lists: add `McpFrame.swift`, `DeferredSpawn.swift`)
- Test: `scripts/unit-check.swift`

**Interfaces:**

- Produces:
  - `nonisolated struct McpFrame { enum Kind { case request, notification, response, unparsed }; let kind: Kind; let id: Data?; let method: String?; let params: Any?; let isError: Bool; static func parse(_ line: Data) -> McpFrame }`. `id` is the id re-serialised with `JSONSerialization` (`.fragmentsAllowed`), so `7` → `7`, `"a"` → `"a"` with quotes.
  - `McpFrame.canonical(_ value: Any?, droppingMeta: Set<String>) -> Data`: `.sortedKeys` + `.withoutEscapingSlashes`, `nil` → `null`, removes the named keys from a top-level `_meta` dict and drops `_meta` if it ends up empty.
  - `nonisolated struct LineBuffer { mutating func append(_ chunk: Data) -> [Data]; var pendingCount: Int; mutating func takePending() -> Data }`: unbounded, returns complete lines without their `\n`, skips empty lines.
  - `nonisolated enum DeferredSpawn { static let answerable: Set<String>; static let handshakes: Set<String> = ["initialize", "server/discover"]; static let volatileMeta: Set<String> = ["progressToken"]; static let oversized = 64 << 10 }`
  - `nonisolated struct ConnectTraffic { mutating func saw(_ frame: McpFrame) -> String?; func atClose() -> String? }`

- [ ] **Step 1: Write the failing tests** in `scripts/unit-check.swift`, a new `// ─── McpFrame ───` section:

```swift
let req = McpFrame.parse(Data(#"{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}"#.utf8))
check("request kind", req.kind == .request && req.method == "tools/list")
check("numeric id", req.id == Data("7".utf8))
check("string id keeps quotes", McpFrame.parse(Data(#"{"id":"a","method":"ping"}"#.utf8)).id == Data(#""a""#.utf8))
check("notification", McpFrame.parse(Data(#"{"method":"notifications/initialized"}"#.utf8)).kind == .notification)
check("error response", McpFrame.parse(Data(#"{"id":1,"error":{"code":-1}}"#.utf8)).isError)
check("garbage", McpFrame.parse(Data("not json".utf8)).kind == .unparsed)
check("canonical sorts and drops volatile meta",
  McpFrame.canonical(["b": 1, "a": 2, "_meta": ["progressToken": 3]], droppingMeta: ["progressToken"])
    == Data(#"{"a":2,"b":1}"#.utf8))
check("canonical keeps other meta",
  McpFrame.canonical(["_meta": ["progressToken": 3, "x": 1]], droppingMeta: ["progressToken"])
    == Data(#"{"_meta":{"x":1}}"#.utf8))
var lb = LineBuffer()
check("line buffer splits", lb.append(Data("a\nb\nc".utf8)) == [Data("a".utf8), Data("b".utf8)])
check("line buffer keeps tail", lb.pendingCount == 1 && lb.takePending() == Data("c".utf8))
var ct = ConnectTraffic()
_ = ct.saw(.parse(Data(#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"x"}}}"#.utf8)))
_ = ct.saw(.parse(Data(#"{"method":"notifications/initialized"}"#.utf8)))
_ = ct.saw(.parse(Data(#"{"id":2,"method":"tools/list","params":{"_meta":{"progressToken":5}}}"#.utf8)))
let line = ct.saw(.parse(Data(#"{"id":3,"method":"tools/call","params":{}}"#.utf8)))
check("connect line lists methods",
  line?.hasPrefix("connect: initialize, notifications/initialized, tools/list | meta: progressToken | handshake: ") == true)
check("connect line names the first call", line?.hasSuffix(" | first: tools/call") == true)
check("said once", ct.saw(.parse(Data(#"{"id":4,"method":"tools/call"}"#.utf8))) == nil && ct.atClose() == nil)
```

- [ ] **Step 2: Run** `make unit`. Expected: compile failure, `cannot find 'McpFrame' in scope`.

- [ ] **Step 3: Implement** `McpFrame.swift` and `DeferredSpawn.swift` per the Interfaces block. `ConnectTraffic` line format, exactly: `connect: <methods, comma-space> | meta: <sorted union of _meta keys seen on answerable requests, or none> | handshake: <first 8 hex of SHA-256 of the canonical handshake params, or none> | first: <method> | params: <method>=<first 8 hex of SHA-256 of its canonical params, volatileMeta dropped>, … (each pair once, in the order seen), or none`; `atClose()` returns the same with `| first: none (closed)` if `saw` never ended the phase. `ping` counts as part of the phase. The line holds method names, `_meta` key names and hashes only, never a param's value or `clientInfo`.

- [ ] **Step 4: Run** `make unit`. Expected: all `ok`, exit 0.

- [ ] **Step 5: Wire the log.** `RequestObserver.init(surface:session:wiredClient:)` holds a `ConnectTraffic` under its existing request lock; `note(_:)` feeds each parsed line and logs a returned line as `hostLog(surface.id, .info, "\(line) (client \(wiredClient ?? "unknown"))")`, and to the unified log too (`Logger(subsystem: "io.mgcrea.cupertino", category: "connect")`, `.notice`, `.public`: the Activity log keeps 1000 rows and the stderr mirror goes nowhere for an app started with `open`); `closed()` logs `atClose()`. `run` passes `wiredClient` and calls `observer.closed()` after `group.wait()`. Run `make unit host-check format-swift-check`. Expected: all pass.

- [ ] **Step 6: Commit** `feat(host): log what each session sends before its first call`.

### Checkpoint A: measure real clients (blocks merging Task 4, not writing it)

- [ ] Build and install the Debug app the way the `use-the-dev-build` skill describes. Use Claude Code, Codex and Claude Desktop normally for a day.
- [ ] Read the day's `connect:` lines from the unified log, not the Activity window (it keeps the last 1000 rows): `log show --style compact --last 1d --predicate 'subsystem == "io.mgcrea.cupertino" AND category == "connect" AND process == "Cupertino"'`. The process term leaves out what `make host-check` logs under the same subsystem. For each client, record which methods it sends before its first call, whether the handshake fingerprint is stable across its sessions, which `_meta` keys appear, and whether each method's `params:` fingerprint is stable across its sessions: one that differs between sessions whose handshake is the same names a request carrying a value that changes, and the `meta:` keys say which to look at.
- [ ] Update the spec's "What clients send" section with the findings, and add any `_meta` key whose value varies between sessions to `DeferredSpawn.volatileMeta`. A client whose connect traffic includes a non-answerable method needs no code: it just spawns at connect. Commit `docs(host): connect traffic measured`.

### Task 2: The cache

**Files:**

- Create: `apps/apple/Cupertino/HandshakeCache.swift`
- Modify: `Makefile` (`unit`, `host-check` lists)
- Test: `scripts/unit-check.swift`

**Interfaces:**

- Consumes: `McpFrame.canonical`, `ServerBinaries` (`ServerResolution.swift`).
- Produces:
  - `nonisolated struct HandshakeBase: Hashable { let surface: String; let build: String; let node: String; let script: String; let env: [String: String] }`
  - `nonisolated struct HandshakeKey: Hashable { let base: HandshakeBase; let handshake: Data?; let method: String; let params: Data }`
  - `nonisolated struct CachedReply: Equatable { init?(frame: Data, id: Data); func frame(id: Data) -> Data; var byteCount: Int }`. Valid only when the frame, with any trailing `\n` removed, ends in `"id":` + `id` + `}`. It is stored as the head before the id plus the tail `}`. Anything else returns `nil` and is not cached.
  - `enum RecordOutcome: Equatable { case stored, matched, mismatch, uncacheable, disabled }`
  - `nonisolated final class HandshakeCache: @unchecked Sendable { static let shared: HandshakeCache; init(byteCap: Int = 8 << 20); func reply(for: HandshakeKey) -> CachedReply?; func record(_ key: HandshakeKey, frame: Data, id: Data) -> RecordOutcome; func disable(surface: String); func isDisabled(surface: String) -> Bool; func reset() /* checks only: empties entries and disabled surfaces */; var byteCount: Int; static func isOn(_ binaries: ServerBinaries, defaults: UserDefaults = .standard) -> Bool }`

- [ ] **Step 1: Write the failing tests** (`// ─── HandshakeCache ───`):

```swift
let base = HandshakeBase(surface: "mail", build: "1", node: "/n", script: "/s", env: ["PATH": "/usr/bin:/bin"])
let k = HandshakeKey(base: base, handshake: nil, method: "tools/list", params: Data("{}".utf8))
let frame = Data(#"{"result":{"tools":[]},"jsonrpc":"2.0","id":7}"#.utf8)
check("reply swaps id", CachedReply(frame: frame, id: Data("7".utf8))?.frame(id: Data(#""x""#.utf8))
  == Data(#"{"result":{"tools":[]},"jsonrpc":"2.0","id":"x"}"#.utf8))
check("id not last is uncacheable", CachedReply(frame: Data(#"{"jsonrpc":"2.0","id":7,"result":{}}"#.utf8), id: Data("7".utf8)) == nil)
let c = HandshakeCache(byteCap: 1 << 20)
check("stored", c.record(k, frame: frame, id: Data("7".utf8)) == .stored)
check("hit", c.reply(for: k) != nil)
check("same again matches", c.record(k, frame: frame, id: Data("7".utf8)) == .matched)
let envKey = HandshakeKey(base: HandshakeBase(surface: "mail", build: "1", node: "/n", script: "/s", env: ["PATH": "/x"]),
  handshake: nil, method: "tools/list", params: Data("{}".utf8))
check("env is in the key", c.reply(for: envKey) == nil)
let other = Data(#"{"result":{"tools":[1]},"jsonrpc":"2.0","id":7}"#.utf8)
check("different answer is a mismatch", c.record(k, frame: other, id: Data("7".utf8)) == .mismatch)
check("mismatch disables the surface", c.isDisabled(surface: "mail") && c.reply(for: k) == nil)
check("disabled refuses records", c.record(k, frame: frame, id: Data("7".utf8)) == .disabled)
let small = HandshakeCache(byteCap: 100)
let big = Data((#"{"result":""# + String(repeating: "a", count: 40) + #"","jsonrpc":"2.0","id":1}"#).utf8)
let k1 = HandshakeKey(base: base, handshake: nil, method: "tools/list", params: Data("1".utf8))
let k2 = HandshakeKey(base: base, handshake: nil, method: "tools/list", params: Data("2".utf8))
_ = small.record(k1, frame: big, id: Data("1".utf8)); _ = small.record(k2, frame: big, id: Data("1".utf8))
check("byte cap evicts oldest", small.reply(for: k1) == nil && small.reply(for: k2) != nil)
let d = UserDefaults(suiteName: "unit-check-\(UUID())")!
check("off for dev builds", !HandshakeCache.isOn(ServerBinaries(node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"), isDevelopment: true), defaults: d))
d.set(true, forKey: "deferSpawnInDevelopment")
check("dev opt-in", HandshakeCache.isOn(ServerBinaries(node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"), isDevelopment: true), defaults: d))
d.set(false, forKey: "deferServerSpawn")
check("kill switch", !HandshakeCache.isOn(ServerBinaries(node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"), isDevelopment: false), defaults: d))
```

- [ ] **Step 2: Run** `make unit`. Expected: `cannot find 'HandshakeBase' in scope`.
- [ ] **Step 3: Implement** `HandshakeCache.swift`. One `OSAllocatedUnfairLock` over a dictionary plus an LRU order. A lookup bumps its entry. An entry larger than the cap is `.uncacheable`. `disable` evicts that surface's entries.
- [ ] **Step 4: Run** `make unit`. Expected: all `ok`.
- [ ] **Step 5: Commit** `feat(host): a handshake cache keyed on everything an answer depends on`.

### Task 3: The session state machine and the reply filter

**Files:**

- Modify: `apps/apple/Cupertino/DeferredSpawn.swift`
- Test: `scripts/unit-check.swift`

**Interfaces:**

- Consumes: `McpFrame`, `HandshakeCache`, `HandshakeKey`, `HandshakeBase`.
- Produces:
  - `nonisolated struct SessionKeys { init(base: HandshakeBase); mutating func key(for frame: McpFrame) -> HandshakeKey? }`. Returns `nil` unless the frame is a request whose method is in `answerable`. The first handshake-method request sets `handshake` to its canonical params, and that handshake is included in every later key.
  - `nonisolated struct DeferredSession { init(base: HandshakeBase, cache: HandshakeCache); enum Step: Equatable { case answer(Data), hold, spawn }; mutating func client(_ line: Data) -> Step; func replay() -> Data; var trigger: McpFrame?; func filter() -> ReplyFilter }`
  - `nonisolated struct ReplyFilter { enum Verdict: Equatable { case pass, drop, mismatch(String) }; mutating func client(_ frame: McpFrame); mutating func server(_ line: Data) -> Verdict; var isRetired: Bool }`

Rules `DeferredSession.client` follows:

- `ping` follows the answerable-request rules below: a hit is answered with node's recorded bytes, a miss spawns.
- Notification → transcript, `.hold`.
- Answerable request that hits the cache (cache not disabled for the surface) → transcript, remember `(id, key, drop: true)`, `.answer(frame + "\n")`.
- Anything else → transcript, `trigger` set, `.spawn`. A trigger that is an answerable miss is remembered as `(id, key, drop: false)` so its live answer is recorded.
- `replay()` is the transcript lines joined with `\n`, plus a trailing `\n`.
- The transcript is capped at `DeferredSpawn.transcriptLimit` (1 MB): the line that would take `replay()` past it spawns, whatever it is, even a hit.
- A request under an id still remembered (a trigger before the spawn, or any request the filter sees after it) taints that entry: it is never recorded, and no difference disables anything. A live one passes whatever comes; a host-served one drops only the response byte for byte what the host served, and passes anything else. An SDK sends no response to a cancelled request, so without this a `tools/call` reusing a cancelled `tools/list` id was recorded as that tool list.

`ReplyFilter` (built by `filter()`, carrying the remembered ids and `SessionKeys`):

- `client(_:)` is called for every client frame after the spawn and before it is forwarded. While the connect phase is open, an answerable request is remembered as `(id, key, drop: false)`. The first request that isn't answerable closes the phase. The phase also starts closed if the trigger wasn't answerable.
- `server(_:)` handles a response whose id is remembered by calling `cache.record`, giving `.mismatch(method)` on `.mismatch`. Otherwise it gives `.drop` when the entry was host-served and `.pass` when it wasn't. When an entry is both host-served and mismatched, the frame is still dropped. Everything else gives `.pass`.
- `isRetired` is true when nothing is remembered and the phase is closed.

- [ ] **Step 1: Write the failing tests** (`// ─── DeferredSession ───`). Use the `base` from Task 2, a fresh `HandshakeCache()`, and lines `I` = `initialize` id 1 with `clientInfo {name:"cc"}`, `N` = `notifications/initialized`, `L` = `tools/list` id 2 with `_meta.progressToken` 1, `T` = `tools/call` id 3:
  - `cold session spawns on initialize`: first `client(I)` is `.spawn`, `replay() == I + "\n"`.
  - `warm session answers without a process`: pre-record `I` and `L` answers (node-style frames) via `SessionKeys`-built keys. Then `client(I)` is `.answer` with id `1`, `client(N)` is `.hold`, `client(L)` with `progressToken` 9 is `.answer` with id `2`, `client(T)` is `.spawn`, and `replay() == [I, N, L(token 9), T]` joined.
  - `ping is learned, not composed`: on a cache with no ping answer, ping id 9 gives `.spawn` and is in `replay()`; node's answer is recorded, and a later session's ping is answered with node's bytes under its own id. A ping refused with `-32601` is passed and not recorded, so the next session's ping spawns too.
  - `different clientInfo misses`: an `initialize` with `name:"codex"` gives `.spawn` against the warm cache.
  - `pipelined chunk`: feed `I`, `N`, `L` through a `LineBuffer` from one `Data` and drive `client` per line. The answers come back in order 1, 2.
  - `filter drops what the host served`: after the warm spawn, `server(<I answer, id 1>) == .drop`.
  - `filter catches a skewed replay`: a different `L` answer for id 2 gives `.mismatch("tools/list")` and `cache.isDisabled(surface: "mail")`.
  - `filter records a live miss`: on a cold spawn, `filter.client(L)`, then `server(<L answer id 2>) == .pass`. A new session then gets `.answer` for `L`.
  - `filter passes notifications`: `server({"method":"notifications/message"})` and `server("not json")` are both `.pass`.
  - `filter retires`: `isRetired` is false until the phase is closed (by `filter.client(T)`) and every remembered id has been seen, and true afterwards.
- [ ] **Step 2: Run** `make unit`. Expected: `cannot find 'DeferredSession' in scope`.
- [ ] **Step 3: Implement** `SessionKeys`, `DeferredSession` and `ReplyFilter` in `DeferredSpawn.swift` per the rules above.
- [ ] **Step 4: Run** `make unit`. Expected: all `ok`.
- [ ] **Step 5: Commit** `feat(host): the deferred session and its reply filter`.

### Task 4: Defer the spawn in `ServerHost`

**Files:**

- Create: `scripts/fixtures/stub-mcp-server.mjs`
- Modify: `apps/apple/Cupertino/ServerHost.swift` (`serve` ~870, `run` ~1300, `pump` ~1508)
- Modify: `Makefile` (`host-check`: pass `HOST_CHECK_NODE=$$(command -v node)` and the stub path)
- Test: `scripts/host-check.swift`

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces:
  - `static var locateOverride: ((Surface) throws -> ServerBinaries)?` on `ServerHost`, read by `serve` in place of `ServerLocator.locate` when set. host-check only.
  - `private func spawnEnvironment(surface:isSelf:wiredClient:) -> (env: [String: String], config: SpawnConfig, lazyTools: Bool)`, holding what `run` computes today in its first 30 lines.
  - `private func startServer(surface:binaries:env:config:lazyTools:client:onTrial:session:observer:preamble: Data, filter: ReplyFilter?) `: today's spawn and relay. It writes `preamble` to the child's stdin before starting the pumps.
  - The stub: `node stub-mcp-server.mjs` answers `initialize`, the four lists and `tools/call` with fixed results, written as `{"result":…,"jsonrpc":"2.0","id":…}`. It appends `<pid> <line>` for every line it receives to `$STUB_LOG`. When `$STUB_SKEW` names a method it answers that method differently. It exits on stdin EOF.

How `run` works after the change. The environment is computed once with `spawnEnvironment`. If `HandshakeCache.isOn(binaries)` is false, `startServer` runs at once with an empty preamble and no filter, which is today's behaviour. Otherwise:

1. Log `session open, server deferred`.
2. Read the client socket into a `LineBuffer` and feed each line to `observer.saw` and `DeferredSession.client`. Write `.answer` bytes with `writeAll`.
3. On `.spawn`, call `startServer` with `preamble = replay() + buffer.takePending()` and `filter = session.filter()`, and log `first <trigger method>, starting server (pid N)`.
4. If the buffer's `pendingCount` passes `DeferredSpawn.oversized` without a newline, spawn the same way, with no trigger, so the bytes are forwarded raw.
5. If the client hangs up while deferred, close and log; no process is ever started.

The `HandshakeBase` holds:

- `build`: `Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"`
- `node` and `script`: `binaries.node.path` and `binaries.script.path`
- `env`: the frozen environment

Pumps while a filter is active:

- **client→server:** parse each line and call `filter.client` _before_ writing it to the child.
- **server→client:** split into lines, apply `server(_:)`, and write the lines that pass, each followed by `\n`. On `.mismatch(m)`, log `.error` with `handshake cache: \(m) answered differently on replay; a key input is missing, the client already has the cached answer; cache off for \(surface.id) until restart` and call `assertionFailure` (Debug only, and not on development binaries: `DeferredSpawn.assertsOnMismatch`. A rebuild under the dev opt-in changes answers without changing the key, and trapping would take the whole app down).
- **Retirement:** once `isRetired`, write `takePending()` and copy raw, as today. The filter is shared by the two pump threads behind one `OSAllocatedUnfairLock`.

- [ ] **Step 1: Write the failing host-check cases.** Set `ServerHost.locateOverride` to the stub and connect over the real socket with the existing `handshake` helper, as `cupertino/1 mail client=claude-code`:
  - `first session spawns and answers`: `I, N, L, T` each get one answer. `$STUB_LOG` holds one pid.
  - `second session starts nothing before a call`: `I, N, L` are answered and no new pid appears in `$STUB_LOG` within 500 ms. After `T`, a new pid appears, and its lines are `I, N, L, T` in order. The client gets exactly one answer per id.
  - `hang-up while deferred`: `I, N`, close. No new pid appears.
  - `split trigger frame`: send half of `T`, wait 100 ms, send the rest. The new pid's last line is `T`, whole.
  - `oversized first frame`: after `I`, a 200 KB `tools/call` line arrives whole in `$STUB_LOG`.
  - `skewed replay disables the cache`: call `HandshakeCache.shared.reset()`, warm the cache with one session, then set `STUB_SKEW=tools/list` and send `I, N, L, T` on a second session. Afterwards `HandshakeCache.shared.isDisabled(surface: "mail")` is true and the host log has the `handshake cache:` line. Call `reset()` again at the end.
- [ ] **Step 2: Run** `make host-check`. Expected: the new cases FAIL (each session spawns at connect).
- [ ] **Step 3: Write the stub, then refactor `run`** into `spawnEnvironment` and `startServer` with no change in behaviour. Run `make host-check`: the existing cases pass and the new ones still fail.
- [ ] **Step 4: Implement the deferred phase and the filtered pumps** as described above.
- [ ] **Step 5: Run** `make unit host-check format-swift-check`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(host): start a node server only when a session needs one`.

### Task 5: Settings, trial and switching off reach deferred sessions; the Activity window

**Files:**

- Modify: `apps/apple/Cupertino/ServerHost.swift` (`settingsChanged` ~1001, `stopSessions` ~970, `endTrialSessions` ~929, the deferred phase from Task 4)
- Modify: `apps/apple/Cupertino/Sessions.swift` (`Session.pid: Int32?`, `opened(id:surface:pid: Int32?)`, new `started(id: UUID, pid: Int32)`)
- Modify: `apps/apple/Cupertino/MainWindow.swift:609`, `apps/apple/Cupertino/SurfaceDetail.swift:648`
- Test: `scripts/host-check.swift`

**Interfaces:**

- Produces: `private let deferredSessions = OSAllocatedUnfairLock<[UUID: DeferredEntry]>`, where `struct DeferredEntry { let fd: Int32; let surface: String; let config: SpawnConfig; let onTrial: Bool }`.

- [ ] **Step 1: Write the failing host-check cases** (stub as in Task 4, `UserDefaults.standard` of the check binary):
  - `writes off closes a deferred session`: `allowWrites.mail` true, connect, `I, N, L`, set it false, call `settingsChanged()`. The client reads EOF within 1 s.
  - `widening leaves it alone`: start with writes off, turn them on. The session is still open 1 s later.
  - `switched off closes it`: `stopSessions(for: mail)` gives EOF.
  - `trial end closes it`: a session admitted on trial, then `endTrialSessions()` with no licence, gives EOF.
  - `narrowed while starting`: send `T` and immediately set writes off and call `settingsChanged()`. Within 2 s either the client reads EOF or the spawned stub pid has exited.
- [ ] **Step 2: Run** `make host-check`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - The deferred phase registers its `DeferredEntry` at start and removes it under the lock before `startServer` puts the pid in `serverPIDs`. `startServer`'s existing `settingsChanged()` re-check then covers the gap.
  - `settingsChanged`, `stopSessions` and `endTrialSessions` each pick deferred entries by the same rule they use for pids, and remove them and `shutdown(fd, SHUT_RDWR)` _under the lock_, for the reason `endTrialSessions` already gives.
  - `Sessions.opened` takes `pid: nil` for a deferred session. `started` fills it in.
  - Both views show `not started` where they show `pid N` today.
- [ ] **Step 4: Run** `make unit host-check format-swift-check` and build the app (`make build` or the Xcode scheme the repo uses). Expected: all pass, no warnings added.
- [ ] **Step 5: Commit** `feat(host): switching a setting off reaches sessions whose server has not started`.

### Task 6: The under-keying check against the real servers

**Files:**

- Create: `scripts/handshake-equivalence.mjs`
- Modify: `Makefile` (new `handshake-check` target, after `host-check`; depends on the servers being built, as `smoke` does)

**Interfaces:**

- Consumes: `packages/<surface>/dist/cli.js` for the nine node surfaces, and each surface's `envPrefix` from `surfaces.json`.

What it does. For each node surface, with writes off and with writes on (`<envPrefix>ALLOW_WRITES=1`), and for each era, it spawns fresh servers with `env = {PATH: "/usr/bin:/bin", HOME}`. The eras are:

- legacy: `initialize` with `protocolVersion: "2025-06-18"`, then `notifications/initialized`, then the lists;
- modern: the lists, each carrying `_meta` = the `ENVELOPE` from `packages/core/test/event-handlers.test.ts:85`.

Each run is one variant. The variants differ only in what the key leaves out:

- numeric versus string ids;
- the list calls in two different orders, with `tools/list` sent twice;
- different `_meta.progressToken` values.

For every answerable method, it asserts that the response frames are byte-identical across variants once the id is normalised. It prints `ok <surface> <writes> <era> <method>` per assertion, and exits non-zero with a diff on the first difference.

One sensitivity case must _differ_: `mail` `tools/list` with writes on versus off. This proves the check can see a difference at all.

- [ ] **Step 1: Write the script**, including the sensitivity case, and the Makefile target. The target is portable: no GNU flags, and `$$` escapes for make 3.81.
- [ ] **Step 2: Run** `pnpm -r build && make handshake-check`. Expected: every line `ok`, and the sensitivity case reported as `differs (expected)`.
- [ ] **Step 3: Commit** `test(host): prove cached handshake answers do not depend on what the key leaves out`.

### Task 7: Verify on this Mac

- [ ] **Step 1: Run the gates.** Run `make unit host-check handshake-check format-swift-check smoke`. Expected: all pass. If `smoke` exits 144, see the memory note on orphaned screenshot instances.
- [ ] **Step 2: Install the build.** Install the Debug build the way `use-the-dev-build` describes. Set `deferSpawnInDevelopment` to true in its preferences with `plutil` on `~/Library/Preferences` (not `defaults`: see the memory note on Cupertino's prefs), and relaunch it. Note the node count first: `ps -axo command | grep -c 'cli.js'`.
- [ ] **Step 3: Check that an idle session starts nothing.** The cache is empty after the relaunch, so the first session under each configuration misses and spawns all nine servers. Open one Claude Code session as a warm-up first, and let it finish connecting. Then note the node count again and open a second one, and measure on that. Expected for the second: 14 new `cupertino-bridge` processes, and no new node process.
- [ ] **Step 4: Check that a call starts exactly one server.** In that session, call `apple_mail_list_accounts`. Expected: one new node process, for mail, and the same answer as before the change. In the log, `first tools/call, starting server (pid N)`.
- [ ] **Step 5: Check settings still reach idle sessions.** Switch Mail's "Allow writes" off in Settings. Expected: sessions that hadn't started a Mail server reconnect, and their tool list no longer has the write tools.
- [ ] **Step 6: Record the result, including a restart.** After a day, record the node count against `bridges / 14 × 9` in the spec's Goal section. Then measure the cold-cache burst: with several sessions open, quit and relaunch the app (as an update does), let every client reconnect, and record how many node servers start and how many are still running an hour later. Every session that reconnects before a key's first answer is recorded spawns, and that server lives for the session, so expect up to one set per session, not one per configuration. Record both numbers in the spec beside the single-flight follow-up, and commit `docs(host): deferred spawn measured`.

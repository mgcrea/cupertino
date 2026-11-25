# HTTP Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clients that take a loopback URL with a header reach Cupertino.app over Streamable HTTP, with no bridge process, and get exactly what a bridge connection gets today.

**Architecture:** Each HTTP session is one `socketpair`. Cupertino writes the same handshake line a bridge sends (`cupertino/1 <surface> client=<id>`) into one end and hands the other to `ServerHost.serve`. Admission, the licence gate, deferral, node children, in-process surfaces, narrowing and trial end therefore all run unchanged. The new code is a translator between Streamable HTTP and that line stream, a loopback listener with a strict gate, per-client tokens, and the wiring that writes `"type": "http"` entries.

**Tech Stack:** Swift (standalone `swiftc` checks: `make unit`, `make host-check`, `make wiring-check`), `swift-mcp-kit`'s `MCPKitLoopback` for the HTTP parser and connection budget, Node for the spike.

**Spec:** `docs/superpowers/specs/2026-11-25-http-endpoint-design.md`

## Global Constraints

- **Bind:** `127.0.0.1` only, by literal address. Port **8830** for release builds and **8831** for Debug, user-adjustable through `@AppStorage("httpPort")`.
- **Path:** `/s/<surface>`, with the surface validated against `Surface.named`. Anything else is 404.
- **Checks, in this order, before the body is read:**
  - `Host` must be exactly `127.0.0.1:<port>`, otherwise 400;
  - any `Origin` is refused with 403;
  - `Authorization: Bearer <token>` must be valid, otherwise 401.

  Each refusal logs which check refused it, never the token.

- **Tokens:** one per wired client. 32 random bytes, hex. Kept in the Keychain under service `io.mgcrea.cupertino.http-token`, with the client id as account. Compared in constant time. Written as a literal header into that client's config, and every file Cupertino writes a token into is mode 0600. Never in a project `.mcp.json`.
- **Protocol:** Streamable HTTP with the 2025 handshake only.
  - `server/discover` POSTed without a session is answered JSON-RPC `-32601`, with the HTTP status the spike recorded (Task 1; 404 until then).
  - The session id is 128 random bits as 32 lowercase hex characters, valid only with the token that created it.
  - `MCP-Protocol-Version` is required on every request after `initialize`.
- **Routing:**
  - A response goes to the POST that carried its request.
  - A `notifications/progress` goes to the POST whose request's `_meta.progressToken` matches its `params.progressToken`.
  - Everything else goes to the session's GET stream, or is dropped if there is none.
  - A POST holding only notifications or responses gets `202`.
- **Session end:** whichever comes first:
  - `DELETE`;
  - the host stopping;
  - the GET stream closed and no POST open or arriving within **30 s**;
  - **30 min** without a request, for a session that never opened a GET stream.
- **Connection budget:** 1024, with keep-alive.
- **Wiring:**
  - Claude Code, VS Code, Cursor and Codex use HTTP. Claude Desktop, LM Studio and Windsurf stay on the bridge.
  - A project `.mcp.json` stays on the bridge, and local scope in `~/.claude.json` uses HTTP.
  - Nothing is rewritten silently. Bridge entries on an HTTP client read `stale`, with a **Switch to HTTP** action. `rewiresAutomatically` keeps writing bridge entries.
  - Wiring a client over HTTP turns on `LoginItem` (launch at login).
- **Swift's MCP reach:** HTTP framing, the `Mcp-Session-Id` and `MCP-Protocol-Version` headers, a frame's `id`/`method`, and `progressToken` for routing. Nothing more.
- **Tooling:** Makefile changes run under BSD tools and Apple make 3.81. Swift passes `make format-swift-check`.
- **Commits:** `feat(http): …`, `test(http): …`, `docs(http): …`, with no Co-Authored-By trailers.

## Review Focus

1. **A client reusing a session after Cupertino restarted.** It must get 404 and start a new session, not hang. → Task 4, `unknown session is 404`, and Task 5, `restart gives 404 then a fresh session works`.
2. **A POST that is still open when the session ends** (setting narrowed, trial end, DELETE from another connection). It must close with an error, never stay open. → Task 5, `narrowed setting ends open POST streams`.
3. **A request body larger than any list call** (a multi-MB `tools/call`). It must reach the child whole. → Task 5, `large POST body arrives whole`.
4. **Two sessions from one client, interleaved.** Responses must never cross sessions, even with the same ids in both. → Task 4, `same ids in two sessions stay apart`, and Task 5, `two sessions get two children`.
5. **A notification arriving while no GET stream is open and no request matches.** It is dropped without error, and the session keeps working. → Task 4, `unrouted notification is dropped`.

---

### Task 1: Spike — how each client falls back over HTTP

Throwaway. Gates which clients get `.http` in Task 6; Tasks 2–5 do not wait on it.

**Files:**

- Create: `scripts/spikes/http-fallback.mjs` (Node built-ins only)
- Modify: the spec's "One protocol era over HTTP" section, with the results

- [ ] **Step 1: Write the spike server.**
  - **Listen:** `127.0.0.1:${PORT ?? 8839}`, at `POST/GET/DELETE /s/spike`.
  - **Log:** one JSON line per request (method, path, headers minus `authorization`, body), and the status it answered.
  - **`server/discover` without a session:** answers JSON-RPC `{"code":-32601,"message":"Method not found"}` with HTTP status `$DISCOVER_STATUS`, default `404`.
  - **`initialize`:** answers a fixed result carrying `Mcp-Session-Id`.
  - **`tools/list`:** answers one tool, `spike_echo`.
  - **`tools/call`:** echoes its arguments.
  - **`GET`:** opens an SSE stream that sends a `: ping` comment every 15 s.
  - **`DELETE`:** forgets the session.
  - **`EXPIRE_AFTER=<n>`:** forgets every session after n requests, so each client's reaction to a 404 can be seen.
- [ ] **Step 2: Checkpoint S, with Olivier.** Each client's managed policy may refuse an unknown server, as Claude Code's did for a stdio stub on 2026-11-25, so this runs with him. For each of Claude Code, Codex, Cursor and VS Code, wire `{"type":"http","url":"http://127.0.0.1:8839/s/spike","headers":{"Authorization":"Bearer spike"}}`, open it, list tools and call `spike_echo`. Repeat with `DISCOVER_STATUS` set to 200, 400 and 404, and with `EXPIRE_AFTER=3`. For each client, record:
  - which status makes it fall back to `initialize`;
  - whether it sends `Mcp-Session-Id` and `MCP-Protocol-Version` back;
  - whether it opens a GET stream;
  - what it does on a 404 for an expired session.
- [ ] **Step 3: Record the results.** Add a per-client table to the spec. A client that never falls back stays on the bridge in Task 6's table. Set `DiscoverRefusal.status` (Task 2) to the one status every HTTP client falls back on, and if no single status works for all of them, record which clients stay on the bridge. Commit `docs(http): how each client falls back over HTTP, measured`.

### Task 2: The request gate and discover refusal

**Files:**

- Create: `apps/apple/Cupertino/HTTPGate.swift`
- Modify: `Makefile` (`unit` and `host-check` source lists)
- Test: `scripts/unit-check.swift`

**Interfaces:**

- Produces:
  - `nonisolated struct HTTPHead: Equatable { let method: String; let path: String; let headers: [String: String] /* lowercased names */ }`. If Task 3's adoption of the kit's `HTTPRequestHead` makes this redundant, use that instead and keep the name in a typealias.
  - `nonisolated enum GateVerdict: Equatable { case admit(surface: String, client: String), refuse(status: Int, reason: String) }`
  - `nonisolated struct HTTPGate { let port: Int; let verify: @Sendable (String) -> String? /* token → client id */; func check(_ head: HTTPHead) -> GateVerdict }`
  - `nonisolated enum DiscoverRefusal { static let status = 404 }`, a placeholder that Task 1 replaces.

- [ ] **Step 1: Write the failing tests** (`// ─── HTTPGate ───`). The gate uses `port 8830` and `verify { $0 == "t1" ? "claude-code" : nil }`. Each case below is a separate check.

  | Check                            | Request                                                            | Expected                                                          |
  | -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
  | `admits a good request`          | `POST /s/mail`, `host: 127.0.0.1:8830`, `authorization: Bearer t1` | `.admit(surface: "mail", client: "claude-code")`                  |
  | `wrong host is 400 first`        | `host: localhost:8830` and a bad token                             | `.refuse(status: 400, …)`; the reason names `Host`, not the token |
  | `any origin is 403`              | `origin: http://127.0.0.1:8830`                                    | `.refuse(status: 403, …)`                                         |
  | `bad token is 401`               | `authorization: Bearer nope`                                       | 401                                                               |
  | `missing token is 401`           | no `authorization` header                                          | 401                                                               |
  | `unknown surface is 404`         | `/s/nope`                                                          | 404                                                               |
  | `other path is 404`              | `/mcp` or `/s/`                                                    | 404                                                               |
  | `reason never carries the token` | a refused request                                                  | `reason` does not contain the token text                          |

- [ ] **Step 2: Run** `make unit`. Expected: compile failure on `HTTPGate`.
- [ ] **Step 3: Implement** `HTTPGate.swift`. Check in the order `Host`, `Origin`, token, then path. Match `Bearer` case-insensitively with a single space. Validate the surface against `Surface.named`, and add `Surfaces.swift` to `make unit`'s list if it isn't there.
- [ ] **Step 4: Run** `make unit`. Expected: all `ok`.
- [ ] **Step 5: Commit** `feat(http): a loopback request gate checked in Bastion's order`.

### Task 3: Per-client tokens

**Files:**

- Create: `apps/apple/Cupertino/HTTPTokens.swift`
- Modify: `Makefile` (`unit`, `host-check`)
- Test: `scripts/unit-check.swift`

**Interfaces:**

- Produces:
  - `nonisolated protocol TokenVault: Sendable { func read(_ client: String) -> String?; func write(_ client: String, _ token: String) throws; func delete(_ client: String) throws; func all() -> [String: String] }`
  - `nonisolated struct KeychainTokenVault: TokenVault`: service `io.mgcrea.cupertino.http-token`, account = client id, generic-password items.
  - `nonisolated final class HTTPTokens: @unchecked Sendable { static let shared: HTTPTokens; init(vault: TokenVault); func token(for client: String) throws -> String /* mints if absent */; func client(for token: String) -> String? /* constant-time */; func revoke(_ client: String) throws }`

- [ ] **Step 1: Write the failing tests** against an in-memory `TokenVault` written in the check itself:
  - `mints 64 hex once`: two `token(for:"cursor")` calls return the same 64-character lowercase hex string.
  - `distinct per client`: `cursor` and `codex` get different tokens.
  - `maps back`: `client(for:)` returns the right id, and `nil` for an unknown token or the empty string.
  - `revoke signs out one`: after revoking `cursor`, its old token gives `nil` and `codex`'s still works.
  - `re-mint after revoke differs`.
- [ ] **Step 2: Run** `make unit`. Expected: compile failure.
- [ ] **Step 3: Implement.**
  - Use `SecRandomCopyBytes` for 32 bytes.
  - Keep a read-through in-memory cache under an `OSAllocatedUnfairLock`, because `client(for:)` runs on every request and must not hit the Keychain each time.
  - Constant-time compare: XOR-accumulate over equal-length UTF-8, after a length check.
  - `KeychainTokenVault` isn't exercised in `make unit`. It stays out of the unit list if it needs the Security framework's runtime, but it must still compile in `make app`.
- [ ] **Step 4: Run** `make unit`, then `make app`. Expected: both pass.
- [ ] **Step 5: Commit** `feat(http): one token per wired client, in the Keychain`.

### Task 4: The session translator

Pure logic. No sockets in its tests.

**Files:**

- Create: `apps/apple/Cupertino/HTTPSessionRouter.swift`
- Modify: `Makefile` (`unit`, `host-check`)
- Test: `scripts/unit-check.swift`

**Interfaces:**

- Consumes: `McpFrame.parse` (McpFrame.swift), `DiscoverRefusal.status` (Task 2).
- Produces:
  - `nonisolated struct HTTPSessionRouter` holds one session's routing state:
    - `init(id: String)`
    - `mutating func post(_ body: Data, stream: Int) -> PostOutcome`
    - `mutating func fromChild(_ line: Data) -> [Delivery]`
    - `mutating func openGet(stream: Int)`
    - `mutating func closeStream(_ stream: Int)`
    - `var hasGet: Bool`
    - `var openPosts: Set<Int>`
  - `enum PostOutcome: Equatable { case accepted /* 202 */, stream(lines: [Data]) /* write lines to the child, answer this POST as SSE */, invalid(status: Int, reason: String) }`
  - `enum Delivery: Equatable { case toStream(Int, Data), closeStream(Int), dropped }`
  - `nonisolated enum HTTPSessionGate { static func preSession(_ body: Data) -> PreSession }` decides a POST with no session id:
    - `enum PreSession: Equatable { case initialize, discoverRefused(status: Int, body: Data), invalid(status: Int) }`
    - `initialize` is a single `initialize` request. `discoverRefused` is a `server/discover`, answered `-32601` with `DiscoverRefusal.status` and the request's id. `invalid` is anything else: 400.
  - `nonisolated enum SessionID { static func mint() -> String /* 32 lowercase hex */; static func isWellFormed(_: String) -> Bool }`

Rules `post` follows:

- The body is one JSON-RPC message or a batch array.
- If it holds no requests, it is `.accepted`, and its lines go to the child. `PostOutcome.stream` with empty lines is never returned.
- If it holds requests, it is `.stream`: every member's line goes to the child in order, and the router remembers each request id → stream and each `_meta.progressToken` → stream.
- An id already pending in this session is `.invalid(status: 400, …)`.
- A non-JSON body is `.invalid(status: 400, …)`.

Rules `fromChild` follows:

- A response whose id is pending goes to `.toStream(thatStream)`. When the last pending id of a stream is answered, it also gives `.closeStream`.
- A `notifications/progress` whose token is mapped goes to that stream.
- Anything else goes to `.toStream(getStream)`, or `.dropped` when there is no GET stream.

- [ ] **Step 1: Write the failing tests** (`// ─── HTTPSessionRouter ───`):
  - `initialize opens a session`: `preSession` on an initialize body gives `.initialize`.
  - `discover is refused`: a `server/discover` body with id 4 gives `.discoverRefused(status: DiscoverRefusal.status, body:)`. The body decodes to error code `-32601` with id `4`.
  - `junk before a session is 400`.
  - `a request streams`: posting `tools/list` id 2 on stream 7 gives `.stream(lines:[that line])`. `fromChild` with the id-2 response gives `[.toStream(7, line), .closeStream(7)]`.
  - `notifications are accepted`: a POST holding only `notifications/initialized` gives `.accepted`.
  - `batch keeps order and waits for all`: a batch of ids 3 and 4 gives one stream with both lines. The id-3 response alone doesn't close the stream; the id-4 response does.
  - `progress follows its request`: a call with `_meta.progressToken: "p1"` on stream 9. A child `notifications/progress` with `progressToken: "p1"` gives `.toStream(9, …)`.
  - `unrouted notification goes to GET`: with a GET stream 1 open, `notifications/resources/updated` goes to `.toStream(1, …)`.
  - `unrouted notification is dropped`: with no GET stream, it gives `[.dropped]`, and a later request still works.
  - `server request goes to GET`: a child line with both `method` and `id` that isn't a pending response goes to the GET stream.
  - `duplicate pending id is 400`.
  - `same ids in two sessions stay apart`: two routers, both with id 2 pending on different streams. Each routes only its own response.
  - `closing a stream forgets its ids`: after `closeStream(7)`, a late id-2 response goes to the GET stream or is dropped, never to stream 7.
  - `session ids`: `mint()` is 32 lowercase hex characters, two mints differ, and `isWellFormed` rejects uppercase, wrong lengths and non-hex.
- [ ] **Step 2: Run** `make unit`. Expected: compile failure.
- [ ] **Step 3: Implement** `HTTPSessionRouter.swift` per the rules. Re-serialise batch members one per line with `JSONSerialization` and `.withoutEscapingSlashes`. A single-message body is passed through as its original bytes.
- [ ] **Step 4: Run** `make unit`. Expected: all `ok`.
- [ ] **Step 5: Commit** `feat(http): the Streamable HTTP session router`.

### Task 5: The listener, wired into the host

**Files:**

- Create: `apps/apple/Cupertino/HTTPListener.swift` (accept loop, parsing, gate, the SSE writer, the session table and timers)
- Modify: `apps/apple/Cupertino/ServerHost.swift` (start and stop the listener with the host; an `internal func serveInternal(_ fd: Int32)` that runs `serve` on a `cupertino.session` thread; `terminateChildren`/`stop` end HTTP sessions)
- Modify: the Xcode project, which adds the `swift-mcp-kit` package (product `MCPKitLoopback`) per `fleet-apple-conventions`
- Modify: `Makefile` (`host-check` compiles the kit's `MCPKitLoopback` HTTP parser and `ConnectionBudget` sources from the resolved checkout. Add a variable for that path and a resolve step that runs first. Keep it portable.)
- Test: `scripts/host-check.swift`

**Interfaces:**

- Consumes: Tasks 2–4, and `BridgeProtocol.version`/`.clientPrefix`/`.ok`.
- Produces:
  - `nonisolated final class HTTPListener: @unchecked Sendable`:
    - `init(port: Int, tokens: HTTPTokens, host: ServerHost)`
    - `func start() throws`
    - `func stop()`
    - `var boundAddress: String?` (for checks)
    - `func endSessions(where: (HTTPSessionInfo) -> Bool)`
  - `struct HTTPSessionInfo { let id: String; let client: String; let surface: String }`
  - Timing hooks for checks only: `static var getCloseGrace: TimeInterval = 30`, `static var idleLimit: TimeInterval = 1800`.

How a session runs:

1. An `initialize` POST that passes the gate creates a session. `socketpair(AF_UNIX, SOCK_STREAM)`; one end goes to `host.serveInternal`.
2. On the other end, write `cupertino/1 <surface> client=<client>\n` and read one line. `ok` means admitted. `err …` means answer the POST `503` with the reason, and no session is created.
3. Then write the POST's lines and answer as SSE, with `Mcp-Session-Id` on that response.
4. One reader thread per session feeds the session end's lines to `router.fromChild` and writes each `Delivery`. An SSE event is `event: message\ndata: <line>\n\n`.
5. The session end closing (the host ended it: narrowed, trial, stop) closes every open stream of that session.
6. Ending a session from the HTTP side (`DELETE`, the 30 s GET-close grace, the 30 min idle limit, `stop`) calls `shutdown(SHUT_RDWR)` on the session end. The host then sees a hang-up, exactly as from a bridge.
7. Later requests need a matching `Mcp-Session-Id` _and_ the same token's client, otherwise 404. They also need `MCP-Protocol-Version`, otherwise 400.

- [ ] **Step 1: Write the failing host-check cases.** Use a scratch port from `HOST_CHECK_HTTP_PORT` or 18830, the Task 4 stub server via `ServerHost.locateOverride`, and an in-memory `TokenVault` that holds `t1` for `claude-code`. HTTP is spoken with a small `URLSession`-free raw-socket client in the check, so the exact bytes are visible.
  - **Listener basics:**
    - `binds 127.0.0.1 only`: `boundAddress == "127.0.0.1:<port>"`.
    - `refused before the body`: headers with `Host: localhost:<port>` and `Content-Length: 10000000`, but no body sent. A 400 arrives within 1 s, and the log has the `Host` refusal.
    - `foreign origin and bad token refused, logged without the token`.
  - **Session behaviour:**
    - `a session answers as the bridge does`: `initialize`, `initialized`, `tools/list`, `tools/call`. Each answer's `result` equals the socket path's for the same stub.
    - `no child before a call`: after `initialize` and `tools/list` on a warm cache, there is no new stub pid, and no `server started (pid` log line since the mark (reuse the deferred-spawn checks' `hostLogMark`, `hostLogLines(since:)` and `isServerStart` helpers).
    - `two sessions get two children`.
    - `unknown session is 404`.
    - `restart gives 404 then a fresh session works`: stop and start the listener, the old id gets 404, and a new `initialize` works.
    - `DELETE ends the child`.
    - `GET close ends after grace`: with `getCloseGrace = 0.5`, open GET, close it, and the stub pid exits within 3 s.
    - `idle session ends`: with `idleLimit = 1`, a session that never opened GET is gone after 3 s.
  - **Bodies, settings and discover:**
    - `large POST body arrives whole`: a 4 MB `tools/call` argument reaches the stub intact.
    - `narrowed setting ends open POST streams`: a `tools/call` the stub delays, then writes switched off and `settingsChanged()`. The open SSE stream ends within 2 s.
    - `in-process surface session tears down`: a session on `screen` (the check's stand-in server) whose GET closes triggers the stand-in's `connectionClosed` within grace + 1 s.
    - `discover without a session`: the answer has status `DiscoverRefusal.status` and code `-32601`.
  - **Source check:**
    - `one listener`: a source check that `HTTPListener.swift` is the only Cupertino file calling `bind(` on an `AF_INET` socket.
- [ ] **Step 2: Run** `make host-check`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - **Package:** add the package and the Makefile kit path.
  - **Listener:** `HTTPListener` per the run order above. Bind with `INADDR_LOOPBACK`. Accept through the kit's `ConnectionBudget` sized 1024, with HTTP keep-alive.
  - **Body cap:** before reading a body, wait for the gate's verdict on the head, then cap the body at 64 MB (413 above).
  - **Port:** read from `@AppStorage("httpPort")`, defaulting to 8830 for release and 8831 for `#if DEBUG`.
  - **Failures:** if the port is taken, log it and keep the unix socket serving, and surface the failure the way `ServerHost.startupError` surfaces its own.
- [ ] **Step 4: Run** `make unit host-check format-swift-check` (host-check 3 times) and `make app`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(http): serve each surface over loopback HTTP, one host session per HTTP session`.

### Task 6: Wiring clients over HTTP

**Files:**

- Modify: `apps/apple/Cupertino/ClientWiring.swift`:
  - `Client` gains `let transport: Transport` (`enum Transport { case http, bridge }`), with the table per the spec and Task 1's results;
  - `entry(for:client:)` builds the HTTP shape;
  - status handling;
  - `switchToHTTP(_:)`;
  - `unwire` revokes the client's token;
  - `configureLocal` uses HTTP;
  - `configureProject` stays bridge.
- Modify: `apps/apple/Cupertino/ClientWiringMerge.swift`: `isOurs` also accepts `{"type":"http","url":"http://127.0.0.1:<any port>/s/<surface>"}`, and `state(…)` compares an HTTP entry's url and header.
- Modify: `apps/apple/Cupertino/ClientWiringTOML.swift`: write `url = "…"` and `http_headers = { Authorization = "Bearer …" }`, one pure-addition hunk.
- Modify: `apps/apple/Cupertino/ClientDetail.swift` (the client pane): show "Wired the old way" with **Switch to HTTP**; show "HTTP clients need Cupertino running; it now opens at login" once switched.
- Test: `scripts/wiring-check.swift`

**Interfaces:**

- Consumes: `HTTPTokens.shared.token(for:)`/`revoke(_:)` (Task 3), and the port from `@AppStorage("httpPort")` (Task 5).
- Produces:
  - `ClientWiring.httpEntry(for surface: Surface, token: String, port: Int) -> [String: Any]`, which returns `["type": "http", "url": "http://127.0.0.1:\(port)/s/\(surface.id)", "headers": ["Authorization": "Bearer \(token)"]]`.
  - `ClientWiring.switchToHTTP(_ client: Client) throws -> ClientWiringMerge.WriteOutcome`.
  - `Status` gains `case oldTransport`, with the copy `"Wired the old way, with a bridge per server. Switch to HTTP to drop them."`

- [ ] **Step 1: Write the failing wiring-check cases** (scratch configs only, as the existing cases do):
  - **HTTP wiring:**
    - `http client wired over http`: Switch to HTTP on Claude Code writes `type`, `url` and `headers` for every enabled surface. The file is mode 0600. It reads back as `.configured`.
    - `bridge entries on an http client are oldTransport`.
    - `bridge client stays bridge`: Claude Desktop is still written with `command`.
    - `codex toml`: the diff against the original is one hunk, pure addition, with `url` and `http_headers`.
  - **Changes that make HTTP entries stale:**
    - `port change is stale`: an entry on port 8830, with the setting at 8840, reads `.stale(…)`.
    - `token change is stale`: an entry whose header token isn't the client's current token reads `.stale(…)`.
  - **Unwiring, folders and silent rewrites:**
    - `unwire revokes`: after unwire the entries are gone and `HTTPTokens.client(for: oldToken) == nil`.
    - `project scope never gets a token`: `configureProject` writes `command` entries and no `Authorization` anywhere in the file.
    - `local scope is http`: `configureLocal` writes HTTP entries under `projects[dir].mcpServers` in a 0600 file.
    - `auto-rewire never switches`: the automatic rewrite on an `oldTransport` client leaves bridge entries in place.
    - `isOurs claims only ours`: an `http` entry on another port with a non-`/s/` path isn't claimed, and Bastion's `http://127.0.0.1:8720/s/prod/stripe` isn't claimed.
- [ ] **Step 2: Run** `make wiring-check`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** per the Files list. `switchToHTTP` also calls `LoginItem.set(true)`, and logs a failure without throwing (the user can turn it on in General). The token is read through `HTTPTokens.shared`. A test vault is injected in `wiring-check` the same way Task 3's check does it.
- [ ] **Step 4: Run** `make wiring-check unit format-swift-check` and `make app`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(http): wire HTTP-capable clients over loopback, on request`.

### Task 7: Settings, Activity and docs

**Files:**

- Modify: `apps/apple/Cupertino/SettingsWindow.swift`. `GeneralPane` (or the pane holding the client list, whichever the fleet convention puts MCP settings in) gains an HTTP port field (1024…65535, restart the listener on change, mark HTTP entries stale) and a per-client **Revoke token** button.
- Modify: `apps/apple/Cupertino/Sessions.swift` (`Session` gains `transport: String`, `"socket"` or `"http"`), plus the two views that show sessions, which show the transport beside the pid.
- Modify: `docs/clients.md` (the transport column, HTTP entries, tokens and the 0600 rule, launch at login), `docs/surfaces.md` if it describes the bridge as the only way in, and `CHANGELOG.md` under Unreleased.
- Test: `make app` builds. `scripts/host-check.swift` gains `http session shows transport http`.

- [ ] **Step 1: Write the failing check** `http session shows transport http` (Task 5's harness, read from `Sessions.shared.live` on the main actor).
- [ ] **Step 2: Run** `make host-check`. Expected: FAIL.
- [ ] **Step 3: Implement** the Files list. The settings follow the existing `@AppStorage` panes. Revoke calls `HTTPTokens.shared.revoke`, and the client then reads `.stale`.
- [ ] **Step 4: Run** `make unit host-check wiring-check format-swift-check`, `pnpm format:check` and `make app`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(http): the port and tokens in Settings, transport in Activity, docs`.

### Task 8: Verify on this Mac (with Olivier)

Installing over the live app breaks every bridge-wired session, so this runs with him, as deferred spawn's Task 7 does.

- [ ] **Step 1:** Run all gates: `make unit host-check wiring-check handshake-check format-swift-check`, `pnpm lint`, `pnpm format:check`.
- [ ] **Step 2:** Install the Debug build the way `use-the-dev-build` describes, and note the result of `pgrep -fc cupertino-bridge`.
- [ ] **Step 3:** Switch Claude Code to HTTP in the client pane. Confirm `~/.claude.json` is 0600 and holds `type: "http"` entries on 8831.
- [ ] **Step 4:** Open a new Claude Code session. Expected: no new `cupertino-bridge`. `apple_mail_list_accounts` answers as before, the Activity window shows the session as `http`, and launch at login is on.
- [ ] **Step 5:** Quit Cupertino while that session is open, then relaunch it. Expected: the session's next call either fails once and recovers on a fresh session, or recovers directly. Record which.
- [ ] **Step 6:** Record the bridge count before and after in the spec. Commit `docs(http): measured on this Mac`.

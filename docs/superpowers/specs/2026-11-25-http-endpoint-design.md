# An HTTP endpoint in place of the bridge

## Why

Every MCP client session that wires Cupertino launches one `cupertino-bridge` relay per surface: 14
processes per Claude Code session, because each config entry is a stdio command. Measured
2026-11-25 on Olivier's Mac: 19 sessions, 266 bridges, 1.29 GB RSS (≈4.8 MB each). Deferred spawn
(`2026-11-25-deferred-server-spawn-design.md`, on main as d2856566) removed most of the node cost;
the bridges are what is left, and they cost the same whether a session ever calls Cupertino or not.

This is for the product, not one Mac: every customer who runs several agent sessions pays it.
(Putting Cupertino behind Bastion would fix this Mac with no code, and was set aside for that
reason: it only helps Macs that run Bastion, and Cupertino would see a single client named
"bastion".)

## Goal

Clients that can reach a loopback URL with a header connect to Cupertino.app over HTTP, with no
process of their own. Everything Cupertino does per connection today (admission, the licence gate,
the deferred phase and its cache, one node child per session, settings narrowing, trial end,
Activity attribution) is done per HTTP session instead, unchanged.

Success: with N Claude Code sessions wired over HTTP, `pgrep -f cupertino-bridge` counts only the
bridges of clients that still need one; every tool answers as it did over the bridge.

## Non-goals

- **Sharing a node child between sessions.** One child per session stays, for the reasons in
  `ServerHost.swift`'s header (state, crashes, write permissions kept apart). Mail and Messages
  watches, `events/stream` and resource subscriptions keep per-client state in the child; sharing
  would make Swift route each push to its client.
- **The 2026-07-28 revision over HTTP.** See "One protocol era over HTTP". Bridge clients keep both
  eras.
- **Claude Desktop, LM Studio, Windsurf.** They keep the bridge. Desktop's config is validated
  against a stdio-only schema (Bastion `docs/clients.md`, "Why Claude Desktop gets a bridge");
  LM Studio and Windsurf have not been seen to carry a header into a URL entry. A row moves to HTTP
  when somebody watches a header carry a token into it.
- **Remote access.** Loopback only, by construction.
- **Retiring the unix socket.** The bridge, the Chat pane (`self`), the desktop lend (`for=`) and the
  store lane all keep using it.

## Anti-goals

- A page in a browser reaching a surface at all (DNS rebinding, a foreign `Origin`), or another
  user on the Mac reaching one. What the token does **not** add, and the doc should not pretend it
  does: a process running as the same user can already reach every surface through the unix socket
  (`serve` admits a plain `cupertino/1 mail` handshake), and can read the 0600 config the token
  sits in. The token keeps out browsers and other users, and names the client; it is not a
  boundary against the user's own processes.
- A client wired over HTTP behaving differently from the same client over the bridge, apart from the
  protocol era it negotiates and the one exception in "When Cupertino is not running".
- Swift learning MCP beyond the transport: it may read the HTTP framing, the `Mcp-Session-Id` and
  `MCP-Protocol-Version` headers, a frame's `id`/`method` as it already does, and a notification's
  `params.progressToken` against the POSTed request's `_meta.progressToken`, which is what routing
  progress to its stream needs. It must not interpret tool calls or subscriptions.
- A token anywhere but the client config it belongs to and that config's backups (Cupertino's own
  `cupertino-backup` copies, and the client's, such as Claude Code's `.claude.json.backup`), or in a
  file Cupertino writes without mode 0600. Never in a file meant to be committed.

## Approaches

1. **HTTP in place of the bridge, one child per HTTP session (chosen).** The app serves Streamable
   HTTP; each MCP session over it gets the same treatment a socket connection gets today. Reuses the
   whole host; costs only the transport.
2. **One shared child per surface and settings, Bastion-style.** Fewest processes, but push features
   need per-client routing in Swift, one crash drops every client of the surface, and deferred
   spawn's per-session model would be undone. Rejected.
3. **Cupertino behind Bastion, this Mac only.** No code, but no product benefit, and the Activity
   window loses every client's name. Rejected (see Why).

## Design

### Listener

- `127.0.0.1` only, by literal address (never `localhost`, which can be made to resolve elsewhere),
  on a fixed port: **8830** for release builds, **8831** for Debug, user-adjustable in Settings like
  the fleet's other loopback servers (Calque, Pochette: `@AppStorage(PreferenceKey.mcpPort)`).
  8830/8831 were unused across `~/Projects/apps` on 2026-11-25; the builder re-checks.
- Path: `/s/<surface>`, one MCP endpoint per surface, so each client config entry stays one surface
  as today and the surface is named by the URL instead of `--server=`. The surface is validated
  against the same closed table as the bridge's handshake; anything else is 404.
- Every request is checked in this order, before the body is read: `Host` is exactly
  `127.0.0.1:<port>`; `Origin`, when present, is refused (no browser has business here); the
  `Authorization: Bearer` token is valid. The order is Bastion's (`Gateway.route`) and is pinned by
  a check, as Bastion's `audit-listener.sh` pins its own.
- What `swift-mcp-kit`'s `MCPKitLoopback` gives as it stands is `HTTPParser` and
  `ConnectionBudget`. Its `RequestGate` does not fit:
  - it accepts `localhost`, `::1` and loopback Origins;
  - it has one fixed `/mcp` endpoint;
  - it refuses GET and DELETE with 405, because the 2026-07-28 revision removed them.

  `KeychainTokenStore` holds one token and cannot tell clients apart, and `HTTPResponse` cannot
  stream. So the gate, a per-client token store and an SSE writer are new: in the kit as
  additions, or in Cupertino, at the builder's discretion. Cupertino adopts the kit for the parser
  either way (`fleet-apple-conventions` covers adding and pinning it).

- **Nothing in the fleet does sessions yet.** Bastion's gateway is prior art for the check order and
  the wiring only: it speaks the stateless revision, never mints `Mcp-Session-Id`, has no GET stream
  and caps itself at 64 connections. Here, every HTTP session may hold a GET stream open for its
  life, so a Mac with 19 Claude sessions holds up to 266 idle connections. The budget is sized for
  that (1024 to start), with keep-alive.

### Tokens

- One token per wired client (Claude Code, VS Code, Cursor, Codex), minted when the client is wired,
  kept in Cupertino's Keychain, and written into that client's config entry as a literal
  `Authorization: Bearer …` header (Codex: `http_headers`). Every config Cupertino writes a token
  into is chmod 0600, backups included.
- A token says which client is asking (it replaces the bridge's `--client=` claim, and is better
  than it: it is verified). It does not limit what the client may reach. Revoking one client's token
  (unwiring it, or a Revoke button in the client pane) signs out that client only.
- Claude Code's per-profile config directories (`CLAUDE_CONFIG_DIR`) each get a token of their own if
  `ClientWiring` already treats them as separate rows; otherwise one token per file.

### One protocol era over HTTP

The HTTP front speaks the 2025 handshake revisions only, as **Streamable HTTP**: `initialize` is
POSTed, its response carries `Mcp-Session-Id`, later requests carry it and `MCP-Protocol-Version`,
`GET` opens the session's server-to-client stream, `DELETE` ends the session. A `server/discover`
POSTed without a session id is answered `-32601`, which is the signal the 2026-07-28 spec gives a
client to fall back to `initialize`.

That is what gives every HTTP client a session, and a session is what maps onto one node child: the
2026-07-28 revision has no session at all over HTTP, so per-session children would have nothing to
key on. The cost is that HTTP clients negotiate the 2025 revision; bridge clients keep both, and the
node servers are unchanged (they still speak both eras on stdio).

**The fallback has only been watched over stdio** (`docs/alternatives.md`: Claude Code 2.1.312 and
2.1.314). Over HTTP, Claude Code reaches Bastion in the modern revision. Nobody has watched a client
fall back over HTTP, and the HTTP status that should carry the `-32601` matters: Bastion's `Dialect`
answers method-not-found on the modern transport as a 404, and clients choose between retrying and
falling back from status and code.

**Plan step 1 is therefore a spike:** a throwaway listener that refuses `server/discover` and
serves `initialize`. It is tried with each of Claude Code, Codex, Cursor and VS Code, recording:

- the status that makes each one fall back;
- whether each sends `Mcp-Session-Id` back and opens a GET stream;
- what each does on a 404 for an expired session (the spec says start a new session).

A client that does not fall back stays on the bridge, so the transport per client is decided by
that measurement, not by this doc.

### Session to child

- An HTTP session is created by its first `initialize` POST, after the request gate passes. It then
  goes through exactly what `serve` and `run` do for a socket today: the surface's enablement, the
  licence gate (`licenceDecision`), the deferred phase (`DeferredSession` and the cache), and on its
  first real call one node child (`startServer`). The session id is random, 128 bits, unguessable,
  and only valid together with the token it was created under.
- The host's per-connection machinery already speaks newline-delimited frames to a client
  descriptor. The design gives each HTTP session an internal duplex byte stream with that shape, so
  `run`, the deferred phase, `ServerRelay`, `RequestObserver` and `deferredSessions` /
  `serverPIDs` / `trialPIDs` work unchanged on it. The HTTP layer is a translator between POST/GET/
  SSE and that stream, and nothing else.
- Client to session: each POSTed JSON-RPC message (or batch member) is written to the stream as one
  line. A POST holding only notifications or responses is answered `202 Accepted` once written.
- Session to client:
  - A response is delivered to the POST that sent its request, matched by `id` within the session.
    A POST holding requests is answered as an SSE stream (`text/event-stream`) that stays open until
    every request in it has its response, then closes. (One stream shape for every request keeps
    the translator simple; a JSON body for a single request is an optimisation the builder may add.)
  - A `notifications/progress` whose `params.progressToken` matches the `_meta.progressToken` of a
    request still open on a POST stream goes to that stream. Every other message with no matching
    open request (other notifications, server-to-client requests) goes to the session's GET stream,
    and is dropped if none is open, which the transport allows. Nothing unrelated is sent on a POST
    stream, per the spec's SHOULD.
- **Session end** (my call, to be confirmed by the spike's per-client observations), whichever
  comes first:
  - `DELETE`;
  - the host stopping;
  - the session's GET stream closing and no POST being open or arriving within a 30 s grace;
  - for a session that never opened a GET stream, 30 minutes with no request.

  The 30 s grace keeps hang-up-bound state (a live recording, a driving session) from outliving its
  client by more than half a minute. A reaped session that comes back gets a 404 and starts a new
  session, as the spec requires; the spike checks each client really does.

- Ending a session ends its internal stream exactly as a socket hang-up does today, on both paths:
  - a node child gets stdin EOF, then the grace period;
  - an in-process surface (`serveInProcess`) runs its existing hang-up teardown:
    `DrivingSession.connectionClosed`, `SoundCapture.connectionClosed`,
    `ShellServer.connectionClosed`, `InProcessCalls.cancelAll`.

  That teardown works because the internal stream is a real descriptor: a socketpair, so `serve`,
  `run` and `serveInProcess` all keep their existing ownership and close-once rules.

- Settings narrowing, `stopSessions(for:)` and trial end reach HTTP sessions through the same maps;
  closing one means ending its internal stream and answering its open HTTP requests with the
  session's end (the client reconnects, as it does after a bridge EOF today).

### Attribution and logs

- The wired client comes from the token, so `RequestObserver`, the connect-traffic log and the
  Activity window name it as they do now, and the cache key's `lazyTools` decision (which depends on
  the client) is taken from it.
- The Activity window shows an HTTP session like a socket one, with its transport noted.
- The log gets one line per refused request (which check refused it, never the token), so a client
  with a stale token is diagnosable.

### Wiring

- `ClientWiring` gains a transport per client: `.http` for Claude Code, VS Code, Cursor and Codex,
  `.bridge` for the rest. An HTTP entry is `{"type": "http", "url":
"http://127.0.0.1:8830/s/<surface>", "headers": {"Authorization": "Bearer …"}}`; VS Code's `servers`
  takes the same shape; Codex's TOML is `url = …` and `http_headers = { Authorization = "Bearer …" }`
  (Bastion `docs/clients.md`).
- Status: a client wired with bridge entries where HTTP is its transport is `stale` ("wired the old
  way"); see Migration. A port or token change makes HTTP entries stale too.
  `ClientWiring`'s "ours" test widens from "a `command` ending in `/Contents/Helpers/cupertino-bridge`"
  to that, or a `url` on Cupertino's loopback port with a `/s/<surface>` path.
- Unwiring removes the entries and revokes the token.
- **Folder wiring (my call):**
  - Project scope (`ClientWiring.configureProject`, a repo's `.mcp.json`) stays on the bridge,
    because that file is meant to be committed and must never carry a token.
  - Local scope (`configureLocal`, `projects[dir].mcpServers` in `~/.claude.json`) moves to HTTP
    with the `claude-code` token, since it lives in the same 0600 file.
  - The success count allows for folder-wired sessions still starting bridges.

### When Cupertino is not running

The bridge starts the app when it is not up (`launchApp` in `CupertinoBridge/main.swift`); an HTTP
entry cannot. Decided by Olivier:

- Wiring any client over HTTP turns on Cupertino's launch at login (`SMAppService.mainApp`, as
  `AppInfo.swift` already offers).
- The client pane says that HTTP clients need Cupertino running.
- A client that connects during an update's relaunch can still miss it once and reconnect. That is
  the one accepted difference from the bridge.

### Migration

Decided by Olivier: nothing is rewritten silently. On the first version with HTTP, a client wired
with bridge entries where HTTP is its transport reads `stale` ("wired the old way"), with a
**Switch to HTTP** action that mints its token and rewrites its entries. Automatic rewiring
(`rewiresAutomatically`) keeps rewriting bridge entries as bridge entries until a later release
makes the switch automatic, once each client has been watched working over HTTP. A downgrade
therefore only meets HTTP entries on clients the person switched by hand. A port change makes HTTP
entries stale the same way, with the same one-click rewrite.

### Bastion

`MCPKitWiring.BastionLink` hands a loopback server to Bastion. Out of scope here; worth a line in
the follow-ups, since Cupertino now has a loopback server to hand.

## Tests

- Unit (`make unit`): the request gate's order and refusals; session-id parsing; the translator
  (POSTed frames to lines, lines to the right POST stream or the GET stream, batches, 202 for
  notification-only POSTs, `server/discover` without a session refused `-32601`).
- `make host-check`: over a real loopback listener on a scratch port, against the existing stub
  server: a full session (initialize, initialized, tools/list, tools/call) answered as over the
  socket; no child before a call (deferral reused); two sessions get two children; DELETE and idle
  timeout end the child; a narrowed setting ends an HTTP session; a bad token, a foreign `Origin`
  and a wrong `Host` are refused before the body is read, and log their reason.
- An audit check in the spirit of Bastion's `audit-listener.sh`: the listener binds `127.0.0.1`
  only, checks run in the order above, and no second listener exists.
- `make wiring-check`: HTTP entries written, read back as `configured`, bridge entries read as
  `stale` for an HTTP client, config files chmod 0600, Codex TOML spliced with a single pure-addition
  hunk.
- On this Mac (with Olivier, as for deferred spawn): wire Claude Code over HTTP, open a session,
  count zero new bridges, call a Mail tool, compare its answer with the bridge's.

## Left to the builder

- Whether the new gate, token store and SSE writer go into `swift-mcp-kit` or into Cupertino.
- The per-session open-stream limits, and the exact timeouts within the bounds above.
- JSON (non-SSE) responses for single requests.
- The Settings UI for the port and token revocation, following the fleet's MCP settings panes.

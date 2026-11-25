# Deferred server spawn

## Why

Every MCP session that wires Cupertino gets its own node process for each of the nine node
surfaces (mail, notes, reminders, calendar, contacts, messages, safari, maps, voice-memos), started
the moment the client connects. Measured 2026-11-25 on Olivier's Mac: 19 sessions, 171 node
servers, 3.14 GB RSS (≈18 MB each), almost all of it the bare V8 runtime rather than anything a
session holds. Most sessions never call a single Mail or Contacts tool: they connect, handshake,
list tools, and idle for hours.

The isolation the host was built around (`ServerHost.swift`, "one accepted connection maps to one
server process") is worth keeping: separate state, separate crashes, settings fixed per process and
enforced by killing the pid. What is not worth keeping is paying for the process before the session
has asked it to do anything.

## Goal

A node server starts only when its session first sends something the host cannot answer from a
recording of what an identical server already said. Until then the session holds a socket and a
few kilobytes of transcript in Cupertino.app, and nothing else.

Success: with the same set of sessions, the node count equals the number of (session, surface)
pairs that have actually called something, and nothing a client sees changes, apart from the first
real call per session per surface taking about 70–95 ms longer (measured cold start to first answer,
mail/calendar/safari, same day).

## Non-goals

- **The bridges.** Claude spawns 14 `cupertino-bridge` relays per session (1.29 GB RSS across 266
  today) because the config entries are stdio commands. Only an HTTP endpoint served by the app
  removes those; that is the follow-up (below), not this change.
- **Putting a started server back to sleep.** Once a session has called Mail, its server lives as
  long as the session does, as today. Idle reaping is a natural next step on top of this design
  (the transcript replay below is exactly what a re-spawn needs), and stays out of this one.
- **The in-process Swift surfaces** (desktop, simulator, screen, sound, shell). They cost no process
  per session already.
- **Persisting the cache.** It is in memory and rebuilt after an app restart: the first connection
  under each configuration pays one spawn.

## Anti-goals

- A client ever receiving an answer that a freshly spawned server, under the same settings and
  build, would not have given byte for byte (apart from the `id`).
- Switching a setting off and a deferred session keeping the tools it had. Narrowing must reach
  deferred sessions exactly as it reaches running ones today.
- Swift code that knows MCP: which protocol era, what `initialize` negotiates, what a tool list
  holds. The host learns answers by recording them, never by composing them.

## Approaches

1. **The host composes the handshake and lists in Swift.** Rejected. The servers speak two eras
   (2025 `initialize`, 2026-07-28 `server/discover` with per-request `_meta`, see
   `packages/core/src/cli.ts`), the SDK negotiates between them, `withTrimmedListing` and the lazy
   facade reshape `tools/list`. Re-implementing that in Swift is a second copy that drifts, which
   is the reason `SurfaceCatalog` asks servers instead of knowing.
2. **Record and replay (chosen).** The host answers a short whitelist of read-only methods from
   results it recorded off a real server, keyed by everything those results can depend on. On the
   first request outside the whitelist, or a cache miss, it spawns the server, replays the session's
   transcript into it, drops the replies the client already has, and becomes the relay it is today.
   It knows nothing about MCP beyond "a frame is a JSON line with a `method` and maybe an `id`".
3. **One shared node per surface answering the handshake for everybody, spawning per-session
   servers on demand.** Rejected: it adds a long-lived process per surface and an internal protocol
   between it and the host, to buy what approach 2 gets from a dictionary.

## Design

### What clients send before their first real call

Bastion's activity log (2026-11-25) shows Claude Code sessions connecting with `tools/list`,
`resources/list` and `prompts/list`, after the handshake Bastion does not log, and nothing else: no
`logging/setLevel`, no `resources/subscribe`, no `subscriptions/listen`. That is the whole saving,
and the whitelist below covers it.

Codex and Claude Desktop are not measured. **Plan step 1** adds a log line per session listing the
methods it sent before its first non-list request, per wired client, and runs it for a day before
the deferral is switched on. A client whose connect traffic falls outside the whitelist simply
spawns at connect, as today: correct, just no saving for that client. Holding a listen or a
subscribe open in the host until spawn is out of scope (it would need the host to understand them,
against anti-goal 3).

### The cache (`HandshakeCache`, new file)

- **Key**: surface id; the app's build (`CFBundleVersion`), the node binary path and the server
  script path; the full spawn environment dict that `ServerLocator.environment` returns
  (allowWrites, every gate, gate values, `LAZY_TOOLS`, socket vars); **the session's handshake**
  (the `params` of its `initialize` or `server/discover`, canonicalised), because the SDK fixes the
  era and its codec per instance from the handshake and Mail and Messages register differently by
  era; the method; and the request's own `params`, canonicalised (sorted keys) with known-volatile
  fields removed (`_meta.progressToken`, and whatever else plan step 1's recordings show to vary).
  Keying on the environment rather than on `SpawnConfig` is deliberate: every registration
  condition in `packages/*/src/server.ts` reads config from env, so the environment is the complete
  input. **Over-keying is safe** (a miss is today's behaviour); under-keying is the only way this
  design can be wrong, which is why the key takes whole dicts rather than chosen fields.
- **Off for development builds** (`ServerBinaries.isDevelopment`). A dev `cli.js` imports shared
  chunks and `@mgcrea/mcp-apple-core` from `node_modules`, so rebuilding `core` changes answers
  without changing anything the key sees. Release servers only change with an app update, which
  restarts the app and empties the cache. A hidden default turns the cache on in a dev build for
  testing.
- **Value**: the whole response frame of a success, as node wrote it; on a hit the host swaps in the
  client's `id` (number or string, verbatim) and leaves every other byte alone. Errors are never
  recorded.
- **Whitelist**: `initialize`, `server/discover`, `tools/list`, `prompts/list`, `resources/list`,
  `resources/templates/list`, `ping`. `ping` is learned and keyed like the lists, never composed:
  in the 2025 era node answers it with its own bytes (`{"result":{},"jsonrpc":"2.0","id":…}`),
  which the host then serves; in the 2026-07-28 era node refuses it with `-32601`, an error is
  never recorded, so a modern-era ping starts the server, as it reached one before. A ping is
  part of the transcript and is replayed like any other line.
- Bounded by bytes, not entries: a full listing is up to ~25 KB (Mail, writes on; ~106 KB across
  eight surfaces, per `facade.ts`), so a cap of a few MB with LRU eviction. Never invalidated
  otherwise.

### Settings are frozen at connect

The environment is computed once, when the session connects, and used for the cache key and,
later, for the spawn: `run` takes that precomputed environment instead of reading
`SpawnConfig.current` at spawn. So the server that starts is the one whose answers the client
already holds. This matches a running server today, which also keeps its connect-time settings.
That includes gate *values* such as Safari's cookie hosts, which `SpawnConfig` doesn't carry and
narrowing doesn't see, for deferred and running sessions alike. Changing that is a separate fix.

### The deferred phase (in `ServerHost.run`)

`run` no longer spawns at once. It reads client frames with the existing `FrameSplitter`, feeds
each to the `RequestObserver` as the pump does today, and appends it to the session's
**transcript**:

- A client **notification** (`notifications/initialized`, `notifications/cancelled`, …) is
  transcript only.
- A whitelisted **request** that hits the cache: the host writes the recorded result back with the
  client's `id` copied verbatim (number or string) and adds the id to `answeredByHost`.
- **Anything else** (a miss, `tools/call`, `resources/read`, `subscriptions/listen`,
  `logging/setLevel`, an unknown method) starts the server:
  1. spawn as today (same `Process`, pid bookkeeping, `settingsChanged()` re-check), with the
     environment frozen at connect;
  2. write the whole transcript, then the triggering frame, then any bytes still buffered in the
     splitter, to the child's stdin, in client order;
  3. start the two pumps as today. The server→client pump runs a **reply filter** while
     `answeredByHost` is non-empty: a response whose id is in the set is compared with the frame
     the host served (ids aside), then dropped and removed from the set; everything else passes.
     Once the set is empty the filter retires and the pump is byte-for-byte today's.
  4. Responses to whitelisted requests that missed are recorded into the cache as they pass.

Replaying the cached list calls too, not only `initialize`, keeps the child's state identical to a
server that served the session from the start, and costs microseconds. It also makes **every
spawn a check of the cache**: a replayed answer that differs from what the host served means the
key is missing an input. The host then logs an error naming the surface and method, evicts that
key, and turns the cache off for that surface until the app restarts. In a Debug build it asserts.
The client has already received the stale answer, so the log says so too.

A client that hangs up during the deferred phase ends the session with no process ever started.

### Settings, trial and switching off

A deferred session registers in a new locked map, `deferredSessions: [UUID: (fd, surface,
spawnEnv, onTrial)]`, the counterpart of `serverPIDs`:

- `settingsChanged()` and `stopSessions(for:)` apply the same narrowing rule to it and
  `shutdown(fd, SHUT_RDWR)` the ones that lost something. The client sees the EOF a killed server
  gives it today and reconnects under the new settings.
- `endTrialSessions()` closes deferred trial sessions the way it closes `trialClients`.
- The move from deferred to running takes the entry out of `deferredSessions` before the pid goes
  into `serverPIDs`, then calls `settingsChanged()` once more, the same close-the-window pattern
  `run` already uses after `process.run()`.

The store lane and the desktop lend check a peer pid against `serverPIDs`; only a running server
can ask for either, so neither changes.

### Activity window and logs

A deferred session appears in the Activity window as connected with no pid, and gains its pid when
the server starts. (How it looks is the builder's call; the session count must stay right.) The
log gets one line at connect ("session open, server deferred") and one at start ("first `<method>`,
starting server (pid N)").

### Tests

- Unit: key canonicalisation (volatile fields dropped, key order irrelevant, any env change a miss);
  the deferred phase against a stub child: cache hit, miss then record, transcript order on spawn,
  the reply filter dropping exactly the host-answered ids, pipelined frames, hang-up while deferred.
- **Under-keying, the one that guards the anti-goal.** Comparing two identical servers only catches
  nondeterminism. A missing key input gives the same wrong answer on both and passes. So for each of
  the nine surfaces, writes on and off, both eras, the test holds the key fixed and varies what the
  key leaves out: client ids, the order and repetition of list calls, the volatile `_meta` fields,
  and `clientInfo` where the canonical handshake would not see it. A fresh server must give the same
  answers every time. A test that varies an input that *is* in the key must get a miss.
- The runtime check above, exercised: a stub child that answers one replayed list differently must
  log the mismatch, evict the key and disable the cache for that surface.
- Narrowing: switching writes off closes a deferred session; the reconnect lists the narrower tools.
- On this Mac, through the installed bridge over stdio (see memory: the agent shell has no FDA but
  the bridge does): handshake + list leaves `ps` with no new node; a `tools/call` starts one and
  answers as before.

### Left to the builder

- Where `HandshakeCache` and the deferred phase live (a new type beside `ServerHost`, or inside it).
- The cache's byte cap and eviction details.
- The exact list of volatile `_meta` fields, from plan step 1's recordings.
- The Activity window's presentation of a deferred session.
- The name of the hidden default that enables the cache in a dev build.

## Follow-up: an HTTP endpoint instead of bridges

Separate design, after this lands. Cupertino.app would serve MCP over streamable HTTP on a loopback
port (or a path under its socket directory, if the clients can reach one), with the client's
identity and surface in the URL instead of `--client=` and `--server=`, and `ClientConfig` would
write `"type": "http"` entries. That removes the 14 relays per session. The permissions argument
for the bridge is unchanged: the app is still the responsible process for everything it spawns.
The open questions there are authentication for a loopback listener any local process can reach,
and which wired clients accept HTTP entries.

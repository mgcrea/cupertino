# MCP Events (SEP-3415): field report from Cupertino's Mail and Messages servers

This is a draft field report for the MCP Triggers & Events Working Group on SEP-3415, written from an experimental implementation of the Events extension on Cupertino's Mail and Messages MCP servers.

## SDK v2 2.4.0 findings

Cupertino's servers run on `@modelcontextprotocol/server` 2.4.0 ("SDK v2") over stdio, behind `serveStdio` and a transport wrapper. Before building `events/stream`, a spike (`scripts/spike-events-stream.mjs`) checked whether the SDK holds a long-lived custom request open. The spike registers `events/stream` through the three-argument `setRequestHandler(method, { params, result }, handler)` with zod 4 schemas. The handler sends `notifications/events/active`, then one `notifications/events/heartbeat` per second, each stamped with `_meta["io.modelcontextprotocol/subscriptionId"]` set to the request id, and resolves only when `ctx.mcpReq.signal` aborts. A client spawns it, opens a modern-era (2026-07-28) connection with per-request `_meta` and no `initialize`, sends `events/stream`, and later sends `notifications/cancelled`.

All four questions come out yes, so no workaround is needed and no transport wrapper is required for events.

1. **The request stays open.** It was still open, with no response written, after 5 s and after 70 s (`SPIKE_HOLD_MS=70000`, past the SDK's 60 s default request timeout). At 70 s the client had seen 1 `active` frame and 69 heartbeats.
2. **Heartbeats reach stdout.** `ctx.mcpReq.notify(...)` frames with method `notifications/events/*` are written to stdout intact, `_meta` subscription id included. `listenRouter` classifies only the change notifications; every other outbound notification is `'passthrough'`, which is what the frames hit. Sample frame:
   `{"jsonrpc":"2.0","method":"notifications/events/heartbeat","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":"s1"}}}`
3. **A cancel aborts the handler's signal.** After `notifications/cancelled` with `requestId`, the handler's `ctx.mcpReq.signal` aborted (server log: `aborted id=s1 after 4 heartbeats`), the handler returned, and no further frame for that id reached stdout in the following second. The SDK writes no response for a cancelled request, so the client must not wait for one. The handler's own cleanup (clearing timers, closing store handles) must hang off the signal.
4. **No timeout or cap ended a stream early.** Eleven concurrent streams on one connection all stayed open and kept heartbeating for 3 s, and all aborted on cancel. The SDK enforces no per-connection limit on custom requests: `serveStdio`'s `maxSubscriptions` (default 1024) governs `subscriptions/listen` only. The limit of 10 streams per connection therefore has to be enforced by the server itself, answering the eleventh with `ResourceExhausted` (`-32025`, `data.limit: "streams"`, `data.max: 10`).

Two smaller notes for the implementation:

- The first request pins the era; the spike used a `tools/list` (answered `-32601`, no tools registered) as a warm-up. Events work the same on a connection opened by any modern-era request.
- Not measured by the spike: a cancel racing an in-flight write. A handler that writes after an await should check `signal.aborted` first; Task 4 tests this.

Reproduce with `node scripts/spike-events-stream.mjs` (about 11 s; the script resolves the SDK through `createRequire` anchored at `packages/core/package.json`, so run `pnpm install` first).

# MCP Events (SEP-3415): field report from Cupertino's Mail and Messages servers

This is a draft field report for the MCP Triggers & Events Working Group on SEP-3415, written from an experimental implementation of the Events extension on Cupertino's Mail and Messages MCP servers.

The two event types are `mail.received` (Mail's `Envelope Index`) and `messages.received` (Messages' `chat.db`). Both offer `poll` and `push` and not `webhook`, because the servers are local and run over stdio. Arguments are a sender filter (`from`, `domains`, and on Mail `mailboxes`), the payload is the envelope only (never a body or message text), `eventId` is the store's own stable id (Mail's `global_message_id`, the Messages `guid`), and the cursor is `v1.<dev>-<ino>.<rowid>`: the store file's identity and a SQLite ROWID. Everything is behind `APPLE_MAIL_ALLOW_EVENTS` and `APPLE_MESSAGES_ALLOW_EVENTS`, off by default, and only on 2026-07-28 connections.

## Conformance results

Graded with the conformance suite's draft PR, modelcontextprotocol/conformance#521, from `panyam/mcpconformance` at `23c7c2d`, which grades SEP-3415 at `2ec39b9c`. The suite reaches a server only by URL, so `scripts/events-conformance.mjs` puts Mail's own server factory behind SDK v2's `createMcpHandler` on `http://127.0.0.1:3917/mcp`, over a temp fixture index with one matching message inserted every 2 s. Messages was not graded by the suite; it shares the engine and is covered by its own unit tests and a stdio end-to-end poll.

The suite ran with `EVENTS_ARGUMENTS={"mail.received":{"domains":["acme.com"]}}` (see [the sender-required rule](#the-sender-required-rule-against-minimalarguments)), and `events-push` with `--timeout 90000`.

| Scenario                     | Pass | Fail | Untestable | Skipped (not applicable) |
| ---------------------------- | ---: | ---: | ---------: | -----------------------: |
| `events-discovery`           |   14 |    0 |          1 |                        3 |
| `events-discovery`, gate off |    2 |    0 |          0 |                       16 |
| `events-poll`                |   28 |    2 |          7 |                        1 |
| `events-push`                |   13 |    2 |         13 |                        0 |

"Untestable" counts the rows the suite reports as not testable, whether it grades them `FAILURE` or `WARNING`. "Pass" includes the suite's `wire-schema-valid` row, which validated every message the server sent against the draft schema, with no violations.

Excluded: the `events-webhook` and `events-webhook-delivery` scenarios were not run, because webhook delivery needs a public HTTPS receiver and these servers are local; the suite's own `sep-3415.yaml` also lists 39 excluded rows (client obligations and the non-normative SDK appendix), which no server scenario emits.

### The four failures: HTTP routing headers

`sep-3415-mcp-name-missing-rejected` and `sep-3415-mcp-name-mismatch-rejected` fail in both `events-poll` and `events-push`: an `events/poll` or `events/stream` with no `Mcp-Name` header, or one naming another event, is served (HTTP 200) instead of being refused with HTTP 400 and `-32020`.

These rows grade the HTTP layer, which here is the test harness and SDK v2 2.4.0, not the server's events code. Cupertino serves stdio only, where there are no headers. The cause is in the SDK: `createMcpHandler` validates `Mcp-Name` from a fixed table, `MCP_NAME_HEADER_SOURCE`, which lists `tools/call`, `prompts/get`, `resources/read` and `tasks/*` and has no way for an extension to add its methods. The SEP's "Streamable HTTP: Routing Headers" section adds `events/poll`, `events/stream`, `events/subscribe` and `events/unsubscribe` to that list, so an SDK that implements the SEP needs either those four rows or an extension hook. We did not paper over it in the harness: a hand-written header check there would make the rows green without saying anything about the SDK or about Cupertino.

### Untestable and skipped rows

None of these is a failure of ours. Each one, with what would make it gradeable:

- **Needs a fixture control the harness does not expose** (`events-push`): `stream-error-is-recoverable` (`events_conformance_yield_error`), `stream-gap-resends-active` and `truncated-false-when-no-replay` (`events_conformance_yield_gap`), `stream-terminated-ends-subscription`, `stream-final-result-shape`, `stream-final-result-timing` and the push `result-type-complete` (`events_conformance_terminate`), and the four `removal-*` rows (`events_conformance_catalog`). Our catalog is fixed and our streams end only on cancel, so `terminated` and the removal rows describe behaviour these servers never have. A gap and an upstream error do happen (an index rebuild, an unreadable index) and are covered by `packages/core` tests; a harness control that replaced or unlocked the fixture index could let the suite grade them too.
- **Needs a server-imposed limit to trip** (`error-resource-exhausted`): we cap streams at 10 per connection, but `createMcpHandler` builds a fresh server instance for every HTTP request, so a per-connection cap is never reached over this harness. Over stdio the eleventh stream is refused with `-32025`, `data.limit: "streams"`, `data.max: 10`, as unit tests show.
- **Needs a type that declines a mode** (`poll-mode-unsupported`, `stream-mode-unsupported`): both of our types offer poll and push.
- **Needs a scalar property in `inputSchema`** (`poll-invalid-arguments`, `error-invalid-params`): the suite only builds a wrong value for a `string`, `boolean`, `integer` or `number` property, and every property of ours is an array. Probed by hand against the harness, the server answers `-32602` for `{}`, for `{"from": 12345}`, for `{"domains": "acme.com"}` and for an unknown mailbox. The suite could cover array properties by sending a string, and could treat a violated `anyOf` (here `{}`) as known-invalid.
- **Needs a stale cursor** (`truncated-returns-fresh-cursor`, `max-age-ms-sets-truncated`, `replay-ceiling-sets-truncated`): cursors are opaque, so the suite cannot mint one. Probed by hand: a cursor from another store (`v1.1-2.3`) answers `truncated: true` with a fresh head cursor; this store's cursor wound back to the first row with `maxAgeMs: 1` answers no events, `truncated: true` and the head cursor; with `maxAgeMs: 10000` it answers the last 10 s of matches and `truncated: true`.
- **Needs a backlog** (`poll-next-poll-ms-ignored-when-has-more`): the suite starts from now. Probed by hand, the wound-back cursor returns 50 events with `hasMore: true`.
- **Single page** (`list-pagination`): two servers, one event type each, so `events/list` never pages.
- **Skipped as not applicable**: `capability-list-changed-flag` and `list-changed-notification` (no `listChanged`, the catalog is fixed), `truncated-false-when-no-replay` in `events-poll` (our types replay), and `fallback-method-not-found` while the gate is on. With the gate off, that row passes: the server declares nothing and answers `events/list` with `-32601`. The other 16 rows of that run skip because the extension is not offered.

### One row that caught a defect the fixture hid

`sep-3415-occurrence-timestamp` passed, but only because every fixture row has a date. It checks every occurrence it receives for an ISO 8601 instant, and both adapters sent `timestamp: ""` for a row with no date (`dateReceived` null in Mail, `date` null in Messages). An undated row inserted into the harness's fixture came back as `{"eventId":"999999","timestamp":"",...}`, which the row would have failed. The SEP makes `timestamp` a required ISO 8601 string, so this was ours, and it is fixed: an undated row's occurrence now carries the time it was scanned, on the server's clock, while the payload's own `dateReceived` or `date` stays null, so a client can tell a stand-in time from a received date. The sent date, where there is one, would be another stand-in; we have no measurement yet of how often a real index holds undated rows.

### What the harness changed

The SDK's `createMcpHandler` writes a `: keepalive` SSE comment every 15 s by default. With that default, `stream-heartbeat-not-sse-comment` warned (2 comment frames), because the SEP rules the comment form out for an events stream. The harness sets `keepAliveMs: 0`; the stream's own `notifications/events/heartbeat` data frame, every 25 s, keeps it alive, and the row then passes. An SDK that serves events over Streamable HTTP probably wants that comment off for `events/stream`, or the SEP could say whether a transport keepalive alongside the heartbeat is acceptable.

## The sender-required rule against `minimalArguments`

`mail.received` refuses an empty filter with `InvalidParams`: there is no subscription to all of someone's mail. The descriptor says so as `anyOf: [{required: ["from"]}, {required: ["domains"]}]`, because either one is enough. The suite derives its arguments with `minimalArguments`, which reads only a top-level `required`, finds none, and sends `{}`.

Run that way, without `EVENTS_ARGUMENTS`, the two scenarios grade almost nothing: `events-poll` has 1 pass, 1 fail and 36 untestable rows, and `events-push` 1 pass, 3 fail and 24 untestable, all from the bootstrap answering `-32602 A subscription needs a sender`. The override exists for this case and fixed it at no cost to us. Two things would help the next server that limits its firehose the same way:

- The suite could take the first `anyOf` / `oneOf` branch's `required`, and build values for `array` properties (`examples`, or one item of the item schema). Both are needed: even with `anyOf` read, an array property gives `minimalArguments` nothing to go on.
- The SEP could say that a server MAY refuse an unfiltered subscription with `InvalidParams`, and that a descriptor SHOULD carry `examples` for its arguments. A privacy-minded local source will want to refuse a firehose, and today that reads as a server that cannot be graded.

## What a local, stdio, ROWID-cursored source taught us

**Cursor identity across rebuilds.** A ROWID is only a position within one file. Mail rebuilds its `Envelope Index` from scratch when it decides to, with fresh ROWIDs, and a cursor from the old file would then name a position in an unrelated sequence. The cursor therefore carries the file's device and inode: if they no longer match, or the ROWID is above the store's head, the server answers `truncated: true` with a fresh head cursor, as the SEP's gap rules ask. The same rule covers a cursor minted by another surface (a Mail cursor sent to Messages), which we answer as a gap and not as `InvalidParams`; only a cursor that does not parse is `InvalidParams`. The SEP's "Gaps and `truncated`" paragraph fit this without change. An open stream gets a second `notifications/events/active` with `truncated: true` and keeps going.

**`maxAgeMs` against a store with full history.** Mail keeps every message, so a week-old cursor has a real backlog behind it. We honour `maxAgeMs` the way the SEP's second bullet allows: scan forward from the cursor and drop matches whose time is older than the floor, setting `truncated` when a matching row was dropped. Three things surfaced:

- ROWID order is arrival order, not time order. Mail syncs old mail late, and is expected (not yet measured) to give a moved message a new row with its old date, so a message that arrived in the index a second ago can fall under the floor and be dropped. "Older than `maxAgeMs`" means older by its `timestamp`, which here is the received date, not the moment it reached the store. That is what the SEP says; it may not be what a client asking for "the last five minutes" expects.
- A scan is bounded at 1,000 rows per call, so a week-old cursor with a small `maxAgeMs` still walks the backlog in steps, returning `hasMore: true` and no events until it reaches the floor. The SEP's third option, resetting to now with `truncated: true`, would be cheaper; seeking by date is possible on Mail (`date_received` is indexed) but is not done yet.
- A row with no date is never dropped by the floor, since it has no time of its own to compare; its `timestamp` is the scan time.

**Mail must be running for Mail to resolve names.** The mailbox lookup comes from Mail itself over AppleScript. With Mail closed and the lookup never loaded, a poll returns no events and does not move the cursor past rows it could not judge, and a subscription that names `mailboxes` is refused with `-32603`, since a closed Mail is the server's state and not the client's mistake. A mailbox created since the lookup was last refreshed is the same problem in small: its rows cannot be judged until Mail is asked again. A poll and a stream both stop before the first such row, returning what came before it with a cursor that has not passed it, and the server refreshes the lookup before the next poll or tick, which then delivers the row. A row whose mailbox the index does not list at all, which no refresh can make known, is held back only once and then excluded. Until the lookup has loaded, every poll or tick asks Mail again; once it has, the lookup is refreshed otherwise only when the index's head has moved and the lookup's TTL has passed, so an idle subscription costs no AppleScript round trip however long it lives. The stop costs latency, one poll interval or one trigger. Only a refresh that fails leaves the row to be judged with the mailboxes already known, which excludes it, as a watch does.

**Stateless HTTP and a local source.** Over stdio, one server instance serves a connection and keeps its store handle and mailbox lookup. Behind `createMcpHandler`, every poll is a fresh instance that opens the index and loads the lookup again (one AppleScript round trip against a real Mail). Per-connection limits, like our 10 streams, also mean nothing there. Neither matters for these servers, but an SDK hosting a stateful local source over Streamable HTTP will want per-process state outside the per-request instance.

## SDK v2 2.4.0 findings

Cupertino's servers run on `@modelcontextprotocol/server` 2.4.0 ("SDK v2") over stdio, behind `serveStdio` and a transport wrapper. Before building `events/stream`, a spike (`scripts/spike-events-stream.mjs`) checked whether the SDK holds a long-lived custom request open. The spike registers `events/stream` through the three-argument `setRequestHandler(method, { params, result }, handler)` with zod 4 schemas. The handler sends `notifications/events/active`, then one `notifications/events/heartbeat` per second, each stamped with `_meta["io.modelcontextprotocol/subscriptionId"]` set to the request id, and resolves only when `ctx.mcpReq.signal` aborts. A client spawns it, opens a modern-era (2026-07-28) connection with per-request `_meta` and no `initialize`, sends `events/stream`, and later sends `notifications/cancelled`.

All four questions come out yes, so no workaround is needed and no transport wrapper is required for events.

1. **The request stays open.** It was still open, with no response written, after 5 s and after 70 s (`SPIKE_HOLD_MS=70000`, past 60 s, the SDK's default timeout for requests it sends; nothing times out a request it serves). At 70 s the client had seen 1 `active` frame and 69 heartbeats.
2. **Heartbeats reach stdout.** `ctx.mcpReq.notify(...)` frames with method `notifications/events/*` are written to stdout intact, `_meta` subscription id included. `listenRouter` classifies only the change notifications; every other outbound notification is `'passthrough'`, which is what the frames hit. Sample frame:
   `{"jsonrpc":"2.0","method":"notifications/events/heartbeat","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":"s1"}}}`
3. **A cancel aborts the handler's signal.** After `notifications/cancelled` with `requestId`, the handler's `ctx.mcpReq.signal` aborted (server log: `aborted id=s1 after 4 heartbeats`), the handler returned, and no further frame for that id reached stdout in the following second. The SDK writes no response for a cancelled request, so the client must not wait for one. The handler's own cleanup (clearing timers, closing store handles) must hang off the signal.
4. **No timeout or cap ended a stream early.** Eleven concurrent streams on one connection all stayed open and kept heartbeating for 3 s, and all aborted on cancel. The SDK enforces no per-connection limit on custom requests: `serveStdio`'s `maxSubscriptions` (default 1024) governs `subscriptions/listen` only. The limit of 10 streams per connection therefore has to be enforced by the server itself, answering the eleventh with `ResourceExhausted` (`-32025`, `data.limit: "streams"`, `data.max: 10`).

Two smaller notes for the implementation:

- The first request pins the era; the spike used a `tools/list` (answered `-32601`, no tools registered) as a warm-up. Cupertino's end-to-end tests open their connections with `events/poll` or `events/stream` directly, and those work too.
- Not measured by the spike: a cancel racing an in-flight write. A handler that writes after an await has to check `signal.aborted` first; the stream engine does, and its tests cover it.

Reproduce with `node scripts/spike-events-stream.mjs` (about 11 s; the script resolves the SDK through `createRequire` anchored at `packages/core/package.json`, so run `pnpm install` first).

The conformance run added two HTTP findings, described above: `createMcpHandler` does not validate `Mcp-Name` on `events/*` and has no hook for an extension to ask it to, and its default SSE keepalive is the comment form the SEP rules out for an events stream.

## On the open questions

**1. How should the client SDK expose events to agent frameworks?** Our evidence is about what is missing. Nothing local consumes events: Claude Code 2.1.311 has no trace of the extension, the same host never subscribes to `notifications/resources/updated` (which is why Cupertino's watches reach no one there), and its `claude/channel` route needs the 2025 handshake and a development flag. A server can be fully conformant and still have no path to the model. From the server side, two things shaped our payload and may help the guidance: a mail subject or a sender name is untrusted text written by a stranger, so we send the envelope only and leave the body to a tool call the model makes deliberately; and a client that injects events as context needs a way to mark them as data, not instructions, which the SEP's "Event payloads are untrusted data" section asks of it but no SDK yet provides.

**2. Should resource subscriptions and `list_changed` be re-expressed as events?** We have both mechanisms on the same source. Mail's watches (a `watch` tool creating a resource, then `notifications/resources/updated` on change) and `mail.received` read the same index through the same trigger. The events version was simpler to get right: poll is stateless, the cursor gives replay and gap detection for free, and there is no server-side registry of watch ids to keep per connection. The watch version needs a read round trip after every update, because `notifications/resources/updated` carries only a URI. A reserved `mcp.resource.updated {uri}` event would keep that round trip; it would still gain cursors and poll. Running both side by side cost us a second store handle per connection, which is the parallel mechanism the question names.

**5. Can one subscription span several event names with one cursor?** Our cursor is already per store, not per event type: any event type drawn from one `Envelope Index` would share the `<dev>-<ino>.<rowid>` position, so option (b) would cost us nothing on the server. But our two types live on different servers with different stores, so we have no case today that needs it, and option (a) is what we do: each stream has its own cursor, and the streams of one event type on a connection share one file trigger. Weak evidence for (b), none against it.

Posting this is Olivier's call.

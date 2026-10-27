# MCP Events on Mail and Messages (experimental)

- **Date:** 2026-10-27
- **Branch:** `feat/mcp-events`
- **Status:** design, awaiting approval
- **Builds on:** [incoming watches](2026-10-25-incoming-watches-design.md), which this does not replace

## Why

Watches tell a host that something arrived through `notifications/resources/updated`, and Claude Code
never subscribes to it (measured 2026-10-27, see the watches spec, Measure first item 1). The
`claude/channel` route works only on the 2025 handshake and behind a per-session development flag.

The protocol's own answer is [SEP-3415, the Events extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
(`io.modelcontextprotocol/events`), a draft from the Triggers & Events Working Group, defined for
2026-07-28 only. Its own example event type is `email.received` with a `from` filter, which is a
watch. Nothing consumes it locally yet: no official SDK implements it, Claude Code 2.1.311 has no
trace of it, and ChatGPT takes only the webhook mode, which needs a remote server.

So this is experimental work with three purposes:

1. Have Mail and Messages ready for the first client that polls or streams events over stdio.
2. Grade the implementation against the Working Group's conformance suite.
3. Give the Working Group a field report from a real local source over stdio, while the draft can
   still change.

## Goals

- **Two event types:**
  - `mail.received` on the Mail server;
  - `messages.received` on the Messages server.
- **Two delivery modes over stdio, on 2026-07-28 connections:**
  - `events/list`;
  - `events/poll`;
  - `events/stream`, with the notifications that go with it: `notifications/events/active`, `/event`, `/heartbeat`, `/error` and `/terminated`, and cancellation by `notifications/cancelled`.
  - `/terminated` is never sent: the server never ends a stream while the connection lives, so a stream ends only on the client's cancel or with the connection.
- **Arguments,** reusing the watch filter:
  - Mail: `from`, `domains`, `mailboxes`;
  - Messages: `from`, `domains`.

  The `inputSchema` requires at least one of `from` and `domains`, through `anyOf` with `required`. There is still no subscription to all mail.

- **Payload:** the watch read row, under a `payloadSchema`.
  - Mail: `ref`, `mailbox`, `senderAddress`, `senderName`, `subject`, `dateReceived`.
  - Messages: `id`, `chat`, `handle`, `date`.

  Envelope only, never a body or message text.

- **Occurrence fields:**
  - `eventId` is the store's stable id: Mail's `global_message_id`, the Messages `guid`.
  - `timestamp` is the received date, or for a row with none the time it was scanned, on the server's clock; the payload's own date stays null.
- **Exclusions:** the same as watches. Own addresses, Sent, Drafts, Junk and Trash, own messages, tapbacks and group events never produce an event.
- **Gates:** `APPLE_MAIL_ALLOW_EVENTS` and `APPLE_MESSAGES_ALLOW_EVENTS`, both off by default.
  - On: the modern instance declares `capabilities.extensions["io.modelcontextprotocol/events"]: {}`.
  - Off: nothing is declared, and every `events/*` method answers `-32601`, as the SEP's fallback requires.
- **Grading:** the conformance suite's `events-discovery`, `events-poll` and `events-push` scenarios. The results go into the field report.

## Non-goals

- **Webhook delivery** (`events/subscribe`). It needs a public HTTPS receiver, and these servers are local. Every webhook-only check is reported as excluded, with that reason.
- **The 2025 era.** The SEP is not defined there. A legacy connection declares nothing and answers `events/*` with `-32601`.
- **Watches.** They stay exactly as they are, with their tools, resource and gates.
- **Client integration.** No Claude Code wiring, and no change to the app's UI.
- **`notifications/events/list_changed`.** The event types are fixed, so `listChanged` is omitted.
- **Filters on subject or body, and attachments.**

## Anti-goals

- **A firehose.** An empty filter is refused with `InvalidParams`, even under the conformance harness, which instead passes arguments through the suite's `EVENTS_ARGUMENTS` override.
- **Searching the past.** A `null` cursor means now. Replay goes forward from a client's cursor only, bounded by `maxAgeMs` and by the scan limits below.
- **Any change with the gates off.** With both flags unset, every server behaves byte for byte as it does today.

## How

### Cursor

The cursor is opaque to clients, and versioned: `v1.<dev>-<ino>.<rowid>`. The store identity is the dev and inode of the index or `chat.db` file, which the watch code already reads (`fileIdentity`).

- **Store replaced or rebuilt:** if the identity no longer matches, or the ROWID is above the store's head, the server answers `truncated: true` with a fresh cursor at the head. This replaces the watches' rebuild reset guard.
- **Malformed cursor:** answered with `InvalidParams`.

### Poll

Poll is stateless. Each `events/poll` scans `source.since(rowid, scanLimit)` and applies the filter and scope as `WatchRegistry.read` does.

- **What it returns:** up to `maxEvents` matches. The default is 50, and the cap is 50.
- **`cursor`:** the last row examined, not the last match.
- **`hasMore`:** set when the match cap or the 1,000-row scan limit stopped the scan.
- **`nextPollMs`:** 10,000 (builder's call).
- **`maxAgeMs`:** replay starts at the later of the cursor and the first row received within `maxAgeMs`, with `truncated: true` when that floor passes the cursor.

### Push

`events/stream` stays pending until the client cancels it.

- **First message:** `notifications/events/active`, with `cursor` and `truncated`.
- **Delivery:** events go out as the existing file trigger fires. That is the same trigger and the same source as a watch tick, but per stream and from the stream's own cursor. On Mail, the events source always holds back at a row in a mailbox the lookup has never seen, for a poll as for a stream, and the lookup is refreshed before the next poll or tick, which then judges the row; otherwise the lookup is refreshed only once the index's head has moved and its TTL has passed.
- **Heartbeat:** at least every 30 s (builder picks 25 s), carrying the scanned cursor.
- **Store problems:**
  - A store that cannot be read sends `notifications/events/error`, and the stream stays open.
  - A rebuild sends a fresh `active` with `truncated: true`.
- **Cancellation:** stops the stream and releases the trigger.
- **Limit:** at most 10 concurrent streams per connection, matching watches. An 11th is refused with an error.

### Code shape

- **Core holds the engine** (builder's call on file names):
  - Pure, testable parts: descriptors, the cursor codec, the poll scan over `ArrivalSource` with filter and scope, and occurrence mapping.
  - Registration: methods on `McpServer` through SDK v2's three-argument `setRequestHandler(method, {params, result}, handler)`.
- **Each surface supplies an adapter:**
  - the descriptor;
  - argument normalization: `normalizeFilter`, and Mail's `mailboxes` resolved to scope keys through the existing mailbox lookup, with an unknown mailbox answered `InvalidParams`;
  - row-to-payload mapping;
  - its source and trigger, from the existing watch services and their own store handles.
- **Errors:** the SEP's provisional codes (`-32023` to `-32027`), named as its Error Handling table names them:
  - `NotFound` for an unknown event name;
  - `Unsupported` for a stream on an event type without push (`events/subscribe` is not registered and answers `-32601`);
  - `InvalidParams` for bad arguments.

### Spike first

Before building on it, verify four things about SDK v2 2.4.0's `serveStdio` on a modern connection:

- it holds a long-lived request open;
- it delivers `notifications/cancelled` to that request's abort signal;
- it passes `notifications/events/*` through the listen router;
- no concurrent-request cap or request timeout ends the stream.

Each failure becomes a field-report finding plus a local workaround, for example a transport wrapper like the existing `withTrimmedListing`.

## Testing

- **Unit:** the engine against fake sources, in the style of the watch registry tests: the cursor codec, poll paging, `maxAgeMs`, truncation, and exclusions.
- **Stdio end to end:** in the style of `scripts/mcp-era.test.mjs`, using Mail's built `dist` and a temp fixture index:
  - list, then a poll bootstrap;
  - an arrival, then resuming from a cursor;
  - a stream showing active, event, heartbeat and cancel;
  - the gate off answering `-32601`, and a legacy connection answering `-32601`.
  - Messages gets the same coverage at unit level, plus one end-to-end poll.
- **Conformance:**
  - A test-only script, not shipped, serves Mail's server factory over Streamable HTTP on `127.0.0.1`, with a fixture index, a stub `osascript`, and a row inserter that keeps events happening.
  - The suite runs from the PR's branch pinned at `panyam/mcpconformance@23c7c2d`, which grades SEP-3415 at `2ec39b9c`, cloned into a scratch folder.
  - It is given `EVENTS_ARGUMENTS={"mail.received":{"domains":["acme.com"]}}`.
  - The rows on HTTP routing headers (`Mcp-Name`) grade the harness and not stdio; the report says so.

## Docs

- **Configuration:** the two flags in the README and package configuration tables, and in `surfaces.json` if environment flags are declared there.
- **Explanation:** a section in `docs/prompts-and-resources.md` beside Watches.
- **CHANGELOG:** an Unreleased entry marked experimental, regenerated into `Changelog.swift`.
- **Field report:** a draft in `docs/superpowers/reports/`. It covers:
  - conformance results per row;
  - what fitting a local, stdio, ROWID-cursored source taught us;
  - the SDK v2 spike findings;
  - comments on the SEP's open questions where we have evidence: 1 (how events reach the model), 2 (resource subscriptions as events), and 5 (multi-name subscriptions);
  - the sender-required versus minimal-arguments tension.

  Posting it to the Working Group is Olivier's call.

## Left to the builder

File layout, `nextPollMs`, the exact heartbeat interval, the cursor's encoding details within the shape above, and how the push stream shares the trigger with watches.

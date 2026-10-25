# Incoming watches: design

Date: 2026-10-25. Status: approved for planning once Olivier signs off.

## Why

Olivier's framing: an MCP session is open, and something in it says "tell me when mail arrives from
these people or these domains". Today no Cupertino surface can say anything unprompted. Every
surface is request and response, nothing watches a file, and the only `notifications/` the repo
sends are the app's own clients sending `initialized` (`SurfaceCatalog.swift:312`,
`MCPChatClient.swift:171`).

[alternatives.md](../../alternatives.md) records the neighbouring gap ("No channel lane") as
undecided. This spec decides the protocol-native half of it. It does not decide the channel half
(see Non-goals).

## What the protocol allows, as of 2026-07-28

Subscriptions were not dropped in the 2026-07-28 revision. They were reshaped:

- `resources/subscribe` / `resources/unsubscribe` and the HTTP GET stream are replaced by
  **`subscriptions/listen`**, one long-lived request whose `notifications.resourceSubscriptions`
  names the URIs to watch. The server acknowledges with `notifications/subscriptions/acknowledged`,
  then sends `notifications/resources/updated` tagged with `io.modelcontextprotocol/subscriptionId`.
  It works on stdio; the id is how several subscriptions on one channel are told apart.
- **The notification carries the URI and nothing else.** The client re-reads the resource to learn
  what changed.
- **The server holds no subscription state across reconnections.** A client that reconnects must
  listen again.
- **`resources/list` must not vary per connection or as a side effect of other requests.** A watch
  created by a tool call therefore cannot appear in the list.
- **Protocol sessions are gone.** Cross-call state is carried by "explicit, server-minted handles
  passed as ordinary tool arguments" (SEP-2567). That is exactly what a watch is.

SDK v2 (`@modelcontextprotocol/server` 2.4.0, read from the published package) implements this:
`serveStdio` owns a `StdioListenRouter` that matches each outbound
`notifications/resources/updated` against the open subscriptions by **exact URI**, and passes
change notifications straight through on a 2025-era connection. A server that calls
`sendResourceUpdated({ uri })` gets correct delivery in both eras for free.

**What the router does not do is tell the server what anyone subscribed to.** The filter is kept
inside `serveStdio` and never surfaces. This decides the design: a URI that encodes the filter
(`…/incoming?from=alice@x.com`) cannot work, because the server would never learn which filters to
evaluate. The filter has to reach the server some other way, and a tool call is the way the spec
itself recommends.

## The design

### A tool registers the watch and returns a handle

```text
apple_mail_watch({ from?: string[], domains?: string[], mailboxes?: string[] })
  → { watch: "w_7f3a", uri: "cupertino://mail/watch/w_7f3a", filter: {…}, cursor: 198604 }

apple_mail_unwatch({ watch: "w_7f3a" })
```

- **A sender filter is required.** `from` (exact addresses, case-insensitive) or `domains` (matches
  `@acme.com` and any subdomain, `@eu.acme.com`) must be non-empty. There is no "all incoming mail"
  watch. The filter is also the trust boundary: it says, in a tool call the user can see, whose
  mail may arrive in the session unasked.
- **`mailboxes` defaults to every mailbox except Sent, Drafts, Junk and Trash**, recognised by the
  mailbox URL's last path component. Mail stores no mailbox roles in the index. **Mail from the
  account's own addresses never matches either.** Gmail files sent mail under All Mail, so the
  mailbox rule alone would let every reply Olivier sends to a watched domain fire his own watch.
- **The handle is the server's.** Its id is minted in-process. It lives exactly as long as the stdio
  connection that created it, which is the server process: no daemon, nothing to clean up when the
  client disconnects. At most 10 watches per connection; the 11th is refused with the count.
- **Neither tool is write-gated.** Both are reads with a side effect inside the process only. But
  both are behind their own switch (below).

### The client subscribes to the handle's URI

The host sends `subscriptions/listen` with `resourceSubscriptions: ["cupertino://mail/watch/w_7f3a"]`
(2026-era) or `resources/subscribe` with the same URI (2025-era). When a matching message arrives,
the server sends `notifications/resources/updated` for that exact URI.

**The model does not do this step.** `subscriptions/listen` is a message the host sends, not a tool
the model can call. A host that never subscribes still gets a useful watch: reading the URI is a
cheap "what came in from these people since I last asked", but nothing will be pushed. See Measure
first, item 1.

### Reading the handle returns what arrived

`cupertino://mail/watch/{id}{?after}` is registered as a resource template, so it is readable
without appearing in `resources/list`.

```json
{
  "watch": "w_7f3a",
  "filter": { "domains": ["acme.com"], "mailboxes": "default" },
  "cursor": 198611,
  "messages": [
    {
      "ref": "…",
      "mailbox": "INBOX",
      "senderAddress": "jo@acme.com",
      "senderName": "Jo",
      "subject": "Quote",
      "dateReceived": "…"
    }
  ],
  "more": false
}
```

- **Envelope metadata only.** The same fields `search_messages` already returns. A body is a
  separate `get_message` call, so mail content never enters the session just because it arrived.
- **`after` is the client's cursor, not the server's.** Without it, the read starts where the watch
  was created. Matches come oldest first, at most 50, and `cursor` is the last row _scanned_, not
  the last row matched, so reading again with `after=cursor` resumes exactly. `more` says to do
  that. The server keeps no "what this client has seen", which would be the per-connection read
  state the spec rules out.
- **An unknown id is `-32602` (resource not found)**, not a `degraded` result. After a reconnect
  the handle really does not exist, and not-found is what tells a client to call `watch` again.
  Failures of a watch that does exist (the index unreadable, Full Disk Access revoked) go through
  `guardedRead` like every other surface resource.

### Detecting arrival

One watcher per server process, started by the first watch and stopped by the last unwatch.

- **Trigger:** `fs.watch` on the `MailData` directory, filtered to `Envelope Index` and
  `Envelope Index-wal`, debounced 500 ms. A **60 s fallback poll** runs as well, since FSEvents may
  coalesce events or drop them.
- **Query:** one statement per trigger for all watches together: `m.ROWID > cursor`, joined to
  `addresses` and `mailboxes` exactly as `envelope.ts` already joins them. It is opened
  **`mode=ro`, never the `immutable=1` fallback**: `immutable` is WAL-blind (`sqlite.ts`), so the
  newest mail is precisely what it misses. If only `immutable` opens, the watch tool refuses with
  that reason rather than watching blind.
- **Cursor:** arrival order is ROWID order, which is what "came in" means. Mail can sync an old
  message late, and that should still fire, so `date_received` is not the cursor. SQLite reuses the
  top ROWID if that row is deleted before the next insert. The watcher keeps the refs of the last
  poll's rows, so a reused id is compared by ref and not silently skipped.
- **Mail has to be running.** The index only changes when Mail.app fetches. The `watch` result says
  so when Mail is not running, rather than staying quiet.

### Messages, second

The same shape on `chat.db`: `apple_messages_watch({ from: string[] })`, with
`cupertino://messages/watch/{id}`. Differences:

- `from` is handles, resolved by the same resolver `handles` already goes through in `store.ts`.
  `domains` applies to email handles only.
- `is_from_me = 0`, and tapbacks (`associated_message_type != 0`) are excluded by default.
- ROWIDs are reused constantly here (`ref.ts`), so the dedup set is by `guid`, which the refs
  already use.

The watcher, the handle table, the cursor/dedup logic and the legacy subscribe bookkeeping live in
core (`packages/core/src/watches.ts`), so the second surface is mostly a query and a filter.

### Switches

`allowWatches`, OFF by default, per surface (`APPLE_MAIL_ALLOW_WATCHES`,
`APPLE_MESSAGES_ALLOW_WATCHES`). It is a surface gate in `surfaces.json`, the same kind as
`allowCodes`, so the app's surface pane shows it with no new UI. The cost: two more tools in every
listing, and a file watcher in a process that had none. When it is off, the tools and the watch
template are not registered and `resources.subscribe` is not declared. It is independent of
`exposePrompts`: a watch is useless without its resource, so the gate registers both.

### Both eras

- **2026-era:** `serveStdio`'s router does the matching. The server calls `sendResourceUpdated` for
  each watch that fired.
- **2025-era:** the router passes change notifications through unsolicited, so the server has to
  gate them itself. It registers `resources/subscribe` / `resources/unsubscribe` handlers, keeps
  the subscribed URIs, and only notifies for those.

### In the app

Notifications already flow through the stdio pumps untouched. Two things need doing in
`RequestObserver`:

- **A `subscriptions/listen` request is answered only when it ends.** Today it would sit in
  `waiting` as a call that never returns. It should be logged as a subscription, opened and closed.
- **Each `notifications/resources/updated` is recorded** in the Activity log and the audit file, so
  "what did Cupertino push into this session" has the same answer as "what did it call".

## Measure first

1. **Does Claude Code do anything with an update?** A minimal server, one resource, one update a
   minute, in both eras. The two public reports found (anthropics/claude-code #7252, #47823) say it
   ignores or drops `notifications/resources/updated`, and both are closed without a stated fix.
   The answer doesn't block this spec: watches are useful to any SDK client and to `MCPChatClient`.
   But it decides whether the README may say "push" next to Claude Code.
2. **Does `fs.watch` fire for `Envelope Index-wal` under the grant the server actually runs with**,
   and how long from Mail showing a message to the event? If it does not fire, the poll becomes the
   trigger and its interval drops to 15 s.
3. **Cost of the watch query** on the 181k-message index: run against the `ROWID > cursor` range it
   should be a few ms, since it is an index range. Measure it anyway.
4. **Does SDK v2's `McpServer` answer `resources/subscribe` on its own** when `subscribe: true` is
   declared? The 2.4.0 package carries the request schemas and no handler, so it looks like the
   server has to register one. Confirm against the installed version. The era is not a guess
   either: `serveStdio` passes `{ era: "legacy" | "modern" }` to the server factory.

## Non-goals (v1)

- **`claude/channel`.** If Measure first item 1 says Claude Code drops updates, a channel adapter on
  this same watcher is the follow-up that actually wakes a session. It needs its own access-control
  and permission-relay design, so it is a separate spec.
- **Running a command, a Shortcut or a webhook on arrival** with no session open. That needs a
  watcher outliving every client, which means the app and not the npm servers.
- Watches surviving a reconnect, persisted handles, watches shared across clients.
- Watching bodies or attachments, or filtering on subject or content.
- Calendar, Reminders, Notes. Same core, if anyone asks.

## Sequencing

After the MCP v2 plan's Phase 2 (modern serving), not before: `subscriptions/listen` exists only on
v2's `serveStdio`, and writing the 2025-era half against v1 first would mean writing it twice.
Mail, then Messages, one PR each.

## Docs this changes

- [prompts-and-resources.md](../../prompts-and-resources.md): its rule says "a resource that is
  never the same twice is a tool call wearing a URI", which is why Messages registers no
  inventory. A watch is the exception that rule needs to name. It is a URI because
  `subscriptions/listen` can only name a URI, and it is kept out of `resources/list` for the
  spec's reasons above.
- [alternatives.md](../../alternatives.md): "No channel lane" stays a gap, but stops being entirely
  undecided. The protocol-native half is decided here.
- Each surface's `guide.ts`: what a watch is, that the host and not the model subscribes, and that
  `after` is the client's to keep.

# Verifying against the real index

The unit tests build a real SQLite database from the captured schema, so they cover the SQL itself —
but they cannot prove the queries match _your_ Mail. These commands do. They need a terminal that
has Full Disk Access, and they are all read-only.

```bash
pnpm build
npx @modelcontextprotocol/inspector node dist/cli.js
```

Then call, in order:

```jsonc
apple_mail_diagnostics        {}
apple_mail_search_messages    { "query": "invoice", "limit": 5 }
apple_mail_count_messages     { "account": "Google", "mailbox": "INBOX" }
apple_mail_get_thread         { "ref": "<a ref from the search>" }
```

## What to check

| Check                                 | Expected                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `diagnostics.lanes.index`             | `live`, with `indexMode: "ro"`                                                  |
| `diagnostics.lanes.schemaFingerprint` | `77aa2cd3a55b` on macOS 26.6 / Mail V10                                         |
| `search_messages` latency             | sub-second, versus 74 s for the Apple Events equivalent                         |
| `count_messages` on a **Gmail** INBOX | `unread.index` non-zero — 0 here means the labels join regressed                |
| `count_messages` unread               | `unread.index` and `unread.applescript` will often disagree; the index is right |
| a `ref` from search                   | passes straight into `set_message_flags` with no re-lookup                      |

The Gmail row is the one worth actually doing. It is the check that fails loudly if the labels
predicate ever breaks, and on this machine the naive query returned 0 against 51,128 real messages.

## Without the inspector

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apple_mail_diagnostics","arguments":{}}}' \
  | node dist/cli.js 2>/dev/null | tail -1
```

---

# Verifying Reminders

Same idea, different questions. Reminders' Apple Events lane already covers the core model, so what
needs proving is that the **index lane is live and is the one answering** — that is where the
all-day flag and subtasks come from.

Needs a terminal with Full Disk Access. All read-only.

```bash
pnpm build
npx @modelcontextprotocol/inspector node packages/reminders/dist/cli.js
```

## What to check

| Check                                       | Expected                                                         |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `diagnostics.server.lanes.index`            | `live`, with `indexMode: "ro"`                                   |
| `diagnostics.server.lanes.storeFingerprint` | `278b001e3c55` on macOS 26.6                                     |
| `diagnostics.store.candidates`              | more than 1 — several `.sqlite` files is normal; largest wins    |
| `list_reminders` → `source`                 | `index`. `apple-events` means the store was not opened           |
| `list_reminders` → `dueAllDaySource`        | `index`. `heuristic` means the same                              |
| a timed reminder                            | `dueAllDay: false` — **the one worth actually doing**, see below |
| `get_reminder` on a parent                  | `subtasks` populated; `attachments` and `alarms` non-null        |

The all-day row is the Gmail row of this surface. Reminders populates **both** `due date` and
`allday due date` for every dated reminder — 144 of 144 on the probed library — so a server that
infers all-day from the property being present marks _every_ dated reminder as all-day. Pick a
reminder you know is due at a specific time and confirm it says `dueAllDay: false`.

Then check a subtask's parent: `container()` throws on every reminder over Apple Events, so a
populated `subtasks` array proves the index join is working and not merely that the store opened.

## The degraded run

Revoke Full Disk Access and restart. Everything should still work:

| Check                       | Expected                                                         |
| --------------------------- | ---------------------------------------------------------------- |
| `lanes.index`               | `unavailable`, with a reason naming the System Settings pane     |
| `lanes.applescript`         | still `live`                                                     |
| `list_reminders`            | still returns reminders, `source: "apple-events"`                |
| `dueAllDaySource`           | `heuristic`                                                      |
| `get_reminder` → `subtasks` | `[]`, and `attachments` / `alarms` **null** — unknown, not empty |

That run is the try-before-you-grant path. It is a feature, not a degradation — the only things
that should disappear are the ones the permission genuinely buys.

## Without the inspector

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apple_reminders_diagnostics","arguments":{}}}' \
  | node packages/reminders/dist/cli.js 2>/dev/null | tail -1
```

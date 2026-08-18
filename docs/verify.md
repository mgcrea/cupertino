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

# @mgcrea/mcp-apple-messages

Model Context Protocol server for **Apple Messages** — iMessage, SMS and RCS — on macOS.

> **Unofficial.** Not affiliated with Apple. It reads the message store already on your Mac.

## The surface with no second lane

Every other server in this family has two ways in and picks the faster one. This one has exactly
one, and that is measured rather than assumed: **every read through Messages' scripting dictionary
fails.** It answers `Application isn't running` even while `NSRunningApplication` reports it running,
because it lives as a windowless background process that declines to wake for a script.

So **Full Disk Access is mandatory, not an upgrade.** Without it this server does nothing at all —
there is no degraded mode to fall back to.

Apple Events is still here, for exactly one verb. `send` is the only command in the dictionary that
works, which makes this the one surface where Apple Events is a **write lane and nothing else** —
and therefore the one where the write gate is also a permission boundary. With
`APPLE_MESSAGES_ALLOW_WRITES` off, no Apple Event is ever sent and no Automation grant is ever
requested. There is no read to leak through the gate, because there is no read.

## One message in thirty-two is invisible to SQL

`chat.db` keeps message text in two places, and the one you would reach for is the _incomplete_ one.
Measured on a real 97,416-message store:

|                               |                  |
| ----------------------------- | ---------------- |
| Messages                      | 97,416           |
| With a plain `text` column    | 94,043           |
| With an `attributedBody` blob | 97,094           |
| **Blob only — no text**       | **3,051 (3.1%)** |

The blob is an `NSArchiver` _typedstream_, and no amount of SQL reaches inside one. A server that
selects `text` returns nothing for one message in thirty-two, silently and with no error to notice.

**And that ratio is a historical average.** Measured through this server against a live store: 2016
through 2025 are ~99% plain `text`, and then it stops — **from March 2026 every message is blob-only.**
Apple appears to have dropped the column between late February and late March. So the decoder is not
handling an edge case; it is the only way to read anything recent, and a server without one would
report that the conversation stopped in February.

This package decodes it. The decoder was written against ground truth — `NSArchiver` still ships on
macOS 26 and is what wrote those blobs, so archiving a known string produces a fixture nobody has to
guess at — and then validated against the whole store using `text` as an oracle on 94,043 labelled
rows:

**100.000% agreement. 97,094 of 97,094 blobs decoded, none failed.** ~2 ms per thousand.

`decodeAttributedBody()` is exported from the package root.

## Names come from Contacts

`chat.db` records a correspondent as `+15551234567` and nothing else, so this server depends on
[`@mgcrea/mcp-apple-contacts`](../contacts) to turn that into a name. Every correspondent carries
both, plus a `resolution` status.

**`unknown` is normal, not an error.** Measured against a real address book: 97.6% of the last year's
messages resolve, but only ~84% of the twenty-five busiest correspondents — so roughly one in six of
the people you talk to most has no contact card. Code that treats an unresolved handle as a failure
will be wrong several times on any real inbox.

If the Contacts permission has not been granted, resolution is skipped and handles come back raw.
That is a capability downgrade reported through `diagnostics`, never a throw.

## Tools

Read: `diagnostics`, `list_chats`, `list_messages`, `search_messages`, `get_message`.

Write: `send_message`, and that is the whole dictionary. `sdef` lists three commands — `send`,
`login` and `logout` — and the other two would sign the user out of iMessage on every device they
own. There is no edit, delete, mark-as-read or reaction verb to expose, so **everything this server
can show you, it cannot change.**

`send`'s direct parameter is typed `file` OR `text`; only the text form ships. A tool that hands an
arbitrary local path to a remote person is an exfiltration primitive whose blast radius, unlike the
text form's, is not bounded by what the model can say.

### Sending, and how it reports what it sent

Prefer a `chatRef` from `list_chats` over a raw handle. Messages refuses to enumerate participants
for a script, so an existing conversation is the only target that can be addressed reliably — but
`chat` carries an id, and the store holds a guid for every conversation. **The read lane picks the
target and the write lane addresses it by id**, which is the only arrangement where neither lane has
to do the thing it cannot.

Apple Events then hands back nothing at all — no identifier for what it sent. So the client takes a
timestamp before the send and polls `chat.db` for the outgoing row:

| `reconciliation` | meaning                                                    |
| ---------------- | ---------------------------------------------------------- |
| `matched`        | the row was found; the result carries a real message ref   |
| `pending`        | Messages accepted the send and has not written the row yet |
| `unavailable`    | there was no existing chat to look in                      |

**`pending` is not a failure. Do not retry it** — the message was sent, and a retry sends it twice.

**No send has yet been executed against a live Messages.** The lane is written from the dictionary
and from the store, and its tests run against a fake `osascript` on purpose. `docs/messages.md`
records exactly what that leaves open; the safe way to measure it is a message to your own handle.

## Configuration

| Variable                            | Default |                                         |
| ----------------------------------- | ------- | --------------------------------------- |
| `APPLE_MESSAGES_RESOLVE_CONTACTS`   | on      | Look names up in Contacts.              |
| `APPLE_MESSAGES_INDEX_MODE`         | `auto`  | `auto` \| `ro` \| `immutable` \| `off`. |
| `APPLE_MESSAGES_STORE`              | auto    | Explicit store path.                    |
| `APPLE_MESSAGES_DEFAULT_RANGE_DAYS` | `30`    | Window when only a start is given.      |
| `APPLE_MESSAGES_MAX_RESULTS`        | `50`    | Default page size.                      |
| `APPLE_MESSAGES_ALLOW_WRITES`       | off     | Register `send_message` at all.         |
| `APPLE_MESSAGES_SEND_RECONCILE_MS`  | `5000`  | How long to wait for the sent row.      |

## Notes that will bite you

- **Dates do not fit in a JavaScript number.** Every date column is nanoseconds since 2001 —
  eighteen digits, past `Number.MAX_SAFE_INTEGER` — and `node:sqlite` _throws_ rather than
  truncating. Swallowed by a `try`/`catch` that throw looks exactly like "this column is empty", and
  it is how a probe once reported "no dates present" for all seven columns across 97,414 messages.
  Every query here divides in SQL so the integer never reaches JavaScript.
- **Tapbacks are rows in the message table.** 2,788 of them on the measured store, and a reader that
  does not filter them renders `Liked "see you at 8"` as if somebody typed it. They are excluded
  from conversations by default and reported on the message they target.
- **Search covers the blob-only messages.** A `LIKE` pass over the column (16 ms across 97,416 rows)
  plus a decode pass over the 3,051 rows SQL cannot see (~6 ms). Completeness turned out to be
  nearly free; a search that silently omitted 3% would not have been.
- **Refs are GUIDs, not rowids.** SQLite reuses a deleted row's id, and Messages deletes constantly,
  so a rowid handed out in one turn can resolve to a different message two turns later — plausible,
  wrong, and silent.
- **A send cannot be taken back, and nothing here pretends otherwise.** There is no unsend, no draft
  and no preview in the dictionary; `send` delivers. The tool is gated on `ALLOW_WRITES`, requires
  `confirm: true`, and its description says all of this, because the model calling it is the last
  thing between a wording and a recipient.

## Licence

[MIT](LICENSE).

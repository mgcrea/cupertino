# Apple Messages, measured

Measured by `scripts/probe-chat-db.mjs` on macOS 26.6, 97,414 messages across 1,076 handles.
Regenerate on each new macOS release. Output is redacted: counts, timings, lengths, column names and
DDL only — no message text, no handles, no chat names.

**Conclusion: buildable, and more expensive than it looks.** The store is rich, fast and complete.
But three things have to be budgeted before a single tool is written — a typedstream decoder, BigInt
date handling, and the fact that Apple Events hands back no identifier for anything it does. None of
them is discoverable from the schema alone.

The third one is no longer a blocker but it did shape the design: see
[the send lane](#the-send-lane) below, where the file lane both chooses the target and finds the
sent row, because the write lane can do neither.

## The numbers

|                         |                                                      |
| ----------------------- | ---------------------------------------------------- |
| Store                   | `~/Library/Messages/chat.db`                         |
| Size / WAL              | 216,629,248 bytes / ~3.6 MB                          |
| Opened                  | `mode=ro` in ~1 ms                                   |
| Schema fingerprint      | `87b01c58a631` — 104 objects, 24 tables              |
| `message` columns       | 95                                                   |
| Messages                | 97,414                                               |
| Attachments             | 17,529 rows, 20,514 files on disk                    |
| Handles by service      | SMS 796, iMessage 265, RCS 15                        |
| `LIKE` search on `text` | **16–21 ms**, 69,836 hits — 27 indexes, no FTS table |
| Apple Events read lane  | **none** — every attempt failed                      |

A live WAL is present, so `mode=ro` is required for the same reason as Mail and Notes: `immutable=1`
would skip it and silently miss recent traffic. `mode=ro` succeeded on the first attempt, so the
ladder in `packages/core/src/sqlite.ts` never had to fall back.

Search needs no work. 16 ms over 97k rows with 27 existing indexes means there is no
index-vs-Apple-Events tradeoff to litigate here — the only question on this surface is capability.

## There is no fallback lane, and that is now measured

`docs/distribution.md` predicted "send only, no reads" from the dictionary. Confirmed by running it:

| Attempt          | Result                                    |
| ---------------- | ----------------------------------------- |
| `chats()`        | `Error: Application isn't running.`       |
| `chats.id()`     | `TypeError: M.chats.id is not a function` |
| `participants()` | `Error: Application isn't running.`       |
| `buddies()`      | `Error: Application isn't running.`       |
| messages of chat | `Error: Application isn't running.`       |

**Messages answers "Application isn't running" while `NSRunningApplication` reports it running.** It
lives as a windowless background process and declines to wake for a script. The liveness check and
the app's own answer disagree, and neither is lying — this looks exactly like a broken probe and is
not. It is one more way the surface has no read lane.

The consequence for `docs/distribution.md`'s "try before you grant" principle: it cannot be honoured
here. Every other surface degrades to a slower server without Full Disk Access. Messages degrades to
no server. The README row and the fallback table should both say so plainly rather than leaving it to
be re-derived.

## 3.1% of messages have no `text` at all

The blocking finding, and the reason this probe existed:

|                                   |                     |
| --------------------------------- | ------------------- |
| Messages                          | 97,414              |
| With non-empty `text`             | 94,049              |
| With a populated `attributedBody` | 97,092              |
| **Empty `text`, populated blob**  | **3,043** (3.1%)    |
| Neither                           | 322                 |
| Blob bytes                        | avg 446, max 34,460 |

The three buckets reconcile exactly — 94,049 + 3,043 + 322 = 97,414 — so the 3.1% is real and not a
query artifact.

The archive header is `04 0B streamtyped 81 E8 03`, the NSArchiver **typedstream** format. Not
`bplist00`, not gzip, and not the protobuf that Notes turned out to hold. A decoder for it is a
prerequisite rather than an enhancement: a server that reads only `text` returns nothing for one
message in thirty-two, silently and with no error to notice.

Note also that 97,092 rows carry a blob while only 94,049 carry text. **The blob is the norm and
`text` is the redundant copy**, not the other way round. A tool that treats `attributedBody` as the
exceptional case has the relationship backwards.

This is Notes' `ZDATA` again, found the same way. It is worth repeating the lesson that document
records: an earlier claim there was wrong because it sampled `LIMIT 1` and landed on an outlier.
Sample more than one row before describing a blob format.

### The 3.1% is a historical average, and it is now ~100%

Measured through the built server against the live store, sampling the newest 100 messages in each
window:

| Window      | from `text` | from the decoder |
| ----------- | ----------- | ---------------- |
| 2016        | 149         | 0                |
| 2019        | 145         | 5                |
| 2021        | 148         | 2                |
| 2023        | 149         | 1                |
| 2025-08     | 100         | 0                |
| 2026-01     | 100         | 0                |
| 2026-02     | 94          | 6                |
| **2026-03** | **0**       | **99**           |
| 2026-06     | 1           | 99               |
| 2026-08     | 0           | 100              |

**Apple stopped populating the `text` column between late February and late March 2026.** Everything
since lives only in `attributedBody`.

So the headline number below — 3,051 of 97,416, one message in thirty-two — is an average over a
decade of history, and it badly understates what the decoder is for. On this machine every message
from the last six months is blob-only. A Messages server without a typedstream decoder would not be
missing an edge case; it would report that the conversation stopped in February.

That also means the ratio will keep climbing on its own, and any future probe run should expect it.
(Sampling caveat: each window returns its newest 100, so a busy month is sampled from its last few
days. That is enough to locate the transition, not to date it precisely.)

### The decoder, written against ground truth

`scripts/lib/typedstream.mjs`, with 19 offline tests in `typedstream.test.mjs`.

The format was not inferred. **`NSArchiver` is deprecated and still ships on macOS 26 — and it is what
wrote every blob in this store** — so archiving an `NSAttributedString` with a known plaintext gives a
fixture nobody has to guess at:

```
04 0b "streamtyped" 81 e8 03      header
84 01 40                          START, type "@" — an object
84 84 84 12 "NSAttributedString" 00
84 84 84 08 "NSString" 01
84 01 2b  0c "Hello, world"       START, type "+", then the bytes
86                                END
```

Three things a reading of the format would have got wrong, each caught by a fixture:

- **Lengths are in BYTES of UTF-8.** `Café ☕️ déjà vu — 日本語` declares 36 for 21 UTF-16 units. Slicing
  by character count desynchronises the walk and corrupts everything after it.
- **Past 127 the length takes the `0x81` int16 form** — measured at `81 90 01` for a 400-byte payload.
- **`84 01 2b` cannot be scanned for.** `0x84` is a valid UTF-8 continuation byte, so that sequence
  occurs inside real messages. Only a structural walk that consumes each payload by its declared
  length stays in sync.

**Text only, and that is now measured rather than assumed.** Attribute values are back-_referenced_
rather than inline — an attachment archives as
`92 84 98 98 22 "__kIMFileTransferGUIDAttributeName" 86`, where `98` indexes the object table — so
reading them means rebuilding that table. And nothing needs it: the only attribute worth having is the
file-transfer GUID, and attachments are already reachable relationally through
`message_attachment_join`, 17,529 rows. The placeholder character (U+FFFC) survives in the text, so
the position is not lost either.

### Measured against the whole store

The fixtures prove the decoder against blobs Apple's archiver wrote today; they prove nothing about
blobs written by a decade of iOS versions. So `pnpm probe:messages` runs it over every one and checks
it against `text`, which is populated on 94,043 rows — **94k labelled examples, free.**

|                           |                                          |
| ------------------------- | ---------------------------------------- |
| Blobs walked              | 97,094 in **183 ms** (2 ms per thousand) |
| Decoded                   | **97,094 — none failed**                 |
| **Agreement with `text`** | **94,043 / 94,043 — 100.000%**           |
| Blob-only rows recovered  | **3,051 of 3,051**                       |
| Carry attribute runs      | 97,081 (not decoded, by design)          |
| Decoded to empty          | 13                                       |

Classes reached on the way to the text: `NSAttributedString` and `NSString` on every blob,
`NSMutableAttributedString` / `NSMutableString` on 66,107 of them.

**The first run failed twice, and both were this decoder's bug rather than the format's.** Both
reported "token limit exceeded" — and both had ALREADY read their text, 936 and 2,095 bytes, before
exhausting the walk on attribute runs whose result is discarded anyway. Two real messages were being
thrown away for work nobody wanted.

The walk now stops at the first payload. That took failures to zero, cut the time by a third, and is
visible in the class list: `NSDictionary`, `NSNumber` and `NSURL` used to appear and no longer do,
because they only ever lived in the attribute runs after the text. Pinned by a regression test that
buries a known-good blob under 200 KB of rubbish — what follows the text must not be able to affect
the text.

Budget for the server: **~2 ms per thousand messages**, so decoding a 500-message page costs about a
millisecond. There is no reason to store the decoded text or to decode lazily.

## The dates do not fit in a JavaScript number

Every populated date column is **nanoseconds since 2001-01-01**, 18 digits, latest value in 2026:

| Column           | Epoch             | Latest |
| ---------------- | ----------------- | ------ |
| `date`           | apple-nanoseconds | 2026   |
| `date_read`      | apple-nanoseconds | 2026   |
| `date_delivered` | apple-nanoseconds | 2026   |
| `date_edited`    | apple-nanoseconds | 2026   |
| `date_played`    | apple-nanoseconds | 2018   |
| `date_retracted` | _no rows_         | —      |
| `date_recovered` | _no rows_         | —      |

18 digits is roughly `7.9e17`, two orders of magnitude past `Number.MAX_SAFE_INTEGER`
(`9,007,199,254,740,991`). **`node:sqlite` throws on these rather than truncating them** — which is
correct of it, and fatal to a naive `SELECT MAX(date)`.

The failure mode is what makes this worth its own section. Wrapped in the usual `try`/`catch`, the
throw is swallowed and the column reports as _empty_. This probe did exactly that on its first
granted run and reported "no dates present" for all seven columns across 97,414 messages. The
section written to catch a silent 31-year error was itself silently wrong.

**Rule for the server: read these columns as BigInt, or `CAST(... AS TEXT)` and parse.** Divide by
`1e9` and add `978307200` to reach a Unix timestamp. `packages/core/src/schema.ts`'s `detectEpoch`
covers the seconds case only, so it needs the nanosecond branch before Messages can use it.

`date_played` is populated but stops in 2018 — audio messages, long unused on this machine. Empty is
not the same as absent, so `date_retracted` and `date_recovered` are **unverified rather than
missing**: their epoch is an assumption until a machine with rows confirms it.

## What the permission buys

The richest capability list of any surface probed so far, and none of it reachable another way:

| Capability     | Columns                                                   | Rows   |
| -------------- | --------------------------------------------------------- | ------ |
| Reactions      | `associated_message_guid`, `associated_message_type`      | 2,788  |
| Reply threads  | `thread_originator_guid`, `thread_originator_part`        | 499    |
| Edits          | `message_summary_info`, `date_edited`, `part_count`       | —      |
| Unsent         | `is_delivered`, `was_delivered_quietly`, `date_retracted` | —      |
| Read receipts  | `date_read`, `date_delivered`, `is_read`                  | —      |
| Expressive     | `balloon_bundle_id`, `expressive_send_style_id`           | —      |
| Group metadata | `style`, `room_name`, `display_name`, `group_id`          | —      |
| Attachments    | `filename`, `mime_type`, `transfer_name`, `total_bytes`   | 17,529 |
| Service        | `service`, `uncanonicalized_id`                           | —      |

Reactions matter more than the row count suggests: 2,788 rows that a naive reader renders as
gibberish ("Liked "see you at 8"") rather than as metadata on another message. Filtering
`associated_message_type` is not an enhancement, it is table stakes for output anyone would want to
read.

Attachment bytes resolve: **23 of 25 sampled rows point at a readable file**. The two that did not
are unexplained — iCloud-offloaded or deleted are both plausible and neither was checked. Worth
settling before writing an attachment tool, since it decides whether a miss is an error or normal.

## The id bridge is unanswerable by construction

Every other surface got an answer here. This one cannot.

The bridge scan works by taking a real identifier from the live app and searching every TEXT column
for it. Messages returns **no chat identifiers at all** — `chats.id` is not even a function — so
there is nothing to search for. The scan is not inconclusive; it is inapplicable.

The consequence is a design constraint, not a detail: **AppleScript can `send`, and nothing joins
that back to a row.** A send tool cannot report what it wrote by id, cannot confirm delivery from the
store, and cannot hand its result to a read tool. Whether that is acceptable, or whether a send
should re-resolve by scanning the store for a recent row on the target chat, is a decision that has
to be taken deliberately rather than discovered later.

**Taken: the scan.** See [the send lane](#the-send-lane). The bridge is still unanswerable in the
direction it was asked — no identifier comes back — but it does not have to be answered in that
direction, because the store is authoritative about what was sent and the send is bounded in time
and scoped to one chat.

## The schema does not replay cleanly, twice over

Both found by trying to build the offline test database from `--write`'s output, and both are worth
knowing before the next surface is captured.

**`sqlite_stat1` cannot be declared.** ANALYZE creates it, and replaying its `CREATE TABLE` raises
`object name reserved for internal use`, which kills the whole fixture. `scripts/lib/probe-kit.mjs`
filtered `sqlite_sequence` and nothing else; it now excludes the entire reserved `sqlite_` prefix.
Calendar's capture never hit this because that store had not been analysed — so this was latent for
every surface, not specific to Messages.

**27 triggers call functions that only exist inside Messages.app.** `verify_chat`, `guid_for_chat`,
`before_delete_attachment_path`, `delete_attachment_path`, `after_delete_message_plugin` and
`delete_chat_background_before_deleting_chat` are registered by Messages on its own connection, so
any INSERT or DROP that fires one dies with `no such function` in a plain `node:sqlite` database.

The fixture keeps the triggers, because it is a record of the schema. The test suite strips them at
replay, which is where the constraint actually is — it exercises SELECTs, and a trigger that can only
run inside Messages.app has nothing to say about them. Worth remembering as a general point: **a
captured schema is not necessarily a runnable one.**

## The send lane

Added after the read half shipped. Everything above stands; this section is about the one thing
Apple Events can do here.

### The dictionary, measured

`sdef /System/Applications/Messages.app`, macOS 26.6. Three commands, total:

| command  | shape                                              | shipped        |
| -------- | -------------------------------------------------- | -------------- |
| `send`   | `file` **or** `text`, `to` a participant or a chat | yes, text only |
| `login`  | log in to all accounts                             | no             |
| `logout` | log out of all accounts                            | no             |

There is no edit, no delete, no mark-as-read, no typing indicator and no reaction. **Everything this
server can show you, it cannot change** — a much sharper limit than any other surface here, and one
that comes from the dictionary rather than from a decision.

`login`/`logout` are not exposed: `logout` signs the user out of iMessage on every device they own,
which is not something to put behind a tool call, and there is no read path to justify `login`.

`send`'s direct parameter is typed `file` OR `text`. **Only the text form ships.** A tool that
transfers an arbitrary local path to a remote person is an exfiltration primitive whose blast radius,
unlike the text form's, is not bounded by what the model can say. `test/jxa.test.ts` asserts no
script contains `Path(`, so shipping it means taking that decision again.

The classes are worth recording because one of them is load-bearing:

| class         | id shape                                    | note                                   |
| ------------- | ------------------------------------------- | -------------------------------------- |
| `chat`        | "A guid identifier for this chat"           | the bridge — see below                 |
| `participant` | `01234567-89AB-…-456789ABCDEF:+11234567890` | account UUID, colon, handle            |
| `account`     | `service type` is one of SMS, iMessage, RCS | `buddy` is a synonym for `participant` |

### Addressing something Messages will not let you enumerate

`send` needs a `participant` or a `chat`, and the ordinary way to obtain either is to enumerate —
which is precisely what this app refuses. So the write lane cannot look anybody up.

But `chat` carries `id`, and the file lane holds `chat.guid` for all 1,027 chats in the store. **The
read lane picks the target and the write lane addresses it by id**, which is the only arrangement
where neither lane has to do the thing it cannot. It is also a concrete answer to "what did the Full
Disk Access grant buy": on this surface it buys the ability to send to a named person at all.

That the two guids are the same string is **not assumed** — it is the exact class of thing this
project has been wrong about before. So `client/jxa/core.ts` is a ladder, every rung records why it
failed, and the strategy that answered comes back in the tool result:

| rung | how                                                               | enumerates? |
| ---- | ----------------------------------------------------------------- | ----------- |
| 1    | `chats.byId(guid)`, guid from `chat.db`                           | no          |
| 2    | `chats.byId("iMessage;-;+15551234567")`, composed from the handle | no          |
| 3    | `accounts.whose({serviceType})` → `participants.whose({handle})`  | yes         |
| 4    | `participants.whose({handle})`                                    | yes         |

Rungs 3 and 4 are expected to fail with "Application isn't running", and are kept because they cost
one round trip and because they are the form every AppleScript example uses — if launching the app
does wake the scripting interface, they are what works.

### Reconciliation, which is what made this shippable

A send that returns `{ok: true}` and stops would be claiming delivery on the strength of a command
that did not throw. Instead the client takes `since` immediately **before** the send and then polls
`chat.db` for an outgoing row in the target chat, matching on text where it is available.

| outcome       | meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `matched`     | the row was found; the result carries a real `m1:` ref, usable by every read |
| `pending`     | Messages accepted the send and has not written the row yet                   |
| `unavailable` | there was no existing chat to look in                                        |

**`pending` is not a failure**, and the tool description says so twice, because the obvious reaction
to a failure is to retry and a retry here sends the message twice.

### Still unverified, and it is the important part

**No send has been executed against a live Messages.** The whole lane is written from the dictionary
and from the store, and its tests run against a fake `osascript` — deliberately, because a suite that
sends on every `pnpm test` is not a suite anyone can run. What that leaves open:

- **Whether rung 1 works at all** — i.e. whether Messages' `chat.id` really is `chat.guid`. If it is
  not, every send falls through to rung 2 and then to the rungs that enumerate, and the practical
  answer becomes "sending works only to a chat whose guid Messages happens to compose the same way".
- **Whether launching the app wakes the scripting interface.** The reads were measured against a
  running background process; a foreground launch was never tried.
- **How long the outgoing row takes to appear**, which is what `APPLE_MESSAGES_SEND_RECONCILE_MS`
  (5,000 by default) is guessing at.

The first two are measurable **without sending anything**:

```
pnpm probe:messages --launch --send-target=+15551234567
```

That runs the same ladder and stops one step short of `send`, reporting whether Messages' `chat.id`
matches the guid the store holds for that conversation. Output is masked — a chat guid contains a
phone number. The worst it can do is launch Messages and prompt for an Automation grant.

The remaining question needs a real send, and the honest first one is a message to **your own
handle** — Messages lets you do that, and it is the only send whose recipient consented in advance.

## Still open

- **`date_retracted` / `date_recovered`** — no rows here, so their epoch is assumed, not measured.
- **The two unresolvable attachments** — offloaded, deleted, or a path convention this probe does not
  handle.
- **The 322 messages with neither text nor blob.** Probably group events — someone joined, someone
  left, a name changed — which `item_type` would separate. Unmeasured, and it decides whether a
  reader should skip them or render them.
- **The send path is still untested against a live Messages** — see the section above for exactly
  what that leaves open and for the one safe way to measure it.

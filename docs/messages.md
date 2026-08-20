# Apple Messages, measured

Measured by `scripts/probe-chat-db.mjs` on macOS 26.6, 97,414 messages across 1,076 handles.
Regenerate on each new macOS release. Output is redacted: counts, timings, lengths, column names and
DDL only — no message text, no handles, no chat names.

**Conclusion: buildable, and more expensive than it looks.** The store is rich, fast and complete.
But three things have to be budgeted before a single tool is written — a typedstream decoder, BigInt
date handling, and the fact that writes cannot be reconciled against reads. None of them is
discoverable from the schema alone.

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

## Still open

- **`date_retracted` / `date_recovered`** — no rows here, so their epoch is assumed, not measured.
- **The two unresolvable attachments** — offloaded, deleted, or a path convention this probe does not
  handle.
- **Whether `attributedBody` carries formatting that matters**, or is only ever a redundant copy of
  `text` plus attachment placeholders. This decides whether the decoder must preserve structure or
  merely extract a string.
- **The send path is untested.** Probing it would mean sending a real message to a real person, which
  is not a measurement worth taking without asking first.
- **No schema fixture captured.** `--write` would emit `packages/messages/test/fixtures/chat-db.sql`,
  but there is no `packages/messages` yet and creating one is out of scope for a phase-0 probe.

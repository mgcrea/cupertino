# Notes — phase 0 findings

Measured by `scripts/probe-notes.mjs` on macOS 26.6, 921 notes in one account.
Regenerate on each new macOS release, and **re-run it on a large library** — the headline number
below is size-dependent. Output is redacted: counts, timings and DDL only.

**Conclusion: ship the Apple Events lane first, design for two lanes.** At 921 notes Apple Events
answers in 97 ms and Full Disk Access buys nothing for search. That does not generalise: the lane
has no index, so every query pays the full cost again, and the projection below puts the wall at
roughly 5–10k notes.

## The numbers

|                                     |                                    |
| ----------------------------------- | ---------------------------------- |
| Accounts / notes / max folder depth | 1 / 921 / 1                        |
| Bulk `id` + `modificationDate`      | 128 ms                             |
| `whose plaintext contains "the"`    | 671 ms — 69 hits                   |
| Bulk `plaintext` + filter in JS     | **97 ms** — 69 hits, 249,719 chars |
| One note's `plaintext` + `body`     | ~116 ms                            |
| Password-protected notes            | 31                                 |

Both search strategies returned the same 69 hits, so they agree; the fast one is not cutting
corners.

## Where the Apple Events lane runs out

0.105 ms per note, measured. There is no index, so this is paid on **every** search:

| Library | Projected scan |            |
| ------- | -------------- | ---------- |
| 921     | 97 ms          | instant    |
| 5,000   | ~530 ms        | noticeable |
| 10,000  | ~1.1 s         | too slow   |
| 20,000  | ~2.1 s         | too slow   |
| 50,000  | ~5.3 s         | unusable   |

Mail's index lane is sub-second over 51k messages by comparison. So Notes hits the same wall Mail
did, just further out — and a "drive your Mac" product will meet users on the wrong side of it.
The probe prints this projection from whatever library it runs on; trust that over the table here.

**The cost is per note, not per byte.** 921 notes at 271 chars each scan in 97 ms, while fetching
two arrays (`id` + `modificationDate`) costs 128 ms for the same notes. Apple Event marshalling
dominates, not string matching.

That has an awkward consequence for the obvious optimisation: **checking whether the cache is
stale costs more than redoing the search.** A plaintext cache keyed by id and modification date
needs those two arrays — 128 ms — to validate, against 97 ms to just re-scan. So a no-FDA cache
has to run on a TTL and accept bounded staleness, the way `APPLE_MAIL_MAILBOX_CACHE_TTL_MS`
already does for mailboxes. It cannot be both fresh and cheap without the file lane.

## Two rules the timings impose

- **Never read a property per note in a loop.** One note costs ~116 ms, so the whole library would
  take ~107 s — the same trap the README documents for Mail. Every read must be a bulk array fetch
  (`N.notes.plaintext()`), which is one Apple Event regardless of size.
- **Prefer the bulk fetch over `whose`.** Counterintuitively `whose plaintext contains` is **6.9×
  slower** than pulling everything and filtering in JS, because the specifier evaluates per note
  across the Apple Event bridge while the bulk form is a single round trip.

## Why two lanes, not one

The per-surface argument said Notes needs only Automation. The product argument outranks it:

- **Scale.** Above ~5k notes the unprivileged lane stops being viable for search, and attachment
  listing degrades the same way — it is per-note over Apple Events.
- **Consistency.** If every surface has the same shape — file lane preferred, Apple Events
  fallback, diagnostics naming which is live — the pattern lives once in `packages/core`, and the
  user story is uniform: grant Full Disk Access for full speed, everything works without it.
- **Try before you grant.** The fallback is what lets someone install the app and use it before
  deciding to hand over whole-disk access. That is worth building deliberately, not as a
  degraded afterthought, and it is why the Apple Events lane must stay a first-class path rather
  than dead code once the file lane exists.

So the lane structure matches Mail's. What differs is the **sequencing**: Mail had to build the
index lane first because 74 s is unusable on day one, whereas Notes is genuinely shippable on
Apple Events alone and can add the file lane when it is needed.

### What the file lane buys, in priority order

1. **Attachment bytes.** The dictionary exposes `name`, `id`, `URL` and `content identifier` but
   **no filesystem path**, so contents require reading `Accounts/<uuid>/Media/`. Apple Events
   cannot do this at any speed — the only pure capability gain, and the reason Notes runs under
   the launcher at all.
2. **Search at scale.** Everything above ~5k notes. Title and date filtering comes free from
   `ZTITLE1`; full text additionally needs the gunzip-plus-protobuf decode.
3. **Attachment listing at scale**, which is per-note over Apple Events.

A hybrid is worth considering before committing to the decoder: use the index for everything it
answers cheaply — title match, folder, dates, attachment presence, ordering, paging — and Apple
Events for the bodies of the page actually being returned. That caps the body cost at page size
rather than library size, and needs no protobuf at all.

### What it does not buy

- **Password-protected notes.** All 31 are encrypted at rest; the store holds ciphertext, so the
  file lane gets no further than AppleScript without the passphrase.
- **Working while Notes.app is closed** — not cleanly. Mail shows why: `searchMessages` reads
  SQLite, but `#mailboxLookup` resolves names through `mailbox-map.ts`, populated over Apple
  Events. With Mail closed and a cold cache the lookup is empty and results are filtered away. Not
  a clean win in the surface that already has both lanes, so not a reason here either.

## The store, measured

Full Disk Access granted, `scripts/probe-notes.mjs` on the same 921-note library.

|                                |                                                                        |
| ------------------------------ | ---------------------------------------------------------------------- |
| Path                           | `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`    |
| Size / WAL                     | 70,094,848 bytes / ~1.2 MB                                             |
| Schema fingerprint             | `5ae59272bcf9` — 61 tables, 25 Core Data entities                      |
| Core Data epoch offset         | 978307200 — seconds since 2001-01-01                                   |
| AppleScript id bridges to Z_PK | **yes** — `x-coredata://…/ICNote/p<N>` is `ZICCLOUDSYNCINGOBJECT.Z_PK` |
| `ZICNOTEDATA.ZDATA`            | **gzipped, and protobuf inside** — see below                           |

The id bridge is the load-bearing row: a note found in the index hands straight to the Apple Events
lane for writes, exactly as `ROWID` does for Mail, so the two lanes mix without a re-lookup.

A live WAL is present and grew between consecutive runs, so `mode=ro` is required for the same
reason as Mail — `immutable=1` would skip it.

### `ZDATA` is gzipped protobuf after all

Over 24 sampled rows: **22 carry the gzip magic `1f8b0800` and all 22 gunzip cleanly**, revealing an
inner magic of `080012ca20080010` — the `08 … 12 …` field-tag pattern of protobuf wire format. The
other 2 rows are `bplist00`.

An earlier note in this document said the opposite. That came from a `LIMIT 1` sample which happened
to land on one of the two `bplist00` outliers, so the widely repeated "gzipped protobuf" description
is **correct**, and the correction was wrong. Sample more than one row.

The practical consequence is that index full-text search _is_ achievable — gunzip, then decode a
protobuf whose shape is well travelled in forensics tooling — rather than blocked. It is still real
work, and the cheaper hybrid below may be the better trade.

### What the indexed columns can and cannot do

49 TEXT-typed columns; scoped to note rows, the ones that carry anything:

| Column           | Coverage       | Avg  | Share of all text |
| ---------------- | -------------- | ---- | ----------------- |
| `ZTITLE1`        | **921 = 100%** | 15ch | 6%                |
| `ZWIDGETSNIPPET` | 879 = 95%      | 86ch | 30%               |
| `ZSNIPPET`       | 545 = 59%      | 32ch | 7%                |

`ZTITLE1` is the note title and its coverage is exactly the Apple Events note count. The other two
are previews. Against the 249,719 characters Apple Events actually returns, no column carries the
body — so **the index gives complete titles plus short previews, and full text needs the blob.**

Beware `ZTITLE` (spans folders and accounts) and `ZIDENTIFIER` (a UUID on every row, which will win
any naive "most populated text column" heuristic — it did in an earlier revision of the probe).

### The 1191-versus-921 trap

`Z_ENT = 12` (`ICNote`) matches **1191 rows** while Apple Events reports **921 notes**, and filtering
on `ZISRECOVERINGFROMTRASH` / `ZMARKEDFORDELETION` changes nothing — both are 1191.

So **`Z_ENT` alone is not "a note the user sees"**, and an index lane keyed on it would return 270
phantom notes. `ZTITLE1` is non-null on exactly 921 rows, which makes `ZTITLE1 IS NOT NULL` the
leading hypothesis for the real predicate — most likely the other rows are tombstones or versions
carrying no title. **Verify before shipping any index query**; the probe now prints a MISMATCH line
so this cannot pass unnoticed.

### Attachments

Attachments are entities inside `ZICCLOUDSYNCINGOBJECT` — there is **no `ZICATTACHMENT` table**:

| Entity                     | Rows |
| -------------------------- | ---- |
| `ICAttachmentPreviewImage` | 2876 |
| `ICAttachment`             | 1596 |
| `ICMedia`                  | 652  |
| `ICInlineAttachment`       | 9    |
| `ICAttachmentLocation`     | 0    |

Path-bearing columns: `ZFILENAME`, `ZIDENTIFIER`, `ZURLSTRING`, `ZREMOTEFILEURLSTRING`,
`ZTOKENCONTENTIDENTIFIER`. `Accounts/` is readable under Full Disk Access, so the row-to-file
mapping is the remaining piece to establish for `save_attachment`.

**Budget for the maintenance.** 61 tables of undocumented Core Data, a gzipped protobuf body format,
and a schema fingerprint that will drift on macOS releases. A real recurring cost — the argument for
sequencing the file lane behind a shipped Apple Events lane, not for skipping it.

## Scripting surface

`sdef /System/Applications/Notes.app` — public, needs no permission.

| Class        | Notable                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `account`    | `folder` and `note` elements, `default folder`, `name`, `id`                                                          |
| `folder`     | nested `folder` elements, `name`, `id`, `shared`, `container`                                                         |
| `note`       | `body` rw, `plaintext` r, `creation date`, `modification date`, `password protected`, `shared`, `attachment` elements |
| `attachment` | `name`, `id`, `URL`, `content identifier`, dates                                                                      |

`body` being read-write means creating and editing notes is native Apple Events on both lanes —
writes never go near the store, same as Mail's rule that the AppleScript lane is the authority.

Folders nest in the dictionary, so a folder map has to recurse — even though the library measured
here is flat (`max folder depth 1`) and would not have exercised it. 31 of 921 notes are
password-protected; how `plaintext` behaves on a locked note is reported by the probe and must be
handled explicitly rather than surfaced as an error.

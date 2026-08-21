# Mail body search — phase-0

Regenerate with `node scripts/probe-mail-body.mjs` on each new macOS release.
Output is redacted: counts, timings, ratios and booleans only — and, unusually for these probes,
**no search terms**, because the round-trip test picks its needles out of real message bodies.

Measured on macOS 26.6 against a live 181,734-message store. **Implemented** — `search_messages`
takes a `body` term; see `packages/mail/src/client/body-scan.ts`.

## The question

`apple_mail_search_messages` matches subject and sender. The tool description says so in the text
the model reads — _"Does NOT search message bodies"_ — and
[`envelope.ts`](../packages/mail/src/client/envelope.ts) calls body search "a separate, opt-in
scan" that does not exist.

It is the one capability where a competing server beats this one outright; see
[alternatives.md](alternatives.md). "Find the mail where they mentioned the invoice" is a body
query, and subject+sender does not merely rank it badly — it returns nothing, and the model
reports that as an absence.

## What is already settled

**The Envelope Index has no full-text table.** 54 tables on macOS 26.6, none of them FTS shadow
tables — see [envelope-index.md](envelope-index.md). What it _does_ have is
`searchable_messages(message_body_indexed)` and `last_spotlight_check_date`: bookkeeping for an
index maintained somewhere else. The somewhere else is Spotlight. Mail's own body search has never
lived in this file, which is why the index lane never found it there.

**The path→ROWID bridge is free.** [`emlx.ts`](../packages/mail/src/client/emlx.ts) `shardPath`
derives `ROWID → Data/8/9/1/Messages/198577.emlx`, so the reverse is `basename()`. Any lane that
produces file paths — Spotlight, or a walk of the store — produces `messages` rows with no lookup
table in between. This is what makes lanes 1 and 3 below possible at all, and the probe verifies it
on real files rather than assuming it.

## Lane 1 is closed: `~/Library` is not in the Spotlight volume index

Settled on macOS 26.6, and it needs no Full Disk Access to reproduce:

```
mdfind -count "kMDItemFSName == '*.app'"                    533
mdfind -onlyin ~/Library -count "kMDItemFSName == '*'"        0
mdfind -onlyin ~/Library/Mail -count "kMDItemFSName == '*.emlx'"   0
```

`mdfind` works; the entire `~/Library` tree is absent from the index it searches. No query scoped
under that path can return anything, however it is phrased, so there is no coverage question to
answer and no amount of needle-tuning that would change it.

**Mail's own body search is not a counter-example.** The Envelope Index carries
`indexing_analytics_message_donations_enqueued` / `_identified` and `last_spotlight_check_date` —
CoreSpotlight _donation_ bookkeeping. A CoreSpotlight index is a per-app store queried through
`CSSearchQuery` by the app that donated to it. It is not the volume index `mdfind` searches, and it
is not reachable by a third party. Reaching it would also mean linking a data framework into
`apps/apple/`, which is the fork [surfaces.md](surfaces.md) says to avoid.

### How this was nearly recorded wrong

Worth keeping, because the first run produced a confident and wrong report.

The probe asked `mdls` per file for `kMDItemContentType` and `kMDItemTextContent`, then ran a body
round trip on 200 files. It reported **100% known to Spotlight, 0% with text content, 0/199 round
trip**, and concluded that Spotlight indexes mail files but not mail bodies. All three numbers were
artifacts:

- `kMDItemContentType` is derived from the file's UTI on demand. `mdls` answers it for a file the
  index has never heard of, so "100% known to Spotlight" measured the `.emlx` extension.
- `kMDItemTextContent` is **searchable but not readable** — Spotlight never returns it through
  `mdls`. "0% with text content" was the API declining to answer, recorded as a finding about mail.
- The round trip was 199 queries against an index that structurally cannot hold those files.

The conclusion — "don't use Spotlight" — happened to be right, for a reason none of those numbers
established. Three counts costing milliseconds settle it; 400 subprocess spawns did not. The probe
now runs the control first and skips the per-file work when it fails.

## The three candidate lanes

| Lane                                                | Cost                                                                            | Failure mode                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **1. Spotlight** (`mdfind` scoped to the Mail root) | none — macOS already pays it                                                    | silent misses if coverage is partial                          |
| **2. Owned FTS5**                                   | a full pass over every `.emlx`, then an index to keep in step with Mail forever | staleness, and a second copy of the user's mail on their disk |
| **3. Narrow, then scan**                            | none                                                                            | silent truncation once the filter leaves too many survivors   |

Lane 2 is what [`imdinu/apple-mail-mcp`](https://github.com/imdinu/apple-mail-mcp) pays. Lane 3 is
what it accuses the rest of the field of doing badly, and the accusation is fair: a scan capped at
the newest 5,000 messages answers "not found" for everything older, indistinguishably from a real
absence.

## The decisive measurement is coverage, not speed

Every lane here is fast enough. The number that decides is **what fraction of a real store a body
query can actually reach**, so the probe measures it directly rather than inferring it:

1. Walk the store for `.emlx` files and sample across the whole walk — not off the front, which
   would sample one mailbox and call it the store.
2. For each sampled file, ask `mdls` whether Spotlight holds `kMDItemTextContent`. An indexed file
   with an unindexed body is the precise failure this lane has to be checked for.
3. Read the message, pick a word that appears in the **body and not in the headers** — a term that
   is also in the subject is already findable by today's search and would score Spotlight a hit for
   work it never did — then `mdfind` for it and check the file comes back.

The ratio in step 3 is the verdict. The probe applies the rule so a later run reaches the same
conclusion from its own numbers:

| Coverage | Lane                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| ≥ 95%    | Spotlight                                                                               |
| 60–95%   | Spotlight as the fast path, reporting its own coverage, with narrow-then-scan behind it |
| < 60%    | build and own an FTS5 index, and budget for the refresh problem                         |

The middle row is not a fudge. It is the same contract the index lane already honours with
`indexAgeSeconds` and the WAL-blind warning: a coverage number the model can read beats a silent
miss.

## Findings

Full walk, no cap. macOS 26.6, 4 accounts.

|                                                  |                           |
| ------------------------------------------------ | ------------------------- |
| Messages in the index                            | 181,734                   |
| `.emlx` files                                    | 182,329 — **9.61 GB**     |
| `.partial.emlx`                                  | 111,523 (61.2%)           |
| Mean file                                        | 52,714 B                  |
| path → ROWID parse                               | 100%                      |
| ROWID → `messages`                               | 500/500 (100%)            |
| Spotlight: `~/Library` indexed                   | **0 files** — lane closed |
| Body read                                        | 0.483 ms/file warm        |
| Indexable text after stripping base64 and markup | 21.0%                     |

### Lane 2 — an owned FTS5 index

|               |                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Build         | 88 s warm, ~365 s cold                                                                             |
| Index on disk | ~2.2 GB (upper bound — the 1.1× multiplier is pessimistic for FTS5 with an external content table) |
| Refresh       | unsolved, and permanent                                                                            |

### Lane 3 — narrow, then scan

No stored state. Cost is linear in survivors, so the filter decides everything:

| Filter                   | Messages | Warm     | Cold      |
| ------------------------ | -------- | -------- | --------- |
| tight (sender + window)  | 100      | 48 ms    | 200 ms    |
| typical filtered         | 500      | 242 ms   | 1.0 s     |
| 90 days, busiest mailbox | 1,932    | 0.9 s    | 3.9 s     |
| 90 days, whole store     | 6,566    | 3.2 s    | 13.1 s    |
| **unbounded**            | 182,329  | **88 s** | **365 s** |

## Verdict

**Bounded body search needs no index.** A tight filter lands at 48–200 ms, which is the same order
as the 97 ms the index lane already costs for subject and sender. A 90-day mailbox scope is under
four seconds cold. Nothing has to be stored, nothing has to be kept in step with Mail, and there is
no second copy of anyone's mail on their disk.

**Only the unbounded query justifies an index**, and it is the one that hurts: a body search across
the whole store with no filter is 88 s warm and 365 s cold — the 74-second Apple Events wall again,
which is the thing this repo exists to avoid. That single case is what 2.2 GB and a permanent
refresh problem would buy.

So the decision is not "which lane is faster". It is **whether unbounded body search is worth a
second copy of the archive**, and for a tool whose whole argument is a smaller footprint than the
alternatives, it is not.

### The shape that follows

Narrow-then-scan, with the bound **declared rather than hidden**. The failure mode
[`imdinu/apple-mail-mcp`](https://github.com/imdinu/apple-mail-mcp) rightly attacks is a silent cap
at the newest 5,000 messages: it answers "not found" for older mail indistinguishably from a real
absence. A bound the model can read is a different thing entirely, and it is the contract this
server already honours elsewhere with `indexAgeSeconds`, the WAL-blind warning and `degraded`.

### What shipped

`APPLE_MAIL_BODY_SCAN_MAX` (2,000) bounds the candidate set and
`APPLE_MAIL_BODY_SCAN_BYTES` (64 KB) bounds the read per file. Over the candidate bound the search
returns `degraded` with `capability: "body-scan"`, naming both numbers and scanning nothing:

```
{
  degraded: true,
  capability: "body-scan",
  reason: '6566 messages match the other filters, above the 2000-message body scan bound.
           Nothing was scanned, so this is not "no results".',
  hint: "Narrow with mailbox, account, sender or dateFrom and try again...",
  candidates: 6566,
  bound: 2000
}
```

Under it, the result carries a `bodyScan` block reporting `candidates`, `scanned`, `matched`,
`unreadable` and `elapsedMs` — the same contract `indexAgeSeconds` and `walBlind` already honour.

Two deliberate trades, both pinned by tests:

- **The read cap can hide a term.** 79% of a store's bytes are base64 no text search would match,
  and MIME puts text parts ahead of attachments, so the cap buys a large latency saving for a rare
  miss. `APPLE_MAIL_BODY_SCAN_BYTES` raises it.
- **Matching is a case-insensitive substring**, not tokenised or stemmed — the same thing SQL
  `LIKE` does for subject and sender. A body search that stemmed while the subject search did not
  would make one tool behave two ways depending on which field matched.

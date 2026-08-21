# Mail body search — phase-0

Regenerate with `node scripts/probe-mail-body.mjs` on each new macOS release.
Output is redacted: counts, timings, ratios and booleans only — and, unusually for these probes,
**no search terms**, because the round-trip test picks its needles out of real message bodies.

> **Not yet measured.** The probe is written and runs; it needs Full Disk Access, which the shell
> that would have run it does not hold. Everything below the method section is blank on purpose —
> a table of numbers nobody measured is worse than an empty one. Run
> `pnpm probe:mail-body` from a process with the grant and fill it in.

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

_Awaiting a run with Full Disk Access._

|                              |     |
| ---------------------------- | --- |
| macOS                        | —   |
| Messages in the index        | —   |
| `.emlx` files walked         | —   |
| `.partial.emlx` ratio        | —   |
| path → ROWID resolve rate    | —   |
| Known to Spotlight           | —   |
| With `kMDItemTextContent`    | —   |
| **Body round-trip coverage** | —   |
| Mean `mdfind`                | —   |
| Projected FTS5 build         | —   |
| Projected FTS5 size          | —   |

## Verdict

_Awaiting a run with Full Disk Access._

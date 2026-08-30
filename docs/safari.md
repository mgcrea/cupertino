# Safari, measured

Measured by `scripts/probe-safari.mjs` on macOS 26.6. Re-run on a granted machine after
`packages/safari` was built; the numbers below are from that second run (7,814 history items,
76 open tabs). The schema fingerprint was unchanged between runs, so the DDL is stable.
Regenerate on each new macOS release. Output is redacted harder than any other surface: **no URLs,
no page titles, no domains**. A single URL can name a person, an employer and a medical condition, so
tab URLs are masked to a shape (`https://<host:25>/<1 segments>`) before they can reach the report.

**Conclusion: two lanes that are not fallbacks for each other.** Every other surface has two routes
to the same data, and the choice is about speed. Safari's lanes see almost disjoint things — Apple
Events sees only what is open right now, the file lane sees everything except that. An ungranted
Safari server is not a slower Safari server; it is a different and much smaller one.

## The files

| File              | Size      | Notes                                                |
| ----------------- | --------- | ---------------------------------------------------- |
| `History.db`      | 6,615,040 | 16 objects, 9 tables, fingerprint `1d20bcd2b9a5`     |
| `Bookmarks.plist` | 880,559   | binary plist — holds the Reading List                |
| `Downloads.plist` | 9,431     | unexamined — this server reports it, never parses it |
| `CloudTabs.db`    | absent    | not present on this machine                          |

All under `~/Library/Safari/`, all EPERM without Full Disk Access. Opened `mode=ro` in 0 ms.

## The file lane is cheap

|                        |                        |
| ---------------------- | ---------------------- |
| History items          | 7,814                  |
| History visits         | 19,384                 |
| `LIKE` search on url   | **16 ms** — 7,424 hits |
| `LIKE` search on title | **4 ms** — 14,833 hits |

There is no index-vs-Apple-Events tradeoff to litigate here, because there is nothing to trade: the
store is small, the queries are milliseconds, and Apple Events cannot answer them at any price.

## The Reading List is not a database

It lives inside `Bookmarks.plist` as a folder whose `Title` is the literal `com.apple.ReadingList`.
Entries carry a `ReadingList` dictionary with `DateAdded` and, once opened, `DateLastViewed` — that
last field is the entire unread/read distinction, and the reason a Reading List tool is worth having.
A server that goes looking for a `.db` will not find any of it.

**Reading it is harder than it looks.** The obvious approach fails outright:

```
$ plutil -convert json -o - ~/Library/Safari/Bookmarks.plist
~/Library/Safari/Bookmarks.plist: Invalid object in plist for JSON format
```

Reading List entries carry `NSData` preview images, and JSON has no representation for it, so the
whole conversion aborts — not just the offending key. Converting to XML and pattern-matching it can
count fixed literals but cannot track nesting, and nesting is the entire question: _which_ leaves sit
under the Reading List folder.

The probe reads the plist as an `NSDictionary` through the osascript boundary already in use for
everything else, walking it with `objectForKey`/`objectAtIndex`. The data keys are simply never
touched, so their unrepresentability stops mattering. `osascript` inherits Full Disk Access from
whatever launched it, exactly as the rest of the file lane does.

## Only 55.3% of open tabs resolve to a history row

> **Superseded. The rate is not "about half" — it is unbounded below.** A third run, measured
> 2026-08-30 on macOS 26.6 against the shipped 1.4.0 build with the variant ladder in place, matched
> **5 of 60 open tabs — 8.3%**, all of them exact. The ladder's extra rungs fired **zero** times.
> See "Why the match rate collapsed" below; the table in this section is the first run and is kept
> because the two together are the finding.

Safari offers no opaque id shared between the lanes. **The only join key is the URL itself**, which
makes the join trivially available and trivially lossy:

| Of 76 open tabs           |        |
| ------------------------- | ------ |
| Exact URL match           | 19     |
| Match after stripping `?` | 23     |
| **Unmatched**             | **34** |

A tool that enriches a live tab with its history — visit count, last visited, title — **must treat a
miss as normal rather than as an error**. Redirects, session parameters and pages never committed to
history all produce a tab whose URL is simply not there. The URL column is `history_items.url`,
confirmed by scanning every TEXT column.

**The query-string fallback is the larger half of this working.** Stripping `?` takes the match rate
from 19 to 42 out of 76 — it more than doubles it. The first run, over 28 tabs, made it look like a
5-of-17 tidy-up; at 76 tabs it is 23 of 42. `packages/safari` applies it on every lookup, and this
is the measurement that justifies the second round trip.

Both runs agree on the shape and disagree on the rate: 60.7% over 28 tabs, 55.3% over 76. Neither is
"the" number, which is the useful finding — a tool description should treat any particular figure as
a sample.

## Why the match rate collapsed to 8.3%

The third run is not a worse sample of the same distribution. It is a different failure, and it says
the join was built facing the wrong way.

| Of 61 open tabs, 1 window |       |
| ------------------------- | ----- |
| Exact URL match           | 5     |
| Normalized (any rung)     | **0** |
| Query-stripped            | **0** |
| Unmatched                 | 56    |

**The ladder is one-directional, and reality points the other way.** Every rung in `match.ts` takes
cruft OFF the tab's URL and looks for a bare row in history. The measured tab set is the inverse: the
tab holds the CANONICAL url and history holds the cruft. Open tab
`https://eu.qidi3d.com/products/plus5`; history has that path three times and never bare —
`?variant=45906184536147`, `?variant=45906184503379`, and a 300-character `?cs_link_idx=…utm_source=…`
campaign URL. Nothing the ladder can generate from the tab reaches any of them, because the ladder
can only remove and this gap requires adding.

That also explains why the first two runs looked healthy: their tabs were the ones carrying session
and tracking parameters, which is exactly the direction the `?`-strip fallback was built for. It was
never a general normaliser, and 55.3% was measuring how often the cruft happened to sit on the side
it could reach.

**Single-page apps are the second cause, and no URL rewriting fixes them.** A tab open on
`https://github.com/mgcrea/mcp-cupertino` does not match, and a full-history search shows why: the
only row for that repo is `/blob/main/docs/notes.md`. The repo root was reached by pushState, which
committed no history row. The page was genuinely visited and genuinely is not in the store.

**A fix has to normalise BOTH sides.** Comparing a canonical form of the tab URL against a canonical
form of the stored URL — or an indexed prefix probe on `scheme://host/path`, bounded so `/plus5`
cannot match `/plus5-pro` — is the shape that reaches these rows. It is unbuilt. The ladder as
shipped is correct and simply cannot see them, which is why it reported five honest matches and
invented nothing.

## An exact URL match is not proof the row is about that page

Also from the third run, and worth more than the rate: one tab was `http://localhost:4321/`, titled
"Bastion — one MCP server, running once, for every client". It matched **exactly**, to a history row
titled "Skirdv — Trouvez votre moniteur de ski indépendant".

Both are true. `localhost:4321` is whatever dev server ran last, so a URL that is a perfect join key
by construction is here a nearly meaningless one. Any local address, and any URL a person reaches
through more than one site, carries this. A caller must not present a matched title or visit count as
describing the page on screen when the tab's own title disagrees with it.

## What the file lane buys

Everything about the past, none of which the live lane can see at any speed:

| Capability       | Columns                                                    |
| ---------------- | ---------------------------------------------------------- |
| Visit timestamps | `history_visits.visit_time`                                |
| Visit counts     | `visit_count`, `daily_visit_counts`, `weekly_visit_counts` |
| Redirects        | `redirect_source`, `redirect_destination`                  |
| Page titles      | `history_visits.title`                                     |
| Load outcome     | `load_successful`, `http_non_get`                          |
| Synced deletions | `history_tombstones`                                       |
| Attribution      | `history_visits.origin`                                    |

And the live lane buys the present: 2 windows, 28–30 tabs, read in 95–1,482 ms.

## Safari needs a third permission state

This is the finding with consequences outside this document.

| Permission                             | Buys               | Modelled in `Permissions.swift`? |
| -------------------------------------- | ------------------ | -------------------------------- |
| Full Disk Access                       | history, bookmarks | yes                              |
| Automation for `com.apple.Safari`      | live tabs          | yes                              |
| **Allow JavaScript from Apple Events** | `do JavaScript`    | **no**                           |

The third is a Safari developer-menu toggle, not a TCC grant, and `apps/apple/Cupertino/Permissions.swift`
has no concept of it. If Safari ships, diagnostics will otherwise report a healthy surface whose most
powerful verb silently fails.

Worse, the toggle's own state is hard to read: `defaults read com.apple.Safari
AllowJavaScriptFromAppleEvents` is itself TCC-protected and returned nothing here, so the probe
reports **unknown** rather than guessing. It deliberately does not attempt `do JavaScript` to find
out — a failed attempt is user-visible, and a probe should not be the thing that teaches someone
their browser can be scripted.

## Built

`packages/safari` ships this surface: six read tools, no write tool, 151 tests. Three decisions
came out of building it that this document did not anticipate.

**The epoch is detected at runtime, not hardcoded.** The obvious response to the `visit_time` bug
below was to write the corrected value into the code. That would have been wrong. A misread epoch
produces dates that are well-formed and off by 31 years, which no test on synthetic data catches
and no reader notices. So `introspect()` reads the store's own newest timestamp and resolves the
epoch from it, and when nothing fits it reports `confident: false` and every date renders **null**.
An absent timestamp is a visible gap somebody reports; a confident wrong one is not.

**The schema is treated as unconfirmed, because it is.** The fixture below was never captured, so
every column in `store.ts` sits behind a `#col()` guard that yields `NULL AS alias` when absent,
and the visits→items join column is DISCOVERED at open time from a candidate list rather than
named. `SchemaDriftError` fires for exactly one condition — a missing `history_items` — and
everything else is a reported capability downgrade. `test/store.test.ts` pins that: a renamed join
column, an absent visits table and a missing title column each yield a working server with null
fields, not an exception.

**The third permission is avoided rather than modelled.** Since `do JavaScript` is the only verb
needing "Allow JavaScript from Apple Events", not shipping that verb removes the problem entirely.
`test/jxa.test.ts` asserts no script contains `doJavaScript`, so this cannot erode quietly. The
finding below stands for whenever that verb is wanted; it is no longer a blocker.

## Page text is unbuilt, and the measurement that would decide it

The surface cannot read a word of any page, which is the most common thing to expect of it. The
route that would not need the third permission is Accessibility: `AXWebArea` through System Events,
needing Accessibility plus Automation to **System Events** — not to Safari — which is the routing
`ad79b4a` established for Maps, and which `packages/mail` already relies on to read attributes
inside a WebKit `AXWebArea` (`findBodyArea` in `src/client/jxa/core.ts`).

That precedent makes it worth measuring rather than assuming, but the repo has rejected an
Accessibility **read** lane once already: ~206 elements at 33.6 ms a round trip is the ~14 s that
`docs/surfaces.md` records for Maps, with no bulk fetch in either JXA or AppleScript. A page's tree
is bigger than a sidebar's.

Everything turns on one unmeasured fact: **does an `AXWebArea` expose an aggregate text
attribute?** If it does, page text is one round trip and worth building. If it does not, it is a
walk of the whole tree — the case already rejected.

`scripts/spike-safari-page-text.mjs` answers it, enumerating the web area's attributes rather than
guessing their names, and measures two comparisons alongside: what `do JavaScript` actually fails
with, and how much less a plain network fetch of the same URL recovers. It reads only, prints
lengths rather than page text, and must be run by hand from a granted context. **Nothing ships from
this until those numbers exist.**

**The Reading List walker now runs for real.** Not against a real `Bookmarks.plist` — that still
needs the grant — but against a synthetic binary plist checked in at
`packages/safari/test/fixtures/Bookmarks.plist`, which reproduces the exact `plutil` failure
(verified by a test that asserts `plutil -convert json` still fails on it), executed through the
real `osascript` runner. That found one bug this document's version also has: the ROOT node is a
`WebBookmarkTypeList` whose `Title` is the empty string, so treating any non-null title as a path
segment prefixes every folder path with a leading slash.

## Still open

- ~~**Reading List counts.**~~ Measured: 6 folders, 200 leaves, tree depth 2. The Reading List
  holds **164 items, 138 of them unread** and 154 carrying preview text. That 84% unread rate is
  the finding that justifies a Reading List tool at all — it is a queue people add to far faster
  than they drain, so "what have I saved and not read" is a real question with a large answer.
- ~~**The `visit_time` epoch.**~~ Confirmed **apple-seconds** (latest visit 2026) on the re-run, as
  expected. The probe bug that reported nanoseconds is fixed — see [calendar.md](calendar.md) for
  that account. `packages/safari` detects the epoch from the store at open time anyway rather than
  hardcoding this result, because the failure mode is a date that is well-formed and wrong by 31
  years, which nothing downstream can notice.
- **`Downloads.plist`** — 9,431 bytes, still unexamined. `packages/safari` reports its presence in
  diagnostics and never parses it.
- **`CloudTabs.db`** — absent here, so tabs open on other devices are unmeasured.
- **Writes.** Opening a URL or adding to the Reading List is an Apple Event and was not attempted;
  it navigates a real browser.
- ~~**No history schema fixture captured.**~~ Captured:
  `packages/safari/test/fixtures/safari-history.sql`, schema only, replayed by
  `packages/safari/test/store.test.ts`. Every open question it was meant to settle came back the
  way the code had guessed — the join column is `history_item`, the primary key is `id`, and
  `url TEXT NOT NULL UNIQUE` — and all three are now pinned by tests.

  Two things the guess had NOT anticipated. `history_items.id` is `AUTOINCREMENT`, so rowids are
  not reused and the reuse hazard `packages/messages` designed against does not exist here; the
  URL ref stands on the cross-lane identity argument alone, which is what it always rested on.
  And `history_visits` carries a **`synthesized`** flag, which Safari's own
  `history_visits__last_visit` index orders by. What it means is unmeasured, so nothing in
  `packages/safari` filters or ranks on it.

- **What `history_visits.synthesized` means.** Plausibly redirect intermediates or otherwise
  non-navigational rows. It is in Safari's own last-visit index, so it is load-bearing for Safari;
  until it is measured, treating it as either would change which visit counts as "the last one" on
  the strength of an assumption.
- **`history_items_to_tags` / `history_tags`** — two tables the probe writeup never mentioned and
  this server does not read.

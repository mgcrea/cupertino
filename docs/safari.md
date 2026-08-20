# Safari, measured

Measured by `scripts/probe-safari.mjs` on macOS 26.6, 7,797 history items and 28 open tabs.
Regenerate on each new macOS release. Output is redacted harder than any other surface: **no URLs,
no page titles, no domains**. A single URL can name a person, an employer and a medical condition, so
tab URLs are masked to a shape (`https://<host:25>/<1 segments>`) before they can reach the report.

**Conclusion: two lanes that are not fallbacks for each other.** Every other surface has two routes
to the same data, and the choice is about speed. Safari's lanes see almost disjoint things — Apple
Events sees only what is open right now, the file lane sees everything except that. An ungranted
Safari server is not a slower Safari server; it is a different and much smaller one.

## The files

| File              | Size      | Notes                                            |
| ----------------- | --------- | ------------------------------------------------ |
| `History.db`      | 6,606,848 | 16 objects, 9 tables, fingerprint `1d20bcd2b9a5` |
| `Bookmarks.plist` | 880,559   | binary plist — holds the Reading List            |
| `Downloads.plist` | 3,871     | unexamined                                       |
| `CloudTabs.db`    | absent    | not present on this machine                      |

All under `~/Library/Safari/`, all EPERM without Full Disk Access. Opened `mode=ro` in 0 ms.

## The file lane is cheap

|                        |                        |
| ---------------------- | ---------------------- |
| History items          | 7,797                  |
| History visits         | 19,329                 |
| `LIKE` search on url   | **11 ms** — 7,411 hits |
| `LIKE` search on title | **2 ms** — 14,788 hits |

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

## Only 60.7% of open tabs resolve to a history row

Safari offers no opaque id shared between the lanes. **The only join key is the URL itself**, which
makes the join trivially available and trivially lossy:

| Of 28 open tabs           |        |
| ------------------------- | ------ |
| Exact URL match           | 12     |
| Match after stripping `?` | 5      |
| **Unmatched**             | **11** |

A tool that enriches a live tab with its history — visit count, last visited, title — **must treat a
miss as normal rather than as an error**. Redirects, session parameters and pages never committed to
history all produce a tab whose URL is simply not there. The URL column is `history_items.url`,
confirmed by scanning every TEXT column.

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

## Still open

- **Reading List counts.** The plist walk was rewritten after `plutil` failed and has been verified
  against a fixture reproducing that exact error, but **not yet run against a real
  `Bookmarks.plist`**. Folder, leaf, item and unread counts are pending one granted run.
- **The `visit_time` epoch.** The first granted run reported `apple-nanoseconds`, which was a probe
  bug — the plausibility window accepted the degenerate 2001 anchor reading. Fixed and verified
  across all epoch shapes; the corrected value (expected `apple-seconds`) awaits a re-run. See
  [calendar.md](calendar.md) for the full account of that bug.
- **`Downloads.plist`** — 3,871 bytes, unexamined.
- **`CloudTabs.db`** — absent here, so tabs open on other devices are unmeasured.
- **Writes.** Opening a URL or adding to the Reading List is an Apple Event and was not attempted;
  it navigates a real browser.
- **No schema fixture captured.** `--write` would emit `packages/safari/test/fixtures/`, and there is
  no `packages/safari` yet.

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
powerful verb cannot be predicted to work.

> **Corrected below.** This paragraph originally said that verb "silently fails", and the sentence
> after it says the probe deliberately never attempts it. Both are superseded: it was attempted on
> 2026-08-30 and the refusal is loud and specific — see
> [The `do JavaScript` refusal is loud](#the-do-javascript-refusal-is-loud-and-the-received-rationale-overstated-it).

The toggle's own state is hard to read: `defaults read com.apple.Safari
AllowJavaScriptFromAppleEvents` is itself TCC-protected and returned nothing here, so the probe
reports **unknown** rather than guessing. It deliberately did not attempt `do JavaScript` to find
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

## Page text is unreachable, and it is an absence rather than a price

The surface cannot read a word of any page, which is the most common thing to expect of it. Measured
2026-08-30 on macOS 26.6 by `scripts/spike-safari-page-text.mjs` and
`scripts/spike-safari-ax-census.mjs`, against a real Safari with 2 windows and 64 tabs.

**The Accessibility lane does not reach the page at all.** Not slowly — at all. System Events sees
the window and enumerates its chrome, and that is the whole tree:

| Under Safari's front window |                     |
| --------------------------- | ------------------- |
| `AXButton`                  | 3                   |
| `AXStaticText`              | 2                   |
| `AXGroup`                   | 2                   |
| `AXTextField`               | 1 (the address bar) |
| `AXImage`                   | 1                   |
| `AXToolbar`                 | 1                   |
| **`AXWebArea`**             | **0**               |
| max depth                   | 3                   |

Ten elements, bottoming out at depth 3 — so the depth-12 bound in the hunting spike was never the
limitation. Safari renders web content in a separate process and does not expose it down this path.

This changes the shape of the argument, not just its answer. `docs/surfaces.md` rejected the
Accessibility read lane for Maps on **cost** — ~206 elements at 33.6 ms a round trip, ~14 s, no bulk
fetch. Here there is nothing to price. A cost can be engineered around; an absence cannot, so this
is the stronger reason to leave the surface alone, and it should not be filed under the Maps
finding.

**It does not generalise from Mail, and that was the assumption worth killing.** `packages/mail`
really does read attributes inside a WebKit `AXWebArea` (`findBodyArea` in
`src/client/jxa/core.ts`), which is what made this look promising. That composer is an _in-process_
WebKit view. Safari's page is not, and the precedent transfers no further than the process boundary.

**Still open, deliberately unattempted:** VoiceOver reads web pages, so the content is in the
accessibility API — just not through this door. WebKit builds that tree lazily for clients it treats
as assistive, which some tools trigger by setting `AXManualAccessibility` or
`AXEnhancedUserInterface` on the application element. That is undocumented and app-specific, which
is the same class of unmodellable dependency as the toggle below — so it was not tried.

### The `do JavaScript` refusal is loud, and the received rationale overstated it

This document, `jxa/tabs.ts` and `surfaces.json` all argue the verb must not ship because it would
report a healthy surface whose best capability **silently fails**. Attempted once, it does not fail
silently. It returns error **code 8**:

> You must enable 'Allow JavaScript from Apple Events' in the Developer section of Safari Settings
> to use 'do JavaScript'.

That names the toggle, the pane and the fix. A tool passing it straight through would leave a user
knowing exactly what to do.

**What survives is the narrower half**, and it is the half worth arguing from: the toggle's own
state is still unreadable, so `apple_safari_diagnostics` cannot say in advance whether the verb will
work — only afterwards, by attempting it and reporting what came back. That is a real objection to
promising the capability in a tool list. It is not "fails silently", and the difference matters if
the verb is ever reconsidered: the cost is one honest diagnostics row, not a broken promise.

The decision does not change on this evidence. The recorded reason for it does.

**The Reading List walker now runs for real.** Not against a real `Bookmarks.plist` — that still
needs the grant — but against a synthetic binary plist checked in at
`packages/safari/test/fixtures/Bookmarks.plist`, which reproduces the exact `plutil` failure
(verified by a test that asserts `plutil -convert json` still fails on it), executed through the
real `osascript` runner. That found one bug this document's version also has: the ROOT node is a
`WebBookmarkTypeList` whose `Title` is the empty string, so treating any non-null title as a path
segment prefixes every folder path with a leading slash.

## The Safari Web Extension lane, built

**Shipped.** `apps/apple/CupertinoSafariExtension` captures a page when it loads on a website the
user has allowed it on, and `apple_safari_read_page` reads it. Verified end to end against a real
page — Hacker News, 3,681 characters of text and 34,907 of HTML, returned through the built server
over stdio on a run where that same server reported `history=UNREADABLE`. The three lanes really are
independent: this one needs neither Full Disk Access nor an Automation grant.

**The app reports it, because nothing else can.** The Safari pane carries a Page content card
beside Access and Store — the three cards are the three lanes — saying whether the extension is
enabled, how many pages it holds and how old the newest is. That last part is the point:
`getStateOfSafariExtension` answers about a SWITCH, and Safari grants the extension one website at
a time, so "enabled" and "allowed on nothing" are the same answer until something counts the
captures. `apple_safari_diagnostics` cannot make up the difference from its side — a disabled
extension leaves its last captures in place and stops adding more, so the store looks healthy while
answering with an ever-older page.

Two things measured while building it. `SFSafariApplication.showPreferencesForExtension` does open
Safari's Extensions pane with our row selected, which the previous plain launch did not; its
completion handler carries an error, so the launch is kept as the fallback. And `SFErrorCode` has
three cases where the code matched only the domain — `noExtensionFound` is 1, and 2 and 3 are
"could not ask", which had been reporting as an extension that is not installed.

The rest of this section is the Phase 0 evidence that said it was payable, kept because the traps it
names cost real time and will cost it again on the next Apple app that grows an extension.

Measured 2026-08-30/31 on macOS 26.6, against a throwaway signed and notarized probe app. The
question was whether an extension could do what neither `do JavaScript` nor Accessibility can, and
do it without costing something this project cannot pay.

**It can be a Developer-ID app, and the container does NOT have to be sandboxed.** This is the
finding that decides the direction, because `docs/distribution.md` forecloses the App Store — the
sandbox denies the store lanes outright — and Apple's own `safari-web-extension-converter` template
sets `ENABLE_APP_SANDBOX = YES` on _both_ the app and the extension. Overriding the app target to
`NO`, leaving the appex sandboxed, still builds, signs, notarizes (`Accepted`), passes
`spctl` as `Notarized Developer ID`, registers in `pluginkit`, and appears in Safari's Settings →
Extensions where it can be enabled. No Develop-menu "Allow unsigned extensions" is involved.

**The whole chain runs with real page content, and the appex needs no app group — so Cupertino
needs no new entitlement.** Measured end to end on `https://example.com`: a content script extracted
the page, a background service worker relayed it through `browser.runtime.sendNativeMessage`, the
sandboxed appex wrote it as JSON into its container, and a shell with no Full Disk Access read it
back — 125 characters of text alongside `htmlLength: 544` for the raw `outerHTML`, which is both
halves of the `format: "text" | "html"` split the tool is specified to offer. A sandboxed appex's own
container — `~/Library/Containers/<appex-id>/Data/…`, `drwx------` and owned by the user — is
readable by any same-user process outside the sandbox, so the node server can read what the
extension writes. Measured with a negative control: a shell that is DENIED on
`~/Library/Safari/History.db`, `~/Library/Mail` and `~/Library/Messages/chat.db` nonetheless reads
the containers of `uBlock Origin Lite`, `Keepa` and the probe. `~/Library/Containers` is not
TCC-protected for same-user access.

That matters more than it sounds. The alternative — an app-group container — means adding
`com.apple.security.application-groups` to an entitlements file that today holds exactly one key,
and `docs/distribution.md` calls the bundle identity "the most expensive string in the project:
changing it is a new TCC identity, so every existing user re-grants Full Disk Access". The container
route avoids that entirely.

**It costs the network audit nothing.** `scripts/audit-network.sh` discovers Mach-O binaries under
`Contents/` by `file -b` rather than from a list, so an appex is scanned automatically — and a
`SafariWebExtensionHandler` linking `SafariServices` introduces **zero** denied symbols
(`nm -u` and `otool -L` both empty against the DENY list). It adds exactly one audited binary.

### Three costs that are not obvious until you build one

**Safari will not list an extension whose container app is not notarized AND stapled.** Signing is
not enough, and the failure is silent: no error, no entry, nothing in the system log. Measured
twice, in both directions. The consequence is that `make app` and `make run` cannot exercise an
extension at all — Debug builds are signed with Apple Development and never notarized — so this work
needs the full `make build-release` path, an Apple round trip per iteration.

**Apple's template grants the CONTAINING app `com.apple.security.network.client`.** On a project
that advertises no network and gates it in CI, that would ship a network entitlement under a
no-network claim — and `audit-network.sh` inspects symbols, not entitlements, so it would pass
straight through. Strip it deliberately, and consider asserting its absence in the audit.

**Xcode's automatic signing adds `com.apple.security.get-task-allow`, which notarization rejects
outright.** The first submission came back `Invalid` naming that entitlement on both binaries. The
appex must be hand-signed with its own entitlements file, inside `make sign`, before the outer app
is sealed — the same inner-out rule the bundle already follows for Sparkle, node and the bridge.

**The converter references resource files individually, not as a folder.** `manifest.json` and
`content.js` each get their own `PBXFileReference` and an entry in the resources build phase. Add a
`background.js` without wiring it in and the build SUCCEEDS, the bundle ships without it, and the
only evidence is a line in Safari's own extension error list — "Unable to find background.js in the
extension's resources" — which nothing in the toolchain surfaces. This cost several build,
notarize and restart cycles to find. Whatever ships here wants a check that the files in
`Resources/` match what `manifest.json` names.

Also: the appex bundle identifier must be prefixed by the app's, so Debug
(`io.mgcrea.cupertino.debug`) and Release get different extension identifiers — and Safari keys
enablement state to that identifier. The two builds hold separate extension state.

### Replacing the app under a running Safari can crash Safari

Observed on macOS 26.6, Safari 26.6, reinstalling `/Applications/Cupertino.app` while Safari was
open with the extension enabled. Safari aborted, and the backtrace is unambiguous about the
mechanism:

```
_extensionDiscoveryHasNewResults           the bundle at a known path changed
  _extensionWasAdded -> insertRowsAtIndexes
    tableView:viewForTableColumn:row:      drawing the new row
      isEnabledInAnyNamedProfile
        extensionDataForExtension:
          _disableAndBlockExtension:       decides to block it, mid-draw
            removeExtension:
              _extensionWasRemoved -> removeRowsAtIndexes    re-entrant mutation
                                                             -> NSTableView raises -> abort
```

Safari starts inserting a row for the newly-discovered extension and, while asking its own delegate
to draw that row, decides the extension must be blocked — which removes it, which mutates the same
table inside the insert. That is a re-entrancy bug in `ExtensionsPreferences`; nothing an extension
does in its own code reaches it, and the app's signature was valid and notarized throughout.

**The reason to record it is Sparkle.** The updater replaces the whole app bundle in place, which is
exactly the trigger. A user running Safari with the extension enabled when Cupertino updates itself
is in the same position as this measurement — with their extension blocked, and possibly their
browser gone. `Sessions.swift` already postpones a relaunch while an MCP client is connected; it
knows nothing about Safari.

Unmeasured, and worth knowing before this ships: whether the block persists across a Safari restart
(i.e. whether the user must re-enable the extension by hand), whether Sparkle's replacement is
gentler than a `ditto` over the top, and whether staging the update and swapping on quit avoids it.
Installing while Safari is closed is the obvious workaround for development and says nothing about
what users will do.

### What is not yet measured

**Whether the app can PULL from the extension on demand** (`SFSafariApplication.dispatchMessage`),
as opposed to the extension pushing. This decides whether a tool returns live content or a cache
carrying a `capturedAt`, and it is the one thing Phase 0 did not settle. Push demonstrably works, so
a push-with-freshness-disclosure design is shippable without it.

**There is a second door to that API, and it is the better one.** Safari's dictionary carries a
hidden command — `dispatch message to extension` (`sfridste`), direct parameter "a dictionary
describing the message" — which is `SFSafariApplication.dispatchMessage` reachable by Apple Event.
Confirmed present in `sdef /Applications/Safari.app` on macOS 26.6 by
`scripts/probe-safari-write.mjs` (Q1); its dictionary shape, and whether it wakes a non-persistent
MV3 service worker, are unmeasured.

Why it matters more than the Swift call: `SafariWebExtensionHandler.swift` records that there is no
channel from the app into a running MCP server, so an app-driven pull could not be triggered by a
tool. An Apple Event can be sent BY the server, which removes the app from the path entirely. That
makes it the candidate for a command channel into the extension — the thing a click-or-fill tool
would need, and the reason such a tool is not on the Apple Events lane. See "Writes, built" below.

## Writes, built

**Shipped, and smaller than the surface could support on purpose.** Two verbs:
`apple_safari_open_url` and `apple_safari_add_reading_list_item`, behind `APPLE_SAFARI_ALLOW_WRITES`
like every other surface's writes. `surfaces.json` flipped `supportsWrites` to true with them.

**The reason `supportsWrites` was false was half right, and the half that was wrong chose the first
verb.** This document said opening a URL or adding to the Reading List "is an Apple Event that
navigates a real, visible browser". True of the first. `add reading list item` opens nothing, loads
nothing and moves nothing on screen — it is the only write in the bundle with no visible effect at
all, which is why it was the one to build first.

**Neither write needs Full Disk Access.** Both are Apple Events, so this is the one surface in the
bundle whose write lane works on a machine where its read lane does not. The `verified` field on the
Reading List add is the exception and degrades honestly when the grant is missing.

### The scheme allowlist is the security boundary, not input validation

`do JavaScript` is still not shipped, for the reasons this document has given since the beginning:
the toggle is global, permanent, unscoped, and its state cannot be read, so diagnostics can never say
in advance whether the verb would work.

Adding a navigation verb puts that decision under pressure from an unexpected direction. **Navigating
a tab to a `javascript:` URL is `do JavaScript` through the front door** — same capability, no
toggle, no consent, reached through a tool whose description says it opens web pages. `file:` is the
same shape one step down: a navigation verb that reads local files.

So the write lane accepts `http` and `https` and nothing else, as an allowlist rather than a
blocklist, enforced in `client/safari.ts` before any Apple Event is sent AND again inside the JXA.
`test/writes.test.ts` asserts a refusal sends no Apple Event at all — a refusal that still dispatched
would be a refusal in name only.

Whether Safari itself would accept such a URL is unmeasured; `scripts/probe-safari-write.mjs
--scheme-gate` asks. The allowlist does not depend on the answer.

### `liveTabs: false` outranks `allowWrites`

That flag is documented as leaving a server that "never sends an Apple Event and so never triggers
the Automation prompt". A write that ignored it would break the promise silently, on the one machine
whose owner asked for it — and invisibly, because the tool list does not vary with runtime state. So
both writes refuse when it is off, naming the variable.

### The Reading List lags its own file, and the tool says so rather than guessing

Safari owns `Bookmarks.plist` and writes it on its own schedule, so an item that was genuinely added
can be absent from the file a moment later. `verified` therefore has three states and not two: `true`
(re-read and found), `null` with a reason (not visible yet, or the file is unreadable), and **never
`false`**. Reporting an unconfirmed write as a failed one is the worse error, because the caller
retries — and the Reading List accepts duplicates while `sdef` offers no verb to remove one. The lag
itself is unmeasured; `--reading-list` in the probe measures it, and if it turns out to be instant the
tool can promise more than it does now.

Safari's hidden `sync all plist to disk` (`sfriplst`) looks like the fix for the lag. It is
undocumented and unmeasured, and is not used.

### What is deliberately not here

**Anything that acts inside a page** — click, fill, scroll. The only Apple Event that could is
`do JavaScript`, and the argument above rules it out. That capability belongs on the extension lane,
where Safari grants access one website at a time rather than all of them forever. It needs a command
channel INTO the extension, which does not exist today: `dispatch message to extension` is the
candidate, and it is unmeasured. Until then Cupertino can open a page and read it, and cannot touch
it.

**`close_tab`**, because closing destroys state that cannot be recovered — a half-filled form, a page
that no longer resolves — and it is the one verb here that doing again differently does not undo. Not
hard; a separate decision.

**`search_web`**, which is `open_url` with the search engine's URL.

### Measured

Written before it was measured — reasoned from the dictionary on a machine with no Automation grant,
which is the reverse of how every other lane here landed — and then measured by
`scripts/probe-safari-write.mjs` on macOS 26.6, Safari 26.6, against a live browser with 1 window and
22 tabs.

**The uncertain idiom works, and no fallback fired.**

| Verb                    | Route         | Cost   |
| ----------------------- | ------------- | ------ |
| `open_url`, new tab     | `tab-push`    | 166 ms |
| `open_url`, current tab | `current-tab` | 108 ms |
| `add reading list item` | —             | 148 ms |

`Safari.Tab({url}).push()` into a window's tab list is what actually places the tab, so
`open location` stays a fallback that has never been needed. The dictionary still carries
`add reading list item` with both optional parameters, and `tab.URL` is still writable.

**The freshly opened tab came back titled "Untitled".** That is the `loadNote` disclosure showing up
in the first measurement taken of it: the read-back happens immediately, the page has not loaded, and
a caller that treated `tab.title` as the page's title would report a wrong one. The current-tab
navigation, going to a URL already loaded in another tab, came back titled correctly — so this is not
reliably visible and must not be inferred from one run either way.

### Safari accepts a `javascript:` URL through the navigation verb

**Measured, and it is the finding that justifies the allowlist.** Asked to push a tab whose URL is
`javascript:void(document.title)`, Safari took it — no refusal, no error, no toggle involved.

So the boundary really is the allowlist and nothing else. "Allow JavaScript from Apple Events" gates
`do JavaScript`; it does not gate a tab whose URL happens to be a script. Any Safari automation that
accepts an arbitrary URL string offers script execution in the page whether its author intended to or
not, and this one would have, which is why the check is duplicated across the TypeScript and the JXA
and why `test/writes.test.ts` asserts a refused URL dispatches nothing at all.

### `with title` and `and preview text` are nearly decorative

**Measured, after the shipped tool was found advertising something it does not deliver.** The probe
added an item with `withTitle: "Cupertino probe"`; reading the Reading List back gave the entry the
title **"Example Domain"** — the page's own — along with preview text the probe never supplied.

The obvious diagnosis, a JXA parameter name that does not map, is wrong. Sending the same custom
title with a URL that cannot resolve (`https://example.invalid/…`, a reserved TLD per RFC 2606) kept
it: the entry came back titled `TITLE-PARAM-SURVIVED` with a null preview. So `withTitle` really does
reach `with title`, and **Safari overwrites it from the page it fetched**. The parameter takes effect
only where Safari cannot reach the page, which is the case nobody has.

**And that is how we know this verb hits the network.** `add reading list item` was described here
and in the tool itself as changing nothing — "no tab opens and no page loads". The first half is
true. The second was false and is now corrected in both: Safari fetches the URL in the background,
from the user's browser, to build the entry. Adding a URL to somebody's Reading List is a network
action taken on their behalf, and a caller deciding whether to save a link should know that the link
gets contacted.

### The Reading List lag is still unmeasured, and the first attempt to measure it was wrong

The probe polls `Bookmarks.plist` for the item it just added. Run from an unprivileged process every
poll returns `EPERM`, the loop times out, and the first version of it printed "NOT visible after 30 s
— which is the lag `verified: null` exists for": a permission failure rendered as a measurement of
Safari's write behaviour, in the exact shape this document warns about everywhere else. It now checks
whether it can read the file at all first — `grep` exits 1 for "no match" and 2 for "cannot read",
and only the second says anything about the instrument — and reports the lag as unmeasurable rather
than as absent.

The add itself succeeded in 148 ms. What remains unknown is the LOWER bound — how quickly Safari
writes it down — which needs a re-run from a process holding Full Disk Access.

An upper bound now exists, from a different instrument. Both probe items were read back through
`apple_safari_list_reading_list`, which walks `Bookmarks.plist` from the bridge process that does
hold the grant, and both were present: the second within seconds of its add. So the file is written
promptly rather than at some later checkpoint, and `verified: true` should be the common case. The
three-state design stands regardless — the cost of being wrong in one direction is a duplicate
nothing can remove.

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
- ~~**Writes.**~~ Built, for two verbs — see "Writes, built" above. What remains open is narrower
  and is listed there: the JXA idioms are reasoned rather than observed, and
  `scripts/probe-safari-write.mjs` is the instrument that closes that.
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

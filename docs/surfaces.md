# Which surfaces, and what each one costs

The per-surface findings live in [notes.md](notes.md), [reminders.md](reminders.md),
[messages.md](messages.md), [calendar.md](calendar.md), [safari.md](safari.md),
[contacts.md](contacts.md) and [envelope-index.md](envelope-index.md). This document is the layer above them: which Apple apps can
be reached at all, what a new surface costs to add, and the rules the phase-0 probes have taught that
now generalise across surfaces.

## The question is which lane can reach an app, not which apps exist

`Surfaces.swift` fixes a closed table, each entry a bundle ID (Apple Events lane) and an optional
store path (file lane). The app links no data frameworks — it is a pure broker. That leaves three
ways to reach anything:

| Lane                                       | Cost                                                             | Ceiling                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Apple Events** (`NSAppleScriptEnabled`)  | one Automation prompt per bundle ID; ~200 LOC of JXA             | per round trip, and the round trip is the cost — see Calendar                               |
| **File lane** (read-only SQLite under FDA) | grant already held; schema must be reverse-engineered by a probe | fast, read-only, drifts across macOS releases                                               |
| **Neither**                                | link EventKit / Contacts / PhotoKit in the app; new TCC grants   | complete and fast, but moves logic from TypeScript into Swift and forks the two-lane design |

No surface has needed the third lane. Calendar looked like it would and did not — see
[calendar.md](calendar.md).

## Scriptability, measured on macOS 26.6

`NSAppleScriptEnabled` read from each installed app's `Info.plist`.

**Scriptable** — Apple Events lane available: Reminders, Messages (writes only), Calendar,
Contacts (writes only — its dictionary has no delete command at all),
Safari (READS only, and the only one — live tabs, which the file lane cannot see at any price),
Photos, Shortcuts, Music, TV, Finder, Preview, QuickTime Player, Terminal, Script Editor,
Xcode, System Settings.

**Not scriptable** — file lane or nothing: Freeform, Journal, Books, Podcasts, **Maps**, News, Home,
Weather, Passwords, Stickies, Font Book, Image Capture, Photo Booth, Clock, Dictionary.

Maps is in that list and now ships anyway: `packages/maps` is the first surface with **no Apple
Events lane at all**. Being non-scriptable turned out not to be the obstacle — see below.

## State of play

| Surface   | Lane verdict                                 | Status      |
| --------- | -------------------------------------------- | ----------- |
| Mail      | file lane required — 74 s search             | implemented |
| Notes     | Apple Events usable below ~5k notes          | implemented |
| Reminders | dictionary complete for the core model       | implemented |
| Messages  | **file lane mandatory** — no read API exists | implemented |
| Calendar  | **file lane mandatory** — 3.4 s range query  | implemented |
| Safari    | two lanes see disjoint things                | implemented |
| Maps      | **file lane only** — no `.sdef` exists       | implemented |
| Contacts  | file-lane reads, 0 ms; store is plural       | implemented |

Every probed surface now has a package. **Safari is the only read-only one**, and that is recorded
as a decision rather than left as an omission: `surfaces.json` carries the reasoning, and its
`tools.test.ts` asserts the tool list is IDENTICAL with writes enabled, so a mutating tool cannot
appear there without that decision being taken again.

Messages was the other one until its send lane landed, and the shape it ended up with is worth
keeping in view, because it is the one this table's "no read API exists" verdict seemed to rule out.
Apple Events on that surface is a **write lane and nothing else** — one command, `send` — and the
thing that made it shippable was not a new measurement but a division of labour between the lanes:
the file lane picks the target (Messages will not enumerate participants for a script, but it will
accept a chat guid, and `chat.db` holds one for every conversation) and the file lane finds the sent
row afterwards (Apple Events returns no identifier for what it sent). Its `jxa.test.ts` asserts
`read.ts` does not exist, which is the same guard by a different name.

**Safari is the exception to the lane policy, and the exception is principled.**
[distribution.md](distribution.md) says a new surface gets file-lane reads only, because an Apple
Events read lane is a slow duplicate of a fast one. Safari's is not a duplicate: its two lanes see
almost disjoint things, and no amount of file-lane speed answers "what is open right now", because
Safari never writes it down. It is the one surface here where losing a grant makes the server
_smaller_ rather than _slower_.

### Beyond the probed set

**Shortcuts** is the cheapest thing available and not a data surface at all: `/usr/bin/shortcuts
list|run`, ~200 LOC, no probe, no schema, no new grant. It makes every app the user has already
automated reachable at once. Two caveats: `run` executes arbitrary user-authored automation, so it
belongs behind `allowWrites`; and its output is unstructured, so the tool contract has to say so.

**Photos** is scriptable with `Photos.sqlite` under FDA. Real value — the file lane buys bytes, as it
did for Notes — but the AppleScript lane is slow and the schema is among the largest Apple ships.
Worth it only for a concrete workflow.

**Deliberately not recommended.** Music, TV, Finder, Preview and QuickTime are trivially scriptable
and low value. Terminal, Script Editor and System Settings are scriptable and dangerous: they hand a
caller arbitrary execution using a permission granted for reading mail, which is precisely what the
closed table in `Surfaces.swift` exists to prevent. The rest of the non-scriptable set (Freeform,
Journal, Books, Podcasts, Home, Weather, Passwords, News) is where the grant is the _only_ way in —
the most differentiated value and the highest maintenance risk, since there is no fallback lane.
`group.com.apple.Journal` and a 33 MB `group.com.apple.freeform` both exist if revisited.

**Maps came out of that set and shipped**, and how it nearly did not is the transferable part.

It was declared "no file lane" **three times** before the store was found, by a process that held no
Full Disk Access and never checked. `find` over `group.com.apple.Maps` returned only the directory
and was read as empty when it was `EPERM`. A sweep for `*.db` / `*.sqlite*` missed the store because
**it has no file extension** — `MapsSync_0.0.1`. A full container listing missed it because
`Data/Maps/` was the one gated directory, and its omission read as absence.

That is this document's own rule — "'Absent' and 'EPERM' are different findings" — broken three
times in a row by the project that wrote it down. The fix is procedural rather than a note:
[`scripts/spike-maps-store.mjs`](../scripts/spike-maps-store.mjs) tests four stores that shipped
surfaces read daily and **refuses to report a negative** unless it can open them, and
`probe-maps.mjs` exits 3 rather than printing a result it cannot stand behind. Any future probe of a
gated store should start the same way.

The Accessibility lane was measured and rejected on the way, which is worth keeping because it is the
first real datum on that lane's cost: Maps' sidebar IS readable through System Events, but a full
read needs ~14 s (33.6 ms per Apple Event round trip x ~206 elements x two properties; bulk fetch is
unavailable in both JXA and AppleScript, and scoping does not help because the sidebar IS 206 of the
window's 213 elements). It also yields no coordinates and no stable identifier. The file lane answers
the same questions in 0 ms with both. See [maps.md](maps.md).

## What a new surface costs

Budget ~2k LOC for a surface with both lanes: `packages/notes` is 20 files / 2,131 LOC,
`packages/mail` 26 / 3,872, on top of `packages/core`. The shape, top to bottom:

`cli.ts` → core's `runStdioServer` → `server.ts` → `tools/*` → `client/<id>.ts` (lane orchestrator) →
`client/jxa/*` or `client/store.ts`.

Start with a probe, not a package: `scripts/probe-<id>.mjs` → `docs/<id>.md` → `packages/<id>`. The
shared probe mechanism is [`scripts/lib/probe-kit.mjs`](../scripts/lib/probe-kit.mjs) — the osascript
boundary, the exists-vs-readable split, the `ro`→`immutable` ladder, schema dump, id-bridge scan,
epoch detection and the fixture writer. The first three probes predate it and still carry their own
copies.

**The surface list lives in [`surfaces.json`](../surfaces.json)** and every other copy is generated
from it by `make surfaces`. `make surfaces-check` fails on drift and runs in CI, so a hand-edit to a
generated region is a red build rather than a shipped inconsistency.

| File                                    | Form                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| `apps/apple/Cupertino/Surfaces.swift`   | `Surface.all`                                                    |
| `apps/apple/CupertinoBridge/main.swift` | `let known = [...]`                                              |
| `Makefile`                              | `SURFACES :=` and `SHOT_WRITES :=`                               |
| `.github/workflows/ci.yml`              | the stdio handshake loop                                         |
| `apps/apple/tsdown.servers.config.ts`   | the bundler's entry map                                          |
| `Cupertino.xcodeproj/project.pbxproj`   | the Apple Events consent string, ×2                              |
| `scripts/wiring-check.swift`            | the surfaces it checks                                           |
| `apps/website/src/data/surfaces.ts`     | the `id` union (not the tool names)                              |
| `.mcp.json`                             | the dev bridge entries (written, not checked — it is gitignored) |

Adding a surface is one manifest entry and `make surfaces`. Two things are deliberately NOT generated:
the website's tool names, which are transcribed from `packages/<id>/src/tools/` because a wrong name
there is a claim the servers do not honour, and the marketing prose, which the site derives from its
own `SURFACES` array at build time.

Releases need no change — the tag convention (`<slug>-v0.1.0` → `packages/<slug>`) already handles
any new package.

## Rules the probes have established

Each of these was learned by getting it wrong first, which is why they are written down.

**Bulk-fetch and filter in JS; do not use `whose`.** Three surfaces, three shapes of predicate, same
answer: Notes measured `whose` 6.9× slower on a text `contains`; Calendar measured it slower _and_
higher-variance on a date range (4.5–7.3 s against a steady 3.4–3.9 s). Reminders asked whether the
answer generalised from text to booleans. It appears to generalise everywhere. Measure it per
surface anyway — but expect this result.

**The Apple Events cost is per round trip, not per item.** Calendar's per-property bulk fetch costs
~2 s whichever property it is, even one returning 23 non-null values out of 742. A server reading
twelve properties pays twelve times that. This is why bulk-fetching wins and why no caller-side
optimisation helps.

**`stat` succeeds on files you cannot read.** "Absent" and "EPERM" are different findings — one means
the surface has no file lane, the other means run it again with the grant. Conflating them is what
put Calendar on a path toward EventKit it never needed.

**Sample more than one row before describing a blob.** The Notes `ZDATA` decoder was documented
backwards because a `LIMIT 1` sample landed on one of two outliers.

**Dates are the richest source of silent errors.** Three distinct traps, all encountered:

- _Overflow._ `node:sqlite` throws on an INTEGER too large for a JS double rather than truncating.
  Messages stores nanoseconds since 2001 (~7.9e17), so the throw is the common case there — and
  swallowed by a `try`/`catch` it is indistinguishable from "this column has no dates". Read such
  columns as BigInt or `CAST(... AS TEXT)`.
- _The 2001 anchor._ Dividing a seconds value by 1e9 lands within a rounding error of 2001-01-01 and
  produces a date that looks entirely plausible. Any epoch heuristic must reject readings sitting on
  the anchor.
- _Future dates._ A calendar's newest row is not "now" — `MAX(start_date)` reads 2030 here. Heuristics
  that assume recency reject the correct answer.

**Name-matching columns needs token boundaries.** `calENDar_id` and `self_attENDee_id` both match a
naive `/END/i` sweep, and `start_tz` sits next to `start_date` holding a timezone string. Check the
declared type too.

**Ask the id-bridge question early.** Whether a store row can be joined to the identifier Apple Events
returns decides whether the surface has two lanes or two disconnected halves. Mail joins on `ROWID`,
Notes on `Z_PK`, Calendar on `CalendarItem.UUID` (198/198). Messages **cannot** — it returns no chat
identifier at all, so a `send` can never be reconciled against a read. Safari joins on the URL itself,
which resolves only about half of open tabs.

## Still open across all surfaces

- **No history schema fixture captured for Safari.** `packages/safari/src/client/store.ts` is
  therefore written against the EXPECTED DDL, with every column behind a `#col()` guard and the
  visits→items join column discovered at open time rather than named — so a wrong expectation
  costs one field instead of the lane, and `test/store.test.ts` pins that degradation. A
  `Bookmarks.plist` fixture IS captured (synthetic, checked in, and it reproduces the `plutil`
  NSData failure), so the Reading List walker runs for real in `test/bookmarks.test.ts`.
- **No schema fixtures captured** for Messages. (Contacts' is captured —
  `packages/contacts/test/fixtures/contacts-store.sql`, 94 objects, no rows.) (Calendar's is captured, and the premise
  of this note was wrong: `writeFixture` creates the directory, so `--write` never needed the package
  to exist first.)
- **Contacts needs a permission the app does not act on.** It sits behind its own TCC service, not
  Full Disk Access, and unlike FDA it PROMPTS — see [contacts.md](contacts.md). `surfaces.json` now
  records which grant gates each store and `Surface.storePermission` carries it into the app, but
  `Permissions.swift` still only ever checks Full Disk Access, so a Contacts store that cannot be
  opened is still reported with the wrong advice. Whether FDA alone opens it is measured in one
  direction only. That pane owes two states, this one and Safari's.
- ~~**The Automation row is a dead end while the target app is closed.**~~ Fixed. Contacts is what
  exposed it: Mail, Notes, Reminders and Calendar are apps people leave open, so `.appNotRunning` was
  effectively unreachable until a surface arrived that nobody keeps running. MEASURED, macOS 26.6,
  Contacts quit:

  | bundle                  | running | `askUserIfNeeded: false` | `askUserIfNeeded: true` |
  | ----------------------- | ------- | ------------------------ | ----------------------- |
  | `com.apple.AddressBook` | no      | `-600`                   | `-600`                  |
  | `com.apple.iCal`        | yes     | `0`                      | `0`                     |
  | `com.apple.reminders`   | yes     | `0`                      | `0`                     |
  | `com.apple.Notes`       | yes     | `0`                      | `0`                     |
  | `com.apple.mail`        | yes     | `0`                      | `0`                     |

  So `AEDeterminePermissionToAutomateTarget` does **not** launch its target: asked to prompt, it
  still returns `procNotFound`. `.appNotRunning` is therefore a precondition rather than a verdict,
  and three buttons wired straight to `requestAutomation` could never clear it — they re-ran the
  same call and wrote back the state they started in. Opening the app first settles it in **53 ms**,
  so `Permissions.launchAndRequestAutomation` opens the target without activating it, polls until
  TCC will answer, and then asks. The same pass found `.denied` had the identical defect in
  `SurfaceDetail`, which offered "Allow…" for a denial that cannot be re-prompted; button labels and
  destinations now come from one `StatusStyle.actionLabel`.

- **`Permissions.swift` models two permission states, and Safari's third is now AVOIDED rather
  than modelled.** `do JavaScript` needs "Allow JavaScript from Apple Events" — a developer-menu
  toggle, not a TCC grant, whose own state is unreadable because `defaults read com.apple.Safari
AllowJavaScriptFromAppleEvents` is itself TCC-protected. `packages/safari` ships no verb that
  needs it, and `test/jxa.test.ts` asserts no script contains `doJavaScript`, so the app's
  two-state model stays honest for this surface. The third state is only owed if that verb is ever
  wanted — see [safari.md](safari.md).
- ~~**The four hardcoded surface lists.**~~ Done, and the count was understated: it was ten, not four.
  `surfaces.json` plus `scripts/generate-surfaces.mjs` replaced all of them when Contacts went in as
  the fifth surface, and `make surfaces-check` runs in CI. Two findings from doing it: a `#` comment
  cannot sit inside a Makefile backslash continuation, so `SHOT_WRITES` had to become its own
  variable; and generating the Apple Events consent string from `usesAppleEvents` means a read-only
  surface no longer widens the permission the app asks for.

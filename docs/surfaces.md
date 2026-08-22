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
Photos, Safari, Shortcuts, Music, TV, Finder, Preview, QuickTime Player, Terminal, Script Editor,
Xcode, System Settings.

**Not scriptable** — file lane or nothing: Freeform, Journal, Books, Podcasts, Maps, News, Home,
Weather, Passwords, Stickies, Font Book, Image Capture, Photo Booth, Clock, Dictionary.

## State of play

| Surface   | Lane verdict                                 | Status          |
| --------- | -------------------------------------------- | --------------- |
| Mail      | file lane required — 74 s search             | implemented     |
| Notes     | Apple Events usable below ~5k notes          | implemented     |
| Reminders | dictionary complete for the core model       | implemented     |
| Messages  | **file lane mandatory** — no read API exists | probed, unbuilt |
| Calendar  | **file lane mandatory** — 3.4 s range query  | implemented     |
| Safari    | two lanes see disjoint things                | probed, unbuilt |
| Contacts  | file-lane reads, 0 ms; store is plural       | implemented     |

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
closed table in `Surfaces.swift` exists to prevent. The non-scriptable set (Freeform, Journal, Books,
Podcasts, Home, Weather, Passwords, Maps, News) is where the grant is the _only_ way in — the most
differentiated value and the highest maintenance risk, since there is no fallback lane and no write
path. `group.com.apple.Journal` and a 33 MB `group.com.apple.freeform` both exist if revisited.

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

- **No schema fixtures captured** for Messages or Safari. (Contacts' is captured —
  `packages/contacts/test/fixtures/contacts-store.sql`, 94 objects, no rows.) (Calendar's is captured, and the premise
  of this note was wrong: `writeFixture` creates the directory, so `--write` never needed the package
  to exist first.)
- **Contacts needs a permission the app does not act on.** It sits behind its own TCC service, not
  Full Disk Access, and unlike FDA it PROMPTS — see [contacts.md](contacts.md). `surfaces.json` now
  records which grant gates each store and `Surface.storePermission` carries it into the app, but
  `Permissions.swift` still only ever checks Full Disk Access, so a Contacts store that cannot be
  opened is still reported with the wrong advice. Whether FDA alone opens it is measured in one
  direction only. That pane owes two states, this one and Safari's.
- **`Permissions.swift` models two permission states.** Safari needs three — see
  [safari.md](safari.md).
- ~~**The four hardcoded surface lists.**~~ Done, and the count was understated: it was ten, not four.
  `surfaces.json` plus `scripts/generate-surfaces.mjs` replaced all of them when Contacts went in as
  the fifth surface, and `make surfaces-check` runs in CI. Two findings from doing it: a `#` comment
  cannot sit inside a Makefile backslash continuation, so `SHOT_WRITES` had to become its own
  variable; and generating the Apple Events consent string from `usesAppleEvents` means a read-only
  surface no longer widens the permission the app asks for.

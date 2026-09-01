# Which surfaces, and what each one costs

The per-surface findings live in [notes.md](notes.md), [reminders.md](reminders.md),
[messages.md](messages.md), [calendar.md](calendar.md), [safari.md](safari.md),
[contacts.md](contacts.md), [maps.md](maps.md), [home.md](home.md), [passwords.md](passwords.md),
[screen.md](screen.md) and [envelope-index.md](envelope-index.md). This document is the layer above them: which Apple apps can
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

**Not scriptable** — file lane or nothing: Freeform, Journal, Books, Podcasts, **Maps**, News,
**Home**, Weather, **Passwords**, Stickies, Font Book, Image Capture, Photo Booth, Clock, Dictionary.

Maps is in that list and now ships anyway: `packages/maps` is the first surface with **no Apple
Events lane at all**, and it both reads AND writes. Being non-scriptable turned out not to be the
obstacle — see below. It is worth knowing what that implies for the rest of the list: an app with
no `.sdef` is not automatically read-only, and "not scriptable" is a statement about Apple Events
rather than about capability.

## State of play

| Surface   | Lane verdict                                 | Status                                                 |
| --------- | -------------------------------------------- | ------------------------------------------------------ |
| Mail      | file lane required — 74 s search             | implemented                                            |
| Notes     | Apple Events usable below ~5k notes          | implemented                                            |
| Reminders | dictionary complete for the core model       | implemented                                            |
| Messages  | **file lane mandatory** — no read API exists | implemented                                            |
| Calendar  | **file lane mandatory** — 3.4 s range query  | implemented                                            |
| Safari    | two lanes see disjoint things                | implemented                                            |
| Maps      | **file lane only** — no `.sdef` exists       | implemented, and writes without an Apple Event         |
| Contacts  | file-lane reads, 0 ms; store is plural       | implemented                                            |
| Screen    | **capture lane** — ScreenCaptureKit, ~30 ms  | implemented, in the app: the first with no npm package |

Every probed surface now has a server, though **Screen no longer means a package** — it is served
in-process by the app, because ScreenCaptureKit is unreachable from node and a server's `PATH`
holds no `screencapture`. `surfaces.json` carries a `runtime` field for exactly that split, so the
targets that mean "has a node package" (the bundler's entry map, the CI handshake, `make servers`)
say so, while the bridge, the closed table and the settings UI take every surface. **Safari is the
only read-only one**, and that is recorded
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
Journal, Books, Podcasts, Weather, News) is where the grant is the _only_ way in —
the most differentiated value and the highest maintenance risk, since there is no fallback lane.
`group.com.apple.Journal` and a 33 MB `group.com.apple.freeform` both exist if revisited.

**Passwords has left that set too, and did not survive its probe** — see [passwords.md](passwords.md).
It was listed above as "the grant is the only way in", and that was wrong: there is no grant that
opens it. All four lanes are closed, three of them by things no Developer-ID build can change.
`Passwords.app` holds the Apple-private `com.apple.password-manager` keychain access group, and
`AuthenticationServices` is a **provider** API — `ASOneTimeCodeCredentialIdentity`'s header says to
use it to _save_ entries. It lets you be a password manager; it never lets you read Apple's. The
file lane is the interesting one: `keychain-2.db` **opens read-only with no Full Disk Access at
all**, and is still unreadable — `srvr` and `acct` are SHA-1 digests and the payload is ciphertext.
The store is readable and the data is not, which is the inverse of the Maps trap. What ships instead
is `apple_messages_find_codes`, because SMS is where 2FA codes actually arrive — joined later by
`apple_safari_find_codes` for the ones a website displays rather than sends, on a FIFTH lane that
document did not evaluate: a Safari extension content script, which needs no TCC grant at all and is
consented per site. Neither reaches the vault, and passwords.md now says so in a table so the two
questions do not get conflated.

**Home has left that set for a probe of its own** — see [home.md](home.md). Two of its four lanes are
already closed and worth recording here so they are not re-opened: `HomeKit.framework` is
`API_UNAVAILABLE(macos)` and exists on macOS only as a private framework, and its entitlement carries
no `DEVELOPER_ID` distribution type at all, so no Developer-ID build of this app can hold it whatever
lane it links; Home.app ships no `.sdef`. What is left is a file lane at `~/Library/HomeKit`, held
open by `homed` and Full-Disk-Access gated, plus `/usr/bin/shortcuts` for control. That last pairing
is new: **`shortcuts list` works with no Full Disk Access while the store does not**, so this would be
the first surface whose read and control lanes sit behind different grants.

`scripts/probe-home.mjs` has since been hand-run against a real store and it is a **GO**: the store
opens `mode=ro` under the grant Cupertino already asks for, nothing name-bearing is sealed
(115,466 B of legible text across 146 columns), the chain home -> room -> accessory -> service
resolves by scalar foreign key at coverage 1.000, and a full read costs 3 ms. One limit shapes the
product rather than blocking it: reading the store twice across a 90-second window moved no
role-bearing table, and `ZMKFCHARACTERISTIC` carries a value RANGE rather than a current value, so
this is **configuration only** — a static inventory that cannot say whether a light is on. Live
values arrive over HAP and stay in `homed`'s memory.

**Screen capture has been probed and is a partial GO** — see [screen.md](screen.md). It is not an
app and it is not in the table above; it would be a FIFTH lane, and the first thing here to need the
"neither" row of the lane table — a framework linked into the app, because ScreenCaptureKit is
unreachable from a node server that holds `PATH=/usr/bin:/bin`. The capability is not in doubt:
`SCContentFilter` composites a window that is 100% covered by another app, in 30 ms, so capture is
passive observation rather than something that has to raise windows. The identity question is
answered too: an `LSUIElement` Developer-ID bundle holds `kTCCServiceScreenCapture` and its
GRANDCHILDREN inherit it, measured through the screen-recording lane now wired into `spike.sh.in`.
That lane exists because the verdict must not be generalised from `scripts/spike-app-tcc` — it
measured Full Disk Access and Apple Events, this document's own codebase generalised to every TCC
service, and it was wrong for Accessibility. The same bundle held three grants and not this one
until it was granted separately. The grant also survives re-signing AND the bundle moving, keyed to
identifier + certificate exactly as Full Disk Access is. The one thing still unmeasured is whether
macOS 26 re-prompts periodically, which shapes the Permissions pane rather than the architecture.

Two findings there generalise beyond the surface. A **raw window enumeration is not a target list** —
Mail reports 16 windows and has one, the rest being shadows and helper layers — and **enumerable is
not capturable**, since a titled window can fail `SCScreenshotManager` with `-3811`. Both are the
same shape as "absent and EPERM are different findings": a count that looks like data and is not.

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

Rejected as a READ lane, not as a lane. Maps has no scripting dictionary and no App Intents
registered on macOS, so Accessibility is the only way a write could ever reach it — and with a place
card open it exposes named, pressable `Favorite` and `Add` controls. A write is a handful of round
trips rather than a walk of the tree, so the ~14 s that disqualifies it for reading does not apply.
That lane is open and unbuilt; [maps.md](maps.md) carries the measurement and the costs.

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
| `Makefile`                              | `SURFACES :=`, `NODE_SURFACES :=`, `SHOT_WRITES :=`              |
| `.github/workflows/ci.yml`              | the stdio handshake loop                                         |
| `apps/apple/tsdown.servers.config.ts`   | the bundler's entry map                                          |
| `Cupertino.xcodeproj/project.pbxproj`   | the Apple Events consent string, ×2                              |
| `scripts/wiring-check.swift`            | the surfaces it checks                                           |
| `apps/website/src/data/surfaces.ts`     | the `id` union (not the tool names)                              |
| `.mcp.json`                             | the dev bridge entries (written, not checked — it is gitignored) |

Adding a surface is one manifest entry and `make surfaces`, plus two declarations that decide what
kind of thing it is:

| Field     | Meaning                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`    | `app` brokers one Apple application; `capability` brokers something the system provides and no app owns. Drives how the settings list is grouped, which icon is drawn, and which permission is asked for. |
| `runtime` | `node` is a package under `packages/<id>`; `swift` is served in-process by the app.                                                                                                                       |

They are declared rather than inferred from each other. Today every capability is also `swift` and
has no `bundleId`, and that is a coincidence of there being one of them — the next capability should
not have to be recognised by what it lacks.

A capability names its own icon, because there is no app to ask LaunchServices about: `iconPath`
points at Apple's own Settings extension so it sits beside the app icons rather than looking like a
different kind of row, and `symbol` is a mandatory SF Symbol fallback. Both are required, because
`iconPath` points into `/System` and those names move — `DisplaysExt.appex` sits beside
`Sound.appex` in one directory, so there is no pattern to rely on. Without the fallback a moved path
lands on `app.dashed`, which means "this app is not installed" and would be a lie about something
that was never an app.

Two things are deliberately NOT generated:
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

**High entropy does not distinguish encrypted from compressed.** Both sit at 7.9–8.0 bits per byte:
measured, gzipped prose scores 7.983 and real AES-CTR ciphertext 7.980. Only a recognised container
header and a successful inflate separate them, so any "is this sealed" test must decompress first and
re-score the inflated bytes. Skipping that step does not produce an uncertain answer, it produces a
confident wrong one — and on a surface where the question is the go/no-go, that kills a legible store
by arithmetic. See `scripts/lib/blob-stats.mjs`, which is tested for exactly this.

**A statistic's threshold belongs at a distance from the null hypothesis, not at a constant.** The
first version of that file called a blob encrypted if its longest printable run was ≤ 6. Over 200
ciphertext samples per size the median run is 6 at 512 B, 8 at 4 KB and 10 at 32 KB — so the constant
reads a large ciphertext blob as legible. Entropy fails the same way from the other side: 256 random
bytes score 7.28, not 8, so a 7.8 threshold calls real ciphertext "unknown" at every small size. Both
statistics are length-dependent; the threshold has to be too.

**A filename can be the data.** Every probe here assumes paths are safe to print, and on seven
surfaces they were: Apple names the files. `~/Library/HomeKit` does not — it holds files named after
accessory MAC addresses, and a MAC identifies one physical device and is geolocatable through public
wifi databases. A directory listing of that surface is a partial inventory of a house before any
store is opened. So redaction has to cover the sweep, not just the rows, and the redaction gate has
to run over the finished document rather than at each call site: `scripts/probe-home.mjs` only found
this because `assertRedacted` refused to print a report that a careful author had already reviewed.

**A schema mirror outscores the thing it mirrors.** `NSPersistentCloudKitContainer` keeps its mirror
beside the real store and names it after the same entities with a `CK` infix, so every name-based
metric ties or favours the mirror while it holds a fraction of the rows. `scripts/probe-home.mjs`
picked `core-cloudkit.sqlite` over `core.sqlite` on 131 vocabulary hits against 127 — outranking
4,970 rows against 136,390 — and then reported the accessory-to-service hop as unresolvable, because
the mirror has no service table. Rank candidates by rows in tables that carry a ROLE, and exclude the
sync bookkeeping (`ANSCK*`, `ACHANGE`, `ATRANSACTION*`) from role assignment: otherwise a CloudKit
_record zone_ scores a perfect join against a HomeKit _zone_.

**Test for the signal with an allowlist, never for the noise with a denylist.** The "does this store
hold live state" test reads the store twice and reports which tables moved, and it was wrong twice in
a row for the same reason. First it counted every table that moved and announced live state on the
strength of `ACHANGE` and `ATRANSACTION` — CloudKit change tracking, which grows on an idle Mac
(+6 rows between two probe runs minutes apart). Then it excluded those by name and announced live
state on `ZRESIDENTSYNCMETADATA`, which is HomeKit's own resident sync token table and no more a fact
about the home. There is always another sync table, so the denylist can never be finished. The
question was never "which tables should not count" but "did a table holding one of the domain's
OBJECTS move" — and a role classifier already answered that. Same shape as scoring an id bridge:
state what would count as evidence BEFORE looking at what moved.

**Check whether the entitlement is claimable by a Developer-ID build before probing the store.**
One `codesign -d --entitlements - --xml` closes Passwords in a second: `Passwords.app` holds the
Apple-private `com.apple.password-manager` keychain access group, which no Developer-ID build can
claim, so nothing behind it is reachable at any grant. That check was run last and should have been
run first — the same lesson HomeKit taught through its missing `DEVELOPER_ID` distribution type, and
it generalises to every remaining candidate. Ask what the app is entitled to before asking what its
store contains.

**"Readable" and "legible" are different findings — the inverse of the EPERM trap.** The rule below
says absent and EPERM must not be conflated. Passwords is the other direction: `keychain-2.db` is
mode 0600, not TCC-protected, and opens read-only in a process holding no grant at all — while that
same process is denied Safari, Messages and Mail. It is still unreadable, because `srvr` and `acct`
are SHA-1 digests and the payload is ciphertext. A store that opens is not a store you can read, and
a probe that reports "opened" without reporting legibility invites a wrong "just grant Full Disk
Access". Measure the process's own blindness first, then say which of the two you actually proved.

**A control lane and a read lane can sit behind different grants — measure each.** Every surface so
far has had one gate for the whole server. `shortcuts list` succeeds with no Full Disk Access while
`~/Library/HomeKit` refuses, which would make an ungranted Home server write-only: the exact inverse
of Safari, where an ungranted server is a different product rather than a slower one. Do not infer a
lane's permission from the surface's.

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

**A candidate list of column NAMES cannot find a many-to-many.** Maps' collection membership was
hunted with four plausible column names — `ZCOLLECTION`, `ZCOLLECTION1`, `ZPARENTCOLLECTION`,
`ZOWNINGCOLLECTION` — and a fifth guess would have been worth as much as the first four, because
Core Data stores a many-to-many in a `Z_<ordinal><RELATIONSHIP>` JOIN TABLE and leaves no column on
either entity. No list of column names could have contained the answer. It is
`Z_6PLACES(Z_6COLLECTIONS, Z_7PLACES)`. So enumerate MECHANISMS, not names — a scalar FK named after
the relationship, a join table, an ordered to-many with its `Z_FOK_*` column, indirection through a
third entity — run each, and score it against something the store already knows.

**Score a resolved relationship against an oracle the app maintains.** `ZCOLLECTION.ZPLACESCOUNT` is
Maps' own tally per guide, so a mechanism reproducing all ten numbers exactly is not a guess that
fits. Better than that: the store's Core Data triggers turned out to maintain `ZPLACESCOUNT` by
counting `Z_6PLACES.Z_6COLLECTIONS`, so the oracle is derived from the mechanism rather than
independent of it — which makes an exact match guaranteed for the true relationship and coincidental
for any other. Look for the trigger that maintains a counter; it documents the relationship.

**A hand-written fixture can invent a column and keep the suite green while the feature is broken.**
Maps' first fixture declared a `ZCOLLECTION` column on `ZCOLLECTIONITEM` that the real store has
never had, so every test passed for as long as collection listing was broken against real data.
Capture fixtures with the probe's `--write`; a fixture that agrees with your hypothesis rather than
with the store tests the hypothesis against itself.

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

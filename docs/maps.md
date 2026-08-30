# Maps — what the store holds, and how it was nearly missed

Phase-0 findings for `packages/maps`. Probe: `pnpm probe:maps`
([scripts/probe-maps.mjs](../scripts/probe-maps.mjs)). Measured on macOS 26.6.

## The headline

Maps has a **file lane and no other lane**, and the file lane is good: favourites,
collections and recents in ordinary Core Data columns, with real coordinates, joined
through a clean foreign key, answered in 0 ms.

## How it was declared impossible three times

This is the more useful half of the writeup, because the failure was not about Maps.

| Attempt                            | Conclusion                                   | Why it was wrong                                                                                                             |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `find` over `group.com.apple.Maps` | "the group container is empty"               | It was `EPERM`. The listing returned the directory itself and nothing else, which reads identically to empty.                |
| Sweep for `*.db` / `*.sqlite*`     | "no database anywhere"                       | **The store has no file extension**: `MapsSync_0.0.1`.                                                                       |
| Full listing of the Maps container | "only prefs, cookies and a CloudKit journal" | `Data/Maps/` was the one unreadable directory in the container. Its contents were omitted, and the omission read as absence. |

Every one of those was run by a process holding **no Full Disk Access**, and none of
them checked that first. `docs/surfaces.md` already states the rule they broke:

> "'Absent' and 'EPERM' are different findings — one means the surface has no file
> lane, the other means run it again with the grant. Conflating them is what put
> Calendar on a path toward EventKit it never needed."

The instrument is now checked before the measurement.
[scripts/spike-maps-store.mjs](../scripts/spike-maps-store.mjs) tests four stores that
shipped surfaces read daily and **refuses to report a negative** if it cannot open
them; `probe-maps.mjs` exits 3 rather than printing a result it cannot stand behind.

What finally found it was watching the filesystem while a favourite was saved by hand.
The only meaningful write was `Data/CloudKit/cloudd_db/db-wal`, 0 → 173 KB, holding one
CloudKit record of type **`CD_HistoryItem`** in `com.apple.coredata.cloudkit.zone`. The
`CD_` prefix is `NSPersistentCloudKitContainer`, which mirrors _from a local Core Data
store_ — so a local store had to exist, and only one Maps-owned directory had never
been read.

## The store

`~/Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1` — 3.3 MB, Core Data,
146 schema objects, fingerprint `2bbc03143125`, 54 entities. Seven carry the surface:

| Entity           | Rows | What it is               |
| ---------------- | ---- | ------------------------ |
| `FavoriteItem`   | 23   | saved places             |
| `Collection`     | 10   | Guides                   |
| `CollectionItem` | 30   | places filed in a Guide  |
| `HistoryItem`    | 33   | Recents                  |
| `MixinMapItem`   | 68   | the shared place records |
| `ReviewedPlace`  | 24   | ratings the user left    |
| `UserRoute`      | 3    | saved routes             |

`MapsSync_0.0.1_deviceLocalCache.db` sits beside it with the same 33 entities and
**zero rows in every one**. It is located by the server and never opened.

### `FavoriteItem` needs no blob decoding

| Column                              | Coverage |
| ----------------------------------- | -------- |
| `ZMAPITEMNAME`                      | 20/23    |
| `ZCUSTOMNAME`                       | 5/23     |
| `ZLATITUDE` / `ZLONGITUDE`          | 20/23    |
| `ZMAPITEMADDRESS`                   | 19/23    |
| `ZMUID`                             | 20/23    |
| `ZCREATETIME` / `ZMODIFICATIONTIME` | 23/23    |

`ZMAPITEMSTORAGE` on `MixinMapItem` (68/68) is an undecoded protobuf holding the richer
GEO record — phone, category, hours. A Notes-scale decoding project that buys detail the
plain columns do not carry, and not needed for v1.

### The id bridge, verified by joining

`MixinMapItem`'s inverse relationships partition exactly:

    ZCOLLECTIONPLACEITEM 30 + ZFAVORITEITEM 21 + ZHISTORYPLACEITEM 20 = 71 = every row

Every favourite, collection entry and recent reaches its place through `ZMAPITEM`.
The probe runs the join rather than reading column names, because **Core Data names a
foreign key after the relationship, not the entity** — no naming rule can tell `ZMAPITEM`
apart from a scalar like `ZHIDDEN` or `ZRATING`.

## Four traps, each of which produces plausible wrong output

**Columns must be resolved by COVERAGE, not by name.** `HistoryItem` carries both
`ZLATITUDE` (1 row of 33) and `ZLATITUDE1` (19 of 33). A resolver that takes the first
recognised name picks the column that is null 97% of the time and reports that Maps holds
almost no coordinates. `store.ts` counts non-nulls per candidate at open time.

**Three favourites have no linked place.** No `ZMAPITEM`, no name, no coordinate —
almost certainly the unconfigured Home / Work / School slots Maps creates whether or not
anyone fills them in. They are returned with `linked: false` rather than filtered, because
silently dropping rows makes the count disagree with the app and reads as a deletion.

**Collection membership is a join table, and it is proved rather than named.** It is
`Z_6PLACES(Z_6COLLECTIONS, Z_7PLACES)` — a Core Data many-to-many, with `Z_PRIMARYKEY`
decoding ordinal 6 as `Collection` and 7 as `CollectionItem`, so the relationship is
`Collection.places`. A many-to-many leaves **no column on either entity**, which is why
four guessed names (`ZCOLLECTION`, `ZCOLLECTION1`, `ZPARENTCOLLECTION`,
`ZOWNINGCOLLECTION`) all missed it and every Guide listed empty.

The server re-derives it at open time by **running each candidate join and scoring it
against `ZPLACESCOUNT`**, Maps' own count per Guide, accepting only a candidate that
reproduces all ten numbers exactly. That oracle is not independent, and is stronger for
it: Core Data maintains `ZPLACESCOUNT` with a trigger that counts
`Z_6PLACES.Z_6COLLECTIONS`, so Apple's schema states the relationship outright. The match
is guaranteed for the true mechanism and coincidental for anything else. Name-matching would not merely have failed here, it
would have been confidently wrong: `ZCOLLECTIONITEM.ZMAPITEM` joins `ZCOLLECTION` for 3 of
10 collections purely because both are small integers. When nothing reproduces the counts,
collections list **without** their places and say so — an unexplained empty Guide is the
failure that avoids.

Membership being many-to-many, one place can sit in several Guides, so the query asks
`IN (SELECT ...)` rather than joining. **30 item rows, 18 of them in a Guide**: the other
12 belong to no collection at all, and all 30 still reach a place through `ZMAPITEM`.

**Those 12 are saved places, not debris, and `apple_maps_list_unfiled_places` returns them.**
The obvious theory — leftovers from deleted Guides — is disproved by the store itself:
`Z_PRIMARYKEY.Z_MAX` equals the live row count for both `Collection` (10) and
`CollectionItem` (30), so Core Data has never deleted one of either. Checked against the
rest of the store, **7 of the 12 appear nowhere else**: not as a favourite, not in another
Guide, not in recents. Before this tool existed they were reachable only by guessing a
term for `apple_maps_search_places`, and `apple_maps_list_collections` reported 18 places
across the Guides with nothing to say about the other 12. It now carries an `unfiled`
count for exactly that reason.

The filter is `Z_PK NOT IN (SELECT <item column> ... WHERE <item column> IS NOT NULL)`, and
the guard is load-bearing: `NOT IN` is false for **every** row as soon as the subquery
yields one NULL, so without it the tool would report no unfiled places at all — a wrong
answer shaped exactly like a right one.

**The epoch is `apple-seconds`, and the wrong reading is plausible.** The same
`ZCREATETIME` value read as unix seconds lands in **1995**. The probe prints both
readings side by side for that reason, and the server detects the epoch from the store
rather than assuming it, withholding dates when it cannot.

## Cost

| Query                       | Time |
| --------------------------- | ---- |
| count favourites            | 0 ms |
| join favourites → map items | 0 ms |
| all recents                 | 0 ms |

For comparison, the Accessibility lane this replaced needed **~14 s** for scraped text
with no coordinates and no identifiers — see [surfaces.md](surfaces.md).

## Writes — measured, and the SQL lane is closed

Probe: `pnpm probe:maps-write` ([scripts/probe-maps-write.mjs](../scripts/probe-maps-write.mjs)),
macOS 26.6. It snapshots the store, waits for a place to be saved BY HAND in Maps, and
diffs. The question was never "is the file writable" — it is, `W_OK` on the store, both
sidecars and the directory. The question is what a write has to maintain, and the answer
is that saving a place moved **eight tables and bumped ten `Z_MAX` counters**.

| What moved                              | Rows | What it is                                                      |
| --------------------------------------- | ---- | --------------------------------------------------------------- |
| `ZFAVORITEITEM`                         | +1   | the favourite, **21 columns set**                               |
| `ZCOLLECTIONITEM`                       | +1   | the list entry, **19 columns set**                              |
| `ZMIXINMAPITEM`                         | +2   | one place record each, `ZMAPITEMSTORAGE` a **~1.2 KB protobuf** |
| `ATRANSACTION`                          | +7   | Core Data persistent history                                    |
| `ACHANGE`                               | +9   | per-row change journal, with `ZTRANSACTIONID`                   |
| `ANSCKRECORDMETADATA`                   | +4   | the CloudKit mirror registry                                    |
| `ANSCKRECORDMETADATAENCODEDRECORDASSET` | +4   | **encoded `CKRecord`s, ~3 KB each**                             |
| `ANSCKEVENT`                            | +6   | the sync operation log                                          |

Two places were saved across the measurement — one into a List, one into Favourites — so
the table is the cost of both. The per-place shape is the same either way: one entry row,
one `MixinMapItem`, two mirror rows carrying an encoded `CKRecord`, and a burst of history.

Three of those are individually disqualifying for a hand-written `INSERT`:

**`ZMAPITEMSTORAGE` cannot be synthesised.** It is the GEO place record, and this repo has
never decoded it — see the read findings above. A place row without it carries the
denormalised columns and nothing Maps itself recognises as a place.

**The encoded `CKRecord` cannot be synthesised either.** `ZBINARYDATA` is a serialised
CloudKit record including server-assigned system fields — change tags, zone identity. It is
not a format to reverse-engineer; it is a format whose correct values only CloudKit knows.

**Persistent history is how the exporter decides what to upload.** `ACHANGE` and
`ATRANSACTION` are `NSPersistentHistoryTracking`, and `ANSCKRECORDMETADATA` carries
`ZLASTEXPORTEDTRANSACTIONNUMBER` straight into it. A row inserted without a history entry
is not merely unsynced — it is invisible to the mechanism whose job is noticing it.

Two further findings close the door:

**Some bookkeeping is created and destroyed inside the window.**
`NSCKHistoryAnalyzerState` bumped `Z_MAX` 60 → 68 while its table stayed at **0 rows**. A
writer cannot imitate a protocol whose intermediate states it can only see the wake of.

**There is no quiet moment.** `mapssyncd` holds the store open _with Maps quit_. Every
other file-lane surface can at least assume nobody is mid-transaction; this one cannot.

So: writing SQL into `MapsSync_0.0.1` is not a hard version of what Notes and Calendar do.
It is a different act — editing one replica of a synchronising graph while its owner is
running — and `packages/maps` will not do it.

### The diff found a stable identifier, which the read surface needs

Every row Maps created carried **`ZIDENTIFIER`, a 16-byte blob** — a UUID — and
`ZCOLLECTIONITEM` carried `ZORIGINALIDENTIFIER` as well. Neither appears in the read
probe's column report, because that probe only looked for columns it already had
candidates for.

This matters more than the write verdict. `packages/maps` addresses rows by `Z_PK` and
documents its refs as session-scoped, because a Core Data row id is reused after a delete
and renumbered by a re-sync — recorded below as having no alternative. `ZIDENTIFIER` is an
alternative, IF it is populated and distinct on rows that predate the observation. A ref
that works for newly-saved places and silently fails for everything the user already had
is the worst available outcome, so question 7 of the write probe measures coverage and
distinctness rather than presence.

The full insert also shows `ZFAVORITEITEM` carrying `ZSOURCE`, `ZTYPE`, `ZVERSION`,
`ZHIDDEN`, `ZPOSITIONINDEX`, `ZMAPITEMCATEGORY` and `ZSHORTCUTIDENTIFIER` — none of them
read today. `ZHIDDEN` is worth a look in particular, since a favourite the app hides is one
the surface may currently be listing.

`HistoryItem` moved 33 → 121 `Z_MAX` between the read probe and this one, on ordinary use.
Recents churn; favourites and collections do not.

### The intents lane — checked, and closed

Maps ships no `.sdef`, no `Metadata.appintents` and no `INIntentsSupported`. It does ship
`IntentsLocalizable.loctable`, whose 218 keys include **`Add Places to List`**,
**`Remove Places From List`**, `The places to add to a list.`, `Add note place` and the
parking verbs.

That would have been the right shape for this repo: an intent runs INSIDE Maps, so Maps
allocates the primary key, writes the history rows and registers the CloudKit record — the
same property that makes an Apple Event safe on the other six surfaces, reached by a
different mechanism.

**The actions are not registered on macOS.** Checked by hand in Shortcuts: no add-a-place
action appears in the Maps set. The loctable proves the intents exist in Apple's code and
nothing more — Maps here is a Catalyst app carrying the iOS resource bundle wholesale, so
iOS-only strings ship regardless. Reading it as a capability would have been this project's
signature mistake in a new costume, which is why the probe printed an instruction rather
than a verdict.

Worth recording for the next macOS release: if those actions ever appear in Shortcuts, the
write half becomes tractable overnight, and it would be about **Lists** — no intent adds a
favourite either.

### Where each lane stands

| Lane               | Verdict                                   | Why                                                                |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------ |
| Apple Events       | absent                                    | no scripting dictionary, checked directly                          |
| App Intents        | absent on macOS                           | strings ship, actions are not registered                           |
| SQL into the store | **works, for any place**                  | Maps mints the record via a URL scheme; the insert is three tables |
| Accessibility      | **open — controls exist, grant inherits** | named, pressable `Favorite` and `Add`; see below                   |

`supportsWrites: false` in `surfaces.json` stays true FOR NOW, and `APPLE_MAPS_ALLOW_WRITES`
stays accepted-and-ignored so a config that sets it does not look broken. But the fourth row
is no longer a closed door.

### SQL into the store works, and the earlier verdict was wrong

This document said the SQL lane was "refused", on the strength of
`pnpm probe:maps-write --diff`. That diff showed eight tables moving when Maps
saved a place, and it was read as eight tables a writer must maintain. **It shows
what Maps DOES, not what Maps REQUIRES**, and those are different claims. Treating
one as the other closed a lane that was open.

[scripts/spike-maps-sql-write.mjs](../scripts/spike-maps-sql-write.mjs) settled it
in two stages. Stage one inserts on a COPY and verifies; stage two (`--apply`)
backs the store up, writes for real, and prints a one-command undo. On macOS 26.6
the row was accepted: it appears in Maps' Pinned panel after a relaunch, with its
name and address intact.

**What it takes, and what it does not:**

| Piece                                  | Needed?                                       |
| -------------------------------------- | --------------------------------------------- |
| `ZFAVORITEITEM` row, 19 columns set    | yes — all ordinary values plus a 16-byte UUID |
| `ZMIXINMAPITEM` with `ZMAPITEMSTORAGE` | yes, and it must be **copied**                |
| `Z_PRIMARYKEY.Z_MAX` bumps             | yes, or the next Core Data insert collides    |
| `ACHANGE` / `ATRANSACTION` history     | **no**, to be displayed                       |
| `ANSCK*` mirror metadata               | **no** — Core Data writes it when it exports  |

**The protobuf is a wall, and the way past it is to make Maps write it.**
`ZMAPITEMSTORAGE` is a ~1.7 KB GEO record this repo cannot generate. But it does not
have to: **opening a place puts it in Recents, with a full record attached.** That was
proved by accident — `Eiffel Tower` appears in the probed Mac's Recents because
`maps://?q=Eiffel+Tower` was used to stage an Accessibility measurement, and Maps
recorded it.

So the sequence for an ARBITRARY place is:

1. `open maps://?q=<name>&ll=<lat>,<lon>` — a URL scheme. Not an Apple Event, not
   Accessibility, and no grant beyond the one this surface already holds.
2. Maps resolves it and writes a `ZHISTORYITEM` with a `ZMIXINMAPITEM` carrying the
   GEO record it generated.
3. Copy that `ZMAPITEMSTORAGE` into a new `ZFAVORITEITEM`.

The blob is still never synthesised — it is minted by Maps, which is the only thing
that can mint one correctly. The cost is a visible side effect: the place lands in the
user's Recents whether or not the favourite is wanted, and any tool built on this has
to say so rather than surprise somebody.

21 of 35 recents on the probed store carry a `ZMAPITEM`, so not every recent gets a
record — places do, searches and directions do not. A seeding step must WAIT for a
usable record and fail if none appears, rather than assume one.

**Omitting the history rows is a deliberate safety property, and also a defect.**
Without `ACHANGE`/`ATRANSACTION` the CloudKit exporter never learns the object
exists, so the row stays on this Mac — which is what made the experiment safe to
run. It also means the favourite **does not reach the user's other devices**, and
its fate under a future full re-sync is unknown: an object with no mirror metadata
could be exported, or could be treated as absent from the cloud and deleted. A
favourite that silently vanishes later is worse than no feature, so history rows
are not optional for anything shipped — they are simply not proved yet.

### The write lane, proven end to end, on Full Disk Access alone

MEASURED on macOS 26.6. An arbitrary place — one not previously in the store — became a
working favourite in four steps, and Maps displays it with its address and working
directions:

1. `open maps://?q=<name>` puts the place on screen. LaunchServices, not Automation:
   **no TCC grant beyond the Full Disk Access this surface already needs.**
2. Maps resolves it and writes a `ZHISTORYITEM` whose `ZMIXINMAPITEM` carries a GEO
   record **Maps minted itself** — 4237 bytes for `Musée d'Orsay`, against 1669 for a
   plain street address, so the record scales with what Apple knows about the place.
3. `INSERT` a `ZFAVORITEITEM` and a `ZMIXINMAPITEM`, copying that record, and bump
   `Z_PRIMARYKEY.Z_MAX` for both entities.
4. Relaunch Maps. The favourite is in Pinned, shows its address, and Directions work.
5. **It reaches the account's other devices.** Confirmed on an iPhone: a place that was
   in no table an hour earlier, written by SQL on a Mac, arrived through iCloud with no
   history rows and no mirror metadata written by hand.

**The record is self-contained.** `ZMAPITEMADDRESS` was inserted as NULL and Maps
rendered the address anyway, so the flat columns on `ZFAVORITEITEM` are a display cache
and the blob is the source of truth. That is worth knowing in both directions: a writer
need not populate them, and a READER that only reads them — which is what
`packages/maps` does today — is reading the cache and will show `address: null` for a
row Maps displays fully.

**No `ACHANGE`, no `ATRANSACTION`, no `ANSCK*` — and that includes for SYNC.** The diff
that once closed this lane showed eight tables moving. Three of them are all that is
required, and the object still reaches iCloud: Core Data reconciles unregistered objects
on the app's next save rather than relying on history it was handed. Reading "what Maps
does" as "what Maps requires" is what closed this lane in the first place, and the same
mistake was nearly repeated in the opposite direction by assuming the bookkeeping was
load-bearing.

**Primary keys are never reused, and the undo respects that.** After removing row 25 the
next insert took 26 while the count read 25 — `Z_MAX` is deliberately not rolled back,
because a decremented counter hands the next Core Data insert a duplicate key.

#### What shipping it took, beyond the insert

`apple_maps_add_favorite` and `apple_maps_remove_favorite` ship behind
`APPLE_MAPS_ALLOW_WRITES`. Four things were wrong on the way, none of which the
offline suite could catch, and each is now pinned by a test:

**The seed URL must carry NO coordinate.** `maps://?q=<name>` makes Maps file the
place in Recents with a record attached. `maps://?q=<name>&ll=<lat>,<lon>` does
not — it was carried over from an Accessibility measurement where that form opened
a place CARD, and a card is not a Recents entry. With the coordinate present Maps
wrote nothing and the poll ran to its timeout every time, which looked exactly
like a hang and cost three wrong theories.

**`Z_PRIMARYKEY.Z_MAX` cannot be trusted alone.** It is not always current, so the
next key is `max(Z_MAX, MAX(Z_PK)) + 1`. Trusting the counter collides with a row
that already exists.

**De-duplication must compare LIKE WITH LIKE.** The caller's coordinate and
Apple's for the same place differ by a building's width — measured at 6.9e-5 for
Sagrada Família, seven times a one-metre tolerance. So a caller repeating its own
request did not match the row its first call created, and a duplicate appeared.
Matching now happens twice: on the caller's coordinate plus the NAME before
seeding, and on Maps' resolved coordinate afterwards. The first keeps a repeat
call from launching Maps and dirtying Recents; the second is what makes it
correct.

**A resolved place must be checked against the coordinate asked for.** A name is
ambiguous, and a favourite for the wrong place syncs to every device. When Maps
answers more than ~250 m away the write is refused rather than guessed.

Every one of those was found against the real store while 74 offline tests passed.
The pattern is the same each time and worth naming: **a fake that agrees with the
code tests the fake.** The stand-in for Maps echoed the caller's coordinate back,
so the comparison bug was invisible; the fixture was in `DELETE` journal mode while
the real store is `WAL`; the fake inserted rows without bumping the counter. The
tests are now unfaithful in fewer ways, and the ones that remain are labelled.

#### What is still not built

- **Guides.** Adding a place to a collection needs one `Z_6PLACES` join row, which
  is small work now that membership is resolved.
- **`list_favorites` reports `address: null`** for rows whose address lives only in
  the place record. The flat columns are a display cache, which the write work
  proved by inserting NULL and watching Maps render the address anyway. A
  pre-existing read defect, exposed rather than caused.

### The Accessibility lane exists, and "not pursued" was wrong

This section previously dismissed AX in one line. That was an assertion, and the record on
Maps is that assertions about Maps have been wrong every time.
[scripts/spike-maps-ax-write.mjs](../scripts/spike-maps-ax-write.mjs) measured it instead.
With a place card open, on macOS 26.6:

    AXButton  "Favorite"   actions = AXPress/AXScrollToVisible/AXCancel/AXShowMenu
    AXButton  "Add"        actions = AXPress/...
    AXButton  "Pin"        actions = AXPress/...

    461 elements · 236 pressable · 219 of them NAMED · 17 anonymous

**The controls are there, and they are addressable by name rather than by position.** That
last number decides whether such a lane could ever be reliable: a verb built on element
position breaks on every layout change and every macOS release, and this tree does not
require one.

Two flaws in the spike had to be fixed before it could say that, and each produced a
confident zero:

- **It walked `windows[0]`.** A place card's overflow control opens a POPOVER, and AppKit
  models a popover as its own `AXWindow`.
- **It filtered by ROLE.** Maps is a Catalyst app, and Catalyst reports tappable controls as
  `AXGenericElement`, `AXStaticText` and `AXImage` at least as often as `AXButton` — the
  role histogram is 92 static texts and 52 generic elements against 49 buttons. The role
  filter saw 15 pressable elements where there are 236, and the add control it missed is an
  `AXImage`. Ask what has `AXPress`, never what calls itself a button.

**What a write would look like**, and it is coherent:

1. **File lane** names the place — `ZIDENTIFIER` for identity, `ZMAPITEMNAME` and
   `ZLATITUDE`/`ZLONGITUDE` for the query. Already shipped.
2. **URL scheme** brings up its card: `maps://?q=<name>&ll=<lat>,<lon>`. Not an Apple Event,
   needs no grant, and is how these measurements were staged without clicking anything.
3. **Accessibility** presses the control whose `AXIdentifier` is `FavoriteButton` or
   `AddButton`.

**Step 2 was wrong in an earlier draft, which said `maps://?ll=<lat>,<lon>`.** Measured on
macOS 26.6:

| URL                               | Elements | Place card?                                    |
| --------------------------------- | -------- | ---------------------------------------------- |
| `maps://?ll=<lat>,<lon>`          | 446      | **no** — centres the map, no controls          |
| `maps://?q=<lat>,<lon>`           | 389      | **no**                                         |
| `maps://?q=<name>`                | 456–461  | yes, but a name can resolve to the wrong place |
| `maps://?q=<name>&ll=<lat>,<lon>` | 303      | **yes**, and the coordinate disambiguates      |

A coordinate positions the map; a NAME selects a place. Since the file lane's strongest
identifier is a coordinate, only the combined form is usable — the query names the place and
the coordinate stops the search resolving somewhere else.

**Addressing is solved, and not by the English title.** Both controls carry a developer-set,
unlocalised `AXIdentifier`: `FavoriteButton` and `AddButton`. A verb that matched on the title
`"Favorite"` would break on the first non-English Mac; one that matches the identifier does
not.

### There is no favourite-state bit in the Accessibility tree

This is the finding that constrains the whole write half, and it is the bad one of the four
outcomes that were possible.

`Favorite` is a toggle in the UI, so pressing it on a place that is ALREADY a favourite would
remove it — and a tool called `add_to_favorites` that pressed blind would silently delete
saved places on exactly the input a caller is most likely to retry with.

So the control's state has to be readable first. It is not. Dumped for three cards — one place
that is not a favourite, and two that are, one of them a bakery whose name can only resolve to
the saved instance — every attribute is identical:

    AXIdentifier   FavoriteButton      AXValue      null
    AXDescription  Favorite            AXSelected   false
    AXEnabled      true                AXHelp       null

Same eight matched controls in all three cases. Maps conveys favourite status visually and
tells Accessibility nothing about it.

**So state must come from the file lane**, which is why the combined URL matters twice: the
coordinate both disambiguates the card AND is what `ZFAVORITEITEM` is looked up by before
deciding whether to press at all. The surface already answers that in 0 ms.

**Still unmeasured: whether `Favorite` really is a toggle.** Nothing has been pressed. That
needs one controlled write — press on a place that is not a favourite, confirm through the file
lane that `ZFAVORITEITEM` gained a row, press again, confirm it went away. Until then the
toggle is an assumption, and it is the assumption the design is built to survive.

Maps performs the write, so the protobuf, the `CKRecord` and the history rows are its problem
and it gets them right. That is why this lane is worth more than the SQL one.

**The gate I first named here does not exist.** An earlier draft of this section said
Accessibility does not work from inside Cupertino.app, quoting the header of
[scripts/spike-maps-ax.mjs](../scripts/spike-maps-ax.mjs). That header is stale. The scope
note in [scripts/spike-app-tcc/README.md](../scripts/spike-app-tcc/README.md) settles it:

> **Accessibility does inherit too** — the conclusion was right and the evidence for it was
> simply missing.

What cost a day was not architecture but **four duplicate TCC rows under one bundle
identifier** — the installed copy, the debug build and earlier reinstalls each leaving their
own Accessibility entry, with the app's check matching one and the checks made on its behalf
matching another. The cure is `tccutil reset Accessibility io.mgcrea.cupertino` and one
grant from the running bundle, never another grant on top.

Measured from inside the installed app on macOS 26.6, via `apple_mail_diagnostics`:

    accessibility           granted
    automationSystemEvents  granted

Those are the two grants a Maps UI read needs. Automation to _Maps_ is not among them —
System Events does the reading, so only Automation to System Events matters.

The remaining costs are real, and they are the honest objections to this lane: a new TCC
service for a surface that needs none today, Maps having to be running, UI the user watches
move, and a tree that Apple can reshape in any release. What is NOT an objection any more is
that the lane cannot reach the app at all.

**Still unmeasured:** whether an `osascript` grandchild of Cupertino.app can name _Maps'_
windows specifically. The grants are right and `composerUiRead` for Mail came back
`inconclusive` only because no composer was open, so nothing suggests it fails — but the
rule this repo keeps relearning is measure, do not ask.

The menu bar, separately, is a genuine no — 122 items across all seven menus, zero write
verbs. macOS keeps contextual menu items present-and-disabled, so that does not depend on
anything being selected.

## `list_favorites` lists more than Maps does

MEASURED on macOS 26.6: Maps' **Pinned** panel showed **17** places while `ZFAVORITEITEM`
holds **24** and `apple_maps_list_favorites` returned all 24. Matching the tool output against
a screenshot of the panel, entry by entry, the seven extras are:

- **3 unlinked rows** — the unconfigured Home/Work/School slots, already known.
- **4 ordinary favourites** with names, addresses and coordinates, which Maps does not show.
  One of them is an exact duplicate of an entry that IS shown.

**The tool's stated reason for returning the unlinked rows is wrong.** It says they are
"returned rather than hidden so the count matches what the app shows". They make the count
disagree with the app by seven. That note has to go whatever the fix turns out to be.

This is the mirror of the failure this document already warned about. Dropping rows the app
shows reads as a deletion; **listing rows the app hides invents places the user cannot see**,
and only the first was guarded against.

**No column in `ZFAVORITEITEM` separates them.** `ZHIDDEN`, `ZSOURCE`, `ZTYPE` and `ZVERSION`
were all cross-tabulated by `pnpm probe:maps`:

| Column     | Groups (rows / linked)      |
| ---------- | --------------------------- |
| `ZHIDDEN`  | 0 → 21/21, 1 → 3/0          |
| `ZSOURCE`  | 0 → 22/20, 2 → 1/0, 3 → 1/1 |
| `ZTYPE`    | 1 → 16/16, 2 → 5/4, 3 → 3/1 |
| `ZVERSION` | 2 → 17/16, 0 → 7/5          |

`ZHIDDEN` marks exactly the three unlinked slots and nothing else — it is a cleaner test for
the unconfigured Home/Work/School rows than `ZMAPITEM IS NULL`, but it does not explain the
four.

**`ZVERSION = 2` has exactly 17 rows and is a trap.** It matches the panel count and is not the
panel: 16 of those 17 are linked, while all 17 shown entries are. A number that agrees for the
wrong reason, the same shape as `ZTYPE = 3` below.

So Maps applies **display rules that are not in the store**. De-duplication is the visible one —
one of the four is an exact duplicate of a shown entry, same name, address and coordinates.

**The fix is honesty, not a filter.** Four column guesses failed on this store —
`ZCOLLECTION` for membership, `ZTYPE`/`ZORIGIN` for unfiled items, `ZHIDDEN` here, and nearly
`ZVERSION` — and a filter built on the fifth guess would drop real favourites. So
`apple_maps_list_favorites` now says what it is: everything SAVED, with a note that Maps' own
panel can show fewer. The old note asserting the count matches the app is gone.

Sidebar vocabulary worth recording, since it does not match the schema: **Pinned** is
`ZFAVORITEITEM` — the first entry carries a house icon and is Home. **Guides** is
`ZCOLLECTION`. **Saved Places** and **Recently Added** are separate sections whose backing is
not yet identified, and one of them is the best remaining candidate for the eight unexplained
collection items below.

## The twelve unfiled collection items

`ZPLACESCOUNT` sums to 18 while `ZCOLLECTIONITEM` holds 30 rows, so twelve saved places belong
to no guide. `pnpm probe:maps` now cross-tabulates them, and the answer is worth recording
mostly because the obvious reading is wrong.

| Column    | Value | Rows | Filed | Unfiled |
| --------- | ----- | ---- | ----- | ------- |
| `ZTYPE`   | 0     | 26   | 18    | **8**   |
| `ZTYPE`   | 3     | 2    | 0     | 2       |
| `ZTYPE`   | 2     | 1    | 0     | 1       |
| `ZTYPE`   | 1     | 1    | 0     | 1       |
| `ZORIGIN` | 0     | 30   | 18    | 12      |

**`ZORIGIN` carries no signal** — one value across every row.

**`ZTYPE` says what an item IS, not where it lives.** Types 1, 2 and 3 are all-unfiled, which
looks exactly like a container kind — Pinned, Recently Added — and is not. `ZTYPE = 3` holds
precisely the 2 rows that also carry `ZDROPPEDPINCOORDINATE`, so these are dropped pins and
other place kinds, which are simply never filed in a guide. Reading an all-unfiled value as a
container would have been a coincidence dressed as a finding.

**Eight rows remain unexplained.** They sit at `ZTYPE = 0` beside all 18 filed items and no
column in this schema separates them. Either they are debris from deleted guides, or Maps
keeps that membership somewhere the probe has not looked. They are reachable today only
through `search_places`; no tool lists them.

Settling it needs evidence from outside the schema. **Pinned is ruled out** — it showed 17
places and maps to `ZFAVORITEITEM`, not to collection items. The remaining candidates are the
**Saved Places** and **Recently Added** sidebar sections; if either holds eight, these are
places the surface cannot list rather than debris.

## Still open

- **The captured fixture is schema-only, so coverage still is not testable offline.**
  `packages/maps/test/fixtures/maps-store.sql` is the real schema (146 objects, fingerprint
  `2bbc03143125`) but holds no rows, and the resolvers that matter here — column choice by
  coverage, identifier adoption by totality, membership by scoring the join — all decide on
  DATA. The offline suite seeds its own, so it proves the rules, not that they pick what a
  real store would.
- **`ZMUID` stability is untested.** It looks like Apple's cross-device place id and is
  reported, but it is populated 20/23 and identifies a _place_ rather than an _entry_, so
  refs use `ZIDENTIFIER` instead. See `packages/maps/src/client/ref.ts`.
- **A write half is now plausible and unbuilt.** The Accessibility lane has named, pressable
  `Favorite` and `Add` controls, and the grants inherit into the app's servers. What is
  missing is a measurement that an `osascript` grandchild of Cupertino.app can name Maps'
  windows, and then the verbs themselves.
- **Refs are session-scoped only when a store has no `ZIDENTIFIER`.** Resolved: refs now
  carry the Core Data UUID when it is set and distinct on every row, and fall back to the
  row id otherwise. The fallback keeps the old caveat in full.

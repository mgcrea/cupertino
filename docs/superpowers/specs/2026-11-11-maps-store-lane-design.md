# Maps on the store lane: favourites, saved places and Guides through Maps' own model

**Status:** approved 2026-11-11. Amended the same day by the watch (`docs/maps.md`, "What Maps changes"): unpinning keeps the place as a saved place, so `remove_favorite` does too. Olivier, the same day: the npm routes may go where the lane
makes them redundant, so the lane is Maps' only write route.

This is Phase 2 of [the store lane](2026-11-10-swift-write-lane-design.md), which fixed the lane
itself: the socket verb, the node client, the Core Data opener, and the rules every writer
follows. This document applies them to Maps, and widens the phase from "add and remove a
favourite" to the five Maps writes that exist today. It also departs from that phase on one
point: the lane spec kept SQL for npm, and this one removes it.

## Why

Two of Maps' five writes are weak today:

- **`remove_favorite` deletes rows by SQL** (`packages/maps/src/client/write.ts`). The delete
  writes no persistent-history row, and the CloudKit exporter decides what to upload from
  persistent history. Whether a removed favourite leaves the iPhone has never been measured, and
  the tool says it does. `docs/maps.md` contradicts itself on whether the SQL inserts sync at all:
  one section says the exporter never learns of them, the next says one reached an iPhone.
- **`add_place_to_guide` presses buttons** in Maps' window through the Accessibility driver, and
  has to return `filed: "unverified"`: nothing in the tree says whether the press landed.
  `save_place` and `remove_saved_place` press buttons too, and bring Maps' window forward while
  doing it.

Maps syncs with `NSPersistentCloudKitContainer`, as Voice Memos does: the store has
`ANSCKRECORDMETADATA`, and `ZLASTEXPORTEDTRANSACTIONNUMBER` points into persistent history. On
2026-11-11, every Voice Memos write saved through the app's own model reached an iPhone, deletes
and app-closed writes included ([docs/voice-memos.md](../../voice-memos.md), "Measured
2026-11-11").

The same day, a read-only check found that Maps' compiled model matches its live store with no
patch: `MapsSync.framework/Versions/A/Resources/DataModel_0_0_1.momd`, 36 entities,
`isConfiguration(withName: nil, compatibleWithStoreMetadata:)` true, no entity hash mismatched.
(The framework's other model, `DataModel.momd`, names its entities `MapsSyncManaged…` and does
not match.) Voice Memos needed a runtime patch; Maps needs none.

## Goals

- When Cupertino hosts the Maps server, these five tools save through the lane, with their names
  unchanged and their inputs as "Inputs" below says:

  | Tool                 | Lane method             | What the save does                                                                                                                                                                                                      |
  | -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `add_favorite`       | `maps.addFavorite`      | inserts a `FavoriteItem` and its own `MixinMapItem`, copying the place record of a recent Maps wrote                                                                                                                    |
  | `remove_favorite`    | `maps.removeFavorite`   | unpins as Maps does (watched 2026-11-11): inserts a `CollectionPlaceItem` in no Guide copying the pin, unless a saved place already sits there, then deletes the `FavoriteItem`; the cascade deletes its `MixinMapItem` |
  | `save_place`         | `maps.savePlace`        | inserts a `CollectionPlaceItem` in no Guide, and its own `MixinMapItem`, copied the same way                                                                                                                            |
  | `remove_saved_place` | `maps.removeSavedPlace` | deletes the `CollectionPlaceItem`; the cascade deletes its `MixinMapItem`                                                                                                                                               |
  | `add_place_to_guide` | `maps.fileInGuide`      | adds a `Collection` to a `CollectionPlaceItem`'s `collections`; `Collection.placesCount` is derived                                                                                                                     |

  Plus `maps.status`, as `voiceMemos.status`.

- Each write is read back before the tool answers, so `add_place_to_guide` returns `filed: true`
  only when the item is in the Guide.
- No write brings Maps forward or presses anything.
- **The lane is the only write route.** The SQL writes and the Accessibility writes are removed.
  Run from npm, the Maps server is read-only, as Voice Memos' is.

## Non-goals

- Creating, renaming or deleting a Guide; removing a place from a Guide; editing a recent, a
  rating or a route. Each is a later, measured addition.
- Measuring the SQL routes this removes. Nothing will run them, so their sync is moot.
- Writing SQL, persistent-history rows or `NSCK*` metadata by hand, or calling CloudKit.
- Decoding `ZMAPITEMSTORAGE`.

## Anti-goals

- **Never make up a place record.** `mapItemStorage` is only ever copied from a `MixinMapItem`
  that Maps wrote, as the SQL lane does today.
- **Never claim a write synced without a measurement**, per tool, on two devices.
- **Never open the store with a model that does not match it**, and never migrate it. The
  opener's refusal from Phase 1 applies unchanged.
- **Never file a place in the wrong Guide or the wrong place.** An ambiguous Guide name, or a
  place Maps resolved more than about 250 m from the coordinate asked for, is refused, not
  guessed.

## Constraints

- The store is `~/Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1`, with no file
  extension, in WAL mode. `mapssyncd` holds it open even with Maps quit, as `voicememod` holds
  Voice Memos'. The Phase 1 opener already copes: one coordinator per call, history tracking and
  remote-change notification on, migration off, author `cupertino`.
- Only Maps can mint a place record. `maps://?q=<name>`, with no coordinate in the URL, makes Maps
  resolve the place and file it in Recents with a record attached. Any write that needs a new
  place leaves it in the user's Recents, and every such tool says so.
- Maps' `VersionInfo.plist` has no `NSManagedObjectModel_CurrentVersionName`, and the model's
  `versionIdentifiers` is `["0.0.1"]`, which is also in its file name and will not change when the
  schema does.

## How it works

### Inputs (my call, after the builder check)

Today `remove_saved_place` and `add_place_to_guide` take a place query and a coordinate, because
the Accessibility route found the place by opening its card. A coordinate cannot name a saved
place safely: Maps' coordinate and the caller's differ by up to a building's width (7e-5 measured
for Sagrada Família, `docs/maps.md`), so a tight match misses and a loose one can hit several
places, and a wrong delete syncs to every device.

- `add_favorite` and `save_place` keep `query`, `latitude`, `longitude` and `name`.
- `remove_favorite` keeps its `ref` and `confirm`.
- `remove_saved_place` takes a `ref` from `list_unfiled_places` or `list_collection_places`, and
  `confirm`, as `remove_favorite` does. Its query form is removed.
- `add_place_to_guide` takes the Guide, and either a `ref` to a saved place or `query` (with
  `latitude`/`longitude` when known) for a place to save first, as `save_place` does, then file.
  The save and the filing are one lane call and one save.

### Node: what stays in `packages/maps`

The node side keeps what only it can do, and what it already does:

1. **De-duplication before seeding**, on the caller's coordinate and name, so a repeated call does
   not open Maps and dirty Recents again.
2. **Seeding**: open `maps://?q=<name>` and poll the store, read-only, until a `HistoryPlaceItem`
   with a `MixinMapItem` record appears, or time out and say nothing was changed.
3. **Calling the lane** with the `identifier` of the item whose place record to copy, the name to
   save under, and the coordinate the caller asked for, if any.

The record may come from any `MixinMapItem` already in the store near the coordinate: a recent's,
a favourite's or a saved place's, as the SQL lane's donor search allows today. Seeding runs only
when none is there, so saving a place that is already a favourite does not open Maps or touch
Recents. A record copied by Cupertino is byte-for-byte one Maps minted, so copying it again keeps
the anti-goal (my call).

A write that names an existing object (`remove_favorite`, `remove_saved_place`, and
`add_place_to_guide` on a place already saved) skips seeding and calls the lane with the object's
`identifier`.

### Swift: `MapsWriter`

`apps/apple/Cupertino/StoreLane/MapsWriter.swift`, beside `VoiceMemosWriter.swift`, on the same
`CoreDataStore`.

- **The model** is `DataModel_0_0_1.momd`, loaded and copied as Voice Memos' is, with no patch.
- **The measured-version key** (my call): `CoreDataStore` takes the version key as a function of
  the `.momd`, instead of always reading `NSManagedObjectModel_CurrentVersionName`. Voice Memos
  keeps reading the version name. Maps uses the `.momd`'s
  `NSManagedObjectModel_VersionChecksums` value for `DataModel_0_0_1`, which changes whenever the
  schema does (on macOS 27.2: `CaxhFkDDBEvVUHzx/wKUv4k+QehKTgcfEuPWR91+uhk=`). `measuredVersions`
  holds the checksums whose sync passed the live check.
- **What each write sets is what the app sets.** The first task watches Maps make each change by
  hand (below) and reads each transaction's columns. The writer sets those attributes and no
  others, with the rule below for the columns only Maps can compute.
- **Copying a place record**: the new `MixinMapItem` gets `mapItemStorage`, `latitude` and
  `longitude` from the source's `MixinMapItem`. The new item gets a fresh `identifier` and
  timestamps.
- **Columns only Maps computes** (my call): where the watch shows Maps sets a display column on
  the item (`mapItemName`, `mapItemAddress`, `mapItemCategory`, `muid`), the writer copies it
  from the source item when the source has that column, and leaves it nil otherwise. It never
  refuses a write for a nil display column: the SQL lane showed Maps renders the address from the
  record when the column is empty (`docs/maps.md`). The Swift check asserts the copied columns and
  that nothing else is set.
- **Checks inside the write**, all refused as `invalid` or `notFound` before anything is saved:
  - the recent, the favourite, the saved place or the Guide must be found by `identifier`, exactly
    once;
  - a place Maps resolved more than about 250 m from the caller's coordinate is refused, as today;
  - `addFavorite` and `savePlace` refuse when an item of the same kind already sits at the
    resolved coordinate, and return that item's `identifier` with `created: false` rather than
    saving a second;
  - `fileInGuide` refuses a Guide title that matches no `Collection`, or more than one, naming the
    candidates. A call that would change nothing (already in that Guide) saves nothing and returns
    `changed: []`.
- **Dispatch**: `StoreLane.surfaces` gains `"maps"`, with the method prefix `maps.`. A write while
  Maps' writes are off in Cupertino is refused as `writesOff`, as Voice Memos' are.

### Registration

As Voice Memos' lane tools are registered:

- **Cupertino hosts the server and Maps' writes are on**: all five are registered, and each saves
  through the lane.
- **The lane is missing** (run from npm) **or writes are off**: none is registered. The read tools
  are unchanged.
- **The lane refuses as `incompatible`** (a future macOS whose model no longer matches): the tools
  stay registered and refuse, naming the mismatch, and diagnostics says so before anyone tries.
  There is no fallback to another route. The cost, accepted: after a macOS update that changes
  Maps' model, Maps writes refuse until the new model is checked and added.

Diagnostics reports `lanes.writeLane` for Maps as Voice Memos does (`compatible`,
`modelVersion`, `syncMeasured`, `refusal`), and names the route each write tool takes.

### What the answers say

- Every lane write answers with `changed`, `modelVersion`, `syncMeasured` and a `sync` sentence,
  chosen by `syncMeasured` as Voice Memos' is.
- `add_place_to_guide` answers `filed: true` from the read-back, never from having been called.
- Writes that seeded a place keep today's `recentsNote`.
- No description says a write brings Maps' window forward or presses anything.

### What is removed

- **The SQL writes**: the `INSERT`, `DELETE` and `Z_PRIMARYKEY` code in
  `packages/maps/src/client/write.ts`. Seeding and de-duplication, which only read the store, move
  to wherever the lane tools need them.
- **The Accessibility writes**: `packages/maps/src/tools/ax-writes.ts`, and whatever in
  `packages/maps/src/client/ax.ts` only those tools use. Nothing that the `desktop` surface itself
  needs is touched.
- **Their tests and docs**: tests that pin the removed routes go with them. `docs/maps.md` keeps
  its measurements as history and says the routes were retired, and why. The README, the guide
  and the CHANGELOG (`### Removed` and `### Changed`) say the npm package no longer writes, and
  that the five tools now exist only in Cupertino.

## Measurements this needs

1. **The watch, before the writer** (Task 1 of the plan). On a throwaway place, by hand in Maps:
   pin it, unpin it, save it to the library, remove it, file a saved place in a Guide. A
   read-only snapshot after each, as `vm-snap.mjs` did for Voice Memos, reads the new transaction's
   entities and column masks. `ACHANGE.ZCOLUMNS` numbers an entity's to-one relationships, then its
   attributes, then its to-many relationships, each group sorted by name, and reads bit 0 as the
   high bit of the first byte ([docs/voice-memos.md](../../voice-memos.md)). The watch also
   records which entities a save touches beyond the item (`Collection`, the recent).
2. **The live check, after it** (the last task). On a Debug build, each of the five lane tools on
   a throwaway place, checked on the Mac and an iPhone, and one write with Maps quit. Recorded in
   `docs/maps.md`.

### A tool that fails the live check, and when the old routes go (my call)

`measuredVersions` stays one set per store, as Voice Memos' is: it says the model's sync was
measured. Each tool is measured on its own in the live check, and a tool whose sync is not seen
does not ship: it is not registered, its lane method stays for a later fix, and `docs/maps.md`
says what was seen. No tool ships with a "not measured" sentence on a measured model.

The old routes are removed **after** the live check, in the last task, so a tool that fails it
keeps today's route until it is fixed rather than vanishing. The branch merges once the removal
is done.

## Tests

- **Swift**: `scripts/store-lane-check.swift` gains a Maps group, on a store built in a temporary
  directory from the real `DataModel_0_0_1.momd`, with synthetic places. It covers each method,
  its refusals, its history (one transaction, only the measured columns), cascade deletes, the
  derived `placesCount`, the checksum version key, and a skip when the machine's model lacks an
  entity the writer needs.
- **Node**: registration in the three cases (lane and writes on, lane missing, writes off), with
  the lane stubbed as Voice Memos' tests stub it; each tool's call and answer; an `incompatible`
  refusal passed through; seeding and de-duplication keep their tests.
- **Live**: as above, by hand, with a person checking the iPhone.

## Left to the builder

The JSON-RPC parameter names and result shapes; the read-back's exact query; the diagnostics
wording; fixture contents.

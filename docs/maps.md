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
| `CollectionItem` | 29   | places filed in a Guide  |
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

    ZCOLLECTIONPLACEITEM 29 + ZFAVORITEITEM 20 + ZHISTORYPLACEITEM 19 = 68 = every row

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

**Collection membership is not exposed.** No `ZCOLLECTION` column was found on
`ZCOLLECTIONITEM`, and it may be a differently-named relationship or a `Z_*` join table.
The server discovers the key among candidates and, when none is found, lists collections
**without** their places and says so — an unexplained empty Guide is the failure that
avoids.

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

## Still open

- **The schema fixture is HAND-WRITTEN**, not captured. `packages/maps/test/fixtures/maps-store.sql`
  carries only the columns the probe reported, so it is certainly missing others.
  Capture the real one with `pnpm probe:maps --write` on a granted machine.
- **`ZMUID` stability is untested.** It looks like Apple's cross-device place id and is
  reported, but it is populated 20/23 and identifies a _place_ rather than an _entry_, so
  refs use the row id instead. See `packages/maps/src/client/ref.ts`.
- **Writes are unmeasured and not merely unprobed.** The store is mirrored to iCloud by
  `NSPersistentCloudKitContainer`. A write is an edit to one replica of a synchronising
  object graph, underneath a running app that is also editing it, with `NSCK*` bookkeeping
  tables a third-party writer would not maintain. That needs its own probe.
- **Refs are session-scoped.** They address a Core Data row id, which is reused after a
  delete and renumbered by a re-sync. There is no alternative that addresses an _entry_,
  so the tools say so rather than pretending otherwise.

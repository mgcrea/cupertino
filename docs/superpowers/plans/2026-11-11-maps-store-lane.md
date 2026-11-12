# Maps on the Store Lane (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maps' five writes (`add_favorite`, `remove_favorite`, `save_place`,
`remove_saved_place`, `add_place_to_guide`) are saved by Cupertino.app through Core Data with
Maps' own model, so Maps' iCloud mirroring uploads them, deletes included; then the SQL and
Accessibility write routes are removed.

**Architecture:** The Phase 1 lane carries a second surface. `StoreLane` admits `maps` and
dispatches `maps.*` methods to a new `MapsWriter` on the shared `CoreDataStore`, which learns a
per-writer version key (Maps' `.momd` has no current-version name) and UUID fetches. The node
server keeps the read-only work only it can do (de-duplication, finding a place record, seeding
one through `maps://`) and calls the lane through a `MapsLane` client. A watch of Maps' own saves
comes first and fixes what each method sets; a two-device live check comes before the old routes
are removed.

**Tech Stack:** Swift 6 + CoreData + SQLite3 (app, `swiftc` check binaries driven by `make`),
TypeScript + vitest + zod (node packages), pnpm workspace, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-11-11-maps-store-lane-design.md` (approved 2026-11-11),
on top of `docs/superpowers/specs/2026-11-10-swift-write-lane-design.md`.

## Global Constraints

- Model: `/System/Library/PrivateFrameworks/MapsSync.framework/Versions/A/Resources/DataModel_0_0_1.momd`,
  copied, **no patch**. Never `DataModel.momd` (its entities are `MapsSyncManaged…`).
- Store: `~/Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1` (no extension, WAL).
- The Phase 1 opener rules hold unchanged: refuse unless
  `isConfiguration(withName:compatibleWithStoreMetadata:)`, migration and inferred mapping off,
  history tracking and remote-change notification on, author `cupertino`, one save per call, a
  coordinator per call.
- Maps' measured-version key is `NSManagedObjectModel_VersionChecksums["DataModel_0_0_1"]` from
  the `.momd`'s `VersionInfo.plist`. Measured list starts **empty**; Task 8 adds
  `CaxhFkDDBEvVUHzx/wKUv4k+QehKTgcfEuPWR91+uhk=` (macOS 27.2) only if the live check passes.
- Objects are named by their `identifier` attribute (Core Data UUID). A `MixinMapItem` has no
  identifier, so a place record is always named by the item that owns it.
- `mapItemStorage` is only ever copied from a `MixinMapItem` already in the store. Never built.
- A place Maps resolved more than **250 m** from the caller's coordinate is refused. "Same place"
  for de-duplication is within **1e-5°** on both axes (the SQL lane's `NEAR`).
- Each method sets exactly the attributes Task 1's watch records for the app's own save, plus the
  display-column rule: copy `mapItemName`, `mapItemAddress`, `mapItemCategory`, `muid` from the
  source item when it has them, else leave nil; never refuse for a nil display column.
- Sync sentence chosen by `syncMeasured`, as Voice Memos' (`packages/voice-memos/src/tools/store-writes.ts`
  `syncSentence`). A tool whose sync Task 8 does not see is not registered.
- Writes that seed keep today's Recents note. No lane tool says it brings Maps forward.
- Tests and printed output use synthetic places only (public landmarks are fine as live-check
  throwaways). The watch prints entity names, column names and scalar values, never strings.
- Do not touch `docs/alternatives.md` or `docs/desktop.md` (other work in the main checkout).
- Makefile and CI stay portable to BSD tools. Worktree: `.claude/worktrees/maps-store-lane`.

## Review Focus

1. **A ref that names a row with no `identifier`** (refs fall back to `Z_PK` on stores where
   `ZIDENTIFIER` is not total). Expected: the tool refuses with `notFound` and says the item has
   no stable id; it never deletes by `Z_PK` through the lane. Pinned in Task 6.
2. **Two Guides with the same title.** Expected: `fileInGuide` refuses `invalid`, listing both
   candidates' identifiers, and saves nothing. Pinned in Task 3.
3. **Deleting a favourite whose place record another item shares.** Each item owns its own
   `MixinMapItem` (one-to-one), so the cascade must remove only that favourite's record; a saved
   place at the same coordinate keeps its own. Pinned in Task 3 (`removeFavoriteCascadesOwnRecordOnly`).
4. **The Recents donor disappears between node's read and the lane's save** (Maps prunes
   Recents). Expected: `notFound` naming the source, nothing saved, and the tool says to retry.
   Pinned in Task 3.
5. **Writes switched off mid-session, and a `voice-memos` server claiming `for=maps`.** Expected:
   `writesOff` on the next line; admission refused. Pinned in Task 4.

---

### Task 1: The history instrument, and the watch (needs Olivier, Maps, about 15 minutes)

**Files:**

- Create: `scripts/history-columns.swift`
- Modify: `docs/maps.md` (new section "What Maps changes, watched 2026-11-1x")

**Interfaces:**

- Produces: `history-columns <momd-path> <store-path> <since-tx>`, printing one JSON line per
  `ACHANGE` after `since-tx`: `{tx, entity, pk, type: "insert"|"update"|"delete", columns:[names]}`,
  and for each inserted or updated row its non-string attribute values (`{attr: value}`, strings
  as `"<string len N>"`, blobs as `"<data len N>"`). Read-only (`SQLITE_OPEN_READONLY`).
- Produces: the watch table in `docs/maps.md` that Task 3 implements and tests against.

- [ ] **Step 1: Write the decoder.** Column order: for the change's entity, its to-one
      relationships, then its attributes, then its to-many relationships, each group sorted by name;
      bit `i` is byte `i / 8`, mask `0x80 >> (i % 8)`. Entity name from `Z_PRIMARYKEY.Z_ENT` →
      `Z_NAME`. An insert's `ZCOLUMNS` is null: print the row's values instead.
- [ ] **Step 2: Verify against a known answer.** Compile, then run under Full Disk Access
      (`mcp__cupertino-shell__apple_shell_run`) on Voice Memos:
      `history-columns <VoiceMemos.momd> <CloudRecordings.db> 171`.
      Expected: tx 172, `CloudRecording`, columns `["customLabelForSorting","encryptedTitle","flags"]`.
      A different answer means the decoder is wrong; fix it before going on.
- [ ] **Step 3: The watch.** Note the store's `MAX(ATRANSACTION.Z_PK)`. Ask Olivier, one step at a
      time, on a throwaway public place (e.g. a museum), running the decoder after each:
      (a) pin it (Pinned / favourite); (b) unpin it; (c) save it to the library (Add); (d) file the
      saved place in a throwaway Guide he creates first; (e) remove the saved place.
      Record per step: every entity touched, insert/update/delete, columns, and scalar values set on
      inserts (`type`, `version`, `source`, `hidden`, `positionIndex`, `origin`, …), and whether
      display columns were set. Also whether the Guide row changed (`placesCount` is derived).
- [ ] **Step 4: Write the table** into `docs/maps.md`, one row per method, as Voice Memos'
      "What the app changes" table. Any step whose shape the spec did not expect (for example, a pin
      that also creates a `CollectionPlaceItem`) is a ledger ruling for Task 3, decided against the
      spec's goals before code.
- [ ] **Step 5: Commit** `scripts/history-columns.swift docs/maps.md`:
      `docs(maps): watch what Maps' own saves change, with a history-column decoder`.

### Task 2: The opener learns a version key and UUID fetches

**Files:**

- Modify: `apps/apple/Cupertino/StoreLane/CoreDataStore.swift`
- Modify: `apps/apple/Cupertino/StoreLane/VoiceMemosWriter.swift` (pass the version-name key)
- Test: `scripts/store-lane-check.swift`

**Interfaces:**

- Produces: `CoreDataStore.init(modelURL:storeURL:patch:measuredVersions:versionKey:)` with
  `versionKey: @Sendable (URL) -> String?` (the `.momd` URL in, the key out), and two keys:
  `CoreDataStore.currentVersionName` (today's behaviour) and
  `CoreDataStore.versionChecksum(_ versionName: String)`.
- Produces: `static func fetchOne(_ entity: String, uuid: UUID, key: String = "identifier", in:)`
  with the same one-exactly rule and `notFound` message as the string overload.

- [ ] **Step 1: Failing checks** `versionKeyIsPerWriter` (a fixture `.momd` from
      `writeMomd` whose `VersionInfo.plist` has checksums but no current name: `status().modelVersion`
      equals the checksum with `versionChecksum`, nil with `currentVersionName`) and
      `fetchOneByUUID` (one match, none, two).
- [ ] **Step 2:** `make store-lane-check` → FAIL on both.
- [ ] **Step 3: Implement.** Voice Memos passes `CoreDataStore.currentVersionName`; its checks
      stay green unchanged.
- [ ] **Step 4:** `make store-lane-check` → all PASS.
- [ ] **Step 5: Commit** `feat(store-lane): a writer names its own model-version key, and fetches by UUID`.

### Task 3: `MapsWriter`

**Files:**

- Create: `apps/apple/Cupertino/StoreLane/MapsWriter.swift`
- Create: `scripts/store-lane-check-maps.swift` (an extension of the check's enum, with
  `static func mapsCases()`; called from the main check)
- Modify: `scripts/store-lane-check.swift` (call `mapsCases()`), `Makefile` (`store-lane-check`
  compiles both script files)

**Interfaces:**

- Consumes: Task 2's `CoreDataStore` init and `fetchOne(_:uuid:in:)`; Task 1's table.
- Produces:

  ```swift
  nonisolated struct MapsWriter: Sendable {
    enum SourceKind: String { case favorite, savedPlace, recent }  // FavoriteItem, CollectionPlaceItem, HistoryPlaceItem
    struct Result: Equatable { var id: String; var changed: [String]; var created: Bool;
                               var filed: Bool?; var modelVersion: String?; var syncMeasured: Bool }
    let store: CoreDataStore
    static let modelURL, storePath, measuredVersions: Set<String> = [], live
    static func store(at: URL) -> CoreDataStore
    func status() -> CoreDataStore.Status
    func addFavorite(source: SourceKind, sourceId: String, name: String?, near: (Double, Double)?) throws -> Result
    func removeFavorite(id: String) throws -> Result
    func savePlace(source: SourceKind, sourceId: String, name: String?, near: (Double, Double)?) throws -> Result
    func removeSavedPlace(id: String) throws -> Result
    func fileInGuide(guideTitle: String, placeId: String?, source: SourceKind?, sourceId: String?,
                     name: String?, near: (Double, Double)?) throws -> Result  // placeId XOR source
  }
  ```

- [ ] **Step 1: Fixture.** `makeMapsStore(at:)` builds a store from the real model with
      synthetic rows: two Guides ("Synthetic guide", and two titled "Synthetic twin"), a recent with
      a record, a favourite, and a saved place filed in "Synthetic guide", records 1–2 KB of
      arbitrary bytes. Skip the group, printing `SKIP maps: …`, when the model is absent or lacks an
      entity or attribute the writer names (as `voiceMemosLacks`).
- [ ] **Step 2: Failing checks**, each asserting one transaction and its exact history columns
      per Task 1's table:
  - `addFavoriteCopiesRecord`: from a recent; new `FavoriteItem` + `MixinMapItem`, storage bytes
    equal, display columns copied/nil per the rule, `created: true`, `changed` lists the
    favourite's attributes.
  - `addFavoriteIsIdempotent`: a favourite already within 1e-5° returns its id, `created: false`,
    no transaction.
  - `addFavoriteRefusesFarResolution`: `near` 300 m away → `invalid`, nothing saved.
  - `removeFavoriteCascadesOwnRecordOnly`: the favourite and its record go; a saved place at the
    same coordinate keeps its own record.
  - `savePlaceUnfiled`, `removeSavedPlace`: as above for `CollectionPlaceItem`, no `collections`.
  - `fileInGuideByPlaceId`: adds the Guide; `placesCount` reads one more; `filed: true` from a
    re-fetch; a second call `changed: []`, no transaction.
  - `fileInGuideSavesThenFiles`: from a source; one save creates the place in the Guide.
  - `fileInGuideRefusesAmbiguousTitle` ("Synthetic twin") and `…UnknownTitle`: `invalid`,
    the message lists candidate identifiers, never titles.
  - `sourceVanished`: a source id that matches nothing → `notFound`.
  - `badIds`: non-UUID ids → `invalid`.
  - `versionKeyIsChecksum`: `status().modelVersion` equals the `.momd`'s checksum;
    `syncMeasured` false while `measuredVersions` is empty.
- [ ] **Step 3:** `make store-lane-check` → the Maps checks FAIL (writer missing).
- [ ] **Step 4: Implement `MapsWriter`.** Distance by haversine. `positionIndex` and any other
      scalar the watch showed the app setting on insert take the watched rule (for example "count of
      favourites"); new `identifier` = `UUID()`; `createTime`/`modificationTime` = `Date()`.
- [ ] **Step 5:** `make store-lane-check` → all PASS, Voice Memos group unchanged.
- [ ] **Step 6: Commit** `feat(maps): MapsWriter saves favourites, saved places and Guide filing through Maps' model`.

### Task 4: The lane admits Maps

**Files:**

- Modify: `apps/apple/Cupertino/StoreLane/StoreLane.swift`, `apps/apple/Cupertino/ServerHost.swift`
  (pass `MapsWriter.live` where `StoreLane.handle` is called, if the default is not enough)
- Test: `scripts/store-lane-check.swift`

**Interfaces:**

- Consumes: Task 3's `MapsWriter`.
- Produces: `StoreLane.surfaces = ["voice-memos", "maps"]`; namespace `"maps": "maps."`;
  methods `maps.addFavorite {source, sourceId, name?, near?: {latitude, longitude}}`,
  `maps.removeFavorite {id}`, `maps.savePlace {…as addFavorite}`, `maps.removeSavedPlace {id}`,
  `maps.fileInGuide {guide, placeId? | source+sourceId, name?, near?}`, `maps.status {}`;
  `handle(_:borrower:allowWrites:voiceMemos:maps:)`; `mapsWritesOff = "writes are off for Maps in Cupertino"`.
  A result is `{id, changed, created, filed?, modelVersion, syncMeasured}`.

- [ ] **Step 1: Failing checks**: `mapsAdmission` (maps admits a maps peer, refuses a
      voice-memos peer claiming `for=maps`), `mapsWritesOff` (a write refused, `maps.status`
      answers), `mapsNamespace` (`voiceMemos.rename` from a maps borrower → -32601),
      `mapsRoundTrip` (each method over `handle` with the params node sends, against the fixture).
- [ ] **Step 2:** `make store-lane-check` → FAIL.
- [ ] **Step 3: Implement** the dispatch, reusing `Params`; a missing `near` is nil.
- [ ] **Step 4:** `make store-lane-check` → PASS; `make app` → BUILD SUCCEEDED.
- [ ] **Step 5: Commit** `feat(store-lane): admit Maps and dispatch its methods`.

### Task 5: Node finds a place record without writing

**Files:**

- Create: `packages/maps/src/client/place-source.ts`
- Modify: `packages/maps/src/client/maps.ts` (`placeSource()` beside `writer()`)
- Test: `packages/maps/test/place-source.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type SourceKind = "favorite" | "savedPlace" | "recent";
  export type PlaceSource = {
    kind: SourceKind;
    id: string;
    latitude: number;
    longitude: number;
    seeded: boolean;
  };
  export class PlaceSourceFinder {
    constructor(opts: { storePath: string; openUrl?: OpenUrl; seedTimeoutMs?: number });
    existingFavorite(q: {
      latitude: number;
      longitude: number;
      name?: string;
    }): { id: string } | null;
    existingSavedPlace(q: {
      latitude: number;
      longitude: number;
      name?: string;
    }): { id: string } | null;
    find(q: { query: string; latitude?: number; longitude?: number }): Promise<PlaceSource>;
    identifierOf(kind: "favorite" | "collection-item" | "history", key: EntityKey): string | null;
  }
  ```

  All read-only. `find` takes a donor near the coordinate first (any of the three kinds, the
  owning item's `ZIDENTIFIER` as the id), else seeds `maps://?q=<query>` and polls Recents above
  a watermark, as `MapsWriter.addFavorite` does today; refuses > 250 m and on timeout with
  today's messages.

- [ ] **Step 1: Failing tests**, moved and adapted from `write.test.ts`'s seeding and
      de-duplication cases (fixture `maps-store.sql`, WAL mode): donor hit skips `openUrl`; seed then
      poll; far resolution refused; timeout message; `identifierOf` returns null for a row whose
      `ZIDENTIFIER` is null.
- [ ] **Step 2:** `pnpm -C packages/maps exec vitest run test/place-source.test.ts` → FAIL.
- [ ] **Step 3: Implement**, lifting the read-only helpers out of `write.ts` (do not delete
      them from `write.ts` yet; Task 9 does).
- [ ] **Step 4:** the same command → PASS; full `pnpm -C packages/maps exec vitest run` green.
- [ ] **Step 5: Commit** `feat(maps): find a place record read-only, for the store lane`.

### Task 6: The Maps lane client and tools

**Files:**

- Create: `packages/maps/src/client/lane.ts` (`MapsLane`, as `packages/voice-memos/src/client/lane.ts`)
- Create: `packages/maps/src/tools/store-writes.ts`
- Modify: `packages/maps/src/tools/index.ts`, `packages/maps/src/client/maps.ts` (`lane` getter,
  `opts.lane` injectable), `packages/maps/src/tools/diagnostics.ts`
- Test: `packages/maps/test/store-writes.test.ts`

**Interfaces:**

- Consumes: Task 4's methods; Task 5's `PlaceSourceFinder`; core's `openStoreLane("maps", env)`.
- Produces: `MapsLane.open(env)` (null without the env), `addFavorite`, `removeFavorite`,
  `savePlace`, `removeSavedPlace`, `fileInGuide`, `status`; `registerStoreWriteTools(server, client, lane)`.
  Tool inputs per the spec's "Inputs": `remove_saved_place {ref, confirm}`,
  `add_place_to_guide {guide, ref?} | {guide, query, latitude?, longitude?}` (exactly one form).
- Registration (until Task 9): lane present and writes on → `registerStoreWriteTools` and **not**
  `registerWriteTools`/`registerAxWriteTools`; lane absent → today's registration.
  Diagnostics: `lanes.writeLane {compatible, modelVersion, syncMeasured, refusal}` and the route.

- [ ] **Step 1: Failing tests** with the lane stubbed as Voice Memos' tests do (`hostStub`):
      registration in three cases; each tool sends the right method and params; a pk-only ref
      (`identifierOf` null) is refused `notFound` without calling the lane; `incompatible` passes
      through as the tool error's `details.reason`; answers carry `sync` from `syncMeasured` and the
      Recents note when `seeded`; `add_place_to_guide` reports `filed` from the lane, and no
      description mentions bringing Maps forward.
- [ ] **Step 2:** `pnpm -C packages/maps exec vitest run test/store-writes.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** full maps suite, `tsc --noEmit`, `oxlint packages/maps` → green.
- [ ] **Step 5: Commit** `feat(maps): the five write tools take the store lane when Cupertino hosts the server`.

### Task 7: Documentation for the lane

**Files:** `docs/maps.md` (a "The store lane" section: methods, what each sets, routes,
refusals), `packages/maps/README.md`, `packages/maps/src/guide.ts` (and its surface test if it
pins wording), `CHANGELOG.md` (`## [Unreleased]` → `### Added`/`### Changed`).

- [ ] **Step 1:** Write them. Sync wording: "not yet measured" until Task 8. Run `make surfaces-check`
      and `make changelog` if the repo's generated checks cover these files.
- [ ] **Step 2:** `pnpm exec oxfmt --check` on the touched files → clean.
- [ ] **Step 3: Commit** `docs(maps): the store lane's tools`.

### Task 8: The live check (needs Olivier, the Mac and the iPhone)

**Files:** `docs/maps.md` ("Measured 2026-11-1x"), `apps/apple/Cupertino/StoreLane/MapsWriter.swift`
(`measuredVersions`), and the tool or docs wording any failure changes.

- [ ] **Step 1:** `make app` from the worktree; quit only the Debug app by pid; open the
      worktree's build; check the Debug socket's owner (`lsof -U | grep cupertino.debug`); Maps
      writes on in the Debug app; `apple_maps_diagnostics` via `dev-mcp.mjs` shows `compatible: true`.
- [ ] **Step 2:** On a throwaway public place, through `dev-mcp.mjs`, one at a time, running
      `history-columns` after each and asking Olivier to check the Mac and the iPhone:
      `add_favorite`, `remove_favorite`, `save_place`, `add_place_to_guide` (ref form, then query
      form), `remove_saved_place`. Then one `add_favorite` with Maps quit (`mapssyncd` alone).
- [ ] **Step 3:** Record a table as Voice Memos' (transaction, history, exported via
      `ZLASTEXPORTEDTRANSACTIONNUMBER`, Mac and iPhone).
- [ ] **Step 4:** All seen → add the 27.2 checksum to `MapsWriter.measuredVersions`, and the
      sync wording becomes measured (tests updated first). A tool not seen → unregistered, with a
      test, and `docs/maps.md` says what was seen.
- [ ] **Step 5:** `make store-lane-check` and the maps suite green. **Commit**
      `docs(maps): measure every store-lane write on a Mac and an iPhone`.

### Task 9: Remove the SQL and Accessibility write routes

**Files:**

- Delete: `packages/maps/src/tools/writes.ts`, `packages/maps/src/tools/ax-writes.ts`,
  `packages/maps/src/client/write.ts` (whatever Task 5 did not move), the parts of
  `packages/maps/src/client/ax.ts` and their tests used only by those tools
- Modify: `packages/maps/src/tools/index.ts` (lane tools only, only when hosted with writes on),
  `packages/maps/src/client/maps.ts`, `packages/maps/src/tools/diagnostics.ts`, tests,
  `docs/maps.md` (routes retired, measurements kept as history), README, guide,
  `CHANGELOG.md` (`### Removed`: the npm package no longer writes; the five tools exist only in
  Cupertino), `surfaces.json`/generated files if `supportsWrites` wording changes

- [ ] **Step 1: Failing test first**: run from npm (no lane), with writes on, the maps server
      registers no write tool; `writer()` no longer exists.
- [ ] **Step 2:** FAIL → delete and rewire → PASS. Full maps suite, `tsc --noEmit`, oxlint,
      `make store-lane-check`, and `pnpm -r --if-present check` (or the repo's `make check`
      equivalent) green; `rg "registerAxWriteTools|MapsWriter\b" packages/maps/src` finds nothing.
- [ ] **Step 3: Commit** `refactor(maps)!: the store lane is Maps' only write route`.

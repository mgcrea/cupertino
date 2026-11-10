# Store Lane, Phase 1 (the lane and Voice Memos writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice Memos gains rename, move, favourite, delete and restore tools, each saved through
Core Data inside Cupertino.app so Voice Memos' own iCloud sync uploads it.

**Architecture:** A second verb on `cupertino.sock`, `cupertino/1 store for=<surface>`, admitted
like the Desktop lend (peer pid must be a server this host spawned for that surface). Past the
handshake it speaks newline-delimited JSON-RPC with lane methods (`voiceMemos.rename`). The app
answers from `StoreLane/`: a shared Core Data opener that refuses a store its patched model does not
match, and one writer per surface. The node server opens the lane lazily with
`openStoreLane` from `@mgcrea/mcp-apple-core` and registers the five lane tools only when the lane
is present and writes are on.

**Tech Stack:** Swift 6 + CoreData (app, `swiftc` check binaries driven by `make`), TypeScript +
vitest + zod (node packages), pnpm workspace, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-11-10-swift-write-lane-design.md` (approved 2026-11-10).

## Global Constraints

- Never migrate Apple's store: open with `NSMigratePersistentStoresAutomaticallyOption: false` and
  `NSInferMappingModelAutomaticallyOption: false`, and refuse unless
  `isConfiguration(withName:compatibleWithStoreMetadata:)` is true.
- Store options, exactly: `NSPersistentHistoryTrackingKey: true`,
  `NSPersistentStoreRemoteChangeNotificationPostOptionKey: true`, the two migration keys false.
- `transactionAuthor = "cupertino"`, one save per call, a coordinator opened per call and
  dropped after it.
- Fetch by the id the read tools return (`uniqueID` for a recording, `uuid` for a folder) and
  refuse unless exactly one object matches.
- Change only the attributes the app itself changes (measured 2026-11-10, table in Task 2).
  `flags` is never written.
- Voice Memos model: `/System/iOSSupport/System/Library/PrivateFrameworks/VoiceMemos.framework/Versions/A/Resources/VoiceMemos.momd`,
  copied, then patched with `CloudRecording.audioFuture.allowsExternalBinaryDataStorage = true`.
- Store: `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db`.
- Sync is promised only for model versions in the measured list, `["VoiceMemos14"]`, keyed on
  `NSManagedObjectModel_CurrentVersionName` in the `.momd`'s `VersionInfo.plist`. Elsewhere the
  result says sync is not yet measured on this macOS.
- The lane launches nothing. Tool copy says a write "syncs when Voice Memos next runs".
- The read tools, the npm behaviour without the app, and `docs/alternatives.md` /
  `docs/desktop.md` (other work in the main checkout) are not touched.
- Tests and printed output use synthetic data only: no real titles, folder names or transcripts.
- Makefile and CI stay portable to BSD tools.
- Worktree at `.claude/worktrees/store-lane` (check `.claude/worktrees` is git-ignored).

## Review Focus

1. **A store that changed under the app** (macOS update with a new model). Expected: every write
   refuses with reason `incompatible`, naming the entity whose hash differs, and diagnostics says
   so before anyone writes. Pinned in Task 1 (`refusesMismatchedStore`).
2. **A connection from a process that is not a spawned voice-memos server**, including another
   surface's server, claiming `for=voice-memos`. Expected: `err this connection is not a
   voice-memos server`. Pinned in Task 3 (admission) and Task 4 (host-check).
3. **Writes switched off while the server keeps running.** Expected: the next write method is
   refused with reason `writesOff`, read per request, and `status` still answers. Pinned in Task 3.
4. **A move that leaves a folder.** Expected: both the old and the new folder's
   `countOfRecordings` equal their `recordings.count` after the save, Recently Deleted members
   included. Pinned in Task 2 (`moveKeepsBothCounts`).
5. **A repeated call** (delete an already-deleted memo, favourite a favourite, move to the same
   folder). Expected: no save at all, `changed: []`, so no history row is written. Pinned in Task 2
   (`noOpWritesNoHistory`).

---

### Task 1: The Core Data opener

**Files:**
- Create: `apps/apple/Cupertino/StoreLane/StoreLaneError.swift`
- Create: `apps/apple/Cupertino/StoreLane/CoreDataStore.swift`
- Create: `scripts/store-lane-check.swift`
- Modify: `Makefile` (new `store-lane-check` target, after `unit`)
- Modify: `.github/workflows/ci.yml` (run `make store-lane-check` in the macOS job, next to `make unit`)

**Interfaces:**
- Produces:
  - `enum StoreLaneError: Error, Equatable { case invalid(String), notFound(String), incompatible(String), writesOff(String), failed(String) }`
    with `var reason: String` (`"invalid"`, `"notFound"`, `"incompatible"`, `"writesOff"`, `"failed"`)
    and `var message: String`.
  - `struct CoreDataStore: Sendable`:
    `init(modelURL: URL, storeURL: URL, patch: @Sendable (NSManagedObjectModel) -> Void, measuredVersions: Set<String>)`.
    `func status() -> CoreDataStore.Status`, where
    `struct Status: Equatable { compatible: Bool; modelVersion: String?; syncMeasured: Bool; refusal: String? }`.
    `func write<T>(_ body: (NSManagedObjectContext) throws -> T) throws -> T`: opens, runs
    `body` in `performAndWait` on a private-queue context with `transactionAuthor = "cupertino"`,
    saves only if `context.hasChanges`, and drops the coordinator.
  - `static func fetchOne(_ entity: String, key: String, value: String, in: NSManagedObjectContext) throws -> NSManagedObject`:
    throws `.notFound` unless exactly one matches.

- [ ] **Step 1: Write the failing check.** `scripts/store-lane-check.swift` with a `check(_ name:, _ body:)`
  harness in the style of `scripts/unit-check.swift` (prints `PASS name` / `FAIL name: why`, exits 1
  on any failure). Its first cases use a model built in code (entity `Thing`, string attributes
  `key` and `name`), with stores in a fresh `FileManager.default.temporaryDirectory` subfolder:
  - `opensMatchingStore`: a store created from model A; `CoreDataStore(model A).write` sets one
    `name` and returns; reading back gives the new value.
  - `refusesMismatchedStore`: a store created from model A, opened with model B (A plus an
    attribute `extra`); `write` throws `.incompatible` whose message contains `Thing`; the
    store file's metadata is unchanged afterwards (no migration).
  - `writesHistoryWithAuthor`: after a write, `NSPersistentHistoryChangeRequest.fetchHistory(after: .distantPast)`
    on a fresh coordinator returns a last transaction with author `"cupertino"`, and its one
    change's `updatedProperties` names only `name`.
  - `statusReportsVersion`: for a `.momd` written by the check with a `VersionInfo.plist` naming
    `Thing3`, `status()` gives `modelVersion == "Thing3"`, `syncMeasured` true when
    `measuredVersions` holds it, false otherwise.
  - `fetchOneRefusesZeroAndTwo`: zero matches and two matches both throw `.notFound`.
- [ ] **Step 2: Add the Makefile target and run it.**
  `store-lane-check:` compiles `apps/apple/Cupertino/StoreLane/*.swift scripts/store-lane-check.swift`
  into `apps/apple/.build/store-lane-check` and runs it, in the form the neighbouring targets use.
  Run: `make store-lane-check`. Expected: compile error (no `CoreDataStore`).
- [ ] **Step 3: Implement `StoreLaneError.swift` and `CoreDataStore.swift`.** The opener runs the
  spec's steps in order: load the model from `modelURL`, `copy()` it, apply `patch`, read the
  store's metadata with `NSPersistentStoreCoordinator.metadataForPersistentStore(type: .sqlite, at:)`,
  pick the first of `[nil] + model.configurations` for which `isConfiguration(withName:compatibleWithStoreMetadata:)`
  is true (the order the 2026-11-10 measurement used), else throw `.incompatible` naming the entities
  whose `versionHash` differs from `NSStoreModelVersionHashes`. Then add the store with the Global
  Constraints' options. The model version comes from `modelURL/VersionInfo.plist`'s
  `NSManagedObjectModel_CurrentVersionName` (nil when that file is absent, and then
  `syncMeasured` is false). Keep the loaded model alive for the life of the call: an
  entity does not retain its model (found 2026-11-10).
- [ ] **Step 4: Run it.** Run: `make store-lane-check`. Expected: `PASS` for all five, exit 0.
- [ ] **Step 5: Commit.**
  `git add apps/apple/Cupertino/StoreLane scripts/store-lane-check.swift Makefile .github/workflows/ci.yml`
  `git commit -m "feat(store-lane): a Core Data opener that refuses a store its model does not match"`

### Task 2: The Voice Memos writer

**Files:**
- Create: `apps/apple/Cupertino/StoreLane/VoiceMemosWriter.swift`
- Modify: `scripts/store-lane-check.swift`

**Interfaces:**
- Consumes: `CoreDataStore`, `StoreLaneError`, `CoreDataStore.fetchOne` (Task 1).
- Produces: `struct VoiceMemosWriter: Sendable` with `init(store: CoreDataStore)`,
  `static let live: VoiceMemosWriter` (the Global Constraints' model and store paths, the
  `audioFuture` patch, `measuredVersions: ["VoiceMemos14"]`), and these methods, each returning
  `VoiceMemosWriter.Result { id: String; changed: [String] /* sorted attribute names */; modelVersion: String?; syncMeasured: Bool }`:
  - `rename(id: String, title: String) throws -> Result`
  - `setFavorite(id: String, favorite: Bool) throws -> Result`
  - `move(id: String, folderId: String?) throws -> Result`
  - `delete(id: String) throws -> Result`
  - `restore(id: String) throws -> Result`
  - `status() -> CoreDataStore.Status`

What each method changes, from the app itself (watched 2026-11-10, one transaction per step):

| Method | Attributes it sets | As the app did it |
| --- | --- | --- |
| `rename` | `encryptedTitle`, `customLabelForSorting` | measured by the Core Data rename that reached the iPhone |
| `setFavorite` | `sharedFlags`: bit 0 set (`(old ?? 0) \| 1`) or cleared (`(old ?? 0) & ~1`) | favourite went `null` → `1`, nothing else |
| `move` | the recording's `folder`; `countOfRecordings` on the old and the new folder, each set to its `recordings.count` | the move set `folder` and the destination's count 0 → 1 in one save |
| `delete` | `evictionDate = Date()` | nothing else; the folder count kept the deleted memo |
| `restore` | `evictionDate = nil` | nothing else |

Rulings to implement: a title is trimmed, must be 1 to 500 characters and contain no newline,
else `.invalid`. A call that would change nothing (same title, flag already in that state, same
folder, already deleted, not deleted) makes no save and returns `changed: []`. Clearing a
favourite on a `nil` `sharedFlags` is a no-op. A `folderId` that matches no `Folder.uuid` is
`.notFound`.

- [ ] **Step 1: Write the failing cases.** Append to `scripts/store-lane-check.swift` a fixture
  that builds a temporary store from the real `VoiceMemos.momd` with the patch (skip the whole
  group with `SKIP voice-memos: model not on this machine` when the file is absent), holding
  folders `F-ONE` (rank 0) and `F-TWO` (rank 1), and recordings `R-ONE` ("Synthetic one", in
  `F-ONE`, `F-ONE` count 1) and `R-TWO` ("Synthetic two", no folder). Cases:
  - `renameSetsTitleAndSortKey`: `rename("R-ONE", "  Synthetic renamed ")` → `changed == ["customLabelForSorting", "encryptedTitle"]`,
    both read back as `"Synthetic renamed"`.
  - `renameRefusesBadTitles`: `""`, `"   "`, `"a\nb"` and 501 characters each throw `.invalid`.
  - `favoriteSetsAndClearsBitZero`: `sharedFlags` starts `nil`; on → `1`; with it at `5`, off → `4`.
  - `moveKeepsBothCounts`: `move("R-ONE", "F-TWO")` → counts `F-ONE` 0, `F-TWO` 1, and
    `changed == ["folder"]` for the recording; then `delete("R-ONE")` and
    `move("R-ONE", nil)` → `F-TWO` count 0 (a deleted memo still counts while it is in the folder).
  - `moveRefusesUnknownFolder`: `move("R-ONE", "F-NONE")` throws `.notFound`.
  - `deleteAndRestoreTouchOnlyEvictionDate`: after each, the last history transaction's single
    change lists only `evictionDate`, and author is `"cupertino"`.
  - `noOpWritesNoHistory`: a second `delete`, a repeated `setFavorite(true)` and a move to the
    current folder each return `changed: []` and leave the history transaction count unchanged.
  - `unknownRecordingIsNotFound`: `rename("R-NONE", "x")` throws `.notFound`.
  - `unpatchedModelIsRefused`: a `CoreDataStore` over the same fixture with a no-op patch throws
    `.incompatible` mentioning `CloudRecording`.
- [ ] **Step 2: Run it.** Run: `make store-lane-check`. Expected: compile error (no `VoiceMemosWriter`).
- [ ] **Step 3: Implement `VoiceMemosWriter.swift`** to the table and rulings above, every write
  through `store.write`, every fetch through `CoreDataStore.fetchOne` (`CloudRecording.uniqueID`,
  `Folder.uuid`).
- [ ] **Step 4: Run it.** Run: `make store-lane-check`. Expected: all Task 1 and Task 2 cases `PASS`.
- [ ] **Step 5: Commit.**
  `git commit -m "feat(store-lane): rename, favourite, move, delete and restore a Voice Memo the way the app saves them"`

### Task 3: The lane's dispatch and admission

**Files:**
- Create: `apps/apple/Cupertino/StoreLane/StoreLane.swift`
- Modify: `scripts/store-lane-check.swift`

**Interfaces:**
- Consumes: `VoiceMemosWriter` (Task 2), `StoreLaneError` (Task 1).
- Produces:
  - `enum StoreLane` with `static let surfaces: Set<String> = ["voice-memos"]`.
  - `static func admit(borrowerId: String, peerSurface: String?) -> String?`: nil to admit, else
    the refusal text without the `err ` prefix: `"'\(id)' has no store lane"` when not in
    `surfaces`, `"this connection is not a \(id) server"` when `peerSurface != borrowerId`.
  - `static func handle(_ line: String, borrower: String, allowWrites: Bool, voiceMemos: VoiceMemosWriter = .live) -> String`:
    one JSON-RPC 2.0 reply line, no trailing newline.

Wire format:
- Request: `{"jsonrpc":"2.0","id":<n>,"method":"voiceMemos.<verb>","params":{...}}`.
- Methods: `voiceMemos.rename {id, title}`, `voiceMemos.setFavorite {id, favorite}`,
  `voiceMemos.move {id, folderId|null}`, `voiceMemos.delete {id}`, `voiceMemos.restore {id}`,
  `voiceMemos.status {}`.
- Success: `{"jsonrpc":"2.0","id":n,"result":{"id","changed","modelVersion","syncMeasured"}}`.
  `status` returns `{"compatible","modelVersion","syncMeasured","refusal"}`.
- Failure: `{"jsonrpc":"2.0","id":n,"error":{"code":-32000,"message":<message>,"data":{"reason":<reason>}}}`.
  Unparseable line: `id` null, code `-32700`. Unknown method or a method outside the borrower's
  namespace (`voiceMemos.` belongs to `voice-memos` only): code `-32601`. Missing or mistyped
  params: `.invalid`.
- Every method but `status` is refused with `.writesOff("writes are off for Voice Memos in Cupertino")`
  when `allowWrites` is false.

- [ ] **Step 1: Write the failing cases.** Against the Task 2 fixture (`voiceMemos:` injected):
  `admitsOnlyItsOwnServer` (`admit("voice-memos", "voice-memos")` nil; `admit("voice-memos", "mail")`
  and `admit("voice-memos", nil)` give the "not a voice-memos server" text; `admit("mail", "mail")`
  gives "'mail' has no store lane"), `renameRoundTrip` (a rename line returns the result shape
  above), `writesOffRefusedStatusAnswers` (with `allowWrites: false` a rename returns reason
  `writesOff` and `status` still returns `compatible: true`), `garbageIsParseError`,
  `foreignNamespaceIsUnknownMethod` (`maps.add` from `voice-memos` → `-32601`),
  `missingParamsIsInvalid` (`voiceMemos.rename {id}` → reason `invalid`).
- [ ] **Step 2: Run it.** Run: `make store-lane-check`. Expected: compile error (no `StoreLane`).
- [ ] **Step 3: Implement `StoreLane.swift`** with `JSONSerialization`, mapping each
  `StoreLaneError` to the failure shape.
- [ ] **Step 4: Run it.** Run: `make store-lane-check`. Expected: every case `PASS`.
- [ ] **Step 5: Commit.** `git commit -m "feat(store-lane): JSON-RPC dispatch, and admission only for the surface's own server"`

### Task 4: The socket verb in `ServerHost`

**Files:**
- Modify: `apps/apple/Cupertino/BridgeProtocol.swift` (add `static let storeLane = "store"` and
  `static func storeHandshake(onBehalfOf: String) -> String` returning `"\(version) store for=\(id)\n"`)
- Modify: `apps/apple/Cupertino/ServerHost.swift` (handshake parsing, around `:545-633`; a
  `serveStoreLane` loop next to `serveInProcess`)
- Modify: `Makefile` (every target that compiles `ServerHost.swift`, today `host-check`, also
  compiles `apps/apple/Cupertino/StoreLane/*.swift`)
- Modify: `scripts/host-check.swift`

**Interfaces:**
- Consumes: `StoreLane.admit`, `StoreLane.handle`, `StoreLane.surfaces` (Task 3).
- Produces: the handshake `cupertino/1 store for=<surface>` → `ok` or `err <text>`, then one
  reply line per request line.

Behaviour: when `parts[1] == BridgeProtocol.storeLane`, it is handled before `Surface.named`
(so "store" never reads as an unknown server). It needs exactly three parts with the `for=`
prefix (else `err malformed handshake`), `StoreLane.admit(borrowerId:peerSurface:)` with
`peerSurface = peerPID(client).flatMap { serverPIDs[$0] }`, then the same enablement and licence
gates the lend passes, answered for the borrower. Past `ok`, `serveStoreLane` reads lines with
`InProcessRPC.nextLine`, rechecks `SurfaceSettings.isEnabled(borrower)` per line (closing the
session when off, as `serveInProcess` does), and answers
`StoreLane.handle(line, borrower:, allowWrites: SurfaceSettings.allowWrites(borrower))` inside an
`autoreleasepool`. It logs one `hostLog(borrower.id, .info, …)` line per write method and its
outcome (no titles), and records no call in the observer: the borrower's own tool call is
already recorded, as for a lend.

- [ ] **Step 1: Write the failing host-check cases**, using the check's existing socket helpers:
  `store for=voice-memos` from the check process → reply starts `err this connection is not a voice-memos server`;
  `store for=mail` → `err 'mail' has no store lane`; `cupertino/1 store` → `err malformed handshake`.
- [ ] **Step 2: Run it.** Run: `make host-check`. Expected: the three new cases FAIL (today's reply is
  `err unknown server 'store'`), the rest PASS.
- [ ] **Step 3: Implement** the behaviour above, plus the `BridgeProtocol` constants and the
  Makefile source lists.
- [ ] **Step 4: Run them.** Run: `make host-check && make store-lane-check && make unit`. Expected: all PASS.
  Then build the app: `xcodebuild -project apps/apple/Cupertino.xcodeproj -scheme Cupertino -configuration Debug build`
  (or the `BuildProject` Xcode tool). Expected: `BUILD SUCCEEDED`. The `StoreLane/` folder is
  picked up by the synchronized root group, with no `project.pbxproj` edit.
- [ ] **Step 5: Commit.** `git commit -m "feat(store-lane): the store verb on cupertino.sock, admitted like the desktop lend"`

### Task 5: `openStoreLane` in core

**Files:**
- Create: `packages/core/src/store-lane.ts`
- Create: `packages/core/test/store-lane.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Consumes: `SurfaceContext`, `AppleAutomationError` from `./errors.js`; the env vars
  `CUPERTINO_AX_SOCKET` and `CUPERTINO_AX_FOR` that `ServerLocator` sets.
- Produces:
  - `type StoreLane = { call(method: string, params: Record<string, unknown>): Promise<unknown>; close(): void }`
  - `openStoreLane(surface: SurfaceContext, env?: NodeJS.ProcessEnv): StoreLane | null`
  - `class StoreLaneError extends AppleAutomationError` with `readonly reason: string`
    (`"refused"` for a handshake refusal, `"unreachable"`, `"timeout"`, `"closed"`, `"protocol"`,
    else the reply's `data.reason`).

Mirrors `openAxChannel` in `ax.ts`: null without both env vars, no connection until the first
call, calls serialised on one chain that survives a failure, a 15 s timeout per call, a closed
socket reconnects on the next call. Handshake `cupertino/1 store for=<CUPERTINO_AX_FOR>`.
`ax.ts` itself is not refactored (ruling: it carries hard-won comments and three consumers; a
second file is cheaper than a shared abstraction now).

- [ ] **Step 1: Write the failing tests**, with a fake socket server in the style of
  `packages/core/test/ax.test.ts`: `returns null without the host's env`; `does not connect until
  the first call`; `sends the store handshake for the surface`; `returns the result of a call`;
  `throws StoreLaneError with the reply's reason` (`data.reason: "notFound"` → `reason === "notFound"`);
  `reports a refused handshake as reason refused with the host's text`; `serialises overlapping calls`;
  `times out a call that is never answered` (inject a short timeout through an optional
  `opts: { timeoutMs?: number }` third parameter).
- [ ] **Step 2: Run them.** Run: `pnpm --filter @mgcrea/mcp-apple-core test -- store-lane`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `store-lane.ts`** and the export.
- [ ] **Step 4: Run them.** Run: `pnpm --filter @mgcrea/mcp-apple-core test && pnpm --filter @mgcrea/mcp-apple-core typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): openStoreLane, the node half of the store verb"`

### Task 6: The Voice Memos lane tools

**Files:**
- Create: `packages/voice-memos/src/client/lane.ts`
- Create: `packages/voice-memos/src/tools/store-writes.ts`
- Create: `packages/voice-memos/test/store-writes.test.ts`
- Modify: `packages/voice-memos/src/client/voice-memos.ts` (an `env?` option; `readonly lane`)
- Modify: `packages/voice-memos/src/tools/index.ts`, `names.ts`, `diagnostics.ts`
- Modify: `packages/voice-memos/src/config.ts` (the doc comment: the store is now written through the app's lane)

**Interfaces:**
- Consumes: `openStoreLane`, `StoreLaneError` (Task 5); the Task 3 wire format.
- Produces:
  - `class VoiceMemosLane` with `static open(env?: NodeJS.ProcessEnv): VoiceMemosLane | null` and
    `rename(id, title)`, `setFavorite(id, favorite)`, `move(id, folderId: string | null)`,
    `delete(id)`, `restore(id)`, each `Promise<LaneWrite>` where
    `type LaneWrite = { id: string; changed: string[]; modelVersion: string | null; syncMeasured: boolean }`,
    and `status(): Promise<LaneStatus>` where
    `type LaneStatus = { compatible: boolean; modelVersion: string | null; syncMeasured: boolean; refusal: string | null }`.
  - `VoiceMemosClient.lane: VoiceMemosLane | null`, opened from `opts.env ?? process.env`.
  - `STORE_WRITE_TOOLS` in `names.ts`: `apple_voice_memos_rename_recording`,
    `apple_voice_memos_move_recording`, `apple_voice_memos_set_favorite`,
    `apple_voice_memos_delete_recording`, `apple_voice_memos_restore_recording`.
  - `registerStoreWriteTools(server: McpServer, lane: VoiceMemosLane): void`.

Registration in `registerTools`: after `registerExportTools`, `if (client.lane) registerStoreWriteTools(server, client.lane)`,
with the Maps comment's reasoning (a package run from npm has no lane, so it must not advertise
these). Inputs: `id: idArg` everywhere; `title: z.string()`; `favorite: z.boolean()`;
`folderId: z.string().min(1).nullable()` (null leaves every folder). Annotations: all
`idempotentHint: true`; `delete_recording` has `destructiveHint: true`, the rest false. Each
result is the lane's answer plus a `sync` sentence: when `syncMeasured`, "Saved the way Voice
Memos saves it. It reaches your other devices through iCloud, once Voice Memos is running."
Otherwise: "Saved, but sync is not yet measured on this macOS (model <modelVersion>): check the
recording on another device." When `changed` is empty: "Nothing to change." The rename
description, verbatim:

> "Rename one recording. Saved through Voice Memos' own data model inside Cupertino, so Voice
> Memos uploads it to iCloud like a rename made in the app; it syncs when Voice Memos next runs.
> Only available when Cupertino hosts this server. Changes the title and nothing else."

The other four follow the same pattern. `delete_recording` says it moves the recording to Recently
Deleted, where Voice Memos removes it for good after its own retention period, and that
`restore_recording` brings it back until then.

Diagnostics gains `writeLane`: `null` with the note "not hosted by Cupertino: rename, move,
favourite and delete need the app" when `client.lane` is null; else the `status()` answer, or
`{ error: <message> }` when it throws. It also lists `STORE_WRITE_TOOLS` beside `WRITE_TOOLS`.

- [ ] **Step 1: Write the failing tests** in `store-writes.test.ts`, with a fake store-lane socket
  (as in Task 5) and a synthetic fixture store for the client:
  - `registers the five lane tools when hosted and writes are on`
  - `registers none of them without the host's env` (writes on, `env: {}`)
  - `registers none of them with writes off` (lane env set)
  - `rename_recording sends voiceMemos.rename with id and title` (assert the request line the fake saw)
  - `a lane refusal comes back as a tool error naming the reason` (`notFound`)
  - `says sync is not yet measured when the lane says so`
  - `diagnostics reports writeLane null without the host, and the lane status with it`
- [ ] **Step 2: Run them.** Run: `pnpm --filter @mgcrea/mcp-apple-voice-memos test -- store-writes`
  (the package name is the one in `packages/voice-memos/package.json`). Expected: FAIL.
- [ ] **Step 3: Implement** `lane.ts`, `store-writes.ts` and the edits above.
- [ ] **Step 4: Run them.** Run: `pnpm --filter @mgcrea/mcp-apple-voice-memos test && pnpm --filter @mgcrea/mcp-apple-voice-memos typecheck && pnpm lint`.
  Expected: PASS, and the existing `tools.test.ts` registration counts still PASS (no lane env in vitest).
- [ ] **Step 5: Commit.** `git commit -m "feat(voice-memos): rename, move, favourite, delete and restore through Cupertino's store lane"`

### Task 7: Documentation and the generated checks

**Files:**
- Modify: `docs/voice-memos.md` (a section "What the app changes, watched 2026-11-10": the Task 2
  table, with the probe facts. Folder counts are maintained and include Recently Deleted members;
  `EntityRevision` is empty; history rows carry no author; `ZFLAGS` is never touched. Plus a
  section on the lane tools.)
- Modify: `packages/voice-memos/README.md` ("What it writes": the five tools, marked as needing
  Cupertino)
- Modify: `README.md` (the Surfaces row's tool count, `### Voice Memos`, and the sentence
  "Nothing writes to the store")
- Modify: `docs/surfaces.md:13` (the "pure broker" sentence: the app now writes through Core
  Data for Voice Memos, reads stay with the servers; link the spec)
- Modify: `apps/apple/Cupertino/Surfaces.swift` (the Voice Memos comment's "Nothing writes to the store")
- Modify: `CHANGELOG.md` (Unreleased: the five tools, Cupertino-only, sync measured on macOS 27.2)

- [ ] **Step 1: Run the checks that guard these files.** Run: `node scripts/readme-surfaces-check.mjs && pnpm test:scripts`.
  Expected: FAIL on the README tool count (6 against 11 registered).
- [ ] **Step 2: Write the docs above.** Synthetic examples only.
- [ ] **Step 3: Run them again.** Run: `node scripts/readme-surfaces-check.mjs && pnpm test:scripts && pnpm format:check && pnpm test`.
  Expected: PASS. The website test keeps Voice Memos in `UNLISTED`.
- [ ] **Step 4: Commit.** `git commit -m "docs(voice-memos): the store lane's writes, and what the app itself changes"`

### Task 8: The live check (needs Olivier, the Mac and the iPhone)

**Files:**
- Modify: `docs/voice-memos.md` (the measurement, per tool)

Run on a Debug build of this branch (the `use-the-dev-build` skill), with Voice Memos' writes on
in Cupertino, against the throwaway memo `02373912-C6C4-4CA2-9EED-BD79D124513E` only, driving the
bridge over stdio (memory: "drive the installed bridge over stdio to test a new tool without a
restart"). Before each step, take a `.backup` of the store into the scratchpad, as on 2026-11-10.

- [ ] **Step 1:** `diagnostics` → `writeLane.compatible: true`, `modelVersion: "VoiceMemos14"`, `syncMeasured: true`.
- [ ] **Step 2:** Each tool in turn: rename, set_favorite on and off, move into "Cupertino test" and out,
  delete, restore. Olivier confirms each one on the Mac (live) and on the iPhone (within a minute).
  The watcher (`vm-watch.mjs`) confirms one transaction per call, author `cupertino`, and only
  the Task 2 attributes. Also watch the app unfavourite once by hand, to confirm it writes `0` as the writer does.
- [ ] **Step 3: App closed.** Quit Voice Memos, rename. Olivier checks the iPhone: not yet. Open
  Voice Memos on the Mac: the iPhone gets the rename within a minute. If it never arrives, the tool
  copy and docs say so, and the result is recorded before anything ships.
- [ ] **Step 4:** Record the results in `docs/voice-memos.md` and commit:
  `git commit -m "docs(voice-memos): the store lane's writes, measured on a Mac and an iPhone"`

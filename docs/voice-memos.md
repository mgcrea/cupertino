# Voice Memos: what the probe found

Phase 0 for a `voice-memos` surface. Measured on 2026-11-10, macOS 27.2, with
[`scripts/probe-voice-memos.mjs`](../scripts/probe-voice-memos.mjs), run through `apple_shell_run`
because the agent's own shell holds no Full Disk Access. That library held 87 recordings from
2019 to 2026. The verdict is **GO, file lane only, read-only**. That was phase 0's verdict: the
reads still take the file lane, and writes later shipped through Cupertino's store lane (see
[Writing](#writing-sql-stays-on-this-mac-core-data-reaches-icloud)).

## Lanes

| Lane         | Verdict                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| Apple Events | **closed**: `VoiceMemos.app` ships no `.sdef` and no `NSAppleScriptEnabled`                         |
| App Intents  | **present, unreachable**: see below                                                                 |
| File lane    | **open** under Full Disk Access: `group.com.apple.VoiceMemos.shared` is EPERM without it, not empty |

`Resources/Metadata.appintents` registers `DeleteRecording`, `RCImportRecording`,
`RecordVoiceMemoIntent`, `StopRecording`, `ToggleRecording`, `CreateFolder`, `DeleteFolder`,
`OpenFolder`, `SearchRecordings`, `SelectRecording`, `PlaybackVoiceMemoIntent`,
`ChangeRecordingPlaybackSetting` and `RCCombineRecordings`. Nothing outside Shortcuts can invoke
an App Intent, and `shortcuts run` only runs a shortcut the user authored. This is the first
surface that has a write vocabulary and no way to reach it. It is the reason a Shortcuts lane
would pay for itself, if one is ever built.

## The store

`~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db` is a Core
Data store mirrored by `NSPersistentCloudKitContainer` (the `ANSCK*` tables). It sits in the same
directory as the audio. It opens `mode=ro` beside a live 494 KB `-wal`, and a full read of
`ZCLOUDRECORDING` takes 0.2 ms.

| Column            | What it holds                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZUNIQUEID`       | a UUID, 87/87 distinct: the recording's id                                                                                                                                               |
| `ZENCRYPTEDTITLE` | **the title, in plaintext** despite its name: 85/87 have spaces and letters, 4–27 chars; equals `ZCUSTOMLABELFORSORTING`                                                                 |
| `ZCUSTOMLABEL`    | 20 chars, no letters: the default date-shaped label, not the title                                                                                                                       |
| `ZDATE`           | Core Data seconds since 2001                                                                                                                                                             |
| `ZDURATION`       | seconds, float                                                                                                                                                                           |
| `ZPATH`           | file name relative to `Recordings/`; 86/86 resolve; **one 2019 row has none** and no audio digest                                                                                        |
| `ZFOLDER`         | foreign key to `ZFOLDER.Z_PK`, null when unfiled; `ZFOLDER.ZCOUNTOFRECORDINGS` agrees                                                                                                    |
| `ZEVICTIONDATE`   | **set when a memo goes to Recently Deleted**, to the moment of deletion (measured: 0.00 days from now), not the purge date                                                               |
| `ZSHAREDFLAGS`    | **bit `0x1` is favourite**: 4 rows set, and the app's Favourites view shows 4. Null or `0` otherwise; `0` on 5 rows, presumably once-favourited                                          |
| `ZFLAGS`          | a bitfield: `4` ×58, `1540` ×8, `4612` ×3, `5636` ×7, `5644` ×10, `0` ×1. **A rename in the app sets bit `0x8`** (2026-11-11); favouriting does not touch it; the other bits are unknown |

`ZRECORDING` is a legacy entity with the same core columns and no rows. The schema fixture lives at
`packages/voice-memos/test/fixtures/cloud-recordings.sql` (fingerprint `fb804d4a4d59`).

## The audio, and Apple's transcript

There are two containers, and the newer one is the current default: 19 of the 25 recordings from
2026 are `.qta`.

| Brand  | Files | Years     | Transcript location                                                                                                              |
| ------ | ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `M4A ` | 66    | 2019–2026 | a `tsrp` box at `moov/trak/udta/tsrp`                                                                                            |
| `qt  ` | 20    | 2025–2026 | a QuickTime keyed metadata item `com.apple.VoiceMemos.tsrp` in `moov/trak/meta` (`keys` + `ilst`), inside a `data` box of type 0 |

**Every recording from 2025 on has a transcript (28 of 28), and none from before has one (0 of 58).**
Apple did not backfill. The payload is UTF-8 JSON in both containers, 217 B to 342 KB:

```jsonc
{
  "locale": { "identifier": "en_US", "current": 0, "preferences": {/* optional */} },
  "attributedString": {
    // word-level: runs alternate text and an index into attributeTable
    "runs": ["word", 0, "word", 1 /* … up to 15 452 entries */],
    "attributeTable": [{ "timeRange": [0.0, 0.42] } /* … */],
  },
}
```

Two variants occur. One file has `attributedString` as a flat array alternating text and
`{ "timeRange": [...] }`. Three have `attributedString: ""`: a transcript that ran and heard nothing.

**`timeRange` is `[start, end]` in seconds**, measured over 41,852 words, not assumed: the next word's
start minus this word's second value has median 0, p99 0.66 s and is never negative. Read as
`[start, duration]`, 41,807 of 41,827 gaps come out negative. Words abut, so **a pause is folded
into the word before it** rather than left as a gap: 2,974 words span more than 1 s, while only
346 gaps exceed 1 s. A segmenter that only looks at gaps misses most pauses.

**Each run carries its own leading space** (41,825 of 41,852; the rest are first words), never a
trailing or inner one, so text is the runs concatenated. 133 runs are punctuation only.

Two parsing traps, both hit by the probe:

- **`meta` is a FullBox in ISO files and a plain box in QuickTime ones.** Reading every `meta` with
  a 4-byte version header failed all 20 `.qta` files. Peek for `hdlr` instead.
- **A redaction check by substring is useless against a word-level transcript.** Single words
  ("name", "date", "number") match the report's own vocabulary. The probe now matches short words
  only against whole values.

## Folders, favourites and Recently Deleted

Measured by diff, with `--snapshot` then `--diff`: numeric columns by `Z_PK` only, so a bit
gets its name without a title being read. Between the two runs Olivier favourited exactly 2 memos
and deleted exactly 1. Exactly 2 rows went `ZSHAREDFLAGS null -> 1` and exactly 1 went
`ZEVICTIONDATE null -> date`; `ZFLAGS` moved on none. Folders were created before the
snapshot. `ZFOLDER` rows carry `ZENCRYPTEDNAME`, which is plaintext like the title (2 of 2
legible), `ZRANK` (sidebar order) and `ZUUID`.

Every edit bumps `Z_OPT`, Core Data's optimistic-lock counter. That makes it a cheap change token
for a cache.

The bin's retention period (Voice Memos › Settings › Clear Deleted) is not in this store. A tool
can say when a memo was deleted, but not when it will be purged.

## Shipped

`packages/voice-memos` reads all of the above. On 2026-11-10, `scripts/check-voice-memos-live.mjs`
ran the built server against the probed library under Full Disk Access. It found 87 recordings,
schema `fb804d4a4d59` verified, 2 folders, 4 favourites, and 0 in Recently Deleted (the memo
deleted for the diff had been restored). All 28 recordings from 2025 on read as `ok` (25) or
`empty` (3). The 58 older ones read `none`, and the 2019 row with no `ZPATH` reads `no-audio`.
The diagnostics call, which walks the boxes of all 86 files, took 31 ms; decoding every transcript
took 45 ms in all.
The newest `.m4a` and `.qta` were exported with `save_recording`, and Cadence imported and
transcribed both. A `.qta` needs no conversion.

## Writing: SQL stays on this Mac, Core Data reaches iCloud

Measured on 2026-11-10 on one throwaway memo. Olivier checked the Mac and an iPhone at each step.

**A rename by SQL never syncs.** An `UPDATE` of `ZENCRYPTEDTITLE` and `ZCUSTOMLABELFORSORTING`,
with `Z_OPT` bumped, showed on the Mac after a relaunch. The iPhone kept the old title. It kept it
even after a favourite toggle on another memo made the app save and sync: that toggle wrote two
`ATRANSACTION`/`ACHANGE` rows for the other memo, and `voicememod` uploaded only that one. The
test memo's `ANSCKRECORDMETADATA.ZLASTEXPORTEDTRANSACTIONNUMBER` stayed at 144. The exporter uploads
what persistent history lists, and an out-of-band write adds nothing to it. Maps' SQL inserts
do not reach iCloud either. This paragraph said they did, because Core Data reconciles a brand-new
object. CORRECTED 2026-11-11: those inserts were never mirrored, and Maps converts them into saved
places ([docs/maps.md](maps.md#what-maps-changes-watched-2026-11-11)).

**A rename through Core Data syncs in seconds.** A Swift helper opened the store with
`NSPersistentStoreCoordinator` and Voice Memos' own model, then saved the new title. The model was
`VoiceMemos.momd`, current version `VoiceMemos14`, from
`/System/iOSSupport/System/Library/PrivateFrameworks/VoiceMemos.framework/Versions/A/Resources/`.
The store options were history tracking and remote-change notifications on, migration off.
Core Data wrote transaction 148, one `ACHANGE` for the memo covering exactly the two changed
columns. Within 15 s `voicememod` had uploaded it, with `ZLASTEXPORTEDTRANSACTIONNUMBER` going
144 → 148. The Mac app showed the new title without a relaunch, and the iPhone had it within a
minute. No private API was used.

**Voice Memos changes its model in code.** As shipped, the model's `CloudRecording` version hash
does not match the store's, so with migration off Core Data refuses to open the store. Every other
entity matches. Trying one property change at a time on a copy of the model, the store's hash comes
back when `audioFuture` has `allowsExternalBinaryDataStorage` set, as the app evidently sets it at
runtime; `preservesValueInHistoryOnDeletion` on the same attribute gives the same hash, and neither
matters to a write that leaves `audioFuture` alone. A writer must make that change, and must
refuse to write whenever the model and the store still disagree: a macOS update can move either.

The syncing process is `voicememod`, in the framework's `Support/`. It holds the CloudKit
entitlements, including `com.apple.private.cloudkit.masquerade` and `com.apple.private.cloudkit.spi`,
so nothing outside Apple's signature can talk to the container directly. It does not need to.

The store lane is how this Core Data route shipped: Cupertino.app makes the save, and the node
server never writes the store. The sections below say what it changes and how a call runs. The
design is [the store lane spec](superpowers/specs/2026-11-10-swift-write-lane-design.md).

## What the app changes, watched 2026-11-10 and 2026-11-11

Each edit was made once in Voice Memos itself, on a throwaway memo, and the store read after each
step, one transaction per step: favourite, move, delete and restore on 2026-11-10, rename,
unfavourite and a move out of a folder on 2026-11-11. The lane sets what the app set and nothing
else. Names are Core Data's; the column is the same name upper-cased with a `Z` in front
(`encryptedTitle` is `ZENCRYPTEDTITLE`).

| Method        | Attributes it sets                                                                                             | As the app did it                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `rename`      | `encryptedTitle`, `customLabelForSorting`; `flags`: bit `0x8` set (`(old ?? 0) \| 0x8`), only with a new title | the same three; `flags` went `1540` → `1548`          |
| `setFavorite` | `sharedFlags`: bit 0 set (`(old ?? 0) \| 1`) or cleared (`(old ?? 0) & ~1`)                                    | favourite went `null` → `1`, nothing else             |
| `move`        | the recording's `folder`; Core Data derives each folder's `countOfRecordings`                                  | `folder`, and each folder's `recordings`, in one save |
| `delete`      | `evictionDate = Date()`                                                                                        | nothing else; the folder count kept the deleted memo  |
| `restore`     | `evictionDate = nil`                                                                                           | nothing else                                          |

Four more facts came out of the same watch:

- **Folder counts are derived, and include Recently Deleted.** `countOfRecordings` is a
  derived attribute, `count:(recordings)`, so Core Data updates it on any save that moves a
  memo: a move's history lists only the folders' `recordings`, for the app and for the lane. A
  memo in Recently Deleted still counts in the folder it was in.
- **`EntityRevision` is empty.** The entity held no rows before or after any edit, so there is
  nothing there to keep in step.
- **The app's history rows carry no author.** Its persistent-history transactions have a null
  `author`. The lane's carry `cupertino`, so its saves can be told apart from the app's.
- **A rename sets bit `0x8` of `ZFLAGS`; nothing else touches it.** The 2026-11-10 watch never
  renamed in the app, and on 2026-11-11 the app's rename changed `flags` beside the two title
  columns. 11 rows carry the bit, each beside `0x200` and `0x400`. Its effect is unknown, perhaps
  keeping a generated title from replacing the person's, so the lane sets it on a rename as the
  app does.

The lane adds its own rules on top. A title is trimmed, then must be 1 to 500 characters with no
line break inside, or the call is refused as `invalid`. A call that would change nothing (the same
title, a favourite already in that state, the folder it is already in, a memo already deleted or
not deleted) makes no save and returns `changed: []`. Clearing a favourite on a null
`sharedFlags` is one of those. A folder id that matches no folder is `notFound`.

## The store lane's tools

| Tool                                  | Method        | What it does                                                      |
| ------------------------------------- | ------------- | ----------------------------------------------------------------- |
| `apple_voice_memos_rename_recording`  | `rename`      | sets the title                                                    |
| `apple_voice_memos_move_recording`    | `move`        | files the recording in a folder, or in none with `folderId: null` |
| `apple_voice_memos_set_favorite`      | `setFavorite` | marks it a favourite, or clears it                                |
| `apple_voice_memos_delete_recording`  | `delete`      | moves it to Recently Deleted                                      |
| `apple_voice_memos_restore_recording` | `restore`     | brings it back from Recently Deleted                              |

**They exist only when Cupertino hosts the server and writes are on.** Run from npm, the server
has no lane and registers none of them, so a host is never told about a capability it lacks.
Without writes on, none is registered either, as for `save_recording`. If writes are switched off
in Cupertino while a session runs, the next call is refused with `writesOff`.

**Rename, move and favourite refuse a recording in Recently Deleted** with `invalid` ("the
recording is in Recently Deleted: restore it first"), since the app offers none of them there and
a state it never makes would sync to every device; delete and restore take it as it is.

**How one call runs.** The server sends one JSON-RPC request over Cupertino's socket, and the app
admits it only from the Voice Memos server it spawned itself. The app then:

1. copies Voice Memos' model, `VoiceMemos.momd` from
   `/System/iOSSupport/System/Library/PrivateFrameworks/VoiceMemos.framework/Versions/A/Resources/`,
   and sets `allowsExternalBinaryDataStorage` on `CloudRecording.audioFuture`, as the app does at
   runtime;
2. refuses with `incompatible` unless that model has every attribute and relationship the writer
   names ("this macOS's Voice Memos model lacks …", naming each) and the store's metadata matches
   it, and never migrates the store;
3. opens a coordinator for this call alone, with history tracking and remote-change notifications
   on and migration off;
4. fetches the recording by the `id` the read tools return (`uniqueID`), and a folder by its
   `uuid`, refusing with `notFound` unless exactly one matches;
5. sets only the attributes in the table above, saves once with the author `cupertino`, and drops
   the coordinator.

**The answer** carries `id`, `changed` (the recording's own attributes it set, sorted),
`modelVersion`, `syncMeasured`, and a `sync` sentence. A refusal's reason (`invalid`,
`notFound`, `incompatible`, `writesOff`, `failed`, or one from the connection) is in the tool
error's `details.reason`.

**Sync.** `voicememod`, Voice Memos' daemon, exports each lane save to iCloud, whether or not
the app is open; the lane launches nothing. Sync was measured on macOS 27.2, model version
`VoiceMemos14`, on a Mac and an iPhone, on 2026-11-11 (below). The model version is read from
the `.momd`'s `VersionInfo.plist` (`NSManagedObjectModel_CurrentVersionName`). On any other
version the save still happens, `syncMeasured` is false, and the `sync` sentence says sync is not
yet measured on this macOS and to check the recording on another device.

**Measured 2026-11-11**, on a Debug build, through each tool on a throwaway memo. The store was
read about 15 s after each call, and Olivier checked the Mac and the iPhone:

| Call                   | Transaction | History                                           | Exported | Mac and iPhone                      |
| ---------------------- | ----------- | ------------------------------------------------- | -------- | ----------------------------------- |
| rename                 | 154         | the recording: the two title columns              | yes      | both                                |
| unfavourite, favourite | 155, 156    | the recording: `sharedFlags`                      | yes      | both                                |
| move out, move back in | 157, 158    | the recording: `folder`; the folder: `recordings` | yes      | both                                |
| delete, restore        | 159, 160    | the recording: `evictionDate`                     | yes      | both                                |
| rename, app quit       | 161         | the recording: the two title columns              | yes      | the iPhone, before the app reopened |
| rename, with the bit   | 172         | the recording: the two title columns and `flags`  | yes      | the iPhone                          |

"Exported" is `ANSCKRECORDMETADATA.ZLASTEXPORTEDTRANSACTIONNUMBER` reaching the transaction.
With the app quit, `voicememod` was still running and exported 161 within 20 s. Renames 154 and
161 predate the `flags` bit. Rename 172 ran on a fresh memo with the writer that sets it: `flags`
went `516` → `524` and the history mask was `02500000`, the app's own rename's.

**Reading a history column mask.** `ACHANGE.ZCOLUMNS` numbers an entity's to-one relationships,
then its attributes, then its to-many relationships, each group by name, and reads bit 0 as the
high bit of the first byte. For `CloudRecording`, `folder` is `80000000`, the two title columns
`02400000`, `flags` `00100000`, `evictionDate` `00200000` and `sharedFlags` `00001000`;
`Folder.recordings` is `08`. Lane transactions read a null `ZAUTHOR` in SQL, though the history
API returns `cupertino` for them.

**Diagnostics** reports the lane when Cupertino hosts the server: `lanes.writeLane` holds
`compatible`, `modelVersion`, `syncMeasured` and the `refusal` a write would meet, and
`lanes.writes.storeTools` lists the five tools when they are registered.

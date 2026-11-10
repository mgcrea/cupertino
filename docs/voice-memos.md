# Voice Memos: what the probe found

Phase 0 for a `voice-memos` surface. Measured on 2026-11-10, macOS 27.2, with
[`scripts/probe-voice-memos.mjs`](../scripts/probe-voice-memos.mjs), run through `apple_shell_run`
because the agent's own shell holds no Full Disk Access. That library held 87 recordings from
2019 to 2026. The verdict is **GO, file lane only, read-only**.

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

| Column            | What it holds                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZUNIQUEID`       | a UUID, 87/87 distinct: the recording's id                                                                                                      |
| `ZENCRYPTEDTITLE` | **the title, in plaintext** despite its name: 85/87 have spaces and letters, 4–27 chars; equals `ZCUSTOMLABELFORSORTING`                        |
| `ZCUSTOMLABEL`    | 20 chars, no letters: the default date-shaped label, not the title                                                                              |
| `ZDATE`           | Core Data seconds since 2001                                                                                                                    |
| `ZDURATION`       | seconds, float                                                                                                                                  |
| `ZPATH`           | file name relative to `Recordings/`; 86/86 resolve; **one 2019 row has none** and no audio digest                                               |
| `ZFOLDER`         | foreign key to `ZFOLDER.Z_PK`, null when unfiled; `ZFOLDER.ZCOUNTOFRECORDINGS` agrees                                                           |
| `ZEVICTIONDATE`   | **set when a memo goes to Recently Deleted**, to the moment of deletion (measured: 0.00 days from now), not the purge date                      |
| `ZSHAREDFLAGS`    | **bit `0x1` is favourite**: 4 rows set, and the app's Favourites view shows 4. Null or `0` otherwise; `0` on 5 rows, presumably once-favourited |
| `ZFLAGS`          | a bitfield: `4` ×58, `1540` ×8, `4612` ×3, `5636` ×7, `5644` ×10, `0` ×1. Favouriting does **not** touch it; meaning unknown                    |

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

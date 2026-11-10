# Voice Memos surface: design

**Status:** approved in chat 2026-11-10, probe complete. Findings in
[docs/voice-memos.md](../../voice-memos.md); read that first, because every column and box named
below is a measurement from it.

## Why

Voice Memos holds spoken notes: meetings, ideas, interviews. Since 2025 Apple transcribes every
recording on-device and embeds the transcript in the audio file. An agent that can list, read and
search those transcripts can answer "what did I say about X last week" without any transcription
of its own. The current alternative is opening Voice Memos and scrolling.

## Goals

- List, read and search recordings, including Apple's transcript with timings.
- Filter by folder, favourite, date and Recently Deleted.
- Hand a recording's audio to something else (Cadence, a script) by copying it to a confined folder.
- Follow every existing surface convention: `surfaces.json` entry, generated wiring, `diagnostics`,
  tools registered regardless of grant, errors that name the missing permission.

## Non-goals

- **No transcription.** If Apple has no transcript, say so; Cadence transcribes audio.
- **No writes to the store.** No rename, move, favourite, delete or record. The store is
  CloudKit-mirrored and nobody has asked for this. Recording is already `apple_sound_*`. The App
  Intents that could do it (docs/voice-memos.md) stay recorded for a future Shortcuts lane.
- No playback, trimming, or Enhance Recording.
- Audio messages in Messages are out of scope: `apple_messages_save_attachment` covers them.

## Anti-goals

- **Never read the whole of every audio file.** A recording can be hundreds of MB. Only box
  headers and the transcript payload are read; `mdat` is skipped by offset.
- **Never imply there is no transcript when the parser failed.** A file that will not parse returns
  `transcript: { status: "unreadable", reason }`, not `null`.
- **Never let the default label pose as a title.** `ZCUSTOMLABEL` is a date string.

## The surface entry

```jsonc
{
  "id": "voice-memos",
  "displayName": "Voice Memos",
  "kind": "app",
  "npmName": "@mgcrea/mcp-apple-voice-memos",
  "runtime": "node",
  "bundleId": "com.apple.VoiceMemos",
  "usesAppleEvents": false,
  "appleEventsScope": null,
  "supportsWrites": true, // the export tool only, as Messages' save_attachment
  "defaultEnabled": true,
  "storePath": "Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db",
  "storePermission": "full-disk-access",
  "envPrefix": "APPLE_VOICE_MEMOS_",
  "notes": [/* the lane verdict and the two traps, short */],
}
```

No gates beyond `allowWrites`. Then `make surfaces` and review the generated diff.

## Package

`packages/voice-memos`, laid out like `packages/maps` (`client/locate.ts`, `client/store.ts`,
`client/<surface>.ts`, `tools/*`, `config.ts`, `guide.ts`, `prompts.ts`). The new pieces are:

- **`client/store.ts`** reads `ZCLOUDRECORDING` and `ZFOLDER` through `openReadOnly` from
  `@mgcrea/mcp-apple-core` (ro, falling back to immutable, recording which one won). Columns are
  looked up by name with a presence check, so a missing column degrades one field rather than the
  tool. `ZRECORDING` (legacy, empty) is ignored.
- **`client/mp4.ts`** walks box headers with positioned reads, handling the 64-bit size and the
  size-0 (to end) cases. Two rules from the probe: `meta` has a version header in ISO files and
  none in QuickTime ones (peek for `hdlr`), and `.qta` keeps the transcript under the
  `keys`/`ilst` item `com.apple.VoiceMemos.tsrp` instead of a `tsrp` box. Pure functions over a
  read callback, so tests feed buffers.
- **`client/transcript.ts`** decodes the JSON into `{ locale, segments: [{ start, end, text }] }`
  for all three variants: `runs` + `attributeTable`, a flat alternating array, and `""` (status
  `empty`). Measured: `timeRange` is `[start, end]`, and each run carries its own leading
  space, so text is the runs concatenated and trimmed. Segments break at sentence-final
  punctuation, at a gap over 1.0 s, or **after a word wider than 1.0 s**, because a pause is folded
  into the preceding word rather than left as a gap. Segments are capped at about 400 characters.
  The builder may tune those numbers.
- A **transcript cache** keyed by `(path, mtime, size)`, in memory, bounded. Search reads every
  transcript; on the probed library all 86 files' boxes were walked in about 200 ms, so no
  persistent index.

### Field mapping

| Output field    | Source                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `ZUNIQUEID`                                                                                                                                    |
| `title`         | `ZENCRYPTEDTITLE` (plaintext), or **null** when empty or the column is absent                                                                  |
| `label`         | `ZCUSTOMLABEL`, always, as its own field: the date-shaped default label. Not searched. Used for the export file name only when `title` is null |
| `recordedAt`    | `ZDATE`, Core Data seconds, ISO 8601                                                                                                           |
| `duration`      | `ZDURATION`, seconds                                                                                                                           |
| `folder`        | `ZFOLDER` → `ZFOLDER.{ZUUID, ZENCRYPTEDNAME}`; null when unfiled                                                                               |
| `favorite`      | `ZSHAREDFLAGS & 1`                                                                                                                             |
| `deletedAt`     | `ZEVICTIONDATE`, the moment of deletion; non-null means Recently Deleted                                                                       |
| `audio`         | `ZPATH` resolved inside `Recordings/` (confined: a path escaping it is treated as missing); `{ format: "m4a" \| "qta", bytes }` or null        |
| `hasTranscript` | computed from the file, not stored; only on `get` and `search`, since `list` must stay cheap                                                   |

`ZFLAGS`, `ZAUDIOFUTURE*` and `ZPLAYBACK*` are not exposed.

## Schema and macOS versions

The probe ran on macOS 27.2 only. The server decides **by column presence, not by OS version**.
`locate.ts` tries the group container first, then the legacy
`~/Library/Application Support/com.apple.voicememos/Recordings/`. Every column is looked up
before use. If `ZENCRYPTEDTITLE` is absent (older releases are believed to keep the title in
`ZCUSTOMLABEL`), `title` comes from `ZCUSTOMLABEL` when it does not parse as a date. There is
no hard OS floor. `diagnostics` reports the schema fingerprint and says `schemaVerified: false`
when it differs from `fb804d4a4d59`. The README states that only that fingerprint has been
measured. Fixtures for older schemas are out of scope until someone has a Mac to capture them on.

## Tools

All tools are registered whatever the grant, and refuse with the missing permission named.

| Tool                                  | Gate          | Purpose                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apple_voice_memos_diagnostics`       | —             | store facts, open mode, counts, transcript coverage by format                                                                                                                                                                                                       |
| `apple_voice_memos_list_folders`      | —             | folders in `ZRANK` order, with counts; Favourites and Recently Deleted are filters, not folders                                                                                                                                                                     |
| `apple_voice_memos_list_recordings`   | —             | newest first; `folderId`, `favorite`, `since`/`until`, `includeDeleted` (default false), `onlyDeleted`, `limit`/`offset`                                                                                                                                            |
| `apple_voice_memos_get_recording`     | —             | metadata plus transcript as `segments` or `text`; paged with `offset`/`maxChars` because the largest measured transcript is 342 KB of JSON                                                                                                                          |
| `apple_voice_memos_search_recordings` | —             | case- and accent-insensitive match on titles and transcript text; each hit gives the matching segment's `start`, so it can be quoted and found by listening                                                                                                         |
| `apple_voice_memos_save_recording`    | `allowWrites` | copy the audio into `APPLE_VOICE_MEMOS_EXPORT_DIR` (default `~/Downloads`, already one of Cadence's import folders) via `writeConfinedFile`; never overwrites unless asked; keeps the original extension; the file name comes from `title`, else `label`, sanitised |

Recently Deleted memos are excluded everywhere unless asked for, and marked `deletedAt` when they
are included.

## Tests

- The schema fixture `test/fixtures/cloud-recordings.sql` is already captured. Tests insert
  synthetic rows into it.
- **Synthetic audio only.** The test helper builds an M4A with a `tsrp` box and a `.qta` with the
  keyed item, in all three JSON variants, plus a truncated and a corrupt file. No real recording
  goes in the repo.
- `tools.test.ts` checks the registered tool set with `allowWrites` on and off, as every package
  does.
- The CI handshake comes from `make surfaces`.

## Docs and release

README for the package, a row in `docs/surfaces.md`'s state of play, and a CHANGELOG entry.
**No website card in this work.** `apps/website/src/data/surfaces.ts` treats a listing as a
commercial promise and wants a read/write surface first. The site also deploys on every push to
main, so a card would go live at merge, before the release.

**One check against real data during implementation:** export one `.qta` and one `.m4a`, and
confirm that Cadence imports and transcribes both (`cadence_add_files` from `~/Downloads`).
Every read of the real library goes through `apple_shell_run` or the installed bridge, both of
which Olivier approves, so batch those checks. `docs/voice-memos.md` stays the
findings record.

## Left to the builder

Segment-break thresholds; the exact `maxChars` default; error wording; the shape of `diagnostics`
beyond the facts listed; whether `search` returns more than one hit per recording.

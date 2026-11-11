# @mgcrea/mcp-apple-voice-memos

MCP server for the macOS **Voice Memos** app: your recordings, and the transcript Apple made of
each one.

```json
{
  "mcpServers": {
    "apple-voice-memos": { "command": "npx", "args": ["-y", "@mgcrea/mcp-apple-voice-memos"] }
  }
}
```

## What it reads

Recordings with their titles, dates, durations, folders, favourites and Recently Deleted, from
Voice Memos' Core Data store. And **Apple's own transcript**, which macOS makes on-device and
embeds in the audio file, with a start and end time for every segment.

| Tool                                  | What                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `apple_voice_memos_list_folders`      | the folders, in sidebar order                                      |
| `apple_voice_memos_list_recordings`   | newest first; by folder, favourite, date, or Recently Deleted      |
| `apple_voice_memos_get_recording`     | one recording and its transcript, as text or timed segments, paged |
| `apple_voice_memos_search_recordings` | titles and transcripts, ignoring case and accents, with the moment |
| `apple_voice_memos_diagnostics`       | what opened, the schema, counts, and transcript coverage by format |

## What it writes

Only with `APPLE_VOICE_MEMOS_ALLOW_WRITES=1`. Every write tool is unregistered rather than refused
when it is off.

| Tool                               | What                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| `apple_voice_memos_save_recording` | copy a recording's audio into `APPLE_VOICE_MEMOS_EXPORT_DIR` |

The default folder is `~/Downloads`, one Cadence can import from, so a recording Apple never
transcribed can be handed to it. A file is never overwritten unless asked.

Five more change the library itself, and are registered only when Cupertino.app hosts this
server: the app makes the save, so a package run from npm has no way to reach them and is never
told they exist. Switching Voice Memos' writes off in Cupertino while a session runs does not take
them away: until the server restarts they stay listed, and each call is refused with reason
`writesOff`.

| Tool                                  | What                                         |
| ------------------------------------- | -------------------------------------------- |
| `apple_voice_memos_rename_recording`  | set a recording's title                      |
| `apple_voice_memos_move_recording`    | file a recording in a folder, or in none     |
| `apple_voice_memos_set_favorite`      | mark a recording as a favourite, or clear it |
| `apple_voice_memos_delete_recording`  | move a recording to Recently Deleted         |
| `apple_voice_memos_restore_recording` | bring a recording back from Recently Deleted |

Cupertino saves each one through Core Data with Voice Memos' own model, so iCloud uploads it like
a change made in the app, even with Voice Memos closed: its background service uploads it.
Sync was measured on macOS 27.2 (model `VoiceMemos14`) on a Mac and an iPhone. On another
model version the save still happens, and the result says sync is not yet measured there. A title
is trimmed, then must be 1 to 500 characters with no line break inside. A call that would change
nothing saves nothing and returns `changed: []`.

## What it does not do

It does not transcribe: recordings from before 2025 have no transcript (Apple did not backfill),
and this server says so rather than making one. It cannot record or play a memo, or create a
folder. Voice Memos ships no scripting dictionary, and its App Intents can only be run from
Shortcuts. This server never writes Voice Memos' store itself: the five tools above ask
Cupertino.app to make the save.

## Full Disk Access is mandatory

Without the grant the store's directory is unreadable, and this server returns an **error**,
never an empty list. Grant it to the app running the server, not to Voice Memos.

## Configuration

| Variable                           | Default       | What                                               |
| ---------------------------------- | ------------- | -------------------------------------------------- |
| `APPLE_VOICE_MEMOS_STORE`          | discovered    | explicit store path, for tests and forensic copies |
| `APPLE_VOICE_MEMOS_INDEX_MODE`     | `auto`        | `auto` / `ro` / `immutable` / `off`                |
| `APPLE_VOICE_MEMOS_EXPORT_DIR`     | `~/Downloads` | where `save_recording` writes                      |
| `APPLE_VOICE_MEMOS_EXPOSE_PROMPTS` | on            | register the `cupertino://voice-memos/*` resources |
| `APPLE_VOICE_MEMOS_DEBUG`          | off           | verbose logging on stderr                          |

Only one schema has been measured: fingerprint `fb804d4a4d59`, on macOS 27.2. Other versions
are read by which columns exist, and `diagnostics` reports `schema.verified: false` for them.
See [docs/voice-memos.md](../../docs/voice-memos.md) for the phase-0 measurements and what each
write changes.

## Licence

[MIT](LICENSE).

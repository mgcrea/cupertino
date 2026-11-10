/**
 * The Voice Memos operating manual, served as `cupertino://voice-memos/guide`. Static by
 * design, so it reads on a server with no permission at all.
 */
export const VOICE_MEMOS_GUIDE = `# Voice Memos: how to drive this server

## What this surface is, and is not

It reads the recordings in Voice Memos on this Mac: their titles, dates, durations, folders,
favourites and Recently Deleted, and the **transcript Apple made of each one**, with timings.
It does **not** transcribe: when Apple has no transcript, say so; Cadence transcribes audio.
It cannot record or play a memo, or create a folder. With writes allowed it can copy a
recording's audio, and, only when Cupertino hosts this server, rename, move, favourite, delete
and restore a recording (see "Writing" below).

## One read lane, and no fallback

Voice Memos ships no scripting dictionary, and its App Intents can only be run from Shortcuts.
Every read comes from \`CloudRecordings.db\` and the audio files beside it, under **Full Disk
Access**. Without the grant this server returns an **error**, not an empty list. Check
\`cupertino://voice-memos/diagnostics\` before concluding anything from an empty answer.

## Writing

\`apple_voice_memos_save_recording\` copies a recording's audio into the export folder. It
changes nothing in Voice Memos.

Five tools change the library itself. **They exist only when Cupertino hosts this server with
writes on**; run from npm, this server does not have them. Cupertino.app saves each one through
Core Data with Voice Memos' own model, so iCloud uploads it like a change made in the app.

| Tool | What it does |
| --- | --- |
| \`apple_voice_memos_rename_recording\` | sets the title |
| \`apple_voice_memos_move_recording\` | files the recording in a folder, or in none with \`folderId: null\` |
| \`apple_voice_memos_set_favorite\` | marks it a favourite, or clears it |
| \`apple_voice_memos_delete_recording\` | moves it to Recently Deleted, where Voice Memos removes it for good later |
| \`apple_voice_memos_restore_recording\` | brings it back from Recently Deleted |

**A title is trimmed, then must be 1 to 500 characters with no line break inside.** Anything
else is refused with reason \`invalid\`. Pass the id the read tools return; a folder id comes
from \`list_folders\`.

**A write syncs when Voice Memos next runs.** Nothing is launched to make it happen, so say the
change is saved on this Mac and will reach other devices once Voice Memos runs, not that it is
already on the iPhone. When the result's \`syncMeasured\` is false, the save still happened but
sync is not yet measured on this macOS: pass on its \`sync\` sentence, which asks to check the
recording on another device.

**\`changed: []\` means nothing needed changing**, for instance a favourite already set, and
nothing was saved.

## Which tool answers which question

| Question | Tool |
| --- | --- |
| What folders are there? | \`apple_voice_memos_list_folders\` |
| What did I record, recently, in a folder, or as a favourite? | \`apple_voice_memos_list_recordings\` |
| What did I say in one recording? | \`apple_voice_memos_get_recording\` |
| Where did I talk about X? | \`apple_voice_memos_search_recordings\` |
| Hand the audio to Cadence or a script | \`apple_voice_memos_save_recording\` (writes allowed only) |

Favourites and Recently Deleted are filters on \`list_recordings\`, not folders.

## Things not to say

**No transcript is not silence.** Apple transcribes on-device and embeds the transcript in the
audio file, and recordings from before 2025 were never transcribed. A transcript status of
\`none\` means Apple has not transcribed it; \`empty\` means it did and heard nothing;
\`unreadable\` means the file would not parse, and is not evidence of either; \`no-audio\` means
the recording has no file on this Mac. A search with no hits says, in \`transcriptsNotSearched\`, how
many recordings it could not search: report that, not that the words were never said.

**\`label\` is not a title.** A memo that was never named has \`title: null\`, and \`label\` is the
date-shaped default Voice Memos shows in its place. Do not present the label as what the memo
is called.

**Segment times are where to listen.** Each segment carries \`start\` and \`end\` in seconds
from the beginning of the recording, so a quote can be found again by ear.

**A long transcript comes in pages.** When \`nextOffset\` is present, call again with it. Never
summarise a transcript you have only read the first page of as if it were the whole.

**Recently Deleted is hidden unless asked for.** A recording there has \`deletedAt\` set to when
it was deleted. When it will be purged is not in the store.

## Privacy, worth holding in mind

Voice memos are meetings, interviews, notes to self, sometimes other people's voices. Quote
what answers the question, not the whole transcript.
`;

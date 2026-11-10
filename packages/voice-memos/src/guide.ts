/**
 * The Voice Memos operating manual, served as `cupertino://voice-memos/guide`. Static by
 * design, so it reads on a server with no permission at all.
 */
export const VOICE_MEMOS_GUIDE = `# Voice Memos: how to drive this server

## What this surface is, and is not

It reads the recordings in Voice Memos on this Mac: their titles, dates, durations, folders,
favourites and Recently Deleted, and the **transcript Apple made of each one**, with timings.
It does **not** transcribe: when Apple has no transcript, say so; Cadence transcribes audio.
It cannot rename, move, favourite or delete a memo, and it cannot record or play one. The only
thing it writes, and only with writes allowed, is a copy of a recording's audio.

## One lane, and no fallback

Voice Memos ships no scripting dictionary, and its App Intents can only be run from Shortcuts.
Everything comes from \`CloudRecordings.db\` and the audio files beside it, under **Full Disk
Access**. Without the grant this server returns an **error**, not an empty list. Check
\`cupertino://voice-memos/diagnostics\` before concluding anything from an empty answer.

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
the recording has no file on this Mac.

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

/** The tools registered only when `allowWrites` is on, named once so diagnostics cannot drift. */
export const WRITE_TOOLS: readonly string[] = ["apple_voice_memos_save_recording"];

/**
 * The tools registered only when writes are on AND Cupertino hosts this server, because the
 * app saves them through Voice Memos' own data model. A package run from npm never has them.
 */
export const STORE_WRITE_TOOLS: readonly string[] = [
  "apple_voice_memos_rename_recording",
  "apple_voice_memos_move_recording",
  "apple_voice_memos_set_favorite",
  "apple_voice_memos_delete_recording",
  "apple_voice_memos_restore_recording",
];

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { LaneWrite, VoiceMemosLane } from "../client/lane.js";
import { idArg } from "./recordings.js";
import { wrap } from "./util.js";

/**
 * What a write promises about iCloud, in one sentence.
 *
 * Sync is promised only on a model version whose upload was measured. Elsewhere the save still
 * happened, but nobody has watched it reach another device, so the result says so.
 */
export const syncSentence = (w: LaneWrite): string => {
  if (w.changed.length === 0) return "Nothing to change.";
  if (w.syncMeasured) {
    return (
      "Saved the way Voice Memos saves it. It reaches your other devices through iCloud, " +
      "once Voice Memos is running."
    );
  }
  return (
    `Saved, but sync is not yet measured on this macOS (model ${w.modelVersion ?? "unknown"}): ` +
    "check the recording on another device."
  );
};

/** The lane's answer, plus the sync sentence. A lane error reaches `toFailure` untouched. */
const report = (write: () => Promise<LaneWrite>) =>
  wrap(async () => {
    const w = await write();
    return { ...w, sync: syncSentence(w) };
  });

/** Every lane tool says this after what it does. */
const savedLike = (what: string): string =>
  "Saved through Voice Memos' own data model inside Cupertino, so Voice Memos uploads it to " +
  `iCloud like ${what} made in the app; it syncs when Voice Memos next runs. Only available ` +
  "when Cupertino hosts this server.";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;

/** Rename, move and favourite say this: the app offers none of them in Recently Deleted. */
const NOT_DELETED =
  "A recording in Recently Deleted is refused with reason invalid: restore it first.";

/**
 * The store lane's tools. Registered only when writes are on and Cupertino hosts this server;
 * see `tools/index.ts`. The app validates every argument and answers with a `reason` on
 * refusal (`invalid`, `notFound`, `incompatible`, `writesOff`, `failed`, or one of the
 * connection's own), which the tool error carries in `details.reason`.
 */
export const registerStoreWriteTools = (server: McpServer, lane: VoiceMemosLane): void => {
  server.registerTool(
    "apple_voice_memos_rename_recording",
    {
      description:
        "Rename one recording. Saved through Voice Memos' own data model inside Cupertino, so " +
        "Voice Memos uploads it to iCloud like a rename made in the app; it syncs when Voice " +
        "Memos next runs. Only available when Cupertino hosts this server. Changes the title " +
        "and nothing else.",
      inputSchema: z.object({
        id: idArg.describe(`${idArg.description ?? "The recording's id."} ${NOT_DELETED}`),
        title: z
          .string()
          .describe(
            "The new title. Trimmed, then 1 to 500 characters, with no line break inside; " +
              "Cupertino refuses anything else with reason invalid.",
          ),
      }),
      annotations: WRITE,
    },
    async ({ id, title }) => report(() => lane.rename(id, title)),
  );

  server.registerTool(
    "apple_voice_memos_move_recording",
    {
      description:
        "Move one recording into a folder, or out of every folder with folderId null. " +
        `${savedLike("a move")} Changes the folder and nothing else. ${NOT_DELETED}`,
      inputSchema: z.object({
        id: idArg,
        folderId: z
          .string()
          .min(1)
          .nullable()
          .describe(
            "The folder's id, as list_folders returns it, or null to take the recording out " +
              "of every folder.",
          ),
      }),
      annotations: WRITE,
    },
    async ({ id, folderId }) => report(() => lane.move(id, folderId)),
  );

  server.registerTool(
    "apple_voice_memos_set_favorite",
    {
      description:
        "Mark one recording as a favourite, or clear it. " +
        `${savedLike("a favourite set")} Changes the favourite and nothing else. ${NOT_DELETED}`,
      inputSchema: z.object({
        id: idArg,
        favorite: z.boolean().describe("True to mark it a favourite, false to clear it."),
      }),
      annotations: WRITE,
    },
    async ({ id, favorite }) => report(() => lane.setFavorite(id, favorite)),
  );

  server.registerTool(
    "apple_voice_memos_delete_recording",
    {
      description:
        "Move one recording to Recently Deleted, where Voice Memos removes it for good after " +
        "its own retention period; restore_recording brings it back until then. " +
        savedLike("a deletion"),
      inputSchema: z.object({ id: idArg }),
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ id }) => report(() => lane.delete(id)),
  );

  server.registerTool(
    "apple_voice_memos_restore_recording",
    {
      description:
        "Bring one recording back from Recently Deleted, before Voice Memos removes it for " +
        `good. ${savedLike("a recovery")}`,
      inputSchema: z.object({ id: idArg }),
      annotations: WRITE,
    },
    async ({ id }) => report(() => lane.restore(id)),
  );
};

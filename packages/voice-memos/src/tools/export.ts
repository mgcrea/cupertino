import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { VoiceMemosClient } from "../client/voice-memos.js";
import { idArg } from "./recordings.js";
import { wrap } from "./util.js";

export const registerExportTools = (server: McpServer, client: VoiceMemosClient): void => {
  server.registerTool(
    "apple_voice_memos_save_recording",
    {
      description:
        "Copy one recording's audio file, byte for byte, into the export folder " +
        `(APPLE_VOICE_MEMOS_EXPORT_DIR, now ${client.config.exportDir}), or a subfolder of ` +
        "it, and return the path. The name comes from the title, else the default label, with " +
        "the original extension (.m4a or .qta). It never overwrites an existing file unless " +
        "overwrite is true, and refuses any destination outside the export folder. Write-gated " +
        "because it creates a file; Voice Memos itself is not touched. The default folder, " +
        "~/Downloads, is one Cadence imports from, so this is how a recording Apple never " +
        "transcribed reaches a transcriber.",
      inputSchema: z.object({
        id: idArg,
        directory: z
          .string()
          .min(1)
          .optional()
          .describe("A subfolder of the export folder. Created if missing."),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace a file of the same name. Default false."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, ...o }) => wrap(async () => client.saveRecording(id, o)),
  );
};

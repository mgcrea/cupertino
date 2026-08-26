import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMessagesClient } from "../client/messages.js";
import { wrap } from "./util.js";

/**
 * Saving an attachment out of a conversation.
 *
 * ## Why this is not in `actions.ts`
 *
 * That file's argument is that Messages' scripting dictionary has exactly one
 * usable verb, so this server has exactly one mutating tool — and that with
 * writes off it sends no Apple Event at all. Both remain true with this tool
 * registered: it opens a file and writes a file, and never speaks to
 * Messages.app. Filing it next to `send` would quietly weaken a claim
 * `diagnostics` makes about what the write gate buys.
 *
 * ## Why it is behind the write gate anyway
 *
 * It puts a file on the user's disk. Mail and Notes made the same call for the
 * same reason, and the three should not disagree about it: a user who has not
 * turned writes on has not agreed to this server creating files.
 */
export const registerAttachmentTools = (server: McpServer, client: AppleMessagesClient): void => {
  server.registerTool(
    "apple_messages_save_attachment",
    {
      description:
        "Save one attachment from a conversation to disk — a photo, a video, a PDF, a voice " +
        "memo. Take the `id` from an attachment on apple_messages_get_message. Needs Full Disk " +
        "Access, like every read here. It can only write into APPLE_MESSAGES_ATTACHMENT_DIR " +
        "(default ~/Downloads) and will not overwrite an existing file unless you ask it to. " +
        "Write-gated because it puts a file on the user's disk, even though it changes nothing " +
        "in Messages. An attachment iCloud has offloaded has no bytes on this Mac and is " +
        "refused with that reason — open the conversation in Messages to pull it down first.",
      inputSchema: {
        attachmentId: z
          .string()
          .min(1)
          .describe(
            "The `id` of an attachment from apple_messages_get_message. Opaque; do not " +
              "construct one, and do not pass the file path shown next to it.",
          ),
        directory: z
          .string()
          .optional()
          .describe("Override the target directory. Must still resolve inside the configured one."),
        overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ attachmentId, directory, overwrite }) =>
      wrap(async () =>
        client.saveAttachment(attachmentId, {
          ...(directory ? { directory } : {}),
          ...(overwrite ? { overwrite } : {}),
        }),
      ),
  );
};

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleNotesClient } from "../client/notes.js";
import { folderArg, limitArg, noteRefArg, ok, okText, wrap, wrapResult } from "./util.js";

export const registerNoteTools = (server: McpServer, client: AppleNotesClient): void => {
  server.registerTool(
    "apple_notes_list_notes",
    {
      description:
        "List notes, newest first. Returns a `ref` per note for the read and action tools. " +
        "Prefers Notes' own index, which stays fast as a library grows.",
      inputSchema: {
        folder: folderArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, limit }) =>
      wrap(() =>
        client.listNotes({ folder, limit: limit ?? Math.min(25, client.config.maxResults) }),
      ),
  );

  server.registerTool(
    "apple_notes_search_notes",
    {
      description:
        'Search notes. `scope: "full"` (the default) matches the body text; `scope: "title"` ' +
        "matches only titles and previews and is the cheaper query. Returns a `ref` per hit.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for. Case-insensitive substring match."),
        scope: z
          .enum(["full", "title"])
          .optional()
          .describe(
            "full = search body text (default). title = titles and previews only, which is a " +
              "single indexed query and cheaper on a large library.",
          ),
        limit: limitArg,
        offset: z.number().int().min(0).optional().describe("Skip this many results, for paging."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, scope, limit, offset }) =>
      wrap(() =>
        client.searchNotes({
          query,
          scope: scope ?? "full",
          limit: limit ?? Math.min(25, client.config.maxResults),
          offset: offset ?? 0,
        }),
      ),
  );

  server.registerTool(
    "apple_notes_get_note",
    {
      description:
        "Read one note's full text by ref. Password-protected notes report as locked rather " +
        "than returning an empty body — their text is encrypted at rest.",
      inputSchema: {
        ref: noteRefArg,
        format: z
          .enum(["text", "json"])
          .optional()
          .describe("text returns the body as-is (default). json wraps it with the metadata."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, format }) =>
      wrapResult(async () => {
        const result = await client.getNote(ref);
        if ((format ?? "text") === "text" && result.body !== null) return okText(result.body);
        return ok(result);
      }),
  );

  server.registerTool(
    "apple_notes_list_attachments",
    {
      description:
        "List a note's attachments. Metadata only — retrieving the bytes needs Full Disk " +
        "Access, because the scripting dictionary carries no file path.",
      inputSchema: { ref: noteRefArg },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) => wrap(() => client.attachments(ref)),
  );

  server.registerTool(
    "apple_notes_save_attachment",
    {
      description:
        "Save one attachment to disk. Needs Full Disk Access. Writes only into the configured " +
        "attachment directory (APPLE_NOTES_ATTACHMENT_DIR, default ~/Downloads).",
      inputSchema: {
        ref: noteRefArg,
        attachmentId: z.string().min(1).describe("An id from apple_notes_list_attachments."),
        directory: z
          .string()
          .optional()
          .describe("Override the target directory. Must still resolve inside it."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, attachmentId, directory }) =>
      wrap(() => client.saveAttachment(ref, attachmentId, directory)),
  );
};

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleNotesClient } from "../client/notes.js";
import { confirmArg, folderIdArg, noteRefArg, noteRefsArg, wrap } from "./util.js";

/**
 * The mutating tools.
 *
 * Registered only when writes are enabled, so with the flag off they are
 * invisible to the model rather than merely refused.
 */
export const registerActionTools = (server: McpServer, client: AppleNotesClient): void => {
  server.registerTool(
    "apple_notes_create_note",
    {
      description:
        "Create a note. Notes takes its title from the first line of the body, so `title` is " +
        "prepended as a heading rather than set as a property.",
      inputSchema: {
        title: z.string().optional().describe("Becomes the first line, and therefore the title."),
        body: z.string().optional().describe("Body content. Simple HTML is accepted."),
        folderId: z
          .string()
          .optional()
          .describe("Target folder id. Defaults to the first account's default folder."),
      },
    },
    async ({ title, body, folderId }) => wrap(() => client.createNote({ title, body, folderId })),
  );

  server.registerTool(
    "apple_notes_update_note",
    {
      description:
        "Replace or append to a note's body. Editing the first line changes the title, because " +
        "that is where Notes takes it from.",
      inputSchema: {
        ref: noteRefArg,
        body: z.string().min(1).describe("The new content. Simple HTML is accepted."),
        mode: z
          .enum(["replace", "append"])
          .optional()
          .describe("replace overwrites the body (default). append adds to the end."),
      },
    },
    async ({ ref, body, mode }) => wrap(() => client.updateNote(ref, body, mode ?? "replace")),
  );

  server.registerTool(
    "apple_notes_add_attachment",
    {
      description:
        "Attach a file to a note. This is the only way to put an image in a note — an <img> tag " +
        "in the body creates an attachment whose bytes are never loaded.",
      inputSchema: {
        ref: noteRefArg,
        path: z
          .string()
          .min(1)
          .describe("Absolute path to the file to attach. It is read by Notes, not copied here."),
      },
    },
    async ({ ref, path }) => wrap(() => client.addAttachment(ref, path)),
  );

  server.registerTool(
    "apple_notes_move_note",
    {
      description: "Move a note to another folder.",
      inputSchema: { ref: noteRefArg, folderId: folderIdArg },
    },
    async ({ ref, folderId }) => wrap(() => client.moveNote(ref, folderId)),
  );

  server.registerTool(
    "apple_notes_delete_notes",
    {
      description:
        "Delete notes. They go to Recently Deleted rather than being destroyed, but this still " +
        "requires an explicit confirm.",
      inputSchema: { refs: noteRefsArg, confirm: confirmArg },
    },
    async ({ refs }) => wrap(() => client.deleteNotes(refs)),
  );
};

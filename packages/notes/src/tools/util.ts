import { z } from "zod";

/**
 * Notes' tool helpers. The generic half lives in `@mgcrea/mcp-apple-core`;
 * re-exported here so tools import from one place.
 */
export {
  compact,
  confirmArg,
  fail,
  limitArg,
  ok,
  okText,
  toFailure,
  wrap,
  wrapResult,
  type ToolResult,
} from "@mgcrea/mcp-apple-core";

// ─── Notes' own args ─────────────────────────────────────────────────────────

export const noteRefArg = z
  .string()
  .min(1)
  .describe(
    'An opaque note ref from a search or list result (looks like "n1:x-coredata://…/ICNote/p123"). ' +
      "Do not construct one by hand.",
  );

export const noteRefsArg = z
  .array(z.string().min(1))
  .min(1)
  .max(200)
  .describe("Note refs from a search or list result.");

export const folderArg = z
  .string()
  .optional()
  .describe('Folder name, e.g. "Notes" or "Projects". Folders nest; give the leaf name.');

export const folderIdArg = z.string().min(1).describe("A folder id from apple_notes_list_folders.");

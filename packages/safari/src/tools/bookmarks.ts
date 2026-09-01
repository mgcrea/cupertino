import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { compact, limitArg, ok, resolveLimit, wrapResult } from "./util.js";

/**
 * Bookmarks and the Reading List.
 *
 * Two tools rather than one flag, because they are two different questions.
 * "What have I bookmarked about X" is a search over a filing system; "what have
 * I saved to read and not read yet" is a queue with a state. Collapsing them
 * would put the unread filter on a tool where it means nothing for most rows.
 */
export const registerBookmarkTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_list_bookmarks",
    {
      description:
        "List Safari bookmarks, with the folder each one sits in. Needs Full Disk Access. Reads " +
        "the bookmarks file directly and does NOT require Safari to be running. Reading List " +
        "entries are excluded — use apple_safari_list_reading_list for those.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring match against the title, the URL and the folder."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit }) =>
      wrapResult(async () => {
        const result = await client.bookmarks({ readingListOnly: false });
        const needle = query?.toLowerCase();
        const rows = result.bookmarks
          .filter((b) => !b.readingList)
          .filter(
            (b) =>
              !needle ||
              b.title?.toLowerCase().includes(needle) ||
              b.url.toLowerCase().includes(needle) ||
              b.folder?.toLowerCase().includes(needle),
          );
        const capped = rows.slice(0, resolveLimit(limit, client.config.maxResults));
        return ok(
          compact({
            bookmarks: capped,
            count: capped.length,
            folders: result.folders,
            truncated: capped.length < rows.length ? `${rows.length} matched.` : undefined,
            depthTruncated: result.depthTruncated
              ? "The bookmark tree was deeper than this walk goes; some entries were not read."
              : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "apple_safari_list_reading_list",
    {
      description:
        "List Safari's Reading List — pages saved to read later. Needs Full Disk Access; does " +
        "NOT require Safari to be running. Unread state is derived from whether the entry has " +
        "ever been opened: there is no read/unread flag in Safari's data, only the presence or " +
        "absence of a last-viewed date. Entries may carry a short preview of the page text.",
      inputSchema: {
        unreadOnly: z.boolean().optional().describe("Only entries that have never been opened."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ unreadOnly, limit }) =>
      wrapResult(async () => {
        const result = await client.bookmarks({ readingListOnly: true });
        const rows = unreadOnly
          ? result.bookmarks.filter((b) => b.unread === true)
          : result.bookmarks;
        const capped = rows.slice(0, resolveLimit(limit, client.config.maxResults));
        return ok(
          compact({
            readingList: capped,
            count: capped.length,
            unread: result.bookmarks.filter((b) => b.unread === true).length,
            total: result.bookmarks.length,
            truncated: capped.length < rows.length ? `${rows.length} matched.` : undefined,
          }),
        );
      }),
  );
};

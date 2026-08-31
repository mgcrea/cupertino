import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleSafariClient } from "../client/safari.js";
import { registerBookmarkTools } from "./bookmarks.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerHistoryTools } from "./history.js";
import { registerPageTools } from "./pages.js";
import { registerTabTools } from "./tabs.js";
import { registerWriteTools } from "./writes.js";

export type ToolContext = {
  /**
   * Gates the two tools that change something outside this process.
   *
   * Both are Apple Events — `open_url` and `add_reading_list_item` — so with
   * writes off this server sends an Apple Event for exactly one thing, reading
   * live tabs, and changes nothing anywhere. Neither tool needs Full Disk
   * Access, which makes this the one surface where the write lane can work on a
   * machine whose read lane cannot.
   *
   * What the flag does NOT gate, because it does not exist: anything that acts
   * inside a page. See `writes.ts`.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Safari tools.
 *
 * The registered set does NOT vary with which lane is working. That is a
 * runtime condition and MCP clients cache the tool list, so a tool list that
 * shrank when Full Disk Access was missing would stay shrunk after it was
 * granted. `apple_safari_list_tabs` is registered on a machine with no
 * Automation grant, and the history tools are registered on one with no Full
 * Disk Access; each fails with an error that says which permission is missing.
 */
export const registerTools = (
  server: McpServer,
  client: AppleSafariClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerHistoryTools(server, client);
  registerTabTools(server, client);
  registerPageTools(server, client);
  registerBookmarkTools(server, client);
  if (!ctx.allowWrites) return;
  registerWriteTools(server, client);
};

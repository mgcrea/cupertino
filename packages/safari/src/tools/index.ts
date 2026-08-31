import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleSafariClient } from "../client/safari.js";
import { registerBookmarkTools } from "./bookmarks.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerHistoryTools } from "./history.js";
import { registerPageTools } from "./pages.js";
import { registerTabTools } from "./tabs.js";

export type ToolContext = {
  /**
   * Accepted and deliberately unused.
   *
   * v1 registers no mutating tool, so there is nothing for the flag to gate.
   * The shape is kept so this surface matches the others and so a write path
   * has an obvious place to hang itself. `tools.test.ts` asserts the tool list
   * is IDENTICAL with writes on and off, which is what stops one being added
   * here without that decision being taken deliberately.
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
  _ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerHistoryTools(server, client);
  registerTabTools(server, client);
  registerPageTools(server, client);
  registerBookmarkTools(server, client);
};

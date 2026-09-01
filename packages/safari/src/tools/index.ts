import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleSafariClient } from "../client/safari.js";
import { registerActionTools, registerElementTools } from "./actions.js";
import { registerBookmarkTools } from "./bookmarks.js";
import { registerCodeTools } from "./codes.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerHistoryTools } from "./history.js";
import { registerPageTools } from "./pages.js";
import { registerTabTools } from "./tabs.js";
import { registerWriteTools } from "./writes.js";

export type ToolContext = {
  /**
   * Gates the five tools that change something outside this process, across two
   * lanes that have nothing in common but this flag.
   *
   * `open_url` and `add_reading_list_item` are Apple Events, so with writes off
   * this server sends an Apple Event for exactly one thing — reading live tabs —
   * and changes nothing anywhere.
   *
   * `click`, `fill` and `scroll` act INSIDE a page and send no Apple Event at
   * all. They reach the page through the Safari extension, which Safari
   * consents to one website at a time, so their real gate is a per-site grant
   * the user can see and revoke; this flag is the second lock rather than the
   * only one.
   *
   * `page_elements` is NOT gated: it changes nothing, and asking what is on a
   * page is the class of act this surface already performs when it reads one.
   * What IS withheld from it is a field's contents — always for a credential,
   * and for a one-time code unless `allowCodes` says otherwise.
   */
  allowWrites: boolean;
  /**
   * Reading a one-time 2FA code, across the two places one can be.
   *
   * Registers `find_codes` for a code the page renders as TEXT, and separately
   * lets `page_elements` return the value of a one-time-code FIELD. A password
   * or a card number is withheld either way; this flag is named for codes and
   * does not widen past them.
   *
   * Not folded into `allowWrites`, for the reason Messages gives: that flag
   * means "may change something", and reaching a read through it would mean
   * granting the right to click a button in order to see a number.
   */
  allowCodes: boolean;
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
  registerElementTools(server, client);
  if (ctx.allowCodes) registerCodeTools(server, client);
  if (!ctx.allowWrites) return;
  registerWriteTools(server, client);
  registerActionTools(server, client);
};

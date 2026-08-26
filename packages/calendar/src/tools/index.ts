import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleCalendarClient } from "../client/calendar.js";
import { registerActionTools } from "./actions.js";
import { registerAvailabilityTools } from "./availability.js";
import { registerCalendarTools } from "./calendars.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerEventTools } from "./events.js";

export type ToolContext = {
  /**
   * Register the mutating tools too. Off by default — with the flag off they are
   * not merely refused, they are invisible and cannot be called at all.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Calendar tools.
 *
 * The registered set is a pure function of `allowWrites` and nothing else. In
 * particular it does NOT vary with whether Full Disk Access is granted: that is
 * a runtime condition which can change while the process lives, and MCP clients
 * cache the tool list, so a tool that appears and disappears would leave clients
 * calling names the server no longer has. Tools that need the store instead
 * report their source, or explain what is missing.
 *
 * Writes go through Apple Events, always. Not a preference: `PRAGMA query_only`
 * is set on the store because Calendar owns it, holds it open and reconciles it
 * against a server, so writing to it would corrupt sync state.
 */
export const registerTools = (
  server: McpServer,
  client: AppleCalendarClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client, ctx);
  registerCalendarTools(server, client);
  registerEventTools(server, client);
  registerAvailabilityTools(server, client);

  if (!ctx.allowWrites) return;
  registerActionTools(server, client);
};

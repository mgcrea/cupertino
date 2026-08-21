import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleCalendarClient } from "../client/calendar.js";
import { registerDiagnosticsTools } from "./diagnostics.js";

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
 * Only diagnostics exists so far. The read tools are gated on the recurrence
 * measurement (`scripts/probe-calendar.mjs`), and the write tools on the JXA
 * lane that follows it.
 */
export const registerTools = (
  server: McpServer,
  client: AppleCalendarClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client, ctx);

  if (!ctx.allowWrites) return;
  // Write tools land here, behind this same gate.
};

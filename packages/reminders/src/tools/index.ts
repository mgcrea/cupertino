import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleRemindersClient } from "../client/reminders.js";
import { registerAccountTools } from "./accounts.js";
import { registerActionTools } from "./actions.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerReminderTools } from "./reminders.js";

export type ToolContext = {
  /**
   * Register the mutating tools too. Off by default — with the flag off they are
   * not merely refused, they are invisible and cannot be called at all.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Reminders tools.
 *
 * The registered set is a pure function of `allowWrites` and nothing else. In
 * particular it does NOT vary with whether Full Disk Access is granted: that is
 * a runtime condition which can change while the process lives, and MCP clients
 * cache the tool list, so a tool that appears and disappears would leave clients
 * calling names the server no longer has. Tools that need the index instead
 * report their source, or explain what is missing.
 */
export const registerTools = (
  server: McpServer,
  client: AppleRemindersClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client, ctx);
  registerAccountTools(server, client);
  registerReminderTools(server, client);

  if (!ctx.allowWrites) return;
  registerActionTools(server, client);
};

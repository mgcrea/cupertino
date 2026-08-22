import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMessagesClient } from "../client/messages.js";
import { registerChatTools } from "./chats.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerMessageTools } from "./messages.js";

export type ToolContext = {
  /**
   * Accepted and deliberately unused.
   *
   * v1 registers no mutating tool, so there is nothing for the flag to gate. The
   * shape is kept so this surface matches the others and so a send path has an
   * obvious place to hang itself. `tools.test.ts` asserts the tool list is
   * IDENTICAL with writes on and off, which is what stops one being added here
   * without that decision being taken deliberately.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Messages tools.
 *
 * All read-only, which on this surface is a permission claim too: with no Apple
 * Events lane at all, this server never asks for an Automation grant. What it
 * does need is Full Disk Access, and it needs it absolutely — see `diagnostics`.
 *
 * The registered set does NOT vary with whether the store is readable. That is a
 * runtime condition, and MCP clients cache the tool list.
 */
export const registerTools = (
  server: McpServer,
  client: AppleMessagesClient,
  _ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerChatTools(server, client);
  registerMessageTools(server, client);
};

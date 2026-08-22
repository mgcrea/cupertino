import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMessagesClient } from "../client/messages.js";
import { registerActionTools } from "./actions.js";
import { registerChatTools } from "./chats.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerMessageTools } from "./messages.js";

export type ToolContext = {
  /**
   * Gates the one mutating tool, `send_message`.
   *
   * It also gates every Apple Event this server can send, because sending is the
   * only thing Apple Events can do here — there is no read lane to fall back to
   * and never can be. So with writes off this server is not merely read-only, it
   * is inert with respect to Messages.app: it opens a file and nothing else.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Messages tools.
 *
 * Five reads, always. One write, only when `allowWrites` is on — and on this
 * surface the flag carries a permission claim as well as a safety one: with it
 * off no Apple Event is ever sent, so no Automation grant is ever requested.
 * What is needed either way is Full Disk Access, absolutely — see `diagnostics`.
 *
 * The registered set does NOT vary with whether the store is readable. That is a
 * runtime condition, and MCP clients cache the tool list.
 */
export const registerTools = (
  server: McpServer,
  client: AppleMessagesClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerChatTools(server, client);
  registerMessageTools(server, client);
  if (ctx.allowWrites) registerActionTools(server, client);
};

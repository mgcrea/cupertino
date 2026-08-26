import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMessagesClient } from "../client/messages.js";
import { registerActionTools } from "./actions.js";
import { registerAttachmentTools } from "./attachments.js";
import { registerChatTools } from "./chats.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerMessageTools } from "./messages.js";

export type ToolContext = {
  /**
   * Gates the two tools that change something outside this process.
   *
   * `send_message` is the only one that touches Messages.app, and it is also
   * every Apple Event this server can send, because sending is the only thing
   * Apple Events can do here — there is no read lane to fall back to and never
   * can be. So with writes off this server remains inert with respect to
   * Messages.app: it opens a file and nothing else.
   *
   * `save_attachment` is gated for a different reason. It sends no Apple Event
   * and changes nothing in Messages; what it does is create a file on the
   * user's disk, which Mail and Notes also treat as a write. The claim above
   * survives it intact.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Messages tools.
 *
 * Five reads, always. Two writes, only when `allowWrites` is on — and on this
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
  if (!ctx.allowWrites) return;
  registerActionTools(server, client);
  registerAttachmentTools(server, client);
};

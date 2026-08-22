import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleContactsClient } from "../client/contacts.js";
import { registerActionTools } from "./actions.js";
import { registerContactTools } from "./contacts.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerResolveTools } from "./resolve.js";

export type ToolContext = {
  /**
   * Register the mutating tools too. Off by default — with the flag off they are
   * not merely refused, they are invisible and cannot be called at all, because
   * MCP clients cache the tool list and a tool that exists and says no is one
   * the model will keep trying.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Contacts tools.
 *
 * READS are file-lane and ask for no Automation grant. WRITES are Apple Events,
 * always — the store is opened `PRAGMA query_only` because Contacts owns it and
 * reconciles it against iCloud, so writing to it would corrupt sync state.
 *
 * That split has a cost worth stating plainly: this surface used to need no
 * Automation grant at all, which docs/distribution.md calls the strongest
 * argument for file-first. Turning writes on gives that up — the first write
 * prompts for permission to control Contacts. With `allowWrites` off, nothing
 * here ever sends an Apple Event and the old property still holds.
 *
 * There is no delete. Contacts' scripting dictionary has no delete command of
 * any kind; see `client/jxa/core.ts` for the measurement.
 *
 * The registered set does NOT vary with whether the store is readable. That is a
 * runtime condition which can change while the process lives, and MCP clients
 * cache the tool list, so a tool that appeared and disappeared would leave
 * clients calling names the server no longer has. Tools that need the store
 * report what is missing instead.
 */
export const registerTools = (
  server: McpServer,
  client: AppleContactsClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerContactTools(server, client);
  registerResolveTools(server, client);

  if (!ctx.allowWrites) return;
  registerActionTools(server, client);
};

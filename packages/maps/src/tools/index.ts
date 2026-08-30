import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMapsClient } from "../client/maps.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerPlaceTools } from "./places.js";
import { registerWriteTools } from "./writes.js";

export type ToolContext = {
  /**
   * Gates the two mutating tools, which are NOT registered when it is false —
   * so a host that has not opted in is never told they exist.
   *
   * This surface writes SQL directly into Maps' Core Data store, because Maps
   * has no scripting dictionary and no App Intents to write through. The store
   * is mirrored to iCloud, so a write here reaches every device on the account.
   * `docs/maps.md` carries the measurements; `client/write.ts` carries the rule
   * that makes it safe — never fabricate a place record, only copy one Maps
   * wrote itself.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Maps tools.
 *
 * The registered set does NOT vary with whether the store opened. That is a
 * runtime condition and MCP clients cache the tool list, so a list that shrank
 * without Full Disk Access would stay shrunk after the grant was given. Every
 * tool is registered on a machine with no grant at all; each fails with an
 * error that says which permission is missing.
 */
export const registerTools = (
  server: McpServer,
  client: AppleMapsClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerPlaceTools(server, client);
  if (!ctx.allowWrites) return;
  registerWriteTools(server, client);
};

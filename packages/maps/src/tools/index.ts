import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMapsClient } from "../client/maps.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerPlaceTools } from "./places.js";

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
  _ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerPlaceTools(server, client);
};

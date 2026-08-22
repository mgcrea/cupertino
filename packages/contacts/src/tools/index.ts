import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleContactsClient } from "../client/contacts.js";
import { registerContactTools } from "./contacts.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerResolveTools } from "./resolve.js";

export type ToolContext = {
  /**
   * Accepted and deliberately unused.
   *
   * Contacts registers no mutating tool, so there is nothing for the flag to
   * gate — the shape is kept so this surface matches the others and so that a
   * future write lane has an obvious place to hang itself. `tools.test.ts`
   * asserts the tool list is IDENTICAL with writes on and off, which is what
   * stops a mutating tool being added here without that decision being taken
   * deliberately.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Contacts tools.
 *
 * Every tool here is read-only, and that is a permission claim as much as a
 * capability one: with no Apple Events lane this server asks for no Automation
 * grant at all. `docs/distribution.md` calls that the strongest argument for
 * file-first, and on this surface it is free.
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
  _ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerContactTools(server, client);
  registerResolveTools(server, client);
};

import type { McpServer } from "@modelcontextprotocol/server";

import type { AppleMapsClient } from "../client/maps.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerPlaceTools } from "./places.js";
import { registerStoreWriteTools } from "./store-writes.js";

export type ToolContext = {
  /**
   * Gates the mutating tools, which are NOT registered when it is false, so a
   * host that has not opted in is never told they exist.
   *
   * It is necessary and not sufficient. Maps has no scripting dictionary and
   * no App Intents to write through, so its one write route is Cupertino's
   * store lane, which saves with Maps' own Core Data model; on 2026-11-11 every
   * one of its five writes was seen on a Mac and an iPhone, one with Maps quit.
   * Run from npm there is no lane, and this server registers no write tool
   * whatever this says. The SQL and Accessibility routes it once had were
   * retired the same day: the watch found the SQL inserts never mirrored to
   * iCloud, and Maps converted them into saved places. `docs/maps.md` carries
   * the measurements. The rule that outlived them: never fabricate a place
   * record, only copy one Maps wrote itself.
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
  // The store lane exists only when Cupertino hosts this server. Without it
  // there is no write route, and registering tools that could only refuse
  // would tell a host about a capability it does not have.
  //
  // Whether the lane is compatible is not asked here: MCP clients cache the
  // list, and opening the lane connects nothing. An incompatible lane refuses
  // per call, naming the mismatch.
  const lane = client.lane;
  if (lane) registerStoreWriteTools(server, client, lane);
};

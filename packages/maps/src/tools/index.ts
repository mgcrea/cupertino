import type { McpServer } from "@modelcontextprotocol/server";

import type { AppleMapsClient } from "../client/maps.js";
import { registerAxWriteTools } from "./ax-writes.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerPlaceTools } from "./places.js";
import { registerStoreWriteTools } from "./store-writes.js";
import { registerWriteTools } from "./writes.js";

export type ToolContext = {
  /**
   * Gates the mutating tools, which are NOT registered when it is false, so a
   * host that has not opted in is never told they exist.
   *
   * Maps has no scripting dictionary and no App Intents to write through, and
   * the route depends on who runs this server. Hosted by Cupertino, the five
   * writes go through its store lane, which saves with Maps' own Core Data
   * model; on 2026-11-11 every one was seen on a Mac and an iPhone, one with
   * Maps quit. Run from npm, two tools write SQL straight into the store; the
   * 2026-11-11 watch found those inserts never mirrored to iCloud, and saw Maps
   * convert such favourites into saved places. `docs/maps.md` carries the
   * measurements. Both routes keep one rule: never fabricate a place record,
   * only copy one Maps wrote itself.
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
  // The store lane, when Cupertino hosts this server: the five writes saved by
  // the app with Maps' own model, and then neither older route. The SQL and
  // interface tools share these names, so registering both would collide, and
  // the lane is the route that records the change the way Maps does.
  //
  // Whether the lane is compatible is not asked here: MCP clients cache the
  // list, and opening the lane connects nothing. An incompatible lane refuses
  // per call, naming the mismatch.
  const lane = client.lane;
  if (lane) {
    registerStoreWriteTools(server, client, lane);
    return;
  }
  registerWriteTools(server, client);
  // The interface lane, and only when the app is hosting this server. The
  // Accessibility grant belongs to Cupertino.app rather than to node, so a
  // package run from npm has no lane here — registering tools that could only
  // ever refuse would tell a host about a capability it does not have.
  //
  // Behind `allowWrites` with the rest, because these press controls in a real
  // window, and Maps itself then saves the change into the store it mirrors to
  // iCloud. Whether that reaches another device was never measured.
  const ax = client.axLane;
  if (ax) registerAxWriteTools(server, ax);
};

import type { McpServer } from "@modelcontextprotocol/server";

import type { VoiceMemosClient } from "../client/voice-memos.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerExportTools } from "./export.js";
import { registerRecordingTools } from "./recordings.js";
import { registerStoreWriteTools } from "./store-writes.js";

export type ToolContext = {
  /** Gates `save_recording` and the store lane's tools, none registered when this is false. */
  allowWrites: boolean;
};

/**
 * Register the Voice Memos tools.
 *
 * The registered set does not vary with whether the store opened. MCP clients cache the tool
 * list, so one that shrank without Full Disk Access would stay shrunk after the grant. Every
 * tool is registered with no grant at all, and each fails naming the missing permission.
 */
export const registerTools = (
  server: McpServer,
  client: VoiceMemosClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client);
  registerRecordingTools(server, client);
  if (!ctx.allowWrites) return;
  registerExportTools(server, client);
  // The store lane, and only when the app is hosting this server. The save happens inside
  // Cupertino.app, which holds Voice Memos' model and the grant to its store, so a package run
  // from npm has no lane here: registering tools that could only ever refuse would tell a host
  // about a capability it does not have.
  //
  // Behind `allowWrites` with the rest, because these change the person's library and reach
  // every device on the account through iCloud.
  const lane = client.lane;
  if (lane) registerStoreWriteTools(server, lane);
};

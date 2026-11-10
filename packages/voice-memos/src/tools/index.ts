import type { McpServer } from "@modelcontextprotocol/server";

import type { VoiceMemosClient } from "../client/voice-memos.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerExportTools } from "./export.js";
import { registerRecordingTools } from "./recordings.js";

export type ToolContext = {
  /** Gates `save_recording`, which is NOT registered when this is false. */
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
};

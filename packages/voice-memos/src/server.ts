import { type Logger, registerSurfaceResources, withLazyTools } from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "./build-info.js";
import { VoiceMemosClient } from "./client/voice-memos.js";
import type { Config } from "./config.js";
import { VOICE_MEMOS_GUIDE } from "./guide.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so discovery never reaches anyone's real home. */
  home?: string;
};

export type CreatedServer = { server: McpServer; client: VoiceMemosClient };

/**
 * Build the server. Side-effect free: it opens no database and reads no file until a tool
 * runs. There is no `osascript` seam: Voice Memos is not scriptable, so this server never
 * spawns one.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const client = new VoiceMemosClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });

  withLazyTools(
    server,
    {
      surface: "voice-memos",
      displayName: "Voice Memos",
      lazy: config.lazyTools,
      allowWrites: config.allowWrites,
    },
    (target, allowWrites) => registerTools(target, client, { allowWrites }),
  );
  // No prompts on this surface; the resources ride the same flag as everywhere else.
  if (config.exposePrompts) {
    registerSurfaceResources(server, {
      surface: "voice-memos",
      displayName: "Voice Memos",
      guide: VOICE_MEMOS_GUIDE,
      diagnostics: () => buildDiagnostics(client),
    });
  }

  return { server, client };
};

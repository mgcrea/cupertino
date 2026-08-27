import { registerSurfaceResources, type Logger } from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleMapsClient } from "./client/maps.js";
import type { Config } from "./config.js";
import { MAPS_GUIDE } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so discovery never reaches the developer's real home. */
  home?: string;
};

export type CreatedServer = {
  server: McpServer;
  client: AppleMapsClient;
};

/**
 * Build the server. Side-effect free: it opens no database and reads no file,
 * so a test can construct it freely and every external dependency arrives
 * through an option.
 *
 * There is no `osascript` seam here, unlike every other surface. This server
 * never spawns one — Maps is not scriptable, so there is no Apple Events lane
 * to inject a fake for. Its absence is the point.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleMapsClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });

  registerTools(server, client, { allowWrites: config.allowWrites });
  /*
   * One flag, both primitives — see `exposePrompts` in core's config. A prompt
   * embeds its surface guide, so registering prompts without the resources
   * would leave every expansion naming a `cupertino://maps/guide` that this
   * server does not serve.
   */
  if (config.exposePrompts) {
    registerPrompts(server);
    registerSurfaceResources(server, {
      surface: "maps",
      displayName: "Maps",
      guide: MAPS_GUIDE,
      diagnostics: () => buildDiagnostics(client),
      // No inventory. Favourites, collections and recents are three queries
      // rather than three named containers, and a caller does not address them
      // by name the way they address a mailbox or a folder.
    });
  }

  return { server, client };
};

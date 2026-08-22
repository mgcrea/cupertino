import type { Logger } from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleContactsClient } from "./client/contacts.js";
import type { Config } from "./config.js";
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
  client: AppleContactsClient;
};

/**
 * Build the server. Side-effect free: it opens no database and reads no file,
 * so a test can construct it freely and every external dependency arrives
 * through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleContactsClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });

  registerTools(server, client, { allowWrites: config.allowWrites });

  return { server, client };
};

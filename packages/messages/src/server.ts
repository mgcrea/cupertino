import type { Logger, OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleMessagesClient } from "./client/messages.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches real Messages. */
  osascript?: OsascriptRunner;
  /** Injected by tests so discovery never reaches the developer's real home. */
  home?: string;
  /** Injected by tests, so no test reaches the developer's real address book. */
  contacts?: ConstructorParameters<typeof AppleMessagesClient>[0]["contacts"];
};

export type CreatedServer = {
  server: McpServer;
  client: AppleMessagesClient;
};

/**
 * Build the server. Side-effect free: it opens no database and reads no file,
 * so a test can construct it freely and every external dependency arrives
 * through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleMessagesClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.osascript ? { osascript: opts.osascript } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.contacts === undefined ? {} : { contacts: opts.contacts }),
  });

  registerTools(server, client, { allowWrites: config.allowWrites });

  return { server, client };
};

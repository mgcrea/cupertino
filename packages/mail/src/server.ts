import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleMailClient } from "./client/mail.js";
import type { Logger, OsascriptRunner } from "./client/osascript.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches a real Mail. */
  osascript?: OsascriptRunner;
};

export type CreatedServer = {
  server: McpServer;
  client: AppleMailClient;
};

/**
 * Build the server. Side-effect free: it opens no connection, spawns no
 * process and reads no file, so a test can construct it freely and every
 * external dependency arrives through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleMailClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.osascript ? { osascript: opts.osascript } : {}),
  });

  registerTools(server, client, { allowWrites: config.allowWrites });

  return { server, client };
};
